import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { computeDiffSquares, computeWaterfallBars, PrDockTray } from "../src/client/PrDockTray.tsx";
import { PrLifecycleCard } from "../src/client/PrLifecycleCard.tsx";
import {
	collectCommitGraph,
	detectMergeConflicts,
	inspectWorkspaceGit,
	PrLifecycleManager,
	parseCiFailureOutput,
} from "../src/server/pr-lifecycle.ts";
import { SurfaceManager } from "../src/server/surface-manager.ts";
import type { PrCiCheck, PrLifecycleSurface, WorkspaceGitSummary } from "../src/shared/pr-lifecycle.ts";

const exec = promisify(execFile);
const tempDirs: string[] = [];

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
	const { stdout } = await exec("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "You",
			GIT_AUTHOR_EMAIL: "you@example.com",
			GIT_COMMITTER_NAME: "You",
			GIT_COMMITTER_EMAIL: "you@example.com",
			...env,
		},
	});
	return stdout.trim();
}

async function createDivergingRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hasilan-pr-test-"));
	tempDirs.push(dir);
	await git(dir, ["init", "-b", "main"]);
	await git(dir, ["config", "user.name", "You"]);
	await git(dir, ["config", "user.email", "you@example.com"]);
	await git(dir, ["config", "commit.gpgsign", "false"]);
	await writeFile(join(dir, "checkout.ts"), "export const currency = 'USD';\nexport const taxRate = 0.08;\nexport const discount = 0;\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-m", "initial checkout"]);

	// Sibling branch (lane 2)
	await git(dir, ["checkout", "-b", "chore/docs"]);
	await writeFile(join(dir, "README.md"), "# Checkout docs\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-m", "add docs"]);

	// Feature branch (lane 1)
	await git(dir, ["checkout", "-b", "feat/checkout-promo", "main"]);
	await writeFile(join(dir, "checkout.ts"), "export const currency = 'USD';\nexport const taxRate = 0.10;\nexport const discount = 0.15;\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-m", "add promo discount"]);

	// Advance main with conflicting edit by Lena Park (lane 0)
	await git(dir, ["checkout", "main"]);
	await writeFile(join(dir, "checkout.ts"), "export const currency = 'USD';\nexport const taxRate = 0.095;\nexport const discount = 0;\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-m", "adjust regional tax rate"], {
		GIT_AUTHOR_NAME: "Lena Park",
		GIT_AUTHOR_EMAIL: "lena@example.com",
		GIT_COMMITTER_NAME: "Lena Park",
		GIT_COMMITTER_EMAIL: "lena@example.com",
	});

	await git(dir, ["checkout", "feat/checkout-promo"]);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("PR lifecycle git inspection, 3-lane DAG, and conflict detection", () => {
	it("inspects workspace diffstat, assigns 3 lanes, and non-destructively detects merge conflicts with author attribution", async () => {
		const dir = await createDivergingRepo();
		await writeFile(join(dir, "promo.ts"), "export const code = 'SAVE15';\nexport const active = true;\n");

		const summary = await inspectWorkspaceGit(dir, false);
		expect(summary.isGitRepo).toBe(true);
		expect(summary.branch).toBe("feat/checkout-promo");
		expect(summary.baseBranch).toBe("main");
		expect(summary.aheadCommits).toBe(1);
		expect(summary.filesChanged).toBe(1);
		expect(summary.additions).toBeGreaterThanOrEqual(2);

		const graph = await collectCommitGraph(dir, "feat/checkout-promo", "main");
		const lanes = new Set(graph.map((node) => node.lane));
		expect(lanes.has(0)).toBe(true);
		expect(lanes.has(1)).toBe(true);
		expect(lanes.has(2)).toBe(true);
		expect(graph.find((node) => node.subject === "adjust regional tax rate")?.lane).toBe(0);
		expect(graph.find((node) => node.subject === "add promo discount")?.lane).toBe(1);
		expect(graph.find((node) => node.subject === "add docs")?.lane).toBe(2);

		const conflicts = await detectMergeConflicts(dir, "main");
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].file).toBe("checkout.ts");
		expect(conflicts[0].line).toBe(2);
		expect(conflicts[0].theirsAuthor).toBe("Lena Park");
		expect(conflicts[0].theirsText).toContain("0.095");
		expect(conflicts[0].oursText).toContain("0.10");

		// Working tree remains untouched (promo.ts still untracked)
		const statusAfter = await git(dir, ["status", "--short"]);
		expect(statusAfter).toContain("?? promo.ts");
	});

	it("drives PR lifecycle surface through conflict detection, resolution prompt, and settled refresh", async () => {
		const dir = await createDivergingRepo();
		await writeFile(join(dir, "promo.ts"), "export const code = 'SAVE15';\n");

		const surfaces = new SurfaceManager({
			getManager: () => undefined,
			getRunId: () => undefined,
			onChanged: () => undefined,
		});
		const manager = new PrLifecycleManager(surfaces);

		const created = await manager.createOrAttach("sess-1", dir, {
			title: "Add checkout promo",
			waitForReady: true,
		});
		expect(created.error).toBeUndefined();
		expect(created.phase).toBe("conflicts");
		expect(created.conflicts).toHaveLength(1);
		expect(created.commits[0]?.isProjectedMerge).toBe(true);
		expect(created.commits.some((node) => node.subject === "adjust regional tax rate" && node.conflictCount === 1)).toBe(true);

		const docked = manager.setViewMode("sess-1", created.surfaceId, "docked_expanded");
		expect(docked.viewMode).toBe("docked_expanded");

		const prompts: string[] = [];
		const resolving = await manager.startResolveConflicts("sess-1", created.surfaceId, dir, async (text) => {
			prompts.push(text);
		});
		expect(resolving.phase).toBe("resolving");
		expect(prompts[0]).toContain("checkout.ts:2");
		expect(prompts[0]).toContain("Lena Park");

		// Simulate the agent merging main and resolving the conflict cleanly
		try {
			await git(dir, ["merge", "main"]);
		} catch {
			await writeFile(join(dir, "checkout.ts"), "export const currency = 'USD';\nexport const taxRate = 0.095;\nexport const discount = 0.15;\n");
			await git(dir, ["add", "checkout.ts"]);
			await git(dir, ["commit", "-m", "merge main and resolve tax conflict"]);
		}

		await manager.onAgentSettled("sess-1", dir);
		const after = surfaces.getPrSurface("sess-1", created.surfaceId);
		expect(after?.phase).toBe("ready");
		expect(after?.conflicts[0]?.resolved).toBe(true);
		manager.close();
	});
});

