import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	InMemoryModelsStore,
} from "@hasilan-code/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { SessionRegistry } from "../src/server/session-registry.ts";
import { TeamManager } from "../src/server/team-manager.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";
import { swarmStartSchema } from "../src/shared/swarm.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(limit = 2) {
	const root = await mkdtemp(join(tmpdir(), "hasilan-swarm-"));
	const workspacePath = join(root, "workspace");
	await mkdir(workspacePath);
	const faux = fauxProvider({ provider: "swarm-faux", tokenSize: { min: 1, max: 1 } });
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	let teams: TeamManager;
	const held = new Map<string, () => void>();
	const gateParameters = Type.Object({ name: Type.String() });
	const registry = new SessionRegistry({
		agentDir: root,
		modelRuntime,
		workspaceFiles: new WorkspaceFiles(),
		customTools: (descriptor) =>
			[
				teams.createTool(descriptor.sessionId),
				teams.createGoalTool(descriptor.sessionId),
				{
					name: "gate",
					label: "Deterministic work gate",
					description: "Hold work until released or cancelled.",
					parameters: gateParameters,
					execute: async (_id, params, signal) => {
						const gate = Promise.withResolvers<void>();
						held.set(params.name, gate.resolve);
						const abort = () => gate.resolve();
						signal?.addEventListener("abort", abort, { once: true });
						try {
							if (!signal?.aborted) await gate.promise;
						} finally {
							signal?.removeEventListener("abort", abort);
						}
						return {
							content: [{ type: "text", text: `verified ${params.name}` }],
							details: { name: params.name },
						};
					},
				} satisfies ToolDefinition<typeof gateParameters>,
			] as unknown as ToolDefinition[],
	});
	teams = new TeamManager(registry, { getLimits: () => ({ maxConcurrentAgents: limit, maxDepth: 3 }) });
	await registry.initialize();
	await teams.initialize();
	const workspace = await registry.addWorkspace(workspacePath);
	const model = { provider: faux.getModel().provider, id: faux.getModel().id };
	// Deliberately omit team: swarm must enable it even on an already-loaded adapter.
	const session = await registry.create({
		workspaceId: workspace.id,
		model,
		tools: ["gate"],
		systemPrompt: "Preserve this existing instruction.",
	});
	await teams.ensureRoot(session.sessionId);
	const requests: string[] = [];
	const respond: FauxResponseFactory = (context) => {
		const system = getCurrentSystemPrompt(context.messages);
		const child = system.includes("Agent role: alpha")
			? "alpha"
			: system.includes("Agent role: beta")
				? "beta"
				: undefined;
		if (child) {
			if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "gate"))
				return fauxAssistantMessage(fauxToolCall("gate", { name: child }), { stopReason: "toolUse" });
			return fauxAssistantMessage(`${child} result`);
		}
		const request = JSON.stringify(context.messages);
		requests.push(request);
		if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "team"))
			return fauxAssistantMessage(
				fauxToolCall("team", {
					action: "workflow",
					tasks: [
						{
							name: "alpha",
							responsibility: "Own implementation of the first subsystem",
							task: "Implement the first independent slice",
							tools: ["gate"],
						},
						{
							name: "beta",
							responsibility: "Own independent verification of the second subsystem",
							task: "Review the second independent slice",
							tools: ["gate"],
						},
					],
					timeoutMs: 10000,
				}),
				{ stopReason: "toolUse" },
			);
		const rootAgent = registry.state.agents.find((agent) => agent.sessionId === session.sessionId)!;
		const rootRuns = registry.state.runs.filter((run) => run.agentId === rootAgent.agentId);
		const swarm = registry.descriptor(session.sessionId).swarm;
		const initial = rootRuns.findIndex((run) => run.runId === swarm?.rootRunId);
		if (rootRuns.length - initial > 1 && swarm?.status === "active")
			return fauxAssistantMessage(
				fauxToolCall("team", {
					action: "swarm",
					op: "complete",
					reason: "Verified alpha result and beta result from actual children",
				}),
				{ stopReason: "toolUse" },
			);
		return fauxAssistantMessage("Integrated alpha result and beta result");
	};
	function script() {
		faux.setResponses(Array.from({ length: 64 }, () => respond));
	}
	cleanups.push(async () => {
		await teams.close();
		await registry.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, faux, modelRuntime, model, registry, teams, workspace, session, held, requests, script };
}

