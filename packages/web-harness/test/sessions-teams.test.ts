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
class ControlledAdapter implements ExecutionAdapter {
	readonly descriptor: SessionDescriptor;
	readonly manager: SessionManager;
	readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	readonly inputs: string[] = [];
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
	async steer(text: string) {
		this.inputs.push(text);
	}
	async followUp(text: string) {
		this.inputs.push(text);
	}
	consume(text: string) {
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
	const teams = new TeamManager(registry, { getLimits: () => ({ maxConcurrentAgents: limit, maxDepth: 3 }) });
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
});

describe("persistent conversation and projection boundaries", () => {
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