describe("CI failure parser, waterfall calculation, and diff squares", () => {
	it("parses Playwright assertion failures with ANSI codes", () => {
		const raw = [
			"\x1b[31m1) [chromium] › tests/checkout.spec.ts:47:5 › Checkout › applies promo code\x1b[0m",
			"  Error: expect(received).toBe(expected)",
			"  Expected: \"$85.00\"",
			"  Received: \"$100.00\"",
		].join("\n");
		const parsed = parseCiFailureOutput(raw);
		expect(parsed?.file).toBe("tests/checkout.spec.ts");
		expect(parsed?.line).toBe(47);
		expect(parsed?.testTitle).toBe("Checkout › applies promo code");
		expect(parsed?.expected).toBe('"$85.00"');
		expect(parsed?.received).toBe('"$100.00"');
	});

	it("parses TypeScript compiler error locations", () => {
		const parsed = parseCiFailureOutput("src/server/pr-lifecycle.ts(88,14): error TS2345: Argument of type 'string' is not assignable.");
		expect(parsed?.file).toBe("src/server/pr-lifecycle.ts");
		expect(parsed?.line).toBe(88);
	});

	it("computes waterfall offsets, durations, and proportional diff squares", () => {
		const base = Date.parse("2026-11-26T10:00:00.000Z");
		const checks: PrCiCheck[] = [
			{
				id: "1",
				name: "Typecheck",
				status: "completed",
				conclusion: "success",
				startedAt: new Date(base).toISOString(),
				completedAt: new Date(base + 20_000).toISOString(),
				durationSec: 20,
			},
			{
				id: "2",
				name: "E2E",
				status: "completed",
				conclusion: "failure",
				startedAt: new Date(base + 20_000).toISOString(),
				completedAt: new Date(base + 60_000).toISOString(),
				durationSec: 40,
			},
		];
		const { bars, totalSec } = computeWaterfallBars(checks, undefined, base + 60_000);
		expect(totalSec).toBe(60);
		expect(bars[0].leftPct).toBeCloseTo(0, 1);
		expect(bars[0].widthPct).toBeCloseTo(33.3, 0);
		expect(bars[1].leftPct).toBeCloseTo(33.3, 0);
		expect(bars[1].widthPct).toBeCloseTo(66.7, 0);

		expect(computeDiffSquares(80, 20)).toEqual(["add", "add", "add", "add", "del"]);
		expect(computeDiffSquares(10, 0)).toEqual(["add", "add", "add", "add", "add"]);
	});
});