async function idle(registry: SessionRegistry, sessionId: string) {
	await expect.poll(() => registry.get(sessionId).currentRun, { timeout: 10000 }).toBeUndefined();
}

describe("Hyakki-Yako real SDK orchestration", () => {
	it("decomposes through the actual team tool on a loaded restricted root and integrates sourced results at concurrency one", async () => {
		const f = await fixture(1);
		f.faux.setResponses([fauxAssistantMessage("Ordinary warmup")]);
		await f.teams.prompt(f.session.sessionId, { text: "Warmup", mode: "prompt" });
		await idle(f.registry, f.session.sessionId);
		expect(f.registry.activeTools(f.session.sessionId)).not.toContain("team");
		f.script();
		const admission = await f.teams.startSwarm(f.session.sessionId, {
			objective: "  Integrate two independent slices  ",
		});
		expect(admission.swarm.objective).toBe("Integrate two independent slices");
		expect(admission.swarm.rootRunId).toBe(admission.runId);
		await expect.poll(() => f.held.has("alpha"), { timeout: 10000 }).toBe(true);
		expect(f.held.has("beta")).toBe(false);
		expect(f.registry.get(f.session.sessionId).currentRun?.status).toBe("waiting");
		expect(f.registry.activeTools(f.session.sessionId)).toEqual(["team"]);
		expect(f.registry.state.runs.filter((run) => run.status === "running")).toHaveLength(1);
		f.held.get("alpha")?.();
		await expect.poll(() => f.held.has("beta"), { timeout: 10000 }).toBe(true);
		f.held.get("beta")?.();
		await expect.poll(() => f.registry.get(f.session.sessionId).swarm?.status).toBe("complete");
		await idle(f.registry, f.session.sessionId);
		const detail = f.registry.get(f.session.sessionId);
		expect(detail.latestRun).toMatchObject({
			status: "completed",
			result: "Integrated alpha result and beta result",
		});
		expect(detail.toolCalls.find((call) => call.name === "team")).toMatchObject({
			status: "success",
			input: { action: "workflow" },
		});
		expect(detail.messages.filter((message) => message.contextInjection)).toHaveLength(2);
		expect(f.requests.at(-1)).toContain("alpha result");
		expect(f.requests.at(-1)).toContain("beta result");
		expect(f.requests[0]).toContain("Preserve this existing instruction.");
		expect(detail.goal).toBeUndefined();
		expect(f.registry.state.runs).toHaveLength(5);
		expect(f.registry.state.runs.filter((run) => run.agentId === detail.latestRun?.agentId)).toHaveLength(3);
		expect(detail.swarm?.status).toBe("complete");
	});

	it("runs independent children concurrently within the existing permits and cancels the entire waiting subtree", async () => {
		const f = await fixture(2);
		f.script();
		await f.teams.startSwarm(f.session.sessionId, { objective: "Parallel work" });
		await expect.poll(() => f.held.size, { timeout: 10000 }).toBe(2);
		expect(f.registry.state.runs.filter((run) => run.status === "running")).toHaveLength(2);
		expect(f.registry.get(f.session.sessionId).currentRun?.status).toBe("waiting");
		await expect(f.teams.startSwarm(f.session.sessionId, { objective: "Conflicting work" })).rejects.toMatchObject({
			statusCode: 409,
		});
		await f.teams.stop(f.session.sessionId);
		expect(f.registry.state.runs.map((run) => run.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
		expect(f.registry.state.pendingInput).toHaveLength(0);
		expect(f.registry.get(f.session.sessionId).swarm?.objective).toBe("Parallel work");
		expect(f.registry.get(f.session.sessionId).swarm?.status).toBe("paused");
		const calls = f.faux.state.callCount;
		f.faux.setResponses([fauxAssistantMessage("Ordinary chat after stop")]);
		await f.teams.prompt(f.session.sessionId, { text: "Chat normally", mode: "prompt" });
		await idle(f.registry, f.session.sessionId);
		expect(f.faux.state.callCount).toBe(calls + 1);
		expect(f.registry.get(f.session.sessionId).swarm?.status).toBe("paused");
	});

	it("refuses an idle root with a busy child and integrates late results despite a historical paused Goal", async () => {
		const f = await fixture(2);
		const now = new Date().toISOString();
		f.registry.descriptor(f.session.sessionId).goal = {
			id: "paused-goal",
			objective: "Historical objective",
			status: "paused",
			createdAt: now,
			updatedAt: now,
		};
		const respond: FauxResponseFactory = (context) => {
			if (getCurrentSystemPrompt(context.messages).includes("Agent role: alpha")) {
				if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "gate"))
					return fauxAssistantMessage(fauxToolCall("gate", { name: "alpha" }), { stopReason: "toolUse" });
				return fauxAssistantMessage("alpha result");
			}
			if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "team"))
				return fauxAssistantMessage(
					fauxToolCall("team", {
						action: "spawn",
						tasks: [
							{
								name: "alpha",
								responsibility: "Own implementation and verification",
								task: "Independent work",
								tools: ["gate"],
							},
						],
					}),
					{ stopReason: "toolUse" },
				);
			if (
				JSON.stringify(context.messages).includes("alpha result") &&
				f.registry.descriptor(f.session.sessionId).swarm?.status === "active"
			)
				return fauxAssistantMessage(
					fauxToolCall("team", { action: "swarm", op: "complete", reason: "Integrated actual alpha result" }),
					{ stopReason: "toolUse" },
				);
			return fauxAssistantMessage(
				JSON.stringify(context.messages).includes("alpha result")
					? "Integrated late alpha result"
					: "Awaiting the actual child result",
			);
		};
		f.faux.setResponses(Array.from({ length: 12 }, () => respond));
		await f.teams.startSwarm(f.session.sessionId, { objective: "Integrate late results" });
		await expect.poll(() => f.held.has("alpha"), { timeout: 10000 }).toBe(true);
		await idle(f.registry, f.session.sessionId);
		await expect(f.teams.startSwarm(f.session.sessionId, { objective: "Too early" })).rejects.toMatchObject({
			statusCode: 409,
		});
		f.held.get("alpha")?.();
		await expect
			.poll(() => f.registry.get(f.session.sessionId).latestRun?.result, { timeout: 10000 })
			.toBe("Integrated late alpha result");
		await idle(f.registry, f.session.sessionId);
		expect(f.registry.state.runs).toHaveLength(3);
		expect(f.registry.get(f.session.sessionId).goal?.status).toBe("paused");
		expect(f.registry.get(f.session.sessionId).messages.filter((message) => message.contextInjection)).toHaveLength(
			1,
		);
	});

	it("retains swarm identity on restart and marks all in-flight work interrupted without replaying a model call", async () => {
		const f = await fixture(2);
		f.script();
		const { swarm } = await f.teams.startSwarm(f.session.sessionId, { objective: "Restart without replay" });
		await expect.poll(() => f.held.size, { timeout: 10000 }).toBe(2);
		await f.registry.persist();
		const calls = f.faux.state.callCount;
		const restored = new SessionRegistry({
			agentDir: f.root,
			workspaceFiles: new WorkspaceFiles(),
			modelRuntime: f.modelRuntime,
		});
		await restored.initialize();
		const restoredTeams = new TeamManager(restored);
		await restoredTeams.initialize();
		expect(restored.get(f.session.sessionId).swarm).toMatchObject({ id: swarm.id, status: "paused" });
		expect(
			restored.list(f.workspace.id).find((session) => session.sessionId === f.session.sessionId)?.swarm?.status,
		).toBe("paused");
		expect(restored.state.runs.map((run) => run.status)).toEqual(["interrupted", "interrupted", "interrupted"]);
		expect(f.faux.state.callCount).toBe(calls);
		await restoredTeams.close();
		await restored.close();
	});

	it("rejects invalid objectives, child roots, active Goal, missing models and missing auth before admitting swarm work", async () => {
		const f = await fixture();
		expect(Check(swarmStartSchema, { objective: "work", extra: true })).toBe(false);
		expect(Check(swarmStartSchema, { objective: "x".repeat(65537) })).toBe(false);
		await expect(f.teams.startSwarm(f.session.sessionId, { objective: "  " })).rejects.toMatchObject({
			statusCode: 400,
		});
		const missing = await f.registry.create({ workspaceId: f.workspace.id });
		await expect(f.teams.startSwarm(missing.sessionId, { objective: "No model" })).rejects.toMatchObject({
			statusCode: 400,
		});
		expect(f.registry.get(missing.sessionId).swarm).toBeUndefined();
		const noAuthProvider = fauxProvider({ provider: "swarm-no-auth" });
		f.modelRuntime.registerNativeProvider({
			...noAuthProvider.provider,
			auth: { apiKey: { name: "Missing credential", resolve: async () => undefined } },
		});
		const noAuth = await f.registry.create({
			workspaceId: f.workspace.id,
			model: { provider: noAuthProvider.getModel().provider, id: noAuthProvider.getModel().id },
		});
		await expect(f.teams.startSwarm(noAuth.sessionId, { objective: "No auth" })).rejects.toMatchObject({
			statusCode: 400,
		});
		expect(f.registry.get(noAuth.sessionId).swarm).toBeUndefined();
		const now = new Date().toISOString();
		f.registry.descriptor(f.session.sessionId).goal = {
			id: "existing-goal",
			objective: "Existing work",
			status: "active",
			createdAt: now,
			updatedAt: now,
		};
		await expect(f.teams.startSwarm(f.session.sessionId, { objective: "Conflict" })).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(f.registry.get(f.session.sessionId).swarm).toBeUndefined();
		delete f.registry.descriptor(f.session.sessionId).goal;
		f.script();
		await f.teams.startSwarm(f.session.sessionId, { objective: "Root" });
		await expect.poll(() => f.held.size, { timeout: 10000 }).toBe(2);
		const child = f.registry.state.sessions.find((session) => session.parentSessionId === f.session.sessionId)!;
		await expect(
			f.teams.startSwarm(child.sessionId, { objective: "Child cannot coordinate a new swarm" }),
		).rejects.toMatchObject({ statusCode: 409 });
	});

	it("continues across multiple root turns only until explicit completion and preserves ordinary chat", async () => {
		const f = await fixture(1);
		f.script();
		await f.teams.startSwarm(f.session.sessionId, { objective: "Finish all delegated work" });
		await expect.poll(() => f.held.has("alpha")).toBe(true);
		f.held.get("alpha")?.();
		await expect.poll(() => f.held.has("beta")).toBe(true);
		f.held.get("beta")?.();
		await expect.poll(() => f.registry.get(f.session.sessionId).swarm?.status).toBe("complete");
		await idle(f.registry, f.session.sessionId);
		const detail = f.registry.get(f.session.sessionId);
		expect(f.registry.state.runs.filter((run) => run.agentId === detail.latestRun?.agentId)).toHaveLength(2);
		expect(detail.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(
			detail.toolCalls.findLast((call) => {
				const input = call.input;
				return input !== null && typeof input === "object" && "action" in input && input.action === "swarm";
			}),
		).toMatchObject({
			status: "success",
			input: { action: "swarm", op: "complete" },
		});
		expect(detail.swarm).not.toHaveProperty("tokenBudget");
		expect(detail.swarm).not.toHaveProperty("tokensUsed");
		const calls = f.faux.state.callCount;
		f.faux.setResponses([fauxAssistantMessage("Normal parent conversation")]);
		await f.teams.prompt(f.session.sessionId, { text: "New unrelated question", mode: "prompt" });
		await idle(f.registry, f.session.sessionId);
		expect(f.faux.state.callCount).toBe(calls + 1);
		expect(f.registry.get(f.session.sessionId).swarm?.status).toBe("complete");
	});

	it.each(["error", "aborted", "length"] as const)(
		"pauses after model %s without retry or continuation",
		async (stopReason) => {
			const f = await fixture();
			f.faux.setResponses([
				fauxAssistantMessage("Interrupted", {
					stopReason,
					errorMessage: stopReason === "error" ? "overloaded_error" : undefined,
				}),
			]);
			await f.teams.startSwarm(f.session.sessionId, { objective: "Do not retry model failures" });
			await expect.poll(() => f.registry.get(f.session.sessionId).swarm?.status).toBe("paused");
			await idle(f.registry, f.session.sessionId);
			expect(f.faux.state.callCount).toBe(1);
			expect(f.registry.state.runs).toHaveLength(1);
		},
	);

	it("blocks explicitly on child failure without manufacturing successful completion", async () => {
		const f = await fixture(1);
		const respond: FauxResponseFactory = (context) => {
			if (getCurrentSystemPrompt(context.messages).includes("Agent role: failure"))
				return fauxAssistantMessage("Child failed", { stopReason: "error", errorMessage: "Missing prerequisite" });
			if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "team"))
				return fauxAssistantMessage(
					fauxToolCall("team", {
						action: "workflow",
						tasks: [
							{
								name: "failure",
								responsibility: "Own implementation and verification",
								task: "Perform the actual implementation",
								tools: ["gate"],
							},
						],
					}),
					{ stopReason: "toolUse" },
				);
			const attemptedCompletion = f.registry.get(f.session.sessionId).toolCalls.some((call) => {
				const input = call.input;
				return input !== null && typeof input === "object" && "op" in input && input.op === "complete";
			});
			if (!attemptedCompletion)
				return fauxAssistantMessage(
					fauxToolCall("team", { action: "swarm", op: "complete", reason: "Cannot claim failed work" }),
					{ stopReason: "toolUse" },
				);
			if (f.registry.descriptor(f.session.sessionId).swarm?.status === "active")
				return fauxAssistantMessage(
					fauxToolCall("team", { action: "swarm", op: "block", reason: "Child failed: Missing prerequisite" }),
					{ stopReason: "toolUse" },
				);
			return fauxAssistantMessage("Need the missing prerequisite");
		};
		f.faux.setResponses(Array.from({ length: 12 }, () => respond));
		await f.teams.startSwarm(f.session.sessionId, { objective: "Respect real child failure" });
		await idle(f.registry, f.session.sessionId);
		expect(f.registry.get(f.session.sessionId).swarm).toMatchObject({
			status: "blocked",
			reason: "Child failed: Missing prerequisite",
		});
		expect(f.registry.state.runs.map((run) => run.status)).toEqual(["completed", "failed"]);
		expect(f.registry.get(f.session.sessionId).toolCalls).toContainEqual(
			expect.objectContaining({
				status: "error",
				input: { action: "swarm", op: "complete", reason: "Cannot claim failed work" },
			}),
		);
	});

	it("refuses completion without real delegated work and pauses prose-only orchestration", async () => {
		const f = await fixture();
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("team", { action: "swarm", op: "complete", reason: "Imaginary work" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("No real work"),
		]);
		await f.teams.startSwarm(f.session.sessionId, { objective: "Require real delegation" });
		await expect.poll(() => f.registry.get(f.session.sessionId).swarm?.status).toBe("paused");
		await idle(f.registry, f.session.sessionId);
		expect(f.registry.get(f.session.sessionId).toolCalls[0]).toMatchObject({ status: "error" });
		expect(f.registry.get(f.session.sessionId).swarm?.reason).toContain("no tool progress");
		expect(f.faux.state.callCount).toBe(2);
	});

	it("pauses repeated inspection rather than spinning through autonomous root turns", async () => {
		const f = await fixture();
		const inspect = fauxAssistantMessage(fauxToolCall("team", { action: "profiles" }), { stopReason: "toolUse" });
		f.faux.setResponses([
			inspect,
			fauxAssistantMessage("Inspected profiles"),
			fauxAssistantMessage(fauxToolCall("team", { action: "profiles" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Inspected the same profiles"),
		]);
		await f.teams.startSwarm(f.session.sessionId, { objective: "Avoid no-work loops" });
		await expect.poll(() => f.registry.get(f.session.sessionId).swarm?.status).toBe("paused");
		await idle(f.registry, f.session.sessionId);
		expect(f.registry.get(f.session.sessionId).swarm?.reason).toContain("repeated");
		expect(f.registry.state.runs).toHaveLength(2);
		expect(f.faux.state.callCount).toBe(4);
	});

	it("rejects implementation tools on the manager", async () => {
		const f = await fixture();
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("gate", { name: "forbidden-root-work" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("team", { action: "swarm", op: "block", reason: "Delegate implementation instead" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Implementation belongs to a child"),
		]);
		await f.teams.startSwarm(f.session.sessionId, { objective: "Coordinate, do not implement" });
		await idle(f.registry, f.session.sessionId);
		expect(f.held.size).toBe(0);
		expect(f.registry.get(f.session.sessionId).swarm?.status).toBe("blocked");
	});

	it("lets a user stop win before an autonomous continuation is admitted", async () => {
		const f = await fixture();
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("team", { action: "profiles" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Ready for the next orchestration turn"),
		]);
		let stopping: Promise<{ status: "cancelled" }> | undefined;
		const unsubscribe = f.registry.subscribe((event) => {
			if (
				event.sessionId === f.session.sessionId &&
				f.registry.get(f.session.sessionId).latestRun?.status === "completed" &&
				f.registry.descriptor(f.session.sessionId).swarm?.status === "active" &&
				!stopping
			)
				stopping = f.teams.stop(f.session.sessionId);
		});
		await f.teams.startSwarm(f.session.sessionId, { objective: "Allow user interruption between rounds" });
		await expect.poll(() => f.registry.get(f.session.sessionId).swarm?.status).toBe("paused");
		await stopping;
		unsubscribe();
		expect(f.registry.state.runs).toHaveLength(1);
		expect(f.faux.state.callCount).toBe(2);
	});

	it("holds late child results after blocking and refuses completion while the child is still active", async () => {
		const f = await fixture(2);
		const respond: FauxResponseFactory = (context) => {
			if (getCurrentSystemPrompt(context.messages).includes("Agent role: alpha")) {
				if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "gate"))
					return fauxAssistantMessage(fauxToolCall("gate", { name: "alpha" }), { stopReason: "toolUse" });
				return fauxAssistantMessage("Late alpha result");
			}
			const calls = f.registry.get(f.session.sessionId).toolCalls;
			if (calls.length === 0)
				return fauxAssistantMessage(
					fauxToolCall("team", {
						action: "spawn",
						tasks: [
							{
								name: "alpha",
								responsibility: "Own implementation and verification",
								task: "Actual implementation",
								tools: ["gate"],
							},
						],
					}),
					{ stopReason: "toolUse" },
				);
			if (calls.length === 1)
				return fauxAssistantMessage(
					fauxToolCall("team", { action: "swarm", op: "complete", reason: "Child still running" }),
					{ stopReason: "toolUse" },
				);
			if (f.registry.descriptor(f.session.sessionId).swarm?.status === "active")
				return fauxAssistantMessage(
					fauxToolCall("team", { action: "swarm", op: "block", reason: "External decision required" }),
					{ stopReason: "toolUse" },
				);
			return fauxAssistantMessage("Waiting for the user's decision");
		};
		f.faux.setResponses(Array.from({ length: 16 }, () => respond));
		await f.teams.startSwarm(f.session.sessionId, { objective: "Do not wake blocked orchestration" });
		await expect.poll(() => f.held.has("alpha")).toBe(true);
		await idle(f.registry, f.session.sessionId);
		expect(f.registry.get(f.session.sessionId).swarm?.status).toBe("blocked");
		expect(f.registry.get(f.session.sessionId).toolCalls[1]?.status).toBe("error");
		const root = f.registry.get(f.session.sessionId).latestRun;
		f.held.get("alpha")?.();
		const child = f.registry.state.sessions.find((session) => session.parentSessionId === f.session.sessionId)!;
		await idle(f.registry, child.sessionId);
		expect(f.registry.get(f.session.sessionId).latestRun?.runId).toBe(root?.runId);
		expect(f.registry.get(f.session.sessionId).swarm?.status).toBe("blocked");
		expect(f.registry.get(f.session.sessionId).pendingInput).toContainEqual(
			expect.objectContaining({
				completionRunId: f.registry.get(child.sessionId).latestRun?.runId,
				status: "undelivered",
			}),
		);
	});

	it("migrates saved pre-autonomy swarms without losing history or starting a model call", async () => {
		const f = await fixture();
		f.faux.setResponses([fauxAssistantMessage("Saved conversation result")]);
		await f.teams.prompt(f.session.sessionId, { text: "Original objective", mode: "prompt" });
		await idle(f.registry, f.session.sessionId);
		const statePath = join(f.root, "web-harness", "state.json");
		const state = JSON.parse(await readFile(statePath, "utf8"));
		const legacy = {
			id: "saved-swarm",
			objective: "Original objective",
			createdAt: "2026-10-15T00:00:00.000Z",
			rootRunId: f.registry.get(f.session.sessionId).latestRun!.runId,
		};
		state.sessions[0].swarm = legacy;
		await writeFile(statePath, JSON.stringify(state));
		const history = await readFile(f.session.path!, "utf8");
		const calls = f.faux.state.callCount;
		const restored = new SessionRegistry({ agentDir: f.root, workspaceFiles: new WorkspaceFiles() });
		await restored.initialize();
		const restoredTeams = new TeamManager(restored);
		await restoredTeams.initialize();
		expect(restored.get(f.session.sessionId).swarm).toMatchObject({ ...legacy, status: "paused" });
		expect(restored.get(f.session.sessionId).messages).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: expect.arrayContaining([
					expect.objectContaining({ type: "text", text: "Saved conversation result" }),
				]),
			}),
		);
		expect(restored.state.runs).toEqual(state.runs);
		expect(f.faux.state.callCount).toBe(calls);
		expect(await readFile(f.session.path!, "utf8")).toBe(history);
		const saved = JSON.parse(await readFile(statePath, "utf8"));
		expect(saved.sessions[0].swarm).toMatchObject({ ...legacy, status: "paused", updatedAt: expect.any(String) });
		await restoredTeams.close();
		await restored.close();
	});

	it.each([
		{ status: "active" },
		{ updatedAt: "2026-10-15T00:00:00.000Z" },
		{ status: "invalid", updatedAt: "2026-10-15T00:00:00.000Z" },
	])("rejects incomplete or invalid lifecycle metadata without overwriting state: %j", async (lifecycle) => {
		const f = await fixture();
		const statePath = join(f.root, "web-harness", "state.json");
		const state = JSON.parse(await readFile(statePath, "utf8"));
		state.sessions[0].swarm = {
			id: "saved-swarm",
			objective: "Saved objective",
			createdAt: "2026-10-15T00:00:00.000Z",
			rootRunId: "saved-run",
			...lifecycle,
		};
		const bytes = JSON.stringify(state);
		await writeFile(statePath, bytes);
		const restored = new SessionRegistry({ agentDir: f.root, workspaceFiles: new WorkspaceFiles() });
		await expect(restored.initialize()).rejects.toThrow("Invalid session swarm state");
		expect(await readFile(statePath, "utf8")).toBe(bytes);
	});

	it("rejects corrupt persisted mode metadata without overwriting state", async () => {
		const f = await fixture();
		const statePath = join(f.root, "web-harness", "state.json");
		const state = JSON.parse(await readFile(statePath, "utf8")) as { sessions: { swarm?: unknown }[] };
		state.sessions[0]!.swarm = { id: "broken", objective: "", createdAt: "now", rootRunId: "missing" };
		const bytes = JSON.stringify(state);
		await writeFile(statePath, bytes);
		const restored = new SessionRegistry({ agentDir: f.root, workspaceFiles: new WorkspaceFiles() });
		await expect(restored.initialize()).rejects.toThrow("Invalid session swarm state");
		expect(await readFile(statePath, "utf8")).toBe(bytes);
	});
});
