import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	formatRateLimitReset,
	pickRateLimitMetrics,
	type ProviderAccountUsageView,
} from "../shared/account-usage.ts";
import type { GithubDashboard } from "../shared/home-dashboard.ts";
import { ACCOUNT_USAGE_ID, GITHUB_DASHBOARD_ID } from "../shared/plugin-profile.ts";
import {
	isFailedCheck,
	isPassedCheck,
	type PrLifecycleSurface,
	type WorkspaceGitSummary,
} from "../shared/pr-lifecycle.ts";
import { aggregateUsage, cacheReadPercent } from "../shared/usage.ts";
import { api } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { usePluginProfile } from "./plugins/profile.tsx";
import { sessionRecency } from "./session-recency.ts";
import type { RunStatus, SessionDetail, SessionSummary } from "./types.ts";
import { UsagePanel } from "./UsagePanel.tsx";
import "./ChatStatusBar.css";

const ACCOUNT_USAGE_TTL_MS = 300_000;
const ACCOUNT_USAGE_SETTLE_TTL_MS = 60_000;

let cachedAccountUsage: { views: ProviderAccountUsageView[]; fetchedAt: number } | undefined;

const ACTIVE_RUN_LABELS: Partial<Record<RunStatus, string>> = {
	running: "実行中",
	waiting: "応答待ち",
	queued: "順番待ち",
	cancelling: "停止中",
};

export function formatRunElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const paddedSeconds = String(seconds).padStart(2, "0");
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
	return `${minutes}:${paddedSeconds}`;
}

export function formatStatusTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return Math.round(value).toLocaleString("ja-JP");
}

export function formatStatusCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

export function summarizePrSurface(surface: PrLifecycleSurface): {
	label: string;
	tone: "neutral" | "active" | "success" | "warning" | "danger";
} {
	const prefix = surface.prNumber !== undefined ? `#${surface.prNumber} ` : "";
	const passed = surface.checks.filter((check) => isPassedCheck(check)).length;
	const failed = surface.checks.some((check) => isFailedCheck(check));
	const unresolved = surface.conflicts.filter((entry) => !entry.resolved).length;
	switch (surface.phase) {
		case "committing":
		case "pushing":
		case "opening":
			return { label: `${prefix}PR作成中`, tone: "active" };
		case "fetching":
		case "checking":
			return { label: `${prefix}確認中`, tone: "active" };
		case "conflicts":
			return { label: `${prefix}競合 ${unresolved}`, tone: "warning" };
		case "resolving":
			return { label: `${prefix}競合解消中`, tone: "active" };
		case "checks_running":
			return {
				label: surface.checks.length > 0 ? `${prefix}Checks ${passed}/${surface.checks.length}` : `${prefix}CI実行中`,
				tone: "active",
			};
		case "check_failed":
			return { label: failed ? `${prefix}CI失敗` : `${prefix}チェック失敗`, tone: "danger" };
		case "fixing":
			return { label: `${prefix}CI修正中`, tone: "active" };
		case "ready":
			return { label: `${prefix}マージ可`, tone: "success" };
		case "merging":
			return { label: `${prefix}マージ中`, tone: "active" };
		case "merged":
			return { label: `${prefix}マージ済`, tone: "success" };
		case "error":
			return { label: `${prefix}PRエラー`, tone: "danger" };
	}
}

function todayContributions(github?: GithubDashboard): number | undefined {
	const lastWeek = github?.contributions?.weeks.at(-1);
	const latestDay = lastWeek?.at(-1);
	return latestDay?.count;
}

