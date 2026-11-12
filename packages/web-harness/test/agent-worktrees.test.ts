import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentWorktrees } from "../src/server/agent-worktrees.ts";
import { SessionRegistry } from "../src/server/session-registry.ts";
import { TeamManager } from "../src/server/team-manager.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

describe("agent Git worktrees", () => {
	it("lets the assigning AI discard, restore and adopt a specialist's isolated changes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hasilan-agent-review-"));
		const agentWorktrees = new AgentWorktrees(directory);
		const registry = new SessionRegistry({
			agentDir: directory,
			workspaceFiles: new WorkspaceFiles(),
			isolatedFiles: new WorkspaceFiles(),
			agentWorktrees,
		});
		const model = { provider: "test", id: "coding" };
		const teams = new TeamManager(registry, {
			agentWorktrees,
			getAgentModels: () => ({ coding: { ...model, thinkingLevel: "high" } }),
		});
		try {
			const source = join(directory, "source");
			await mkdir(source);
			git(source, "init", "-q");
			const workspace = await registry.addWorkspace(source);
			const parent = await registry.create({ workspaceId: workspace.id });
			await teams.ensureRoot(parent.sessionId);
			const tool = teams.createTool(parent.sessionId);
			const {
				agents: [child],
			} = await teams.spawn(parent.sessionId, [{ name: "Engineer", task: "Edit the file", category: "coding" }]);
			await expect
				.poll(() => teams.workOverview().find((item) => item.sessionId === child.sessionId)?.status)
				.toBe("failed");
			const isolated = registry.descriptor(child.sessionId);
			expect(isolated.model).toEqual(model);
			expect(isolated.thinkingLevel).toBe("high");
			await writeFile(join(isolated.cwd, "result.txt"), "new work\n");
			const run = (op: "diff" | "adopt" | "discard" | "restore") =>
				tool.execute(
					"test",
					{ action: "work", op, agentId: child.agentId },
					undefined,
					undefined,
					{} as Parameters<typeof tool.execute>[4],
				);
			await expect(teams.agentWork(child.sessionId, "adopt")).rejects.toThrow("assigning agent");
			await expect(run("diff")).resolves.toMatchObject({ details: { changed: true } });
			await expect(run("discard")).resolves.toMatchObject({ details: { status: "discarded" } });
			await expect(run("adopt")).rejects.toThrow("Restore discarded work");
			await expect(readFile(join(source, "result.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(run("restore")).resolves.toMatchObject({ details: { status: "active" } });
			await expect(run("adopt")).resolves.toMatchObject({ details: { status: "adopted" } });
			await expect(readFile(join(source, "result.txt"), "utf8")).resolves.toMatch(/^new work\r?\n$/);
			const restored = new SessionRegistry({
				agentDir: directory,
				workspaceFiles: new WorkspaceFiles(),
				isolatedFiles: new WorkspaceFiles(),
				agentWorktrees,
			});
			await restored.initialize();
			expect(restored.descriptor(child.sessionId).cwd).toBe(isolated.cwd);
			expect(restored.descriptor(child.sessionId).worktree?.status).toBe("adopted");
		} finally {
			await teams.close();
			await registry.close();
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps source edits and the index intact, and applies only the chosen agent's changes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hasilan-agent-worktrees-"));
		try {
			const source = join(directory, "source");
			await mkdir(source);
			git(source, "init", "-q");
			await writeFile(join(source, "shared.txt"), "base\n");
			git(source, "add", "shared.txt");
			git(
				source,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-qm",
				"base",
			);
			await writeFile(join(source, "shared.txt"), "staged\n");
			git(source, "add", "shared.txt");
			await writeFile(join(source, "shared.txt"), "working\n");
			await writeFile(join(source, "existing.txt"), "untracked\n");
			const service = new AgentWorktrees(directory);
			const first = await service.create(source);
			const second = await service.create(source);
			if (!first || !second) throw new Error("Worktrees were not created");
			const firstCwd = await service.cwd(first, source);
			const secondCwd = await service.cwd(second, source);
			expect(await readFile(join(firstCwd, "existing.txt"), "utf8")).toMatch(/^untracked\r?\n$/);
			expect(await readFile(join(firstCwd, "shared.txt"), "utf8")).toMatch(/^working\r?\n$/);
			await writeFile(join(firstCwd, "shared.txt"), "first\n");
			await writeFile(join(secondCwd, "shared.txt"), "second\n");
			expect((await service.changes(first)).diff).toContain("+first");
			const applied = await service.changes(first, source);
			expect(applied.changed).toBe(true);
			first.baseline = applied.baseline;
			expect((await service.changes(first)).changed).toBe(false);
			await expect(service.changes(second, source)).rejects.toThrow();
			expect(await readFile(join(source, "shared.txt"), "utf8")).toMatch(/^first\r?\n$/);
			expect(git(source, "show", ":shared.txt")).toBe("staged");
			expect((await service.changes(second)).diff).toContain("+second");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
