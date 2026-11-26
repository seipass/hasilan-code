import { useEffect, useMemo, useState } from "react";
import {
	isFailedCheck,
	isPassedCheck,
	type PrCiCheck,
	type PrLifecycleSurface,
	type WorkspaceGitSummary,
} from "../shared/pr-lifecycle.ts";
import type { SurfaceAction } from "../shared/surfaces.ts";
import { Icon } from "./Icon.tsx";
import { Presence } from "./Motion.tsx";
import "./PrDockTray.css";

export interface WaterfallBar {
	check: PrCiCheck;
	leftPct: number;
	widthPct: number;
	elapsedSec?: number;
}

export function computeDiffSquares(additions: number, deletions: number): ("add" | "del" | "neutral")[] {
	const total = additions + deletions;
	if (total <= 0) return ["neutral", "neutral", "neutral", "neutral", "neutral"];
	let addCount = Math.round((additions / total) * 5);
	let delCount = Math.round((deletions / total) * 5);
	if (additions > 0 && addCount === 0) addCount = 1;
	if (deletions > 0 && delCount === 0) delCount = 1;
	while (addCount + delCount > 5) {
		if (addCount >= delCount) addCount -= 1;
		else delCount -= 1;
	}
	const squares: ("add" | "del" | "neutral")[] = [];
	for (let i = 0; i < addCount; i++) squares.push("add");
	for (let i = 0; i < delCount; i++) squares.push("del");
	while (squares.length < 5) squares.push("neutral");
	return squares;
}

export function computeWaterfallBars(
	checks: readonly PrCiCheck[],
	fallbackStart?: string,
	nowMs = Date.now(),
): { bars: WaterfallBar[]; totalSec: number } {
	if (checks.length === 0) return { bars: [], totalSec: 0 };
	const parsedStarts = checks
		.map((check) => (check.startedAt ? Date.parse(check.startedAt) : NaN))
		.filter((ms) => Number.isFinite(ms));
	const fallbackMs = fallbackStart ? Date.parse(fallbackStart) : NaN;
	const minStart =
		parsedStarts.length > 0
			? Math.min(...parsedStarts)
			: Number.isFinite(fallbackMs)
				? fallbackMs
				: nowMs - 10_000;

	let maxEnd = minStart + 1000;
	for (const check of checks) {
		const start = check.startedAt ? Date.parse(check.startedAt) : NaN;
		const completed = check.completedAt ? Date.parse(check.completedAt) : NaN;
		if (Number.isFinite(completed)) {
			maxEnd = Math.max(maxEnd, completed);
		} else if (check.status === "in_progress") {
			maxEnd = Math.max(maxEnd, nowMs);
		} else if (Number.isFinite(start) && check.durationSec !== undefined) {
			maxEnd = Math.max(maxEnd, start + check.durationSec * 1000);
		}
	}

	const spanMs = Math.max(1000, maxEnd - minStart);
	const bars: WaterfallBar[] = checks.map((check, index) => {
		const startMs = check.startedAt && Number.isFinite(Date.parse(check.startedAt)) ? Date.parse(check.startedAt) : minStart;
		const endMs =
			check.completedAt && Number.isFinite(Date.parse(check.completedAt))
				? Date.parse(check.completedAt)
				: check.status === "in_progress"
					? nowMs
					: check.durationSec !== undefined
						? startMs + check.durationSec * 1000
						: startMs;
		const clampedStart = Math.max(minStart, startMs);
		const clampedEnd = Math.max(clampedStart, endMs);
		const leftPct =
			check.status === "queued" && !check.startedAt
				? Math.min(82, (index / Math.max(checks.length, 1)) * 20)
				: Math.min(94, ((clampedStart - minStart) / spanMs) * 100);
		const rawWidth = ((clampedEnd - clampedStart) / spanMs) * 100;
		const widthPct =
			check.status === "queued" ? 8 : Math.max(6, Math.min(100 - leftPct, rawWidth));
		const elapsedSec =
			check.durationSec ??
			(check.status === "queued" ? undefined : Math.max(0, Math.round((clampedEnd - clampedStart) / 1000)));
		return { check, leftPct, widthPct, elapsedSec };
	});

	return { bars, totalSec: Math.max(0, Math.round((maxEnd - minStart) / 1000)) };
}

