import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	ChatStatusBar,
	formatRunElapsed,
	formatStatusCost,
	formatStatusTokens,
	summarizePrSurface,
} from "../src/client/ChatStatusBar.tsx";
import type { SessionDetail, SessionSummary } from "../src/client/types.ts";
import { pickRateLimitMetrics, type ProviderAccountUsageView } from "../src/shared/account-usage.ts";
import type { PrLifecycleSurface, WorkspaceGitSummary } from "../src/shared/pr-lifecycle.ts";

describe("ChatStatusBar formatters", () => {
	it("formats active run elapsed durations", () => {
		expect(formatRunElapsed(-500)).toBe("0:00");
		expect(formatRunElapsed(0)).toBe("0:00");
		expect(formatRunElapsed(5_000)).toBe("0:05");
		expect(formatRunElapsed(65_000)).toBe("1:05");
		expect(formatRunElapsed(3_599_000)).toBe("59:59");
		expect(formatRunElapsed(3_725_000)).toBe("1:02:05");
	});

	it("formats token counts and USD costs concisely", () => {
		expect(formatStatusTokens(0)).toBe("0");
		expect(formatStatusTokens(850)).toBe("850");
		expect(formatStatusTokens(16_850)).toBe("16.9k");
		expect(formatStatusTokens(1_000_000)).toBe("1M");
		expect(formatStatusTokens(1_250_000)).toBe("1.3M");

		expect(formatStatusCost(0)).toBe("$0.00");
		expect(formatStatusCost(0.0023)).toBe("$0.0023");
		expect(formatStatusCost(0.042)).toBe("$0.042");
		expect(formatStatusCost(1.24)).toBe("$1.24");
	});

	it("summarizes PR lifecycle phases for the status bar", () => {
		const base: PrLifecycleSurface = {
			kind: "pr_lifecycle",
			surfaceId: "s1",
			sessionId: "sess-1",
			viewMode: "docked_collapsed",
			phase: "checks_running",
			title: "Add status bar",
			headBranch: "feat/status-bar",
			baseBranch: "main",
			prNumber: 42,
			filesChanged: 3,
			additions: 42,
			deletions: 12,
			commits: [],
			conflicts: [],
			checks: [
				{ id: "c1", name: "lint", status: "completed", conclusion: "success" },
				{ id: "c2", name: "test", status: "in_progress" },
			],
			createdAt: "2026-11-28T00:00:00Z",
			updatedAt: "2026-11-28T00:00:00Z",
		};
		expect(summarizePrSurface(base)).toEqual({ label: "#42 Checks 1/2", tone: "active" });
		expect(summarizePrSurface({ ...base, phase: "ready" })).toEqual({ label: "#42 マージ可", tone: "success" });
		expect(summarizePrSurface({ ...base, phase: "merged" })).toEqual({ label: "#42 マージ済", tone: "success" });
		expect(
			summarizePrSurface({
				...base,
				phase: "check_failed",
				checks: [{ id: "c1", name: "test", status: "completed", conclusion: "failure" }],
			}),
		).toEqual({ label: "#42 CI失敗", tone: "danger" });
		expect(
			summarizePrSurface({
				...base,
				phase: "conflicts",
				conflicts: [
					{ id: "k1", file: "a.ts", theirsText: "a", oursText: "b", resolved: false },
					{ id: "k2", file: "b.ts", theirsText: "a", oursText: "b", resolved: true },
				],
			}),
		).toEqual({ label: "#42 競合 1", tone: "warning" });
	});

	it("picks preferred provider session and weekly rate-limit metrics", () => {
		const views: ProviderAccountUsageView[] = [
			{
				provider: "openai",
				name: "OpenAI",
				status: "ok",
				checkedAt: 1000,
				usage: {
					metrics: [{ id: "5h", label: "5h window", usedPercent: 12 }],
				},
			},
			{
				provider: "anthropic",
				name: "Anthropic",
				status: "ok",
				checkedAt: 1000,
				usage: {
					metrics: [
						{ id: "session", label: "5時間枠", usedPercent: 38 },
						{ id: "weekly", label: "週次枠", usedPercent: 24 },
					],
				},
			},
		];
		const picked = pickRateLimitMetrics(views, "anthropic");
		expect(picked.providerName).toBe("Anthropic");
		expect(picked.session?.usedPercent).toBe(38);
		expect(picked.weekly?.usedPercent).toBe(24);
	});
});

