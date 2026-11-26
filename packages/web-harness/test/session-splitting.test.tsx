import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MultiSessionTray } from "../src/client/MultiSessionTray.tsx";
import { SplitNoticeCard, SplitProposalCard } from "../src/client/SplitProposalCard.tsx";
import type { SessionSummary } from "../src/client/types.ts";
import { AgentWorktrees } from "../src/server/agent-worktrees.ts";
import { deriveSplitMetadata, heuristicShouldSplit } from "../src/server/session-splitter.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

describe("session splitting and multi-session tray", () => {
	it("detects orthogonal mid-turn requests while keeping steering instructions in the same session", () => {
		expect(heuristicShouldSplit("upgrade us to next 16.3", "also, fix the footer on mobile")).toBe(true);
		expect(heuristicShouldSplit("Next 16.3 にアップグレード", "ついでにモバイルのフッターの崩れを直して")).toBe(true);
		expect(heuristicShouldSplit("upgrade us to next 16.3", "wait, use 16.3.1 instead")).toBe(false);
		expect(heuristicShouldSplit("upgrade us to next 16.3", "also, check next 16.3 upgrade guide")).toBe(false);

		const meta = deriveSplitMetadata("also, fix the footer on mobile");
		expect(meta.suggestedTitle).toBe("fix the footer on mobile");
		expect(meta.branchName).toBe("fix/fix-footer-mobile");
	});

	it("creates an isolated worktree on a named branch and avoids branch collisions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hasilan-split-wt-"));
		try {
			const repo = join(dir, "repo");
			await mkdir(repo);
			git(repo, "init", "-q");
			await writeFile(join(repo, "README.md"), "hello\n");
			git(repo, "add", "README.md");
			git(
				repo,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-qm",
				"init",
			);

			const worktrees = new AgentWorktrees(dir);
			const first = await worktrees.create(repo, "fix/footer-mobile");
			const second = await worktrees.create(repo, "fix/footer-mobile");
			expect(first?.branch).toBe("fix/footer-mobile");
			expect(second?.branch).toMatch(/^fix\/footer-mobile-[a-f0-9]{6}$/);

			const firstCwd = await worktrees.cwd(first!, repo);
			expect(git(firstCwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("fix/footer-mobile");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 20_000);

	it("renders split proposal, completion notice, and multi-session tray", () => {
		const proposalHtml = renderToStaticMarkup(
			<SplitProposalCard
				surface={{
					kind: "split_proposal",
					surfaceId: "sp-1",
					sessionId: "s-main",
					promptText: "also, fix the footer on mobile",
					suggestedTitle: "fix the footer on mobile",
					branchName: "fix/footer-mobile",
					explanation: "進行中の作業とは別のタスクです。",
					status: "pending",
					createdAt: "2026-10-01T00:00:00Z",
					updatedAt: "2026-10-01T00:00:00Z",
				}}
				onAction={async () => {}}
			/>,
		);
		expect(proposalHtml).toContain("新しいセッション");
		expect(proposalHtml).toContain("このまま続ける");

		const noticeHtml = renderToStaticMarkup(
			<SplitNoticeCard
				surface={{
					kind: "split_notice",
					surfaceId: "sn-1",
					sessionId: "s-main",
					childSessionId: "s-child",
					childTitle: "Fix footer on mobile",
					branchName: "fix/footer-mobile",
					changedFiles: 2,
					status: "completed",
					createdAt: "2026-10-01T00:01:00Z",
					updatedAt: "2026-10-01T00:01:00Z",
				}}
				onSelectSession={() => {}}
			/>,
		);
		expect(noticeHtml).toContain("Fix footer on mobile");
		expect(noticeHtml).toContain("2 ファイル変更");

		const sessions: SessionSummary[] = [
			{
				sessionId: "s-main",
				workspaceId: "w1",
				cwd: "/tmp/repo",
				title: "Upgrade to Next 16.3",
				materialized: true,
				availability: "ready",
				pendingInput: [],
				activeActivity: "edit · package.json",
				currentRun: { runId: "r1", agentId: "a1", task: "upgrade", status: "running", startedAt: "2026-10-01T00:00:00Z" },
			},
			{
				sessionId: "s-child",
				workspaceId: "w1",
				cwd: "/tmp/wt",
				splitFromSessionId: "s-main",
				splitBranch: "fix/footer-mobile",
				title: "Fix footer on mobile",
				materialized: true,
				availability: "ready",
				pendingInput: [],
				changedFileCount: 2,
				latestRun: {
					runId: "r2",
					agentId: "a2",
					task: "fix footer",
					status: "completed",
					startedAt: "2026-10-01T00:00:10Z",
					settledAt: "2026-10-01T00:01:44Z",
				},
			},
		];
		const trayHtml = renderToStaticMarkup(
			<MultiSessionTray sessions={sessions} activeSessionId="s-main" onSelect={() => {}} />,
		);
		expect(trayHtml).toContain("2 セッション");
		expect(trayHtml).toContain("1 件実行中");
		expect(trayHtml).toContain("fix/footer-mobile");
		expect(trayHtml).toContain("2 ファイル変更");
	});
});
