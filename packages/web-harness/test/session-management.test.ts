import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseClaude } from "../src/server/session-import/jsonl-formats.ts";
import { SessionRegistry } from "../src/server/session-registry.ts";
import { TeamManager } from "../src/server/team-manager.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-session-management-"));
	const options = { agentDir: join(directory, "agent"), workspaceFiles: new WorkspaceFiles() };
	let registry = new SessionRegistry(options);
	cleanups.push(async () => {
		await registry.close();
		await rm(directory, { recursive: true, force: true });
	});
	await registry.initialize();
	const workspace = await registry.addWorkspace(directory);
	return {
		get registry() {
			return registry;
		},
		workspace,
		directory,
		async restart() {
			await registry.close();
			registry = new SessionRegistry({ ...options, workspaceFiles: new WorkspaceFiles() });
			await registry.initialize();
		},
	};
}

describe("conversation management", () => {
	it("persists the renamed title without rewriting imported history", async () => {
		const state = await fixture();
		const transcript = parseClaude(
			[
				{
					type: "user",
					uuid: "u",
					parentUuid: null,
					cwd: state.directory,
					message: { content: "Original conversation" },
				},
			],
			"original-id",
			[],
		);
		const session = await state.registry.importSession(state.workspace.id, transcript, "revision");
		const original = await readFile(session.path!);
		await state.registry.renameSession(session.sessionId, "  新しい会話名  ");
		expect(state.registry.page(session.sessionId).title).toBe("新しい会話名");
		await state.restart();
		expect(state.registry.list()[0].title).toBe("新しい会話名");
		expect(await readFile(session.path!)).toEqual(original);
		await state.registry.deleteSession(session.sessionId);
		expect(await readFile(session.path!)).toEqual(original);
		await state.restart();
		expect(state.registry.list()).toEqual([]);
		expect(() => state.registry.page(session.sessionId)).toThrow("Session not found");
	});
	it("removes the selected root's whole team without affecting other conversations", async () => {
		const state = await fixture();
		const root = await state.registry.create({ workspaceId: state.workspace.id });
		const other = await state.registry.create({ workspaceId: state.workspace.id });
		const teams = new TeamManager(state.registry);
		const agent = await teams.ensureRoot(root.sessionId);
		const otherAgent = await teams.ensureRoot(other.sessionId);
		const child = await state.registry.create({ workspaceId: state.workspace.id, parentSessionId: root.sessionId });
		state.registry.state.agents.push({
			agentId: "child-agent",
			parentAgentId: agent.agentId,
			teamId: agent.teamId,
			sessionId: child.sessionId,
			name: "Child",
			role: "worker",
		});
		state.registry.state.runs.push({
			runId: "finished",
			agentId: "child-agent",
			task: "Completed work",
			status: "completed",
		});
		state.registry.state.pendingInput.push({
			inputId: "pending",
			sessionId: child.sessionId,
			runId: "finished",
			text: "Unsent instruction",
			mode: "followUp",
			status: "undelivered",
		});
		await state.registry.persist();
		await expect(state.registry.deleteSession(child.sessionId)).rejects.toThrow("親の会話と一緒に");
		expect(await state.registry.deleteSession(root.sessionId)).toEqual(
			expect.arrayContaining([root.sessionId, child.sessionId]),
		);
		expect(teams.snapshot(state.workspace.id).agents.map((entry) => entry.agentId)).toEqual([otherAgent.agentId]);
		expect(state.registry.state.runs).toEqual([]);
		expect(state.registry.state.pendingInput).toEqual([]);
		await teams.close();
		await state.restart();
		expect(state.registry.list().map((entry) => entry.sessionId)).toEqual([other.sessionId]);
	});
	it.each(["queued", "running", "waiting", "cancelling"] as const)(
		"rejects deletion while a descendant run is %s",
		async (status) => {
			const state = await fixture();
			const root = await state.registry.create({ workspaceId: state.workspace.id });
			const child = await state.registry.create({
				workspaceId: state.workspace.id,
				parentSessionId: root.sessionId,
			});
			const teams = new TeamManager(state.registry);
			const agent = await teams.ensureRoot(root.sessionId);
			state.registry.state.agents.push({
				agentId: "child-agent",
				parentAgentId: agent.agentId,
				teamId: agent.teamId,
				sessionId: child.sessionId,
				name: "Child",
				role: "worker",
			});
			state.registry.state.runs.push({ runId: "active", agentId: "child-agent", task: "Active work", status });
			await expect(state.registry.deleteSession(root.sessionId)).rejects.toThrow("停止してから削除");
			expect(state.registry.list()).toHaveLength(2);
			state.registry.state.runs[0].status = "completed";
			await teams.close();
		},
	);
	it("rejects blank and excessively long titles without modifying the session", async () => {
		const state = await fixture();
		const session = await state.registry.create({ workspaceId: state.workspace.id });
		await expect(state.registry.renameSession(session.sessionId, "  ")).rejects.toThrow("1〜200文字");
		await expect(state.registry.renameSession(session.sessionId, "x".repeat(201))).rejects.toThrow("1〜200文字");
		expect(state.registry.descriptor(session.sessionId).title).toBeUndefined();
	});
});
