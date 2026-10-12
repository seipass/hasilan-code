import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ExecutionAdapter,
	type SessionDescriptor,
	SessionRegistry,
	type WorkspaceDirectory,
	type WorkspaceDirectoryService,
} from "../src/server/session-registry.ts";
import { TeamManager } from "../src/server/team-manager.ts";
import type { PendingInputAction } from "../src/shared/contracts.ts";

class Directories implements WorkspaceDirectoryService {
	entries: WorkspaceDirectory[] = [];
	async register(path: string, preferredId?: string) {
		let entry = this.entries.find((item) => item.path === path);
		if (!entry) {
			entry = { id: preferredId ?? randomUUID(), path };
			this.entries.push(entry);
		}
		return entry;
	}
	getWorkspaceRoot(id: string) {
		const workspace = this.entries.find((entry) => entry.id === id);
		if (!workspace) throw new Error("Unknown workspace");
		return workspace.path;
	}
	getWorkspaces() {
		return this.entries;
	}
}
type Program = (adapter: ControlledAdapter, text: string) => Promise<string>;
type ControlledQueueItem = { inputId: string; text: string };

class ControlledAdapter implements ExecutionAdapter {
	readonly descriptor: SessionDescriptor;
	readonly manager: SessionManager;
	readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	readonly inputs: string[] = [];
	private readonly queuedSteering: ControlledQueueItem[] = [];
	private readonly queuedFollowUp: ControlledQueueItem[] = [];
	controller = new AbortController();
	private readonly program?: Program;
	private finishPrompt?: (text: string) => void;
	private idle: Promise<void> = Promise.resolve();
	constructor(descriptor: SessionDescriptor, manager: SessionManager, program?: Program) {
		this.descriptor = descriptor;
		this.manager = manager;
		this.program = program;
	}
	subscribe(listener: (event: AgentSessionEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(event: AgentSessionEvent) {
		for (const listener of this.listeners) listener(event);
	}
	private queueFor(mode: "steer" | "followUp"): ControlledQueueItem[] {
		return mode === "steer" ? this.queuedSteering : this.queuedFollowUp;
	}
	private emitQueueUpdate() {
		this.emit({
			type: "queue_update",
			steering: this.queuedSteering.map((input) => input.text),
			followUp: this.queuedFollowUp.map((input) => input.text),
		});
	}
	async prompt(text: string) {
		this.controller = new AbortController();
		let resolveIdle = () => {};
		this.idle = new Promise<void>((resolve) => {
			resolveIdle = resolve;
		});
		this.emit({ type: "agent_start" });
		const user = { role: "user" as const, content: text, timestamp: Date.now() };
		this.emit({ type: "message_start", message: user });
		this.emit({ type: "message_end", message: user });
		this.manager.appendMessage(user);
		try {
			const result = this.program
				? await this.program(this, text)
				: await new Promise<string>((resolve) => {
						this.finishPrompt = resolve;
						this.controller.signal.addEventListener("abort", () => resolve(""), { once: true });
					});
			if (!this.controller.signal.aborted) {
				const message = fauxAssistantMessage(result);
				this.emit({ type: "message_start", message });
				this.emit({ type: "message_end", message });
				this.manager.appendMessage(message);
			}
		} finally {
			this.emit({ type: "agent_settled", aborted: this.controller.signal.aborted });
			resolveIdle();
		}
	}
	finish(text: string) {
		this.finishPrompt?.(text);
	}
	async deliverInput(text: string, mode: "steer" | "followUp", inputId: string) {
		this.inputs.push(text);
		this.queueFor(mode).push({ inputId, text });
		this.emitQueueUpdate();
	}
	hasQueuedInput(inputId: string): boolean {
		return (
			this.queuedSteering.some((input) => input.inputId === inputId) ||
			this.queuedFollowUp.some((input) => input.inputId === inputId)
		);
	}
	mutateQueuedInput(inputId: string, action: PendingInputAction): boolean {
		const followUpIndex = this.queuedFollowUp.findIndex((input) => input.inputId === inputId);
		if (action.type === "sendNow") {
			if (followUpIndex === -1) return false;
			const [input] = this.queuedFollowUp.splice(followUpIndex, 1);
			if (!input) return false;
			this.queuedSteering.push(input);
		} else {
			const queue = this.queuedSteering.some((input) => input.inputId === inputId)
				? this.queuedSteering
				: this.queuedFollowUp;
			const index = queue.findIndex((input) => input.inputId === inputId);
			if (index === -1) return false;
			if (action.type === "edit") {
				const input = queue[index];
				if (!input) return false;
				input.text = action.text;
			} else queue.splice(index, 1);
		}
		this.emitQueueUpdate();
		return true;
	}
	consume(text: string) {
		let index = this.queuedSteering.findIndex((input) => input.text === text);
		if (index !== -1) this.queuedSteering.splice(index, 1);
		else {
			index = this.queuedFollowUp.findIndex((input) => input.text === text);
			if (index !== -1) this.queuedFollowUp.splice(index, 1);
		}
		this.emitQueueUpdate();
		const message = { role: "user" as const, content: text, timestamp: Date.now() };
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
		this.manager.appendMessage(message);
	}
	async abort() {
		this.controller.abort();
		await this.idle;
	}
	waitForIdle() {
		return this.idle;
	}
	clearQueue() {
		this.inputs.length = 0;
		this.queuedSteering.length = 0;
		this.queuedFollowUp.length = 0;
		this.emitQueueUpdate();
	}
	getActiveToolNames() {
		return this.descriptor.tools ?? ["read", "edit", "write", "bash", "team"];
	}
	async setModel() {}
	dispose() {
		this.listeners.clear();
	}
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(limit = 4, program?: Program) {
	const root = await mkdtemp(join(tmpdir(), "pi-web-sessions-"));
	const workspacePath = join(root, "workspace");
	await mkdir(workspacePath);
	const adapters = new Map<string, ControlledAdapter>();
	const registry = new SessionRegistry({
		agentDir: root,
		workspaceFiles: new Directories(),
		adapterFactory: async (descriptor, manager) => {
			const adapter = new ControlledAdapter(descriptor, manager, program);
			adapters.set(descriptor.sessionId, adapter);
			return adapter;
		},
	});
	const teams = new TeamManager(registry, {
		agentDir: root,
		getLimits: () => ({ maxConcurrentAgents: limit, maxDepth: 3 }),
	});
	await registry.initialize();
	await teams.initialize();
	const workspace = await registry.addWorkspace(workspacePath);
	const session = await registry.create({ workspaceId: workspace.id });
	await teams.ensureRoot(session.sessionId);
	cleanups.push(async () => {
		await teams.close();
		await registry.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, workspace, session, registry, teams, adapters };
}
async function running(adapters: Map<string, ControlledAdapter>, id: string) {
	await expect.poll(() => adapters.has(id)).toBe(true);
	const adapter = adapters.get(id);
	if (!adapter) throw new Error("Adapter did not start");
	return adapter;
}

describe("team run boundaries", () => {
	it("runs independent roots concurrently and preserves immutable old runs across resume", async () => {
		const f = await fixture(1);
		const second = await f.registry.create({ workspaceId: f.workspace.id });
		const firstRun = await f.teams.prompt(f.session.sessionId, { text: "A", mode: "prompt" });
		const secondRun = await f.teams.prompt(second.sessionId, { text: "B", mode: "prompt" });
		expect(firstRun.disposition).toBe("started");
		expect(secondRun.disposition).toBe("started");
		(await running(f.adapters, f.session.sessionId)).finish("final A");
		(await running(f.adapters, second.sessionId)).finish("final B");
		await expect.poll(() => f.registry.get(f.session.sessionId).latestRun?.status).toBe("completed");
		await expect.poll(() => f.registry.get(second.sessionId).latestRun?.status).toBe("completed");
		const old = structuredClone(f.registry.state.runs.find((run) => run.runId === firstRun.runId));
		await f.teams.prompt(f.session.sessionId, { text: "A2", mode: "prompt" });
		expect(f.registry.state.runs.find((run) => run.runId === firstRun.runId)).toEqual(old);
		expect(f.registry.get(second.sessionId).messages.at(-1)?.content).toEqual([{ type: "text", text: "final B" }]);
	});
	it("releases and reacquires permits through parent-child-grandchild waits at limit one", async () => {
		let teams: TeamManager;
		const f = await fixture(1, async (adapter) => {
			const level = adapter.descriptor.parentSessionId ? (adapter.descriptor.role === "grandchild" ? 2 : 1) : 0;
			if (level === 2) return "grandchild result";
			const spawned = await teams.spawn(adapter.descriptor.sessionId, [
				{ name: level === 0 ? "child" : "grandchild", task: "investigate" },
			]);
			const waited = await teams.wait(
				adapter.descriptor.sessionId,
				[spawned.agents[0].agentId],
				10000,
				adapter.controller.signal,
			);
			expect(waited.timedOut).toBe(false);
			expect(waited.runs[0].status).toBe("completed");
			for (const notice of adapter.inputs) adapter.consume(notice);
			return `${level === 0 ? "root" : "child"}: ${waited.runs[0].result}`;
		});
		teams = f.teams;
		await teams.prompt(f.session.sessionId, { text: "coordinate", mode: "prompt" });
		await expect
			.poll(() => f.registry.get(f.session.sessionId).latestRun?.status, { timeout: 15000 })
			.toBe("completed");
		expect(f.registry.get(f.session.sessionId).latestRun?.result).toBe("root: child: grandchild result");
		expect(f.registry.state.runs).toHaveLength(3);
	});
	it("delivers a child completion to a running parent as one persisted follow-up", async () => {
		const f = await fixture();
		await f.teams.prompt(f.session.sessionId, { text: "coordinate", mode: "prompt" });
		const parent = await running(f.adapters, f.session.sessionId);
		const child = (await f.teams.spawn(f.session.sessionId, [{ name: "research", task: "investigate" }])).agents[0];
		(await running(f.adapters, child.sessionId)).finish("finished research");
		await expect.poll(() => parent.inputs.length).toBe(1);
		expect(parent.inputs[0]).toContain(`Run ${child.runId} (research) completed`);
		expect(parent.inputs[0]).toContain("finished research");
		const pending = f.registry.get(f.session.sessionId).pendingInput;
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({
			runId: f.registry.get(f.session.sessionId).currentRun?.runId,
			delivered: true,
		});
		parent.consume(parent.inputs[0]);
		await expect.poll(() => f.registry.get(f.session.sessionId).pendingInput).toHaveLength(0);
		expect(f.registry.get(f.session.sessionId).messages.at(-1)?.content).toBe(parent.inputs[0]);
		expect(parent.inputs).toHaveLength(1);
	});
	it("admits one idle parent continuation for two completed children", async () => {
		const f = await fixture(3);
		await f.teams.prompt(f.session.sessionId, { text: "delegate", mode: "prompt" });
		const parent = await running(f.adapters, f.session.sessionId);
		const children = (
			await f.teams.spawn(f.session.sessionId, [
				{ name: "first", task: "one" },
				{ name: "second", task: "two" },
			])
		).agents;
		await running(f.adapters, children[0].sessionId);
		await running(f.adapters, children[1].sessionId);
		parent.finish("delegated");
		await expect.poll(() => f.registry.get(f.session.sessionId).currentRun).toBeUndefined();
		f.adapters.get(children[0].sessionId)?.finish("first result");
		await expect.poll(() => f.registry.get(f.session.sessionId).latestRun?.task).toContain("first result");
		f.adapters.get(children[1].sessionId)?.finish("second result");
		const continuation = f.registry.get(f.session.sessionId).latestRun;
		expect(continuation?.task).toContain(`Run ${children[0].runId}`);
		await expect
			.poll(() =>
				f.registry
					.get(f.session.sessionId)
					.pendingInput.some((input) => input.completionRunId === children[1].runId),
			)
			.toBe(true);
		expect(
			f.registry
				.get(f.session.sessionId)
				.pendingInput.filter((input) => input.completionRunId === children[1].runId),
		).toHaveLength(1);
		expect(
			f.registry.state.runs.filter(
				(run) =>
					run.agentId ===
					f.registry.state.agents.find((agent) => agent.sessionId === f.session.sessionId)?.agentId,
			),
		).toHaveLength(2);
		await expect
			.poll(() =>
				f.registry
					.get(f.session.sessionId)
					.messages.some(
						(message) => message.role === "user" && JSON.stringify(message.content).includes("first result"),
					),
			)
			.toBe(true);
	});
	it("notifies a parent exactly once when a queued child is cancelled", async () => {
		const f = await fixture(1);
		await f.teams.prompt(f.session.sessionId, { text: "root", mode: "prompt" });
		const parent = await running(f.adapters, f.session.sessionId);
		const child = (await f.teams.spawn(f.session.sessionId, [{ name: "queued", task: "never admitted" }])).agents[0];
		expect(child.status).toBe("queued");
		await f.teams.stop(child.sessionId);
		await expect.poll(() => parent.inputs.length).toBe(1);
		expect(parent.inputs[0]).toContain(`Run ${child.runId} (queued) cancelled`);
		expect(f.adapters.has(child.sessionId)).toBe(false);
		expect(f.registry.get(f.session.sessionId).pendingInput).toHaveLength(1);
	});
	it("wait any returns the first pinned failure while another child remains running", async () => {
		const failGate = Promise.withResolvers<void>();
		const finishGate = Promise.withResolvers<string>();
		const f = await fixture(3, async (_adapter, text) => {
			if (text === "fail") {
				await failGate.promise;
				throw new Error("child failure");
			}
			return finishGate.promise;
		});
		await f.teams.prompt(f.session.sessionId, { text: "root", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		const [failed, slow] = (
			await f.teams.spawn(f.session.sessionId, [
				{ name: "failure", task: "fail" },
				{ name: "slow", task: "slow" },
			])
		).agents;
		const timeout = await f.teams.wait(f.session.sessionId, [failed.agentId, slow.agentId], 0, undefined, "any");
		expect(timeout.timedOut).toBe(true);
		expect(timeout.runs.map((run) => run.status)).toEqual(["running", "running"]);
		const waiting = f.teams.wait(f.session.sessionId, [failed.agentId, slow.agentId], 10000, undefined, "any");
		await running(f.adapters, failed.sessionId);
		await running(f.adapters, slow.sessionId);
		await expect.poll(() => f.registry.get(f.session.sessionId).currentRun?.status).toBe("waiting");
		failGate.resolve();
		const result = await waiting;
		expect(result.timedOut).toBe(false);
		expect(result.runs).toEqual([
			expect.objectContaining({ runId: failed.runId, status: "failed", error: "child failure" }),
			expect.objectContaining({ runId: slow.runId, status: "running" }),
		]);
		expect(f.registry.get(f.session.sessionId).currentRun?.status).toBe("running");
		await expect.poll(() => f.adapters.get(f.session.sessionId)?.inputs[0]).toContain(`Run ${failed.runId}`);
		expect(f.adapters.get(f.session.sessionId)?.inputs[0]).toContain("Error:\nchild failure");
		finishGate.resolve("finished");
	});
	it("keeps completion notices pending during wait all, then delivers both on readmission", async () => {
		const f = await fixture(3);
		await f.teams.prompt(f.session.sessionId, { text: "root", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		const [first, second] = (
			await f.teams.spawn(f.session.sessionId, [
				{ name: "first", task: "first" },
				{ name: "second", task: "second" },
			])
		).agents;
		const waiting = f.teams.wait(f.session.sessionId, [first.agentId, second.agentId], 10000);
		void waiting.catch(() => undefined);
		const firstAdapter = await running(f.adapters, first.sessionId);
		const secondAdapter = await running(f.adapters, second.sessionId);
		await expect.poll(() => f.registry.get(f.session.sessionId).currentRun?.status).toBe("waiting");
		firstAdapter.finish("one");
		await expect.poll(() => f.registry.get(first.sessionId).latestRun?.status).toBe("completed");
		expect(f.registry.get(f.session.sessionId).currentRun?.status).toBe("waiting");
		expect(f.adapters.get(f.session.sessionId)?.inputs).toEqual([]);
		expect(f.registry.get(f.session.sessionId).pendingInput).toEqual([
			expect.objectContaining({ completionRunId: first.runId, delivered: false, status: "pending" }),
		]);
		secondAdapter.finish("two");
		expect((await waiting).runs.map((run) => run.result)).toEqual(["one", "two"]);
		await expect.poll(() => f.adapters.get(f.session.sessionId)?.inputs.length).toBe(2);
		expect(f.adapters.get(f.session.sessionId)?.inputs[0]).toContain(`Run ${first.runId}`);
		expect(f.adapters.get(f.session.sessionId)?.inputs[1]).toContain(`Run ${second.runId}`);
	});
	it("records a waiting parent's undelivered completion notice without replaying it after restart", async () => {
		const f = await fixture(3);
		await f.teams.prompt(f.session.sessionId, { text: "root", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		const [first, second] = (
			await f.teams.spawn(f.session.sessionId, [
				{ name: "first", task: "first" },
				{ name: "second", task: "second" },
			])
		).agents;
		const waiting = f.teams.wait(f.session.sessionId, [first.agentId, second.agentId], 10000);
		void waiting.catch(() => undefined);
		const firstAdapter = await running(f.adapters, first.sessionId);
		await running(f.adapters, second.sessionId);
		await expect.poll(() => f.registry.get(f.session.sessionId).currentRun?.status).toBe("waiting");
		firstAdapter.finish("done");
		await expect.poll(() => f.registry.get(f.session.sessionId).pendingInput[0]?.completionRunId).toBe(first.runId);
		const restoredAdapters: ControlledAdapter[] = [];
		const restored = new SessionRegistry({
			agentDir: f.root,
			workspaceFiles: new Directories(),
			adapterFactory: async (descriptor, manager) => {
				const adapter = new ControlledAdapter(descriptor, manager);
				restoredAdapters.push(adapter);
				return adapter;
			},
		});
		await restored.initialize();
		const teams = new TeamManager(restored);
		await teams.initialize();
		expect(restored.get(f.session.sessionId).pendingInput).toEqual([
			expect.objectContaining({ completionRunId: first.runId, status: "undelivered", delivered: false }),
		]);
		expect(restored.get(f.session.sessionId).latestRun?.status).toBe("interrupted");
		expect(restoredAdapters).toHaveLength(0);
		await teams.close();
		await restored.close();
	});
	it("does not activate a stopped parent from a cancelled child or replay its notice on restart", async () => {
		const f = await fixture(2);
		await f.teams.prompt(f.session.sessionId, { text: "root", mode: "prompt" });
		const child = (await f.teams.spawn(f.session.sessionId, [{ name: "child", task: "slow" }])).agents[0];
		await running(f.adapters, child.sessionId);
		await f.teams.stop(f.session.sessionId);
		expect(f.registry.get(f.session.sessionId).currentRun).toBeUndefined();
		expect(f.registry.get(f.session.sessionId).pendingInput).toHaveLength(0);
		expect(
			f.registry.state.runs.filter(
				(run) =>
					run.agentId ===
					f.registry.state.agents.find((agent) => agent.sessionId === f.session.sessionId)?.agentId,
			),
		).toHaveLength(1);
		const restoredAdapters: ControlledAdapter[] = [];
		const restored = new SessionRegistry({
			agentDir: f.root,
			workspaceFiles: new Directories(),
			adapterFactory: async (descriptor, manager) => {
				const adapter = new ControlledAdapter(descriptor, manager);
				restoredAdapters.push(adapter);
				return adapter;
			},
		});
		await restored.initialize();
		const teams = new TeamManager(restored);
		await teams.initialize();
		expect(restored.get(f.session.sessionId).currentRun).toBeUndefined();
		expect(restoredAdapters).toHaveLength(0);
		await teams.close();
		await restored.close();
	});
	it("rejects busy root prompts and keeps queued child inputs in FIFO until start", async () => {
		const f = await fixture(1);
		await f.teams.prompt(f.session.sessionId, { text: "hold", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		await expect(f.teams.prompt(f.session.sessionId, { text: "conflict", mode: "prompt" })).rejects.toMatchObject({
			statusCode: 409,
		});
		const spawned = await f.teams.spawn(f.session.sessionId, [{ name: "child", task: "initial" }]);
		const child = spawned.agents[0];
		expect(child.status).toBe("queued");
		const first = await f.teams.send(f.session.sessionId, child.agentId, "one");
		const second = await f.teams.send(f.session.sessionId, child.agentId, "two");
		expect(first.disposition).toBe("queued");
		expect(f.adapters.has(child.sessionId)).toBe(false);
		const waiting = f.teams.wait(f.session.sessionId, [child.agentId], 10000);
		const adapter = await running(f.adapters, child.sessionId);
		await expect.poll(() => adapter.inputs.length).toBe(2);
		expect(adapter.inputs[0]).toContain(`inputId=${first.inputId}`);
		expect(adapter.inputs[1]).toContain(`inputId=${second.inputId}`);
		adapter.consume(adapter.inputs[0]);
		adapter.consume(adapter.inputs[1]);
		await expect.poll(() => f.registry.get(child.sessionId).pendingInput.length).toBe(0);
		adapter.finish("child result");
		expect((await waiting).runs[0].result).toBe("child result");
	});
	it("pins a completed target run even when that agent is restarted", async () => {
		const f = await fixture();
		await f.teams.prompt(f.session.sessionId, { text: "root", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		const spawned = await f.teams.spawn(f.session.sessionId, [{ name: "child", task: "first" }]);
		const child = spawned.agents[0];
		(await running(f.adapters, child.sessionId)).finish("first result");
		await expect.poll(() => f.registry.get(child.sessionId).latestRun?.status).toBe("completed");
		const waited = await f.teams.wait(f.session.sessionId, [child.agentId]);
		const anyWaited = await f.teams.wait(f.session.sessionId, [child.agentId], 30000, undefined, "any");
		expect(anyWaited).toMatchObject({ timedOut: false, runs: [{ runId: child.runId, status: "completed" }] });
		await f.teams.send(f.session.sessionId, child.agentId, "second");
		expect(waited.runs[0]).toMatchObject({ runId: child.runId, result: "first result", status: "completed" });
		expect(f.registry.get(child.sessionId).currentRun?.runId).not.toBe(child.runId);
	});
	it("rejects self, ancestor, cross-team and dependency-cycle waits and stops", async () => {
		const f = await fixture();
		const rootAgent = await f.teams.ensureRoot(f.session.sessionId);
		await f.teams.prompt(f.session.sessionId, { text: "root", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		const spawned = await f.teams.spawn(f.session.sessionId, [
			{ name: "one", task: "one" },
			{ name: "two", task: "two" },
		]);
		const [one, two] = spawned.agents;
		await running(f.adapters, one.sessionId);
		await running(f.adapters, two.sessionId);
		await expect(f.teams.wait(f.session.sessionId, [rootAgent.agentId])).rejects.toThrow("self");
		await expect(f.teams.wait(one.sessionId, [rootAgent.agentId])).rejects.toThrow("ancestor");
		await expect(f.teams.stop(f.session.sessionId, one.sessionId)).rejects.toThrow("ancestor");
		await expect(f.teams.stop(one.sessionId, one.sessionId)).rejects.toThrow("self");
		const other = await f.registry.create({ workspaceId: f.workspace.id });
		const otherAgent = await f.teams.ensureRoot(other.sessionId);
		await expect(f.teams.send(one.sessionId, otherAgent.agentId, "no")).rejects.toMatchObject({ statusCode: 403 });
		const waitOne = f.teams.wait(one.sessionId, [two.agentId], 10000);
		await expect.poll(() => f.registry.get(one.sessionId).currentRun?.status).toBe("waiting");
		await expect(f.teams.wait(two.sessionId, [one.agentId])).rejects.toThrow("cycle");
		(await running(f.adapters, two.sessionId)).finish("two");
		await waitOne;
	});
	it("cancels queued descendants without stopping siblings and fences concurrent sends/spawns", async () => {
		const f = await fixture(2);
		await f.teams.prompt(f.session.sessionId, { text: "hold root", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		const spawned = await f.teams.spawn(f.session.sessionId, [
			{ name: "one", task: "one" },
			{ name: "two", task: "two" },
		]);
		const [one, two] = spawned.agents;
		await running(f.adapters, one.sessionId);
		const stopping = f.teams.stop(one.sessionId);
		await expect(f.teams.send(f.session.sessionId, one.agentId, "late")).rejects.toThrow("stopping");
		await stopping;
		expect(f.registry.get(one.sessionId).latestRun?.status).toBe("cancelled");
		await running(f.adapters, two.sessionId);
		expect(f.registry.get(two.sessionId).currentRun?.status).toBe("running");
		const stopRoot = f.teams.stop(f.session.sessionId);
		await expect(f.teams.spawn(f.session.sessionId, [{ name: "late", task: "late" }])).rejects.toThrow("stopping");
		await stopRoot;
		expect(f.registry.state.runs.every((run) => ["cancelled", "completed"].includes(run.status))).toBe(true);
		await f.teams.prompt(f.session.sessionId, { text: "explicit restart", mode: "prompt" });
		expect(f.registry.get(f.session.sessionId).currentRun?.status).toBe("running");
	});
	it("resumes a waiting parent once with the cancelled child's notice", async () => {
		const f = await fixture(2);
		await f.teams.prompt(f.session.sessionId, { text: "root", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		const child = (await f.teams.spawn(f.session.sessionId, [{ name: "child", task: "slow" }])).agents[0];
		const waiting = f.teams.wait(f.session.sessionId, [child.agentId], 10000, undefined, "any");
		await running(f.adapters, child.sessionId);
		await expect.poll(() => f.registry.get(f.session.sessionId).currentRun?.status).toBe("waiting");
		await f.teams.stop(child.sessionId);
		expect((await waiting).runs).toEqual([expect.objectContaining({ runId: child.runId, status: "cancelled" })]);
		await expect.poll(() => f.adapters.get(f.session.sessionId)?.inputs.length).toBe(1);
		expect(f.adapters.get(f.session.sessionId)?.inputs[0]).toContain(`Run ${child.runId} (child) cancelled`);
		expect(f.registry.get(f.session.sessionId).currentRun?.status).toBe("running");
	});
	it("aborts a waiting caller without reacquiring a permit or hanging stop", async () => {
		const f = await fixture(1);
		await f.teams.prompt(f.session.sessionId, { text: "root", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		const spawned = await f.teams.spawn(f.session.sessionId, [{ name: "child", task: "child" }]);
		const waiting = f.teams.wait(f.session.sessionId, [spawned.agents[0].agentId], 10000);
		void waiting.catch(() => undefined);
		await running(f.adapters, spawned.agents[0].sessionId);
		await f.teams.stop(f.session.sessionId);
		await expect(waiting).rejects.toThrow("cancelled");
		expect(f.registry.state.runs.map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
	});
	it("resumes only after admission on timeout and enforces depth/tool subsets", async () => {
		const f = await fixture(1);
		await f.teams.prompt(f.session.sessionId, { text: "root", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		await expect(
			f.teams.spawn(f.session.sessionId, [{ name: "bad", task: "bad", tools: ["unknown"] }]),
		).rejects.toThrow("subset");
		const spawned = await f.teams.spawn(f.session.sessionId, [{ name: "child", task: "child", tools: [] }]);
		const waiting = f.teams.wait(f.session.sessionId, [spawned.agents[0].agentId], 0);
		const adapter = await running(f.adapters, spawned.agents[0].sessionId);
		await expect.poll(() => f.registry.get(f.session.sessionId).currentRun?.status).toBe("queued");
		adapter.finish("child done");
		expect((await waiting).timedOut).toBe(true);
		expect(f.registry.get(f.session.sessionId).currentRun?.status).toBe("running");
	});
	it("applies a named project profile without granting tools outside its allowance", async () => {
		const f = await fixture();
		const directory = join(f.workspace.path, ".hasilan-code", "agents");
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "reviewer.json"),
			JSON.stringify({
				name: "reviewer",
				description: "Checks changes",
				systemPrompt: "Review carefully",
				tools: ["read"],
			}),
		);
		await f.teams.prompt(f.session.sessionId, { text: "coordinate", mode: "prompt" });
		await expect(
			f.teams.spawn(f.session.sessionId, [{ name: "bad", task: "review", profile: "missing" }]),
		).rejects.toThrow("Unknown agent profile");
		await expect(
			f.teams.spawn(f.session.sessionId, [{ name: "bad", task: "review", profile: "reviewer", tools: ["bash"] }]),
		).rejects.toThrow("subset of profile");
		expect(f.registry.state.agents).toHaveLength(1);
		const child = (await f.teams.spawn(f.session.sessionId, [{ name: "audit", task: "review", profile: "reviewer" }]))
			.agents[0];
		const descriptor = f.registry.descriptor(child.sessionId);
		expect(descriptor.systemPrompt).toBe("Review carefully");
		expect(descriptor.tools).toEqual(["read"]);
	});
	it("executes dependency stages only after successful prerequisites and passes their results", async () => {
		let teams: TeamManager;
		const started: string[] = [];
		const f = await fixture(2, async (adapter, text) => {
			if (text !== "workflow" && !adapter.descriptor.parentSessionId) return "continuation";
			if (!adapter.descriptor.parentSessionId) {
				const outcome = await teams.workflow(
					adapter.descriptor.sessionId,
					[
						{ name: "review", task: "review", dependsOn: ["implementation"] },
						{ name: "implementation", task: "implement" },
						{ name: "research", task: "research" },
					],
					10000,
					adapter.controller.signal,
				);
				return JSON.stringify(outcome);
			}
			started.push(adapter.descriptor.role ?? "");
			if (adapter.descriptor.role === "review") {
				expect(started).toContain("implementation");
				expect(text).toContain("implementation:\nimplemented");
			}
			return adapter.descriptor.role === "implementation" ? "implemented" : "done";
		});
		teams = f.teams;
		const admission = await teams.prompt(f.session.sessionId, { text: "workflow", mode: "prompt" });
		await expect
			.poll(() => f.registry.state.runs.find((run) => run.runId === admission.runId)?.status, { timeout: 15000 })
			.toBe("completed");
		const outcome = JSON.parse(f.registry.state.runs.find((run) => run.runId === admission.runId)?.result ?? "{}");
		expect(outcome.timedOut).toBe(false);
		expect(outcome.tasks.map((task: { name: string; status: string }) => [task.name, task.status])).toEqual([
			["review", "completed"],
			["implementation", "completed"],
			["research", "completed"],
		]);
	});
	it("skips transitive dependents after failure, including reverse-ordered graph nodes", async () => {
		let teams: TeamManager;
		const f = await fixture(2, async (adapter, text) => {
			if (text !== "workflow" && !adapter.descriptor.parentSessionId) return "continuation";
			if (adapter.descriptor.parentSessionId) throw new Error("source failed");
			return JSON.stringify(
				await teams.workflow(
					adapter.descriptor.sessionId,
					[
						{ name: "publish", task: "publish", dependsOn: ["review"] },
						{ name: "review", task: "review", dependsOn: ["source"] },
						{ name: "source", task: "source" },
					],
					10000,
					adapter.controller.signal,
				),
			);
		});
		teams = f.teams;
		const admission = await teams.prompt(f.session.sessionId, { text: "workflow", mode: "prompt" });
		await expect
			.poll(() => f.registry.state.runs.find((run) => run.runId === admission.runId)?.status, { timeout: 15000 })
			.toBe("completed");
		const outcome = JSON.parse(f.registry.state.runs.find((run) => run.runId === admission.runId)?.result ?? "{}");
		expect(outcome.tasks.map((task: { name: string; status: string }) => [task.name, task.status])).toEqual([
			["publish", "skipped"],
			["review", "skipped"],
			["source", "failed"],
		]);
		expect(f.registry.state.agents).toHaveLength(2);
	});
});

describe("persistent conversation and projection boundaries", () => {
	it("retains thinking chosen before the first prompt without materializing a session", async () => {
		const f = await fixture();
		await f.registry.setThinkingLevel(f.session.sessionId, "low");
		expect(f.registry.get(f.session.sessionId)).toMatchObject({ thinkingLevel: "low", materialized: false });
		const restored = new SessionRegistry({ agentDir: f.root, workspaceFiles: new Directories() });
		await restored.initialize();
		expect(restored.get(f.session.sessionId)).toMatchObject({ thinkingLevel: "low", materialized: false });
		await restored.close();
	});
	it("keeps the first user prompt as the title across later runs and restart, and persists thinking selection", async () => {
		const f = await fixture();
		expect(f.registry.get(f.session.sessionId).title).toBeUndefined();
		await f.teams.prompt(f.session.sessionId, { text: "最初の依頼", mode: "prompt" });
		await expect(f.registry.setThinkingLevel(f.session.sessionId, "high")).rejects.toMatchObject({ statusCode: 409 });
		(await running(f.adapters, f.session.sessionId)).finish("一回目");
		await expect.poll(() => f.registry.get(f.session.sessionId).latestRun?.status).toBe("completed");
		await f.registry.setThinkingLevel(f.session.sessionId, "high");
		await f.teams.prompt(f.session.sessionId, { text: "別の依頼", mode: "prompt" });
		expect(f.registry.get(f.session.sessionId).title).toBe("最初の依頼");
		expect(f.registry.list(f.workspace.id)[0].title).toBe("最初の依頼");
		await expect
			.poll(() => f.registry.get(f.session.sessionId).messages.filter((message) => message.role === "user").length)
			.toBe(2);
		(await running(f.adapters, f.session.sessionId)).finish("二回目");
		await expect.poll(() => f.registry.get(f.session.sessionId).latestRun?.status).toBe("completed");
		const restored = new SessionRegistry({ agentDir: f.root, workspaceFiles: new Directories() });
		await restored.initialize();
		expect(restored.get(f.session.sessionId)).toMatchObject({ title: "最初の依頼", thinkingLevel: "high" });
		expect(restored.list(f.workspace.id)[0].title).toBe("最初の依頼");
		await restored.close();
	});
	it("replaces streamed messages in place and restores the authoritative JSONL after restart", async () => {
		const f = await fixture();
		await f.teams.prompt(f.session.sessionId, { text: "question", mode: "prompt" });
		const adapter = await running(f.adapters, f.session.sessionId);
		const partial = fauxAssistantMessage("partial");
		adapter.emit({ type: "message_start", message: partial });
		adapter.emit({
			type: "message_update",
			message: fauxAssistantMessage("updated"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "updated", partial },
		});
		adapter.emit({ type: "message_end", message: fauxAssistantMessage("final") });
		adapter.manager.appendMessage(fauxAssistantMessage("final"));
		expect(
			f.registry.get(f.session.sessionId).messages.filter((message) => message.role === "assistant"),
		).toHaveLength(1);
		expect(f.registry.get(f.session.sessionId).messages.at(-1)).toMatchObject({
			partial: false,
			content: [{ type: "text", text: "final" }],
		});
		adapter.finish("settled");
		await expect.poll(() => f.registry.get(f.session.sessionId).latestRun?.status).toBe("completed");
		const restored = new SessionRegistry({
			agentDir: f.root,
			workspaceFiles: new Directories(),
			adapterFactory: async (descriptor, manager) => new ControlledAdapter(descriptor, manager),
		});
		await restored.initialize();
		expect(restored.get(f.session.sessionId).messages.at(-1)?.content).toEqual([{ type: "text", text: "settled" }]);
		expect(restored.get(f.session.sessionId).sessionId).toBe(f.session.sessionId);
		await restored.close();
	});
	it("marks active runs interrupted and pending input undelivered without auto-replay", async () => {
		const f = await fixture();
		await f.teams.prompt(f.session.sessionId, { text: "hold", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		await f.teams.prompt(f.session.sessionId, { text: "pending", mode: "followUp" });
		const restoredAdapters: ControlledAdapter[] = [];
		const restored = new SessionRegistry({
			agentDir: f.root,
			workspaceFiles: new Directories(),
			adapterFactory: async (descriptor, manager) => {
				const adapter = new ControlledAdapter(descriptor, manager);
				restoredAdapters.push(adapter);
				return adapter;
			},
		});
		await restored.initialize();
		const teams = new TeamManager(restored);
		await teams.initialize();
		expect(restored.get(f.session.sessionId).latestRun?.status).toBe("interrupted");
		expect(restored.get(f.session.sessionId).pendingInput[0].status).toBe("undelivered");
		expect(restoredAdapters).toHaveLength(0);
		await teams.close();
		await restored.close();
	});
	it("distinguishes an unused session from a deleted materialized conversation", async () => {
		const f = await fixture();
		const empty = await f.registry.create({ workspaceId: f.workspace.id });
		await f.teams.prompt(f.session.sessionId, { text: "materialize", mode: "prompt" });
		(await running(f.adapters, f.session.sessionId)).finish("result");
		await expect.poll(() => f.registry.get(f.session.sessionId).latestRun?.status).toBe("completed");
		const path = f.registry.get(f.session.sessionId).path;
		if (!path) throw new Error("No conversation path");
		await unlink(path);
		const restored = new SessionRegistry({ agentDir: f.root, workspaceFiles: new Directories() });
		await restored.initialize();
		expect(restored.get(empty.sessionId)).toMatchObject({ availability: "ready", materialized: false });
		expect(restored.get(f.session.sessionId).availability).toBe("missing");
		await restored.close();
	});
	it("rejects corrupt state rather than replacing it and observes asynchronous preflight failure", async () => {
		const f = await fixture();
		const statePath = join(f.root, "web-harness", "state.json");
		await writeFile(statePath, "{broken", "utf8");
		const corrupted = new SessionRegistry({ agentDir: f.root, workspaceFiles: new Directories() });
		await expect(corrupted.initialize()).rejects.toThrow();
		expect(await readFile(statePath, "utf8")).toBe("{broken");
		const failing = new SessionRegistry({
			agentDir: join(f.root, "failing"),
			workspaceFiles: new Directories(),
			adapterFactory: async () => {
				throw new Error("preflight failure");
			},
		});
		await failing.initialize();
		const workspace = await failing.addWorkspace(f.workspace.path);
		const session = await failing.create({ workspaceId: workspace.id });
		const teams = new TeamManager(failing);
		await teams.initialize();
		const accepted = await teams.prompt(session.sessionId, { text: "go", mode: "prompt" });
		expect(accepted.disposition).toBe("started");
		await expect.poll(() => failing.get(session.sessionId).latestRun?.status).toBe("failed");
		expect(failing.get(session.sessionId).latestRun?.error).toBe("preflight failure");
		await teams.close();
		await failing.close();
	});
});

describe("pending input queue controls", () => {
	it("edits, deletes, and immediately sends tracked inputs in the live queue", async () => {
		const f = await fixture();
		const sessionId = f.session.sessionId;
		await f.teams.prompt(sessionId, { text: "hold", mode: "prompt" });
		const adapter = await running(f.adapters, sessionId);
		const editing = await f.teams.prompt(sessionId, { text: "before edit", mode: "followUp" });
		const deleting = await f.teams.prompt(sessionId, { text: "remove me", mode: "followUp" });
		const promoting = await f.teams.prompt(sessionId, { text: "send now", mode: "followUp" });
		const editId = editing.inputId;
		const deleteId = deleting.inputId;
		const sendId = promoting.inputId;
		if (!editId || !deleteId || !sendId) throw new Error("Follow-up inputs were not assigned IDs");
		await expect
			.poll(
				() => adapter.hasQueuedInput(editId) && adapter.hasQueuedInput(deleteId) && adapter.hasQueuedInput(sendId),
			)
			.toBe(true);

		await f.teams.updatePendingInput(sessionId, editId, { type: "edit", text: "edited text" });
		await f.teams.updatePendingInput(sessionId, deleteId, { type: "delete" });
		await f.teams.updatePendingInput(sessionId, sendId, { type: "sendNow" });

		expect(f.registry.get(sessionId).activity.queue).toEqual({
			steering: ["send now"],
			followUp: ["edited text"],
		});
		expect(f.registry.get(sessionId).pendingInput).toEqual([
			expect.objectContaining({ inputId: editId, text: "edited text", mode: "followUp", manageable: true }),
			expect.objectContaining({ inputId: sendId, text: "send now", mode: "steer", manageable: true }),
		]);
		expect(adapter.hasQueuedInput(deleteId)).toBe(false);

		adapter.consume("send now");
		await expect
			.poll(() => f.registry.get(sessionId).pendingInput.some((input) => input.inputId === sendId))
			.toBe(false);
		adapter.consume("edited text");
		await expect.poll(() => f.registry.get(sessionId).pendingInput).toHaveLength(0);
		adapter.finish("finished");
		await expect.poll(() => f.registry.get(sessionId).latestRun?.status).toBe("completed");
	});

	it("rejects controls for messages routed between team agents", async () => {
		const f = await fixture();
		await f.teams.prompt(f.session.sessionId, { text: "root work", mode: "prompt" });
		await running(f.adapters, f.session.sessionId);
		const child = (await f.teams.spawn(f.session.sessionId, [{ name: "child", task: "child work" }])).agents[0];
		await running(f.adapters, child.sessionId);
		const sent = await f.teams.send(f.session.sessionId, child.agentId, "internal message");
		if (!sent.inputId) throw new Error("Team message was not assigned an ID");
		await expect.poll(() => f.registry.get(child.sessionId).pendingInput[0]?.manageable).toBe(false);
		await expect(f.teams.updatePendingInput(child.sessionId, sent.inputId, { type: "delete" })).rejects.toMatchObject(
			{ statusCode: 403 },
		);
		await f.teams.stop(f.session.sessionId);
	});
});