describe("PR Lifecycle UI rendering", () => {
	const baseSurface: PrLifecycleSurface = {
		kind: "pr_lifecycle",
		surfaceId: "pr-1",
		sessionId: "sess-1",
		viewMode: "inline",
		phase: "conflicts",
		title: "Add checkout promo",
		headBranch: "feat/checkout-promo",
		baseBranch: "main",
		headSha: "abcdef1234567",
		headSubject: "add promo discount",
		prNumber: 128,
		prUrl: "https://github.com/org/repo/pull/128",
		filesChanged: 3,
		additions: 42,
		deletions: 8,
		commits: [
			{
				sha: "projected-merge",
				shortSha: "merge",
				parents: ["1111111", "2222222"],
				lane: 1,
				branchRefs: [],
				author: "Merge preview",
				relativeTime: "1 件の競合",
				subject: "main ← feat/checkout-promo",
				isMerge: true,
				isProjectedMerge: true,
				conflictCount: 1,
			},
			{
				sha: "1111111",
				shortSha: "1111111",
				parents: ["0000000"],
				lane: 1,
				branchRefs: ["feat/checkout-promo"],
				author: "You",
				relativeTime: "2m ago",
				subject: "add promo discount",
			},
			{
				sha: "2222222",
				shortSha: "2222222",
				parents: ["0000000"],
				lane: 0,
				branchRefs: ["main"],
				author: "Lena Park",
				relativeTime: "5m ago",
				subject: "adjust regional tax rate",
				conflictCount: 1,
			},
		],
		conflicts: [
			{
				id: "checkout.ts:2:0",
				file: "checkout.ts",
				line: 2,
				theirsAuthor: "Lena Park",
				theirsCommitSha: "2222222",
				theirsText: "export const taxRate = 0.095;",
				oursText: "export const taxRate = 0.10;",
				resolved: false,
			},
		],
		checks: [],
		createdAt: "2026-11-26T10:00:00.000Z",
		updatedAt: "2026-11-26T10:00:00.000Z",
	};

	it("renders inline PR card with 3-lane SVG, conflict chips, and Resolve CTA, and hides when docked", () => {
		const html = renderToStaticMarkup(
			<PrLifecycleCard surface={baseSurface} onAction={async () => undefined} onFile={() => undefined} />,
		);
		expect(html).toContain("Add checkout promo");
		expect(html).toContain("#128");
		expect(html).toContain('width="54"');
		expect(html).toContain("Lena Park");
		expect(html).toContain("競合を解消");

		const dockedHtml = renderToStaticMarkup(
			<PrLifecycleCard
				surface={{ ...baseSurface, viewMode: "docked_collapsed" }}
				onAction={async () => undefined}
				onFile={() => undefined}
			/>,
		);
		expect(dockedHtml).toBe("");
	});

	it("renders pre-PR dock pills and expanded CI waterfall drawer with inline assertion diff", () => {
		const summary: WorkspaceGitSummary = {
			isGitRepo: true,
			branch: "feat/checkout-promo",
			baseBranch: "main",
			filesChanged: 3,
			additions: 42,
			deletions: 8,
			aheadCommits: 1,
			hasRemote: true,
		};
		const preHtml = renderToStaticMarkup(
			<PrDockTray
				gitSummary={summary}
				onCreatePr={async () => undefined}
				onOpenReview={() => undefined}
				onFile={() => undefined}
			/>,
		);
		expect(preHtml).toContain("+42");
		expect(preHtml).toContain("-8");
		expect(preHtml).toContain("Create PR");

		const failedSurface: PrLifecycleSurface = {
			...baseSurface,
			viewMode: "docked_expanded",
			phase: "check_failed",
			conflicts: [],
			checks: [
				{
					id: "c1",
					name: "Typecheck",
					status: "completed",
					conclusion: "success",
					startedAt: "2026-11-26T10:00:00.000Z",
					completedAt: "2026-11-26T10:00:14.000Z",
					durationSec: 14,
				},
				{
					id: "c2",
					name: "E2E",
					status: "completed",
					conclusion: "failure",
					startedAt: "2026-11-26T10:00:14.000Z",
					completedAt: "2026-11-26T10:00:48.000Z",
					durationSec: 34,
					failure: {
						file: "tests/checkout.spec.ts",
						line: 47,
						testTitle: "Checkout › applies promo code",
						expected: '"$85.00"',
						received: '"$100.00"',
					},
				},
			],
		};
		const dockHtml = renderToStaticMarkup(
			<PrDockTray surface={failedSurface} onSurfaceAction={async () => undefined} onFile={() => undefined} />,
		);
		expect(dockHtml).toContain('width="18"');
		expect(dockHtml).toContain("E2E 失敗");
		expect(dockHtml).toContain("tests/checkout.spec.ts:47");
		expect(dockHtml).toContain("+ Expected: &quot;$85.00&quot;");
		expect(dockHtml).toContain("- Received: &quot;$100.00&quot;");
		expect(dockHtml).toContain("Fix");

		const mergedHtml = renderToStaticMarkup(
			<PrDockTray
				surface={{ ...failedSurface, viewMode: "docked_collapsed", phase: "merged" }}
				onSurfaceAction={async () => undefined}
				onFile={() => undefined}
			/>,
		);
		expect(mergedHtml).toContain("main にマージ済み");
	});
});
