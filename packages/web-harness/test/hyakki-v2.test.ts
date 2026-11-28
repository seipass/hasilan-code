import { execFileSync } from "node:child_process";
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
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { AgentWorktrees } from "../src/server/agent-worktrees.ts";
import { SessionRegistry } from "../src/server/session-registry.ts";
import { TeamManager } from "../src/server/team-manager.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";
import { findOwnedPathConflicts, normalizeOwnedPath } from "../src/shared/swarm.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

async function createFixture(options: { withGit?: boolean; tools?: string[] } = {}) {
	const root = await mkdtemp(join(tmpdir(), "hasilan-hyakki-v2-"));
	const workspacePath = join(root, "workspace");
	await mkdir(workspacePath);
	if (options.withGit) {
		git(workspacePath, "init", "-q");
		await writeFile(join(workspacePath, "README.md"), "initial\n");
	}
	const faux = fauxProvider({ provider: "hyakki-v2-faux", tokenSize: { min: 1, max: 1 } });
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const agentWorktrees = options.withGit ? new AgentWorktrees(root) : undefined;
	let teams: TeamManager;
	const registry = new SessionRegistry({
		agentDir: root,
		swarmEnabled: true,
		modelRuntime,
		workspaceFiles: new WorkspaceFiles(),
		isolatedFiles: options.withGit ? new WorkspaceFiles() : undefined,
		agentWorktrees,
		customTools: (descriptor) => [teams.createTool(descriptor.sessionId) as unknown as ToolDefinition],
	});
	teams = new TeamManager(registry, {
		agentDir: root,
		agentWorktrees,
		getLimits: () => ({ maxConcurrentAgents: 4, maxDepth: 3 }),
	});
	await registry.initialize();
	await teams.initialize();
	const workspace = await registry.addWorkspace(workspacePath);
	const model = { provider: faux.getModel().provider, id: faux.getModel().id };
	const session = await registry.create({
		workspaceId: workspace.id,
		model,
		...(options.tools ? { tools: options.tools } : {}),
	});
	await teams.ensureRoot(session.sessionId);
	cleanups.push(async () => {
		await teams.close();
		await registry.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, workspacePath, faux, modelRuntime, registry, teams, workspace, session };
}

async function idle(registry: SessionRegistry, sessionId: string) {
	await expect.poll(() => registry.get(sessionId).currentRun, { timeout: 10_000 }).toBeUndefined();
}

describe("Hyakki-Yako v2 shared board, ownership guards, worktree sync, and verification gates", () => {
	it("normalizes owned paths and detects directory and glob overlaps", () => {
		expect(normalizeOwnedPath("./src/auth/**")).toBe("src/auth");
		expect(normalizeOwnedPath("src\\auth\\login.ts")).toBe("src/auth/login.ts");
		expect(() => normalizeOwnedPath("../outside")).toThrow("Invalid owned path");
		expect(() => normalizeOwnedPath("**")).toThrow("Invalid owned path");
		const conflicts = findOwnedPathConflicts(
			["src/auth/login.ts"],
			[{ id: "t1", title: "Auth module", ownerName: "coder", ownedPaths: ["src/auth"] }],
		);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({
			taskId: "t1",
			requestedPath: "src/auth/login.ts",
			existingPath: "src/auth",
		});
		expect(
			findOwnedPathConflicts(
				["src/ui/button.tsx"],
				[{ id: "t1", title: "Auth module", ownerName: "coder", ownedPaths: ["src/auth"] }],
			),
		).toHaveLength(0);
	});

	it("enforces path conflicts, dependencies, independent reviews, real verification, and check invalidation on adopt", async () => {
		const f = await createFixture({ withGit: true });
		const managerId = f.session.sessionId;
		const reviewerRequests: string[] = [];
		const managerTool = f.teams.createTool(managerId);
		const ctx = {} as Parameters<typeof managerTool.execute>[4];

		// Start swarm and let root hold until we drive steps deterministically via direct tool & specialist runs.
		const releaseRoot = Promise.withResolvers<void>();
		cleanups.push(async () => releaseRoot.resolve());
		const respond: FauxResponseFactory = async (context) => {
			const system = getCurrentSystemPrompt(context.messages);
			if (system.includes("Agent role: coder")) {
				if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "team")) {
					const coderSession = f.registry.state.sessions.find((entry) => entry.role === "coder")!;
					await writeFile(join(coderSession.cwd, "auth.ts"), "export const authReady = true;\n");
					return fauxAssistantMessage(
						fauxToolCall("team", {
							action: "board",
							op: "post",
							kind: "contract",
							title: "Auth export contract",
							body: "auth.ts exports authReady: boolean",
							paths: ["auth.ts"],
							taskId: "t1",
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Implemented auth.ts");
			}
			if (system.includes("Agent role: reviewer")) {
				reviewerRequests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("Reviewed auth.ts");
			}
			await releaseRoot.promise;
			return fauxAssistantMessage("Manager idle");
		};
		f.faux.setResponses(Array.from({ length: 24 }, () => respond));

		await f.teams.startSwarm(managerId, { objective: "Implement auth with independent review and checks" });
		await expect.poll(() => f.registry.get(managerId).currentRun?.status).toBe("running");

		// 1. Plan tasks + verification check (also verify cycle rejection).
		await expect(
			f.teams.boardPlan(managerId, {
				tasks: [
					{ id: "a", title: "A", dependsOn: ["b"] },
					{ id: "b", title: "B", dependsOn: ["a"] },
				],
			}),
		).rejects.toThrow("Dependency cycle");

		const planned = await f.teams.boardPlan(managerId, {
			tasks: [
				{
					id: "t1",
					title: "Implement auth",
					ownedPaths: ["src/auth/**", "auth.ts"],
					acceptanceCriteria: ["auth.ts exports authReady"],
					needsReview: true,
				},
				{
					id: "t2",
					title: "Conflicting parallel auth edit",
					ownedPaths: ["src/auth/token.ts"],
					needsReview: false,
				},
				{
					id: "t3",
					title: "Integrate auth",
					dependsOn: ["t1"],
					ownedPaths: ["src/app.ts"],
					needsReview: false,
				},
			],
			checks: [
				{
					id: "c1",
					name: "smoke-check",
					command: `node -e "const fs = require('node:fs'); process.exit(fs.existsSync('auth.ts') ? 0 : 1)"`,
				},
			],
		});
		expect(planned.tasks).toHaveLength(3);
		expect(planned.overlapWarnings).toEqual([
			expect.objectContaining({ taskA: "t1", taskB: "t2", pathA: "src/auth", pathB: "src/auth/token.ts" }),
		]);

		// 2. Spawn coder and reviewer specialists.
		const spawned = await f.teams.spawn(managerId, [
			{ name: "coder", responsibility: "Implement features", task: "Implement auth.ts", category: "coding" },
			{
				name: "reviewer",
				responsibility: "Independent code review",
				task: "Stand by for review",
				category: "advisor",
			},
		]);
		const coder = spawned.agents.find((agent) => agent.name === "coder")!;
		const reviewer = spawned.agents.find((agent) => agent.name === "reviewer")!;
		await idle(f.registry, coder.sessionId);
		await idle(f.registry, reviewer.sessionId);

		// 3. Assign t1 to coder (in_progress) and verify guards.
		await f.teams.boardUpdateTask(managerId, { taskId: "t1", ownerAgentId: coder.agentId, status: "in_progress" });
		// Overlapping path on concurrent in_progress task t2 must be rejected.
		await expect(f.teams.boardUpdateTask(managerId, { taskId: "t2", status: "in_progress" })).rejects.toMatchObject({
			statusCode: 409,
		});
		// Dependent task t3 cannot start before t1 is done.
		await expect(f.teams.boardUpdateTask(managerId, { taskId: "t3", status: "in_progress" })).rejects.toMatchObject({
			statusCode: 409,
		});
		// Cancel t2 and move t1 to in_review.
		await f.teams.boardUpdateTask(managerId, { taskId: "t2", status: "cancelled" });
		await f.teams.boardUpdateTask(coder.sessionId, {
			taskId: "t1",
			status: "in_review",
			resultSummary: "Added auth.ts",
		});

		// 4. Coder cannot mark needsReview task done directly or self-approve it.
		await expect(f.teams.boardUpdateTask(coder.sessionId, { taskId: "t1", status: "done" })).rejects.toThrow(
			"independent approval",
		);
		await expect(
			f.teams.boardReviewTask(coder.sessionId, { taskId: "t1", verdict: "approved", summary: "Self LGTM" }),
		).rejects.toMatchObject({ statusCode: 403 });

		// 5. Run check BEFORE adopting auth.ts -> must fail with exitCode 1.
		const failedCheck = await f.teams.boardVerify(managerId, { checkId: "c1" });
		expect(failedCheck.check).toMatchObject({ status: "failed", exitCode: 1 });

		// Also verify adopting invalidates an already-passed check back to pending.
		await f.teams.boardPlan(managerId, {
			checks: [{ id: "c2", name: "always-pass", command: `node -e "process.exit(0)"` }],
		});
		const preAdoptPass = await f.teams.boardVerify(managerId, { checkId: "c2" });
		expect(preAdoptPass.check).toMatchObject({ status: "passed", exitCode: 0 });

		// 6. Adopt coder's worktree -> invalidates c2 back to pending and reports staleAgents containing reviewer.
		const adopted = await f.teams.agentWork(coder.sessionId, "adopt", managerId);
		expect(adopted).toMatchObject({
			status: "adopted",
			changed: true,
			staleAgents: [expect.objectContaining({ agentId: reviewer.agentId, name: "reviewer" })],
		});
		expect(await readFile(join(f.workspacePath, "auth.ts"), "utf8")).toContain("authReady");
		expect(f.registry.get(managerId).swarm?.checks?.find((entry) => entry.id === "c2")?.status).toBe("pending");

		// 7. Send work to idle clean reviewer -> auto-syncs reviewer's worktree AND injects shared board note!
		await f.teams.send(managerId, reviewer.agentId, "Review auth.ts against t1 acceptance criteria");
		await idle(f.registry, reviewer.sessionId);
		const reviewerDescriptor = f.registry.descriptor(reviewer.sessionId);
		expect(await readFile(join(reviewerDescriptor.cwd, "auth.ts"), "utf8")).toContain("authReady");
		expect(reviewerRequests.at(-1)).toContain("Shared Hyakki-Yako board");
		expect(reviewerRequests.at(-1)).toContain("Auth export contract");

		// 8. Reviewer requests changes -> t1 goes back to in_progress; then approves -> t1 goes to done.
		const reqChanges = await f.teams.boardReviewTask(reviewer.sessionId, {
			taskId: "t1",
			verdict: "changes_requested",
			summary: "Confirm export type",
		});
		expect(reqChanges.task.status).toBe("in_progress");
		const approved = await f.teams.boardReviewTask(reviewer.sessionId, {
			taskId: "t1",
			verdict: "approved",
			summary: "Verified auth.ts exports authReady",
		});
		expect(approved.task.status).toBe("done");

		// 9. Now t3 can start & finish (needsReview=false), but swarm complete is still blocked by unpassed checks!
		await f.teams.boardUpdateTask(managerId, { taskId: "t3", status: "in_progress" });
		await f.teams.boardUpdateTask(managerId, { taskId: "t3", status: "done" });
		await expect(
			managerTool.execute(
				"complete-before-checks",
				{ action: "swarm", op: "complete", reason: "Trying early completion" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("verification checks");

		// 10. Run both verification checks -> both pass -> swarm complete succeeds!
		expect((await f.teams.boardVerify(managerId, { checkId: "c1" })).check).toMatchObject({
			status: "passed",
			exitCode: 0,
		});
		expect((await f.teams.boardVerify(managerId, { checkId: "c2" })).check).toMatchObject({
			status: "passed",
			exitCode: 0,
		});
		const completed = await managerTool.execute(
			"complete-ok",
			{ action: "swarm", op: "complete", reason: "All tasks reviewed and checks passed" },
			undefined,
			undefined,
			ctx,
		);
		expect(completed.details).toMatchObject({ status: "complete" });
		releaseRoot.resolve();
		await idle(f.registry, managerId);

		// 11. Persist & reload into a fresh registry to verify schema validation and durability.
		const restored = new SessionRegistry({
			agentDir: f.root,
			workspaceFiles: new WorkspaceFiles(),
			isolatedFiles: new WorkspaceFiles(),
			agentWorktrees: new AgentWorktrees(f.root),
			modelRuntime: f.modelRuntime,
		});
		await restored.initialize();
		const restoredSwarm = restored.get(managerId).swarm;
		expect(restoredSwarm?.tasks).toHaveLength(3);
		expect(restoredSwarm?.notes).toHaveLength(1);
		expect(restoredSwarm?.checks?.every((entry) => entry.status === "passed")).toBe(true);
		expect((restoredSwarm?.events?.length ?? 0) > 0).toBe(true);
		await restored.close();
	}, 30_000);

	it("pauses an active swarm cleanly and enforces bash permission for board verify", async () => {
		const f = await createFixture({ tools: ["read"] });
		const managerId = f.session.sessionId;
		const release = Promise.withResolvers<void>();
		cleanups.push(async () => release.resolve());
		f.faux.setResponses([
			async () => {
				await release.promise;
				return fauxAssistantMessage("Stopped");
			},
		]);
		await f.teams.startSwarm(managerId, { objective: "Test pause and permission boundary" });
		await expect.poll(() => f.registry.get(managerId).currentRun?.status).toBe("running");

		// Restricted root without bash must not be able to run shell verification commands.
		await expect(
			f.teams.boardVerify(managerId, { name: "restricted", command: `node -e "process.exit(0)"` }),
		).rejects.toMatchObject({ statusCode: 403 });

		const paused = await f.teams.pauseSwarm(managerId);
		release.resolve();
		expect(paused).toMatchObject({ status: "paused", reason: "Paused by user" });
		expect(paused.events?.some((event) => event.kind === "paused")).toBe(true);
		await expect(f.teams.pauseSwarm(managerId)).rejects.toMatchObject({ statusCode: 409 });
	}, 15_000);

	it("rejects corrupt persisted v2 swarm board fields without overwriting state.json", async () => {
		const f = await createFixture();
		f.faux.setResponses([fauxAssistantMessage("ok")]);
		await f.teams.prompt(f.session.sessionId, { text: "hello", mode: "prompt" });
		await idle(f.registry, f.session.sessionId);
		const statePath = join(f.root, "web-harness", "state.json");
		const state = JSON.parse(await readFile(statePath, "utf8"));
		state.sessions[0].swarm = {
			id: "bad-board",
			objective: "Valid objective",
			createdAt: "2026-11-28T00:00:00.000Z",
			updatedAt: "2026-11-28T00:00:00.000Z",
			status: "paused",
			rootRunId: f.registry.get(f.session.sessionId).latestRun!.runId,
			tasks: [{ id: "t1", title: "Bad status", status: "not-a-status", updatedAt: "2026-11-28T00:00:00.000Z" }],
		};
		const bytes = JSON.stringify(state);
		await writeFile(statePath, bytes);
		const restored = new SessionRegistry({ agentDir: f.root, workspaceFiles: new WorkspaceFiles() });
		await expect(restored.initialize()).rejects.toThrow("Invalid session swarm state");
		expect(await readFile(statePath, "utf8")).toBe(bytes);
	});
});
