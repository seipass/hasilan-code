import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxThinking,
	fauxToolCall,
	getCurrentSystemPrompt,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { createHttpHost, HttpError, readJson, sendJson } from "../src/server/http-host.ts";
import { HarnessError, SessionRegistry } from "../src/server/session-registry.ts";
import { TeamManager } from "../src/server/team-manager.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";
import { goalActionSchema } from "../src/shared/goals.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(responses: FauxResponseStep[] = [], limit = 4) {
	const root = await mkdtemp(join(tmpdir(), "hasilan-goal-"));
	const workspacePath = join(root, "workspace");
	await mkdir(workspacePath);
	const faux = fauxProvider({ provider: "goal-faux", tokenSize: { min: 1, max: 1 } });
	faux.setResponses(responses);
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	let teams: TeamManager;
	const held = new Map<number, { release: () => void; done: Promise<void> }>();
	const started = new Set<number>();
	const abortGoals: string[] = [];
	const progressParameters = Type.Object({ step: Type.Integer(), hold: Type.Optional(Type.Boolean()) });
	const registry = new SessionRegistry({
		agentDir: root,
		modelRuntime,
		workspaceFiles: new WorkspaceFiles(),
		customTools: (descriptor) =>
			[
				teams.createTool(descriptor.sessionId),
				teams.createGoalTool(descriptor.sessionId),
				{
					name: "progress",
					label: "Deterministic progress",
					description: "Record deterministic progress; optionally wait until released or cancelled.",
					parameters: progressParameters,
					execute: async (_id, params, signal) => {
						if (params.hold) {
							const gate = Promise.withResolvers<void>();
							held.set(params.step, { release: gate.resolve, done: gate.promise });
							started.add(params.step);
							const abort = () => gate.resolve();
							signal?.addEventListener("abort", abort, { once: true });
							try {
								if (!signal?.aborted) await gate.promise;
								if (signal?.aborted) {
									const state = JSON.parse(readFileSync(join(root, "web-harness", "state.json"), "utf8")) as {
										sessions: { goal?: { status: string } }[];
									};
									abortGoals.push(state.sessions.find((session) => session.goal)?.goal?.status ?? "none");
								}
							} finally {
								signal?.removeEventListener("abort", abort);
							}
						}
						return { content: [{ type: "text", text: `step ${params.step}` }], details: { step: params.step } };
					},
				} satisfies ToolDefinition<typeof progressParameters>,
			] as unknown as ToolDefinition[],
	});
	teams = new TeamManager(registry, { getLimits: () => ({ maxConcurrentAgents: limit, maxDepth: 3 }) });
	await registry.initialize();
	await teams.initialize();
	const workspace = await registry.addWorkspace(workspacePath);
	const model = { provider: faux.getModel().provider, id: faux.getModel().id };
	const session = await registry.create({
		workspaceId: workspace.id,
		model,
		tools: ["goal", "progress", "team"],
		systemPrompt: "Preserve this custom SYSTEM instruction.",
	});
	await teams.ensureRoot(session.sessionId);
	cleanups.push(async () => {
		await teams.close();
		await registry.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, workspace, session, registry, teams, faux, held, started, abortGoals, modelRuntime, model };
}

const complete = () =>
	fauxAssistantMessage(fauxToolCall("goal", { op: "complete", reason: "Objective verified" }), {
		stopReason: "toolUse",
	});
const progress = (step: number, hold = false) =>
	fauxAssistantMessage(fauxToolCall("progress", { step, hold }), { stopReason: "toolUse" });

async function idle(registry: SessionRegistry, sessionId: string) {
	await expect.poll(() => registry.get(sessionId).currentRun, { timeout: 10000 }).toBeUndefined();
}