const sampleGit: WorkspaceGitSummary = {
	isGitRepo: true,
	branch: "web-harness",
	filesChanged: 3,
	additions: 42,
	deletions: 12,
	aheadCommits: 2,
	hasRemote: true,
	openPr: {
		number: 42,
		title: "Status bar",
		url: "https://github.com/example/repo/pull/42",
		state: "OPEN",
	},
};

const baseSession: SessionDetail = {
	sessionId: "sess-1",
	workspaceId: "ws-1",
	cwd: "/tmp/repo",
	title: "テスト会話",
	materialized: true,
	availability: "ready",
	pendingInput: [],
	messages: [],
	toolCalls: [],
	activity: {},
	contextUsage: { tokens: 42_000, contextWindow: 200_000, percent: 21 },
	usage: [
		{
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			input: 10_000,
			output: 2_000,
			cacheRead: 4_000,
			cacheWrite: 850,
			cost: 0.042,
			responses: 2,
			failures: 0,
			auxiliary: 0,
		},
	],
};

describe("ChatStatusBar rendering", () => {
	it("shows git, PR, context, usage, and model without a run timer when idle", () => {
		const html = renderToStaticMarkup(
			<ChatStatusBar
				session={baseSession}
				summaries={[]}
				workspaceId="ws-1"
				gitSummary={sampleGit}
				model={{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }}
				thinkingLabel="medium"
				contextWindow={200_000}
				connection="connected"
				canOpenReview
				onOpenReview={() => undefined}
				onOpenWorkOverview={() => undefined}
				onOpenModelMenu={() => undefined}
				onOpenSettings={() => undefined}
			/>,
		);
		expect(html).toContain("web-harness");
		expect(html).toContain("↑2");
		expect(html).toContain("+42");
		expect(html).toContain("-12");
		expect(html).toContain("#42");
		expect(html).toContain("21%");
		expect(html).toContain("16.9k tok");
		expect(html).toContain("$0.042");
		expect(html).toContain("Claude Sonnet 4.5");
		expect(html).not.toContain("chat-status-running");
	});

	it("shows the active AI execution status and elapsed timer while running", () => {
		const runningSession: SessionDetail = {
			...baseSession,
			currentRun: {
				runId: "run-live",
				agentId: "agent-1",
				task: "Run tests",
				status: "running",
				startedAt: new Date(Date.now() - 15_000).toISOString(),
			},
		};
		const html = renderToStaticMarkup(
			<ChatStatusBar
				session={runningSession}
				summaries={[]}
				workspaceId="ws-1"
				gitSummary={sampleGit}
				model={{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }}
				contextWindow={200_000}
				connection="connected"
				canOpenReview
				onOpenReview={() => undefined}
				onOpenWorkOverview={() => undefined}
				onOpenModelMenu={() => undefined}
				onOpenSettings={() => undefined}
			/>,
		);
		expect(html).toContain("chat-status-running");
		expect(html).toContain("実行中");
		expect(html).toMatch(/chat-status-elapsed">0:1[456]/);
	});

	it("aggregates workspace usage on the new-conversation home screen", () => {
		const summaries: SessionSummary[] = [
			{
				sessionId: "sess-a",
				workspaceId: "ws-1",
				cwd: "/tmp/repo",
				materialized: true,
				availability: "ready",
				pendingInput: [],
				usage: [
					{
						provider: "openai",
						model: "gpt-5.2",
						input: 50_000,
						output: 5_000,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 1.24,
						responses: 3,
						failures: 0,
						auxiliary: 0,
					},
				],
			},
		];
		const html = renderToStaticMarkup(
			<ChatStatusBar
				summaries={summaries}
				workspaceId="ws-1"
				gitSummary={sampleGit}
				connection="connected"
				canOpenReview={false}
				onOpenReview={() => undefined}
				onOpenWorkOverview={() => undefined}
				onOpenModelMenu={() => undefined}
				onOpenSettings={() => undefined}
			/>,
		);
		expect(html).toContain("web-harness");
		expect(html).toContain("全体 ");
		expect(html).toContain("55.0k tok");
		expect(html).toContain("$1.24");
	});
});