export function ChatStatusBar({
	session,
	summaries,
	workspaceId,
	gitSummary,
	preferredProvider,
	connection,
	canOpenReview,
	onOpenReview,
	onOpenWorkOverview,
	onOpenSettings,
}: {
	session?: SessionDetail;
	summaries: readonly SessionSummary[];
	workspaceId?: string;
	gitSummary?: WorkspaceGitSummary;
	preferredProvider?: string;
	connection: "connecting" | "connected" | "disconnected";
	canOpenReview: boolean;
	onOpenReview: () => void;
	onOpenWorkOverview: () => void;
	onOpenSettings: () => void;
}) {
	const profile = usePluginProfile();
	const githubEnabled = profile?.activeIds.includes(GITHUB_DASHBOARD_ID) ?? false;
	const accountUsageEnabled = profile?.activeIds.includes(ACCOUNT_USAGE_ID) ?? false;

	const [github, setGithub] = useState<GithubDashboard>();
	const [githubRefresh, setGithubRefresh] = useState(0);
	const [githubOpen, setGithubOpen] = useState(false);
	const [githubPosition, setGithubPosition] = useState<{ left: number; bottom: number; maxHeight: number }>();
	const githubTriggerRef = useRef<HTMLButtonElement>(null);
	const githubPopoverRef = useRef<HTMLDivElement>(null);
	const githubPopoverId = useId();

	const [accountViews, setAccountViews] = useState<ProviderAccountUsageView[]>(() => cachedAccountUsage?.views ?? []);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const fallbackStartsRef = useRef(new Map<string, number>());

	const activeRun = session?.currentRun;
	const otherRunning = useMemo(
		() => summaries.filter((entry) => entry.workspaceId === workspaceId && entry.sessionId !== session?.sessionId && !!entry.currentRun),
		[summaries, workspaceId, session?.sessionId],
	);
	const anyRunning = !!activeRun || otherRunning.length > 0;
	const activeRunId = activeRun?.runId;
	const otherSingleRun = !activeRun && otherRunning.length === 1 ? otherRunning[0].currentRun : undefined;
	const trackedRun = activeRun ?? otherSingleRun;

	useEffect(() => {
		if (!anyRunning) return;
		setNowMs(Date.now());
		const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [anyRunning, activeRunId, otherSingleRun?.runId]);

	const elapsedMs = useMemo(() => {
		if (!trackedRun) return undefined;
		const parsed = trackedRun.startedAt ? Date.parse(trackedRun.startedAt) : Number.NaN;
		if (Number.isFinite(parsed)) return Math.max(0, nowMs - parsed);
		let started = fallbackStartsRef.current.get(trackedRun.runId);
		if (started === undefined) {
			started = nowMs;
			fallbackStartsRef.current.set(trackedRun.runId, started);
		}
		return Math.max(0, nowMs - started);
	}, [trackedRun, nowMs]);

	useEffect(() => {
		if (!githubEnabled) {
			setGithub(undefined);
			setGithubOpen(false);
			return;
		}
		const controller = new AbortController();
		void api<GithubDashboard>("/api/home/github", { signal: controller.signal })
			.then((value) => {
				if (!controller.signal.aborted) setGithub(value);
			})
			.catch(() => undefined);
		return () => controller.abort();
	}, [githubEnabled, githubRefresh]);

	const latestSettledAt = session?.latestRun?.settledAt;
	useEffect(() => {
		if (!accountUsageEnabled) {
			setAccountViews([]);
			return;
		}
		const now = Date.now();
		const ttl = latestSettledAt ? ACCOUNT_USAGE_SETTLE_TTL_MS : ACCOUNT_USAGE_TTL_MS;
		if (cachedAccountUsage && now - cachedAccountUsage.fetchedAt < ttl) {
			setAccountViews(cachedAccountUsage.views);
			return;
		}
		const controller = new AbortController();
		void api<ProviderAccountUsageView[]>("/api/account-usage", { signal: controller.signal })
			.then((views) => {
				if (controller.signal.aborted) return;
				cachedAccountUsage = { views, fetchedAt: Date.now() };
				setAccountViews(views);
			})
			.catch(() => undefined);
		return () => controller.abort();
	}, [accountUsageEnabled, latestSettledAt]);

	useLayoutEffect(() => {
		if (!githubOpen) return;
		const trigger = githubTriggerRef.current;
		if (!trigger) return;
		function updatePosition() {
			const bounds = trigger!.getBoundingClientRect();
			const vw = window.visualViewport?.width ?? window.innerWidth;
			const vh = window.visualViewport?.height ?? window.innerHeight;
			const width = Math.min(360, vw - 24);
			const left = Math.max(12, Math.min(bounds.left, vw - width - 12));
			setGithubPosition({
				left,
				bottom: window.innerHeight - bounds.top + 8,
				maxHeight: Math.max(200, Math.min(440, vh * 0.65, bounds.top - 20)),
			});
		}
		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [githubOpen]);

	useEffect(() => {
		if (!githubOpen) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Node | null;
			if (!githubTriggerRef.current?.contains(target) && !githubPopoverRef.current?.contains(target)) {
				setGithubOpen(false);
			}
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			setGithubOpen(false);
			githubTriggerRef.current?.focus();
		}
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [githubOpen]);

	const activePrSurface = session?.surfaces?.findLast(
		(entry): entry is PrLifecycleSurface => entry.kind === "pr_lifecycle",
	);
	const prSummary = activePrSurface ? summarizePrSurface(activePrSurface) : undefined;
	const branch = gitSummary?.branch ?? session?.splitBranch;
	const hasGitChanges = !!gitSummary?.isGitRepo && (gitSummary.filesChanged > 0 || gitSummary.additions > 0 || gitSummary.deletions > 0);
	const openPr = gitSummary?.openPr;

	const sessionHasUsage = !!session?.usage?.length;
	const usageRows = useMemo(
		() => (sessionHasUsage ? (session?.usage ?? []) : aggregateUsage(summaries.map((entry) => entry.usage ?? []))),
		[sessionHasUsage, session?.usage, summaries],
	);
	const usageTotals = useMemo(() => {
		let tokens = 0;
		let cost = 0;
		let responses = 0;
		let input = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let unpriced = false;
		for (const row of usageRows) {
			tokens += row.input + row.output + row.cacheRead + row.cacheWrite;
			cost += row.cost;
			responses += row.responses;
			input += row.input;
			cacheRead += row.cacheRead;
			cacheWrite += row.cacheWrite;
			if (row.provider === "devin") unpriced = true;
		}
		const cachePct = cacheReadPercent({ input, cacheRead, cacheWrite });
		return { tokens, cost, responses, cachePct, unpriced };
	}, [usageRows]);
	const usageGroups = useMemo(
		() =>
			sessionHasUsage && session
				? [{ id: session.sessionId, label: session.parentSessionId ? "子AI" : "この会話", usage: session.usage }]
				: [{ id: "workspace-all", label: "全体", usage: usageRows }],
		[sessionHasUsage, session, usageRows],
	);

	const rateLimits = useMemo(
		() => pickRateLimitMetrics(accountViews, preferredProvider),
		[accountViews, preferredProvider],
	);
	const sessionQuotaPct = rateLimits.session?.usedPercent !== undefined ? Math.round(rateLimits.session.usedPercent) : undefined;
	const weeklyQuotaPct = rateLimits.weekly?.usedPercent !== undefined ? Math.round(rateLimits.weekly.usedPercent) : undefined;
	const highestQuota = Math.max(sessionQuotaPct ?? 0, weeklyQuotaPct ?? 0);
	const quotaTone = highestQuota >= 95 ? "danger" : highestQuota >= 80 ? "warning" : undefined;
	const quotaTitle = useMemo(() => {
		const parts: string[] = [];
		if (rateLimits.providerName) parts.push(rateLimits.providerName);
		if (rateLimits.session && sessionQuotaPct !== undefined) {
			const reset = formatRateLimitReset(rateLimits.session.resetsAt);
			parts.push(`${rateLimits.session.label}: ${sessionQuotaPct}%${reset ? `（${reset}）` : ""}`);
		}
		if (rateLimits.weekly && weeklyQuotaPct !== undefined) {
			const reset = formatRateLimitReset(rateLimits.weekly.resetsAt);
			parts.push(`${rateLimits.weekly.label}: ${weeklyQuotaPct}%${reset ? `（${reset}）` : ""}`);
		}
		return parts.join(" · ");
	}, [rateLimits, sessionQuotaPct, weeklyQuotaPct]);

	const runLabel = activeRun ? (ACTIVE_RUN_LABELS[activeRun.status] ?? "実行中") : undefined;
	const runTone = activeRun?.status === "waiting" || activeRun?.status === "cancelling" ? "warning" : "active";
	const githubReady = githubEnabled && github?.state === "ready";
	const todayCount = todayContributions(github);

	return (
		<footer className="chat-status-bar" aria-label="ステータスバー">
			<div className="chat-status-group is-left">
				{branch &&
					(canOpenReview ? (
						<button
							type="button"
							className="chat-status-item chat-status-branch-btn"
							onClick={onOpenReview}
							title={`ブランチ: ${branch}${gitSummary?.aheadCommits ? ` (未プッシュ ↑${gitSummary.aheadCommits})` : ""} · クリックで変更をレビュー`}
						>
							<Icon name="gitBranch" size="inline" />
							<span className="chat-status-branch">{branch}</span>
							{!!gitSummary?.aheadCommits && <span className="chat-status-muted">↑{gitSummary.aheadCommits}</span>}
						</button>
					) : (
						<span
							className="chat-status-item"
							title={`ブランチ: ${branch}${gitSummary?.aheadCommits ? ` (未プッシュ ↑${gitSummary.aheadCommits})` : ""}`}
						>
							<Icon name="gitBranch" size="inline" />
							<span className="chat-status-branch">{branch}</span>
							{!!gitSummary?.aheadCommits && <span className="chat-status-muted">↑{gitSummary.aheadCommits}</span>}
						</span>
					))}

				{hasGitChanges &&
					gitSummary &&
					(canOpenReview ? (
						<button
							type="button"
							className={`chat-status-item chat-status-diff${anyRunning ? " chat-status-hide-narrow" : ""}`}
							onClick={onOpenReview}
							title={`${gitSummary.filesChanged} ファイルに変更 (+${gitSummary.additions} -${gitSummary.deletions}) · クリックでレビュー`}
						>
							<span className="chat-status-add">+{gitSummary.additions}</span>
							<span className="chat-status-del">-{gitSummary.deletions}</span>
							<span className="chat-status-muted chat-status-hide-narrow">{gitSummary.filesChanged}件</span>
						</button>
					) : (
						<span
							className={`chat-status-item chat-status-diff${anyRunning ? " chat-status-hide-narrow" : ""}`}
							title={`${gitSummary.filesChanged} ファイルに変更 (+${gitSummary.additions} -${gitSummary.deletions})`}
						>
							<span className="chat-status-add">+{gitSummary.additions}</span>
							<span className="chat-status-del">-{gitSummary.deletions}</span>
							<span className="chat-status-muted chat-status-hide-narrow">{gitSummary.filesChanged}件</span>
						</span>
					))}

				{activePrSurface && prSummary ? (
					activePrSurface.prUrl ? (
						<a
							className={`chat-status-item is-${prSummary.tone}`}
							href={activePrSurface.prUrl}
							target="_blank"
							rel="noopener noreferrer"
							title={activePrSurface.title}
						>
							<Icon
								name={
									activePrSurface.phase === "merged"
										? "gitMerge"
										: activePrSurface.phase === "conflicts"
											? "warning"
											: "gitPr"
								}
								size="inline"
							/>
							<span>{prSummary.label}</span>
						</a>
					) : (
						<span className={`chat-status-item is-${prSummary.tone}`} title={activePrSurface.title}>
							<Icon name="gitPr" size="inline" />
							<span>{prSummary.label}</span>
						</span>
					)
				) : (
					openPr && (
						<a
							className="chat-status-item"
							href={openPr.url}
							target="_blank"
							rel="noopener noreferrer"
							title={`PR #${openPr.number}: ${openPr.title}`}
						>
							<Icon name="gitPr" size="inline" />
							<span>
								#{openPr.number}
								{openPr.isDraft ? " Draft" : ""}
							</span>
						</a>
					)
				)}

				{githubReady && (
					<button
						ref={githubTriggerRef}
						type="button"
						className={`chat-status-item chat-status-github${githubOpen ? " is-open" : ""}${activePrSurface || openPr ? " chat-status-hide-narrow" : ""}`}
						aria-haspopup="dialog"
						aria-expanded={githubOpen}
						aria-controls={githubPopoverId}
						title={
							github.login
								? `GitHub @${github.login}${github.pullRequestCount !== undefined ? ` · 未完了PR ${github.pullRequestCount}件` : ""}${github.contributions ? ` · 年間 ${github.contributions.total.toLocaleString("ja-JP")} contributions` : ""}`
								: "GitHub ステータス"
						}
						onClick={() => setGithubOpen((value) => !value)}
					>
						<Icon name="gitPr" size="inline" />
						{github.login && <span className="chat-status-hide-medium">@{github.login}</span>}
						{github.login && github.pullRequestCount !== undefined && (
							<span className="chat-status-sep chat-status-hide-medium" aria-hidden="true">
								·
							</span>
						)}
						{github.pullRequestCount !== undefined && (
							<span className="chat-status-pr-count">PR {github.pullRequestCount}</span>
						)}
					</button>
				)}

				{activeRun && elapsedMs !== undefined ? (
					<button
						type="button"
						className={`chat-status-item chat-status-running is-${runTone}`}
						onClick={onOpenWorkOverview}
						title={`${runLabel} (${formatRunElapsed(elapsedMs)})${session?.activeActivity ? ` · ${session.activeActivity}` : ""} · クリックで作業一覧を開く`}
					>
						<span className="chat-status-pulse" aria-hidden="true" />
						<Icon name="clock" size="inline" className="chat-status-hide-narrow" />
						<span>{runLabel}</span>
						<span className="chat-status-elapsed">{formatRunElapsed(elapsedMs)}</span>
					</button>
				) : (
					otherRunning.length > 0 && (
						<button
							type="button"
							className="chat-status-item chat-status-running is-active"
							onClick={onOpenWorkOverview}
							title={`他の会話で ${otherRunning.length} 件実行中 · クリックで作業一覧を開く`}
						>
							<span className="chat-status-pulse" aria-hidden="true" />
							<span>
								他{otherRunning.length}件実行中
								{elapsedMs !== undefined ? ` ${formatRunElapsed(elapsedMs)}` : ""}
							</span>
						</button>
					)
				)}
			</div>

			<div className="chat-status-group is-right">
				{connection !== "connected" && (
					<span className="chat-status-item is-warning" role="status">
						{connection === "connecting" ? "接続中…" : "再接続中"}
					</span>
				)}

				{usageRows.length > 0 && (
					<UsagePanel
						title={sessionHasUsage ? "この会話の使用量" : "全体の使用量"}
						groups={usageGroups}
						trigger={
							<span
								className="chat-status-usage-label"
								title={`${sessionHasUsage ? "この会話" : "全体"}: ${formatStatusTokens(usageTotals.tokens)} トークン · ${usageTotals.unpriced ? "一部未計測" : formatStatusCost(usageTotals.cost)}${usageTotals.cachePct !== null ? ` · キャッシュ ${usageTotals.cachePct.toFixed(1)}%` : ""} · ${usageTotals.responses}応答`}
							>
								<span className={usageTotals.unpriced ? undefined : "chat-status-hide-narrow"}>
									{!sessionHasUsage && "全体 "}
									{formatStatusTokens(usageTotals.tokens)} tok
								</span>
								{!usageTotals.unpriced && (
									<>
										<span className="chat-status-sep chat-status-hide-narrow" aria-hidden="true">
											·
										</span>
										<span>{formatStatusCost(usageTotals.cost)}</span>
									</>
								)}
							</span>
						}
					/>
				)}

				{sessionQuotaPct !== undefined && (
					<button
						type="button"
						className={`chat-status-item chat-status-hide-narrow${quotaTone ? ` is-${quotaTone}` : ""}`}
						onClick={onOpenSettings}
						title={`${quotaTitle} · クリックで設定を開く`}
					>
						<span>
							枠 {sessionQuotaPct}%{weeklyQuotaPct !== undefined ? ` · 週 ${weeklyQuotaPct}%` : ""}
						</span>
					</button>
				)}
			</div>

			{githubReady &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						ref={githubPopoverRef}
						id={githubPopoverId}
						className="chat-status-popover"
						role="dialog"
						aria-label="GitHub ステータス"
						style={githubPosition}
						hidden={!githubOpen}
						inert={!githubOpen}
					>
						<header className="chat-status-popover-head">
							{github.login && github.profileUrl ? (
								<a href={github.profileUrl} target="_blank" rel="noopener noreferrer">
									<Icon name="gitPr" size="inline" />
									<span>@{github.login}</span>
									<Icon name="arrowUpRight" size="inline" />
								</a>
							) : (
								<span>GitHub</span>
							)}
							<div className="chat-status-popover-actions">
								<button
									type="button"
									aria-label="GitHub を再読み込み"
									title="再読み込み"
									onClick={() => setGithubRefresh((value) => value + 1)}
								>
									<Icon name="refresh" size="inline" />
								</button>
								<button
									type="button"
									aria-label="GitHub ステータスを閉じる"
									title="閉じる"
									onClick={() => {
										setGithubOpen(false);
										githubTriggerRef.current?.focus();
									}}
								>
									<Icon name="close" size="inline" />
								</button>
							</div>
						</header>
						{github.contributions && (
							<div className="chat-status-popover-meta">
								<span>過去1年 {github.contributions.total.toLocaleString("ja-JP")} contributions</span>
								{todayCount !== undefined && <span>今日 {todayCount}</span>}
							</div>
						)}
						<div className="chat-status-popover-body">
							<div className="chat-status-popover-section-title">
								<span>未完了の Pull Request</span>
								{github.pullRequestCount !== undefined && <span>{github.pullRequestCount}件</span>}
							</div>
							{github.pullRequests && github.pullRequests.length > 0 ? (
								<ul className="chat-status-pr-list">
									{github.pullRequests.map((pr) => (
										<li key={pr.url}>
											<a href={pr.url} target="_blank" rel="noopener noreferrer">
												<strong>{pr.title}</strong>
												<small>
													{pr.repository} #{pr.number} ·{" "}
													{pr.draft
														? "Draft"
														: pr.review === "APPROVED"
															? "Approved"
															: pr.review === "CHANGES_REQUESTED"
																? "Changes requested"
																: "Open"}{" "}
													· {sessionRecency(pr.updatedAt)}
												</small>
											</a>
										</li>
									))}
								</ul>
							) : (
								<p className="chat-status-popover-empty">未完了の Pull Request はありません。</p>
							)}
						</div>
					</div>,
					document.body,
				)}
		</footer>
	);
}