describe("Goal mode production SDK boundaries", () => {
	it("leaves ordinary sessions at one successful run", async () => {
		const f = await fixture([fauxAssistantMessage("ordinary response")]);
		await f.teams.prompt(f.session.sessionId, { text: "ordinary request", mode: "prompt" });
		await idle(f.registry, f.session.sessionId);
		expect(f.faux.state.callCount).toBe(1);
		expect(f.registry.get(f.session.sessionId).goal).toBeUndefined();
	});

	it("performs two autonomous rounds and ends only through the production goal tool", async () => {
		const requests: string[] = [];
		const f = await fixture([
			(context) => {
				requests.push(JSON.stringify(context.messages));
				expect(getCurrentSystemPrompt(context.messages)).toContain("Preserve this custom SYSTEM instruction.");
				return fauxAssistantMessage("The objective is complete (prose is not authority)");
			},
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return progress(1);
			},
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("First autonomous round made progress");
			},
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return complete();
			},
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("Final wrap-up");
			},
		]);
		const goal = await f.teams.goal(f.session.sessionId, { op: "create", objective: "Verify the objective" });
		await expect.poll(() => f.registry.get(f.session.sessionId).goal?.status, { timeout: 10000 }).toBe("complete");
		await idle(f.registry, f.session.sessionId);
		const snapshot = f.registry.get(f.session.sessionId);
		expect(f.registry.state.runs).toHaveLength(3);
		expect(f.faux.state.callCount).toBe(5);
		expect(snapshot.goal).toMatchObject({ id: goal?.id, reason: "Objective verified", status: "complete" });
		expect(snapshot.toolCalls.find((tool) => tool.name === "goal")).toMatchObject({
			status: "success",
			input: { op: "complete", reason: "Objective verified" },
		});
		expect(
			requests.every((request) => request.includes("Goal mode: ") && request.includes(goal?.id ?? "missing")),
		).toBe(true);
		expect(requests.at(-1)).toContain('\\"status\\":\\"complete\\"');
		expect(snapshot.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(snapshot.messages.some((message) => JSON.stringify(message).includes("harness-goal-continuation"))).toBe(
			false,
		);
		const restored = new SessionRegistry({ agentDir: f.root, workspaceFiles: new WorkspaceFiles() });
		await restored.initialize();
		expect(restored.get(f.session.sessionId).goal).toEqual(snapshot.goal);
		expect(
			restored
				.get(f.session.sessionId)
				.messages.some((message) => JSON.stringify(message).includes("harness-goal-continuation")),
		).toBe(false);
		await restored.close();
	});

	it("pauses goals after an autonomous round without tool progress", async () => {
		const f = await fixture([fauxAssistantMessage("First prose"), fauxAssistantMessage("More prose")]);
		await f.teams.goal(f.session.sessionId, { op: "create", objective: "Keep working" });
		await expect.poll(() => f.registry.get(f.session.sessionId).goal?.status).toBe("paused");
		await idle(f.registry, f.session.sessionId);
		expect(f.registry.get(f.session.sessionId).goal?.reason).toContain("no tool progress");
		expect(f.faux.state.callCount).toBe(2);
		expect(f.registry.state.runs).toHaveLength(2);
	});

	it("pauses identical autonomous tool-call/result rounds", async () => {
		const f = await fixture([
			fauxAssistantMessage("Start"),
			progress(1),
			fauxAssistantMessage("Round one"),
			progress(1),
			fauxAssistantMessage("Round two"),
		]);
		await f.teams.goal(f.session.sessionId, { op: "create", objective: "Avoid repeating work" });
		await expect.poll(() => f.registry.get(f.session.sessionId).goal?.status).toBe("paused");
		await idle(f.registry, f.session.sessionId);
		expect(f.registry.get(f.session.sessionId).goal?.reason).toContain("repeated");
		expect(f.faux.state.callCount).toBe(5);
	});

	it("continues across provider output and reasoning until explicitly completed without Goal usage accounting", async () => {
		const requests: string[] = [];
		const f = await fixture([
			fauxAssistantMessage([fauxThinking("reasoning tokens"), { type: "text", text: "output tokens" }]),
			progress(1),
			fauxAssistantMessage("Continue pursuing the objective"),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return complete();
			},
			fauxAssistantMessage("Wrap-up"),
		]);
		await f.teams.goal(f.session.sessionId, { op: "create", objective: "Continue working" });
		await expect.poll(() => f.registry.get(f.session.sessionId).goal?.status).toBe("complete");
		await idle(f.registry, f.session.sessionId);
		const goal = f.registry.get(f.session.sessionId).goal;
		expect(goal).not.toHaveProperty("tokensUsed");
		expect(goal).not.toHaveProperty("tokenBudget");
		expect(f.faux.state.callCount).toBe(5);
		expect(f.registry.state.runs).toHaveLength(3);
		expect(requests[0]).not.toContain("budget-limited");
		expect(requests[0]).not.toContain("tokenBudget");
		expect(requests[0]).not.toContain("tokensUsed");
	});

	it.each(["error", "aborted", "length"] as const)("pauses on model %s without retrying", async (stopReason) => {
		const f = await fixture([
			fauxAssistantMessage("interrupted", {
				stopReason,
				errorMessage: stopReason === "error" ? "overloaded_error" : undefined,
			}),
		]);
		await f.teams.goal(f.session.sessionId, { op: "create", objective: "Do not retry failures" });
		await expect.poll(() => f.registry.get(f.session.sessionId).goal?.status).toBe("paused");
		await idle(f.registry, f.session.sessionId);
		expect(f.faux.state.callCount).toBe(1);
	});

	it("blocks with a tool reason and resumes only by user command", async () => {
		const f = await fixture([
			fauxAssistantMessage(fauxToolCall("goal", { op: "block", reason: "Need repository access" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Please grant access"),
		]);
		await f.teams.goal(f.session.sessionId, { op: "create", objective: "Read repository" });
		await idle(f.registry, f.session.sessionId);
		expect(f.registry.get(f.session.sessionId).goal).toMatchObject({
			status: "blocked",
			reason: "Need repository access",
		});
		f.faux.setResponses([complete(), fauxAssistantMessage("Rejected completion outside active mode")]);
		await f.teams.prompt(f.session.sessionId, { text: "Try to complete without resuming", mode: "prompt" });
		await idle(f.registry, f.session.sessionId);
		expect(f.registry.get(f.session.sessionId).toolCalls.findLast((tool) => tool.name === "goal")).toMatchObject({
			status: "error",
		});
		expect(f.registry.get(f.session.sessionId).goal?.status).toBe("blocked");
		f.faux.setResponses([complete(), fauxAssistantMessage("Access granted")]);
		await f.teams.goal(f.session.sessionId, { op: "resume" });
		await expect.poll(() => f.registry.get(f.session.sessionId).goal?.status).toBe("complete");
		await idle(f.registry, f.session.sessionId);
	});

	it("retains limit-one team permits and sourced child results before finishing the goal", async () => {
		const requests: string[] = [];
		const f = await fixture(
			[
				progress(1, true),
				progress(2, true),
				fauxAssistantMessage("First child result"),
				progress(3, true),
				fauxAssistantMessage("Second child result"),
				(context) => {
					requests.push(JSON.stringify(context.messages));
					return complete();
				},
				fauxAssistantMessage("Integrated both child results"),
			],
			1,
		);
		await f.teams.goal(f.session.sessionId, { op: "create", objective: "Integrate child results" });
		await expect.poll(() => f.started.has(1)).toBe(true);
		const children = (
			await f.teams.spawn(f.session.sessionId, [
				{ name: "first", task: "First child", tools: ["progress"] },
				{ name: "second", task: "Second child", tools: ["progress"] },
			])
		).agents;
		expect(children.map((child) => child.status)).toEqual(["queued", "queued"]);
		const waiting = f.teams.wait(
			f.session.sessionId,
			children.map((child) => child.agentId),
			10000,
		);
		await expect.poll(() => f.started.has(2)).toBe(true);
		expect(f.registry.get(f.session.sessionId).currentRun?.status).toBe("waiting");
		f.held.get(2)?.release();
		await expect.poll(() => f.started.has(3)).toBe(true);
		f.held.get(3)?.release();
		expect((await waiting).runs.map((run) => run.status)).toEqual(["completed", "completed"]);
		expect(f.registry.get(f.session.sessionId).currentRun?.status).toBe("running");
		f.held.get(1)?.release();
		await expect.poll(() => f.registry.get(f.session.sessionId).goal?.status).toBe("complete");
		await idle(f.registry, f.session.sessionId);
		expect(requests[0]).toContain("First child result");
		expect(requests[0]).toContain("Second child result");
		expect(f.registry.get(f.session.sessionId).messages.filter((message) => message.contextInjection)).toHaveLength(
			2,
		);
		expect(f.registry.get(f.session.sessionId).messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(f.registry.state.runs).toHaveLength(3);
	});

	it("durably pauses before cancelling the root subtree and can drop then create a distinct goal", async () => {
		const f = await fixture([progress(1, true), progress(2, true)]);
		await f.teams.goal(f.session.sessionId, { op: "create", objective: "Long running goal" });
		await expect.poll(() => f.started.has(1)).toBe(true);
		const child = (
			await f.teams.spawn(f.session.sessionId, [{ name: "child", task: "child task", tools: ["progress"] }])
		).agents[0];
		await expect.poll(() => f.started.has(2)).toBe(true);
		await f.teams.stop(f.session.sessionId);
		expect(f.registry.get(f.session.sessionId).goal?.status).toBe("paused");
		expect(f.abortGoals).toEqual(["paused", "paused"]);
		expect(f.registry.get(child.sessionId).latestRun?.status).toBe("cancelled");
		expect(f.registry.get(f.session.sessionId).pendingInput).toHaveLength(0);
		expect(f.registry.state.runs).toHaveLength(2);
		const oldId = f.registry.get(f.session.sessionId).goal?.id;
		await f.teams.goal(f.session.sessionId, { op: "drop" });
		expect(f.registry.get(f.session.sessionId).goal?.status).toBe("dropped");
		f.faux.setResponses([complete(), fauxAssistantMessage("done")]);
		const next = await f.teams.goal(f.session.sessionId, { op: "create", objective: "New goal" });
		expect(next?.id).not.toBe(oldId);
		await expect.poll(() => f.registry.get(f.session.sessionId).goal?.status).toBe("complete");
		await idle(f.registry, f.session.sessionId);
	});

	it("keeps user follow-up inputs ahead of autonomous continuation", async () => {
		const userRequests: string[] = [];
		const f = await fixture([
			progress(1, true),
			fauxAssistantMessage("Original turn"),
			(context) => {
				userRequests.push(JSON.stringify(context.messages));
				return complete();
			},
			fauxAssistantMessage("User follow-up handled"),
		]);
		await f.teams.goal(f.session.sessionId, { op: "create", objective: "Follow user guidance" });
		await expect.poll(() => f.started.has(1)).toBe(true);
		await f.teams.prompt(f.session.sessionId, { text: "Prioritize my correction", mode: "followUp" });
		f.held.get(1)?.release();
		await expect.poll(() => f.registry.get(f.session.sessionId).goal?.status).toBe("complete");
		await idle(f.registry, f.session.sessionId);
		expect(userRequests[0]).toContain("Prioritize my correction");
		expect(f.registry.state.runs).toHaveLength(1);
		expect(f.registry.get(f.session.sessionId).pendingInput).toHaveLength(0);
	});

	it("rejects illegal transitions, child goals, busy starts, and missing model/auth before activating", async () => {
		const f = await fixture([progress(1, true)]);
		await expect(f.teams.goal(f.session.sessionId, { op: "resume" })).rejects.toMatchObject({ statusCode: 409 });
		await expect(f.teams.goal(f.session.sessionId, { op: "pause" })).rejects.toMatchObject({ statusCode: 409 });
		await expect(f.teams.goal(f.session.sessionId, { op: "create", objective: "  " })).rejects.toMatchObject({
			statusCode: 400,
		});
		const missing = await f.registry.create({ workspaceId: f.workspace.id });
		await expect(f.teams.goal(missing.sessionId, { op: "create", objective: "No model" })).rejects.toMatchObject({
			statusCode: 400,
		});
		expect(f.registry.get(missing.sessionId).goal).toBeUndefined();
		const unavailable = fauxProvider({ provider: "goal-faux-no-auth" });
		f.modelRuntime.registerNativeProvider({
			...unavailable.provider,
			auth: { apiKey: { name: "Unavailable test credential", resolve: async () => undefined } },
		});
		const noAuth = await f.registry.create({
			workspaceId: f.workspace.id,
			model: { provider: unavailable.getModel().provider, id: unavailable.getModel().id },
		});
		await expect(f.teams.goal(noAuth.sessionId, { op: "create", objective: "No auth" })).rejects.toMatchObject({
			statusCode: 400,
		});
		expect(f.registry.get(noAuth.sessionId).goal).toBeUndefined();
		await f.teams.prompt(f.session.sessionId, { text: "ordinary active run", mode: "prompt" });
		await expect.poll(() => f.started.has(1)).toBe(true);
		await expect(f.teams.goal(f.session.sessionId, { op: "create", objective: "busy" })).rejects.toMatchObject({
			statusCode: 409,
		});
		const child = (await f.teams.spawn(f.session.sessionId, [{ name: "queued child", task: "work" }])).agents[0];
		await expect(f.teams.goal(child.sessionId, { op: "create", objective: "child" })).rejects.toMatchObject({
			statusCode: 409,
		});
		await f.teams.stop(f.session.sessionId);
	});

	it("restores active goals paused without constructing an adapter or paying for automatic replay", async () => {
		const f = await fixture([progress(1, true)]);
		await f.teams.goal(f.session.sessionId, { op: "create", objective: "Restart safely" });
		await expect.poll(() => f.started.has(1)).toBe(true);
		await f.registry.persist();
		const restored = new SessionRegistry({
			agentDir: f.root,
			workspaceFiles: new WorkspaceFiles(),
			modelRuntime: f.modelRuntime,
		});
		await restored.initialize();
		const restoredTeams = new TeamManager(restored);
		await restoredTeams.initialize();
		expect(restored.get(f.session.sessionId).goal).toMatchObject({
			status: "paused",
			objective: "Restart safely",
		});
		expect(restored.get(f.session.sessionId).latestRun?.status).toBe("interrupted");
		expect(f.faux.state.callCount).toBe(1);
		await restoredTeams.close();
		await restored.close();
	});

	it.each(["active", "paused", "blocked", "budget-limited"])(
		"discards obsolete persisted limits and usage from %s goals and resumes without arguments",
		async (status) => {
			const f = await fixture();
			const statePath = join(f.root, "web-harness", "state.json");
			const state = JSON.parse(await readFile(statePath, "utf8"));
			state.sessions[0].tools = ["goal"];
			state.sessions[0].goal = {
				id: "saved-goal",
				objective: "Finish saved work",
				status,
				tokenBudget: 1,
				tokensUsed: 100000,
				createdAt: "saved",
				updatedAt: "saved",
			};
			await writeFile(statePath, JSON.stringify(state));
			const restored = new SessionRegistry({
				agentDir: f.root,
				workspaceFiles: new WorkspaceFiles(),
				modelRuntime: f.modelRuntime,
				customTools: (descriptor) =>
					[restoredTeams.createGoalTool(descriptor.sessionId)] as unknown as ToolDefinition[],
			});
			const restoredTeams = new TeamManager(restored);
			await restored.initialize();
			await restoredTeams.initialize();
			const goal = restored.get(f.session.sessionId).goal;
			expect(goal).toMatchObject({
				id: "saved-goal",
				status: status === "blocked" ? "blocked" : "paused",
			});
			expect(goal).not.toHaveProperty("tokenBudget");
			expect(goal).not.toHaveProperty("tokensUsed");
			const saved = JSON.parse(await readFile(statePath, "utf8")).sessions[0].goal;
			expect(saved).toEqual(goal);
			f.faux.setResponses([complete(), fauxAssistantMessage("Saved work completed")]);
			await restoredTeams.goal(f.session.sessionId, { op: "resume" });
			await expect.poll(() => restored.get(f.session.sessionId).goal?.status).toBe("complete");
			await idle(restored, f.session.sessionId);
			expect(f.faux.state.callCount).toBe(2);
			await restoredTeams.close();
			await restored.close();
		},
	);

	it("rejects corrupt persisted goal state without overwriting it", async () => {
		const f = await fixture();
		const statePath = join(f.root, "web-harness", "state.json");
		const state = JSON.parse(await readFile(statePath, "utf8"));
		state.sessions[0].goal = {
			id: "bad",
			objective: "bad",
			status: "invalid",
			createdAt: "now",
			updatedAt: "now",
		};
		const bytes = JSON.stringify(state);
		await writeFile(statePath, bytes);
		const restored = new SessionRegistry({ agentDir: f.root, workspaceFiles: new WorkspaceFiles() });
		await expect(restored.initialize()).rejects.toThrow("Invalid session goal state");
		expect(await readFile(statePath, "utf8")).toBe(bytes);
	});

	it("validates authenticated HTTP goal commands and returns Goal or null", async () => {
		const f = await fixture([progress(1, true)]);
		const host = createHttpHost({
			port: 0,
			handleApi: async (request, response, url) => {
				if (url.pathname !== `/api/sessions/${f.session.sessionId}/goal`) return false;
				try {
					const goal = await f.teams.goal(
						f.session.sessionId,
						request.method === "GET" ? { op: "get" } : await readJson(request, goalActionSchema),
					);
					sendJson(response, 200, goal);
					return true;
				} catch (error) {
					if (error instanceof HarnessError) throw new HttpError(error.statusCode, error.message);
					throw error;
				}
			},
		});
		const launch = await host.listen();
		cleanups.push(() => host.close());
		const auth = await fetch(launch.launchUrl, { redirect: "manual" });
		const cookie = auth.headers.get("set-cookie")?.split(";")[0] ?? "";
		const url = `${launch.origin}/api/sessions/${f.session.sessionId}/goal`;
		expect(await (await fetch(url, { headers: { cookie } })).json()).toBeNull();
		const post = (body: unknown) =>
			fetch(url, {
				method: "POST",
				headers: { cookie, origin: launch.origin, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		expect((await post({ op: "create", objective: "HTTP work", tokenBudget: 1000 })).status).toBe(400);
		expect((await post({ op: "resume", tokenBudget: 1000 })).status).toBe(400);
		expect((await post({ op: "create", objective: "HTTP work", tokensUsed: 0 })).status).toBe(400);
		const created = await post({ op: "create", objective: "HTTP work" });
		expect(created.status).toBe(200);
		expect(await created.json()).toMatchObject({ status: "active", objective: "HTTP work" });
		await expect.poll(() => f.started.has(1)).toBe(true);
		expect((await post({ op: "resume" })).status).toBe(409);
		expect(await (await post({ op: "pause" })).json()).toMatchObject({ status: "paused" });
		expect(await (await post({ op: "drop" })).json()).toMatchObject({ status: "dropped" });
	});
});
