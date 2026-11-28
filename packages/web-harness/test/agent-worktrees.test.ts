import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

	it("resolves symlinked private directories and source paths consistently with git", async () => {
		const realRoot = await mkdtemp(join(tmpdir(), "hasilan-agent-worktree-link-"));
		const linkParent = await mkdtemp(join(tmpdir(), "hasilan-agent-worktree-alias-"));
		try {
			const linkedRoot = join(linkParent, "alias");
			await symlink(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
			const source = join(linkedRoot, "source");
			const subdir = join(source, "nested");
			await mkdir(subdir, { recursive: true });
			git(source, "init", "-q");
			await writeFile(join(subdir, "note.txt"), "initial\n");
			const service = new AgentWorktrees(linkedRoot);
			const worktree = await service.create(subdir);
			if (!worktree) throw new Error("Worktree was not created");
			const worktreeCwd = await service.cwd(worktree, subdir);
			await writeFile(join(worktreeCwd, "note.txt"), "updated\n");
			const applied = await service.changes(worktree, subdir);
			expect(applied.changed).toBe(true);
			expect(await readFile(join(realRoot, "source", "nested", "note.txt"), "utf8")).toMatch(/^updated\r?\n$/);
		} finally {
			await rm(linkParent, { recursive: true, force: true });
			await rm(realRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it("syncs clean and non-conflicting worktrees after adoption while rolling back conflicting local edits safely", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hasilan-agent-sync-"));
		try {
			const source = join(directory, "source");
			await mkdir(source);
			git(source, "init", "-q");
			await writeFile(join(source, "shared.txt"), "v1\n");
			const service = new AgentWorktrees(directory);
			const alpha = await service.create(source);
			const beta = await service.create(source);
			const gamma = await service.create(source);
			if (!alpha || !beta || !gamma) throw new Error("Worktrees were not created");
			const alphaCwd = await service.cwd(alpha, source);
			const betaCwd = await service.cwd(beta, source);
			const gammaCwd = await service.cwd(gamma, source);

			// Alpha edits shared.txt and adds auth.txt, then adopts into source.
			await writeFile(join(alphaCwd, "shared.txt"), "v2-from-alpha\n");
			await writeFile(join(alphaCwd, "auth.txt"), "auth-impl\n");
			const adopted = await service.changes(alpha, source);
			expect(adopted.changed).toBe(true);
			alpha.baseline = adopted.baseline;

			// Beta edits an independent file and syncs: onlyIfClean skips, full sync merges cleanly.
			await writeFile(join(betaCwd, "ui.txt"), "ui-impl\n");
			const skipped = await service.sync(beta, source, { onlyIfClean: true });
			expect(skipped).toMatchObject({ updated: false, hadLocalChanges: true });
			const syncedBeta = await service.sync(beta, source);
			expect(syncedBeta).toMatchObject({ updated: true, hadLocalChanges: true });
			beta.baseline = syncedBeta.baseline;
			expect(await readFile(join(betaCwd, "auth.txt"), "utf8")).toMatch(/^auth-impl\r?\n$/);
			expect(await readFile(join(betaCwd, "ui.txt"), "utf8")).toMatch(/^ui-impl\r?\n$/);
			const betaDiff = await service.changes(beta);
			expect(betaDiff.changed).toBe(true);
			expect(betaDiff.diff).toContain("+ui-impl");
			expect(betaDiff.diff).not.toContain("+auth-impl");

			// Clean gamma syncs directly and sees alpha's adopted files with zero local diff.
			const syncedGamma = await service.sync(gamma, source, { onlyIfClean: true });
			expect(syncedGamma).toMatchObject({ updated: true, hadLocalChanges: false });
			gamma.baseline = syncedGamma.baseline;
			expect(await readFile(join(gammaCwd, "auth.txt"), "utf8")).toMatch(/^auth-impl\r?\n$/);
			expect((await service.changes(gamma)).changed).toBe(false);

			// Conflicting local change on gamma is rolled back cleanly when sync conflicts with source.
			await writeFile(join(source, "shared.txt"), "v3-source\n");
			await writeFile(join(gammaCwd, "shared.txt"), "v3-gamma-conflict\n");
			await expect(service.sync(gamma, source)).rejects.toThrow("conflicting local changes");
			expect(await readFile(join(gammaCwd, "shared.txt"), "utf8")).toMatch(/^v3-gamma-conflict\r?\n$/);
			expect((await service.changes(gamma)).diff).toContain("+v3-gamma-conflict");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