function formatSec(sec?: number): string {
	if (sec === undefined || !Number.isFinite(sec)) return "";
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

function SegmentedChecksRing({ surface }: { surface: PrLifecycleSurface }) {
	if (surface.phase === "merged") {
		return (
			<span className="pr-dock-ring-badge is-merged" aria-hidden="true">
				<Icon name="gitMerge" size="inline" />
			</span>
		);
	}
	if (surface.phase === "conflicts") {
		return (
			<span className="pr-dock-ring-badge is-warning" aria-hidden="true">
				<Icon name="warning" size="inline" />
			</span>
		);
	}
	const count = Math.max(1, surface.checks.length);
	const radius = 6.5;
	const circumference = 2 * Math.PI * radius;
	const gap = count > 1 ? 2.4 : 0;
	const segLength = Math.max(1.5, circumference / count - gap);

	return (
		<svg
			className="pr-dock-ring"
			width={18}
			height={18}
			viewBox="0 0 18 18"
			aria-hidden="true"
		>
			{surface.checks.length === 0 ? (
				<circle
					cx="9"
					cy="9"
					r={radius}
					fill="none"
					stroke={surface.phase === "ready" ? "var(--success)" : "var(--secondary)"}
					strokeWidth="2"
					strokeDasharray={surface.phase === "ready" ? undefined : "18 12"}
				/>
			) : (
				surface.checks.map((check, index) => {
					const stroke = isFailedCheck(check)
						? "var(--danger)"
						: isPassedCheck(check)
							? "var(--success)"
							: check.status === "in_progress"
								? "var(--secondary)"
								: "var(--border-strong)";
					const offset = -(index * (circumference / count));
					return (
						<circle
							key={check.id}
							cx="9"
							cy="9"
							r={radius}
							fill="none"
							stroke={stroke}
							strokeWidth="2"
							strokeLinecap="round"
							strokeDasharray={`${segLength} ${circumference - segLength}`}
							strokeDashoffset={offset}
							transform="rotate(-90 9 9)"
						/>
					);
				})
			)}
		</svg>
	);
}

function statusSummary(surface: PrLifecycleSurface): string {
	const unresolved = surface.conflicts.filter((entry) => !entry.resolved).length;
	const passed = surface.checks.filter((check) => isPassedCheck(check)).length;
	const failed = surface.checks.find((check) => isFailedCheck(check));

	switch (surface.phase) {
		case "committing":
			return "変更をコミット中…";
		case "pushing":
			return "ブランチをプッシュ中…";
		case "opening":
			return "PR を作成中…";
		case "fetching":
		case "checking":
			return "競合とチェックを確認中…";
		case "conflicts":
			return `競合 ${unresolved} 件`;
		case "resolving":
			return "競合を解消中…";
		case "checks_running":
			return surface.checks.length > 0 ? `Checks ${passed}/${surface.checks.length}` : "CI チェック実行中…";
		case "check_failed":
			return failed ? `${failed.name} 失敗` : "CI チェック失敗";
		case "fixing":
			return `${surface.fixingCheckName ?? "CI"} を修正中…`;
		case "ready":
			return surface.checks.length > 0 ? "すべてのチェックが通過" : "マージ可能";
		case "merging":
			return "マージ中…";
		case "merged":
			return `${surface.baseBranch} にマージ済み`;
		case "error":
			return surface.error ?? "エラー";
	}
}

export function PrDockTray({
	gitSummary,
	surface,
	creating = false,
	onCreatePr,
	onOpenReview,
	onSurfaceAction,
	onFile,
}: {
	gitSummary?: WorkspaceGitSummary;
	surface?: PrLifecycleSurface;
	creating?: boolean;
	onCreatePr?: () => Promise<void>;
	onOpenReview?: () => void;
	onSurfaceAction?: (surfaceId: string, action: SurfaceAction) => Promise<void>;
	onFile: (path: string, line?: number) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const hasRunningChecks = !!surface?.checks.some((check) => check.status === "in_progress");

	useEffect(() => {
		if (!hasRunningChecks) return;
		const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [hasRunningChecks]);

	const waterfall = useMemo(
		() => (surface ? computeWaterfallBars(surface.checks, surface.checksStartedAt, nowMs) : { bars: [], totalSec: 0 }),
		[surface, nowMs],
	);

	// Pre-PR composer dock pills (diffstat + Create PR)
	if (!surface) {
		if (!gitSummary?.isGitRepo) return null;
		const hasActivity = gitSummary.filesChanged > 0 || gitSummary.aheadCommits > 0 || !!gitSummary.openPr;
		if (!hasActivity) return null;
		const squares = computeDiffSquares(gitSummary.additions, gitSummary.deletions);

		return (
			<div className="composer-dock-pills pr-dock-pre">
				{(gitSummary.filesChanged > 0 || gitSummary.additions > 0 || gitSummary.deletions > 0) && (
					<button
						type="button"
						className="pr-dock-diffstat-pill"
						onClick={onOpenReview}
						disabled={!onOpenReview}
						title="変更の差分をレビュー"
					>
						<span className="pr-diff-files">{gitSummary.filesChanged} ファイル</span>
						<span className="is-add">+{gitSummary.additions}</span>
						<span className="is-del">-{gitSummary.deletions}</span>
						<span className="pr-diff-squares" aria-hidden="true">
							{squares.map((tone, index) => (
								<span key={index} className={`pr-diff-sq is-${tone}`} />
							))}
						</span>
					</button>
				)}
				{onCreatePr && (
					<button
						type="button"
						className="pr-dock-create-pill"
						disabled={creating}
						onClick={() => void onCreatePr()}
					>
						<Icon name="gitPr" size="inline" />
						<span>
							{creating
								? "PR を準備中…"
								: gitSummary.openPr
									? `PR #${gitSummary.openPr.number} を表示`
									: "Create PR"}
						</span>
					</button>
				)}
			</div>
		);
	}

	const expanded = surface.viewMode === "docked_expanded";
	const docked = surface.viewMode !== "inline";
	const failedCheck = surface.checks.find((check) => isFailedCheck(check));
	const unresolvedConflicts = surface.conflicts.filter((entry) => !entry.resolved);

	async function dispatch(action: SurfaceAction) {
		if (!surface || !onSurfaceAction || busy) return;
		setBusy(true);
		try {
			await onSurfaceAction(surface.surfaceId, action);
		} finally {
			setBusy(false);
		}
	}

	function toggleDrawer() {
		if (!surface) return;
		const next = expanded ? "docked_collapsed" : "docked_expanded";
		void dispatch({ type: "set_pr_view_mode", viewMode: next });
	}

	return (
		<section
			className={`composer-dock-tray pr-dock-tray is-${surface.phase}${docked ? " is-docked" : " is-sync"}`}
			aria-label="Pull Request ステータス"
		>
			<div className="pr-dock-header">
				<button
					type="button"
					className="pr-dock-summary-btn"
					aria-expanded={expanded}
					onClick={toggleDrawer}
				>
					<SegmentedChecksRing surface={surface} />
					<strong className="pr-dock-id">
						{surface.prNumber !== undefined ? `#${surface.prNumber}` : surface.headBranch}
					</strong>
					<span className={`pr-dock-status is-${surface.phase}`}>{statusSummary(surface)}</span>
				</button>

				<div className="pr-dock-actions">
					{surface.phase === "conflicts" && (
						<button
							type="button"
							className="pr-dock-action-btn is-warning"
							disabled={busy}
							onClick={() => void dispatch({ type: "resolve_conflicts" })}
						>
							競合を解消
						</button>
					)}
					{surface.phase === "check_failed" && failedCheck && (
						<button
							type="button"
							className="pr-dock-action-btn is-danger"
							disabled={busy}
							onClick={() => void dispatch({ type: "fix_ci", checkName: failedCheck.name })}
						>
							Fix
						</button>
					)}
					{surface.phase === "ready" && surface.prNumber !== undefined && (
						<button
							type="button"
							className="pr-dock-action-btn is-primary"
							disabled={busy}
							onClick={() => void dispatch({ type: "merge_pr", method: "merge" })}
						>
							<Icon name="gitMerge" size="inline" />
							<span>Merge</span>
						</button>
					)}
					{surface.phase === "merged" && surface.prUrl && (
						<a
							className="pr-dock-link-btn"
							href={surface.prUrl}
							target="_blank"
							rel="noreferrer"
						>
							<span>GitHub</span>
							<Icon name="external" size="inline" />
						</a>
					)}
					{docked && (
						<button
							type="button"
							className="pr-dock-icon-btn"
							aria-label="インライン表示に戻す"
							title="インライン表示に戻す"
							disabled={busy}
							onClick={() => void dispatch({ type: "set_pr_view_mode", viewMode: "inline" })}
						>
							<Icon name="dock" size="inline" />
						</button>
					)}
					<button
						type="button"
						className="pr-dock-icon-btn"
						aria-label={expanded ? "チェック詳細を閉じる" : "チェック詳細を開く"}
						title={expanded ? "チェック詳細を閉じる" : "チェック詳細を開く"}
						onClick={toggleDrawer}
					>
						<Icon name={expanded ? "chevronDown" : "chevronUp"} size="inline" />
					</button>
				</div>
			</div>

			<Presence show={expanded} collapse>
				<div className="composer-dock-tray-body pr-dock-drawer">
					<div className="pr-dock-drawer-head">
						<span className="pr-dock-commit-line">
							<span>Checks on</span>
							{surface.headSha && <code>{surface.headSha.slice(0, 7)}</code>}
							<span className="pr-dock-commit-subject">{surface.headSubject ?? surface.title}</span>
						</span>
						<span className="pr-dock-drawer-right">
							{waterfall.totalSec > 0 && <span className="pr-dock-elapsed">{formatSec(waterfall.totalSec)}</span>}
							<button
								type="button"
								className="pr-dock-icon-btn"
								aria-label="チェックを更新"
								title="チェックを更新"
								disabled={busy}
								onClick={() => void dispatch({ type: "refresh_pr" })}
							>
								<Icon name="refresh" size="inline" />
							</button>
						</span>
					</div>

					{unresolvedConflicts.length > 0 && (
						<div className="pr-dock-conflicts-bar">
							<span>
								<Icon name="warning" size="inline" /> {unresolvedConflicts.length} 件のマージ競合があります
							</span>
							<button
								type="button"
								className="pr-dock-action-btn is-warning"
								disabled={busy}
								onClick={() => void dispatch({ type: "set_pr_view_mode", viewMode: "inline" })}
							>
								グラフで比較
							</button>
						</div>
					)}

					{waterfall.bars.length === 0 ? (
						<p className="pr-dock-empty">CI チェックの結果はまだ登録されていません。</p>
					) : (
						<ul className="pr-waterfall-list">
							{waterfall.bars.map(({ check, leftPct, widthPct, elapsedSec }) => {
								const failed = isFailedCheck(check);
								const passed = isPassedCheck(check);
								const running = check.status === "in_progress";
								const kind = failed ? "failed" : passed ? "passed" : running ? "running" : "queued";
								return (
									<li key={check.id} className={`pr-waterfall-item is-${kind}`}>
										<div className="pr-waterfall-row">
											<span className={`pr-check-glyph is-${kind}`} aria-hidden="true">
												{passed && <Icon name="check" size="inline" />}
												{failed && <Icon name="close" size="inline" />}
											</span>
											<span className="pr-waterfall-name" title={check.name}>
												{check.name}
											</span>
											<div className="pr-gantt-track" aria-hidden="true">
												<span
													className={`pr-gantt-bar is-${kind}`}
													style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
												/>
											</div>
											<span className="pr-waterfall-duration">
												{elapsedSec !== undefined ? formatSec(elapsedSec) : "待機"}
											</span>
											{check.url && (
												<a
													className="pr-waterfall-ext"
													href={check.url}
													target="_blank"
													rel="noreferrer"
													aria-label={`${check.name} の詳細を開く`}
												>
													<Icon name="external" size="inline" />
												</a>
											)}
										</div>
										{failed && check.failure && (() => {
											const failure = check.failure;
											const failureFile = failure.file;
											return (
												<div className="pr-dock-failure-box">
													<div className="pr-dock-failure-head">
														{failureFile && (
															<button
																type="button"
																className="pr-conflict-file-link"
																onClick={() => onFile(failureFile, failure.line)}
															>
																<code>
																	{failureFile}
																	{failure.line ? `:${failure.line}` : ""}
																</code>
															</button>
														)}
														{failure.testTitle && (
															<span className="pr-dock-failure-title">{failure.testTitle}</span>
														)}
														<button
															type="button"
															className="pr-dock-action-btn is-danger"
															disabled={busy}
															onClick={() => void dispatch({ type: "fix_ci", checkName: check.name })}
														>
															Fix
														</button>
													</div>
													{(failure.expected || failure.received) ? (
														<div className="pr-dock-assert-diff">
															{failure.expected && (
																<div className="pr-assert-line is-expected">
																	+ Expected: {failure.expected}
																</div>
															)}
															{failure.received && (
																<div className="pr-assert-line is-received">
																	- Received: {failure.received}
																</div>
															)}
														</div>
													) : (
														failure.excerpt && (
															<pre className="pr-dock-failure-excerpt">{failure.excerpt}</pre>
														)
													)}
												</div>
											);
										})()}
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</Presence>
		</section>
	);
}
