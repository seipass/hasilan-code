import { useState } from "react";
import {
	isFailedCheck,
	isPassedCheck,
	type PrCiCheck,
	type PrCommitNode,
	type PrConflictEntry,
	type PrLifecycleSurface,
} from "../shared/pr-lifecycle.ts";
import type { SurfaceAction } from "../shared/surfaces.ts";
import { Icon } from "./Icon.tsx";
import "./PrLifecycleCard.css";

const ROW_HEIGHT = 34;
const GRAPH_WIDTH = 54;
const LANE_X = [12, 28, 44] as const;

function laneColor(lane: 0 | 1 | 2): string {
	if (lane === 1) return "var(--primary)";
	if (lane === 2) return "var(--secondary)";
	return "var(--border-strong)";
}

function isBusyPhase(phase: PrLifecycleSurface["phase"]): boolean {
	return (
		phase === "committing" ||
		phase === "pushing" ||
		phase === "opening" ||
		phase === "fetching" ||
		phase === "checking" ||
		phase === "resolving" ||
		phase === "fixing" ||
		phase === "merging"
	);
}

function formatDuration(sec?: number): string {
	if (sec === undefined || !Number.isFinite(sec)) return "";
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

function CommitGraphSvg({ commits, merged }: { commits: readonly PrCommitNode[]; merged: boolean }) {
	const height = Math.max(ROW_HEIGHT, commits.length * ROW_HEIGHT);
	const indexBySha = new Map(commits.map((commit, index) => [commit.sha, index]));

	const edges: { key: string; d: string; color: string; dashed?: boolean }[] = [];
	for (let index = 0; index < commits.length; index++) {
		const commit = commits[index];
		const x1 = LANE_X[commit.lane];
		const y1 = index * ROW_HEIGHT + ROW_HEIGHT / 2;
		for (const parentSha of commit.parents) {
			const parentIndex = indexBySha.get(parentSha);
			if (parentIndex !== undefined) {
				const parent = commits[parentIndex];
				const x2 = LANE_X[parent.lane];
				const y2 = parentIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
				const midY = (y1 + y2) / 2;
				const d = x1 === x2 ? `M ${x1} ${y1} L ${x2} ${y2}` : `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
				edges.push({
					key: `${commit.sha}->${parentSha}`,
					d,
					color: commit.isProjectedMerge ? (commit.conflictCount ? "var(--warning)" : "var(--success)") : laneColor(commit.lane),
					dashed: commit.isProjectedMerge,
				});
			} else if (index === commits.length - 1 || commit.lane === 0) {
				edges.push({
					key: `${commit.sha}->tail-${parentSha}`,
					d: `M ${x1} ${y1} L ${x1} ${height}`,
					color: laneColor(commit.lane),
				});
			}
		}
	}

	return (
		<svg
			className="pr-graph-svg"
			width={GRAPH_WIDTH}
			height={height}
			viewBox={`0 0 ${GRAPH_WIDTH} ${height}`}
			aria-hidden="true"
		>
			{edges.map((edge) => (
				<path
					key={edge.key}
					d={edge.d}
					fill="none"
					stroke={edge.color}
					strokeWidth={1.8}
					strokeDasharray={edge.dashed ? "3 3" : undefined}
					strokeLinecap="round"
				/>
			))}
			{commits.map((commit, index) => {
				const cx = LANE_X[commit.lane];
				const cy = index * ROW_HEIGHT + ROW_HEIGHT / 2;
				const stroke = commit.conflictCount
					? "var(--warning)"
					: commit.isProjectedMerge
						? "var(--success)"
						: merged && commit.lane === 0 && index === 0
							? "var(--primary)"
							: laneColor(commit.lane);
				const hollow = commit.isProjectedMerge || !!commit.conflictCount;
				return (
					<circle
						key={commit.sha}
						cx={cx}
						cy={cy}
						r={commit.isProjectedMerge ? 4.8 : 3.8}
						fill={hollow ? "var(--surface-raised)" : stroke}
						stroke={stroke}
						strokeWidth={1.8}
					/>
				);
			})}
		</svg>
	);
}

function ConflictComparisonPopover({
	conflict,
	baseBranch,
	headBranch,
	onFile,
}: {
	conflict: PrConflictEntry;
	baseBranch: string;
	headBranch: string;
	onFile: (path: string, line?: number) => void;
}) {
	return (
		<div className="pr-conflict-popover" role="dialog" aria-label={`${conflict.file} の競合比較`}>
			<div className="pr-conflict-popover-head">
				<button
					type="button"
					className="pr-conflict-file-link"
					onClick={() => onFile(conflict.file, conflict.line)}
				>
					<code>
						{conflict.file}
						{conflict.line ? `:${conflict.line}` : ""}
					</code>
				</button>
				{conflict.resolved && <span className="pr-conflict-resolved-tag">解消済み</span>}
			</div>
			<div className="pr-conflict-party is-theirs">
				<div className="pr-conflict-party-label">
					<strong>{conflict.theirsAuthor ?? baseBranch}</strong>
					<span>{baseBranch}</span>
				</div>
				<pre className="pr-conflict-code">{conflict.theirsText || "(削除)"}</pre>
			</div>
			<div className="pr-conflict-party is-ours">
				<div className="pr-conflict-party-label">
					<strong>あなた</strong>
					<span>{headBranch}</span>
				</div>
				<pre className="pr-conflict-code">{conflict.oursText || "(削除)"}</pre>
			</div>
		</div>
	);
}

function CheckPill({
	check,
	onFix,
	busy,
}: {
	check: PrCiCheck;
	onFix?: () => void;
	busy: boolean;
}) {
	const [open, setOpen] = useState(false);
	const failed = isFailedCheck(check);
	const passed = isPassedCheck(check);
	const running = check.status === "in_progress";
	const kind = failed ? "failed" : passed ? "passed" : running ? "running" : "queued";

	return (
		<div
			className="pr-check-pill-wrap"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
		>
			<button
				type="button"
				className={`pr-check-pill is-${kind}`}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				onClick={() => setOpen((value) => !value)}
			>
				<span className={`pr-check-glyph is-${kind}`} aria-hidden="true">
					{passed && <Icon name="check" size="inline" />}
					{failed && <Icon name="close" size="inline" />}
				</span>
				<span className="pr-check-name">{check.name}</span>
				{check.durationSec !== undefined && (
					<span className="pr-check-duration">{formatDuration(check.durationSec)}</span>
				)}
			</button>
			{open && (check.detail || check.failure || check.url) && (
				<div className="pr-check-tooltip" role="tooltip">
					<div className="pr-check-tooltip-head">
						<strong>{check.name}</strong>
						{check.durationSec !== undefined && <span>{formatDuration(check.durationSec)}</span>}
					</div>
					{check.detail && <p className="pr-check-tooltip-detail">{check.detail}</p>}
					{check.failure && (
						<div className="pr-check-tooltip-failure">
							{check.failure.file && (
								<code className="pr-check-tooltip-file">
									{check.failure.file}
									{check.failure.line ? `:${check.failure.line}` : ""}
								</code>
							)}
							{check.failure.testTitle && <div className="pr-check-tooltip-test">{check.failure.testTitle}</div>}
							{check.failure.expected && (
								<div className="pr-assert-line is-expected">+ Expected: {check.failure.expected}</div>
							)}
							{check.failure.received && (
								<div className="pr-assert-line is-received">- Received: {check.failure.received}</div>
							)}
						</div>
					)}
					{failed && onFix && (
						<button type="button" className="pr-inline-fix-btn" disabled={busy} onClick={onFix}>
							修正する
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export function PrLifecycleCard({
	surface,
	onAction,
	onFile,
}: {
	surface: PrLifecycleSurface;
	onAction: (surfaceId: string, action: SurfaceAction) => Promise<void>;
	onFile: (path: string, line?: number) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [activeConflictId, setActiveConflictId] = useState<string>();
	const [pinnedConflictId, setPinnedConflictId] = useState<string>();
	const [localError, setLocalError] = useState<string>();

	if (surface.viewMode !== "inline") return null;

	const transitioning = isBusyPhase(surface.phase);
	const unresolvedConflicts = surface.conflicts.filter((entry) => !entry.resolved);
	const conflictFiles = new Set(unresolvedConflicts.map((entry) => entry.file)).size;
	const failedCheck = surface.checks.find((check) => isFailedCheck(check));
	const passedCount = surface.checks.filter((check) => isPassedCheck(check)).length;
	const merged = surface.phase === "merged";

	const statusTone = merged
		? "merged"
		: surface.phase === "conflicts"
			? "warning"
			: surface.phase === "check_failed" || surface.phase === "error"
				? "danger"
				: transitioning
					? "busy"
					: "ready";

	async function dispatch(action: SurfaceAction) {
		if (busy) return;
		setBusy(true);
		setLocalError(undefined);
		try {
			await onAction(surface.surfaceId, action);
		} catch (reason) {
			setLocalError(reason instanceof Error ? reason.message : "操作に失敗しました。");
		} finally {
			setBusy(false);
		}
	}

	const shownConflictId = pinnedConflictId ?? activeConflictId;

	return (
		<section className={`pr-card is-${statusTone}`} aria-label={`Pull Request: ${surface.title}`}>
			<header className="pr-card-header">
				<span className={`pr-status-icon is-${statusTone}`} aria-hidden="true">
					{transitioning ? null : merged ? (
						<Icon name="gitMerge" size="inline" />
					) : surface.phase === "conflicts" ? (
						<Icon name="warning" size="inline" />
					) : surface.phase === "check_failed" || surface.phase === "error" ? (
						<Icon name="close" size="inline" />
					) : (
						<Icon name="gitPr" size="inline" />
					)}
				</span>
				<div className="pr-card-title-group">
					<div className="pr-card-title-row">
						<strong className="pr-card-title">{surface.title}</strong>
						{surface.prNumber !== undefined && <span className="pr-card-number">#{surface.prNumber}</span>}
					</div>
					<div className="pr-card-branches">
						<code>{surface.headBranch}</code>
						<span className="pr-branch-arrow" aria-hidden="true">
							→
						</span>
						<code>{surface.baseBranch}</code>
					</div>
				</div>
				<div className="pr-card-header-actions">
					<button
						type="button"
						className="pr-icon-btn"
						aria-label="PR の状態を更新"
						title="PR の状態を更新"
						disabled={busy}
						onClick={() => void dispatch({ type: "refresh_pr" })}
					>
						<Icon name="refresh" size="inline" />
					</button>
					{surface.prUrl && (
						<a
							className="pr-ext-link"
							href={surface.prUrl}
							target="_blank"
							rel="noreferrer"
							title="GitHub で開く"
						>
							<span>GitHub</span>
							<Icon name="external" size="inline" />
						</a>
					)}
					<button
						type="button"
						className="pr-icon-btn"
						aria-label="入力欄の上に格納"
						title="入力欄の上に格納"
						disabled={busy}
						onClick={() => void dispatch({ type: "set_pr_view_mode", viewMode: "docked_collapsed" })}
					>
						<Icon name="dock" size="inline" />
					</button>
				</div>
			</header>

			{surface.statusNote && (
				<div className={`pr-status-banner${transitioning ? " is-busy" : ""}`} role="status">
					{transitioning && <span className="pr-inline-spinner" aria-hidden="true" />}
					<span>{surface.statusNote}</span>
				</div>
			)}

			{(surface.error || localError) && (
				<p className="pr-error-banner" role="alert">
					{localError ?? surface.error}
				</p>
			)}

			{surface.commits.length > 0 && (
				<div className="pr-graph">
					<CommitGraphSvg commits={surface.commits} merged={merged} />
					<ul className="pr-commit-list">
						{surface.commits.map((commit) => (
							<li
								key={commit.sha}
								className={`pr-commit-row${commit.isProjectedMerge ? " is-projected" : ""}${commit.conflictCount ? " has-conflict" : ""}`}
							>
								<div className="pr-commit-main">
									{commit.branchRefs.map((ref) => (
										<code key={ref} className={`pr-ref-pill lane-${commit.lane}`}>
											{ref}
										</code>
									))}
									<span className="pr-commit-subject">{commit.subject}</span>
									{commit.conflictCount ? (
										<span className="pr-commit-conflict-badge">{commit.conflictCount} 件の競合</span>
									) : commit.conflictsResolved ? (
										<span className="pr-commit-resolved-badge">競合解消済み</span>
									) : null}
								</div>
								<div className="pr-commit-meta">
									{!commit.isProjectedMerge && <code className="pr-commit-sha">{commit.shortSha}</code>}
									{!commit.isProjectedMerge && <span className="pr-commit-author">{commit.author}</span>}
									<span className="pr-commit-time">{commit.relativeTime}</span>
								</div>
							</li>
						))}
					</ul>
				</div>
			)}

			{surface.conflicts.length > 0 && (
				<div className={`pr-conflicts${unresolvedConflicts.length === 0 ? " is-resolved" : ""}`}>
					<div className="pr-conflicts-head">
						<span className="pr-conflicts-summary">
							<Icon name={unresolvedConflicts.length > 0 ? "warning" : "check"} size="inline" />
							{unresolvedConflicts.length > 0
								? `${unresolvedConflicts.length} 件の競合（${conflictFiles} ファイル）`
								: "すべての競合が解消されました"}
						</span>
						{unresolvedConflicts.length > 0 && (
							<button
								type="button"
								className="pr-cta-btn is-warning"
								disabled={busy || surface.phase === "resolving"}
								onClick={() => void dispatch({ type: "resolve_conflicts" })}
							>
								{surface.phase === "resolving" ? "解消中…" : "競合を解消"}
							</button>
						)}
					</div>
					<div className="pr-conflict-chips">
						{surface.conflicts.map((conflict) => {
							const isOpen = shownConflictId === conflict.id;
							return (
								<div
									key={conflict.id}
									className="pr-conflict-chip-wrap"
									onMouseEnter={() => setActiveConflictId(conflict.id)}
									onMouseLeave={() => setActiveConflictId((cur) => (cur === conflict.id ? undefined : cur))}
								>
									<button
										type="button"
										className={`pr-conflict-chip${conflict.resolved ? " is-resolved" : ""}${isOpen ? " is-open" : ""}`}
										onFocus={() => setActiveConflictId(conflict.id)}
										onBlur={() => setActiveConflictId((cur) => (cur === conflict.id ? undefined : cur))}
										onClick={() =>
											setPinnedConflictId((cur) => (cur === conflict.id ? undefined : conflict.id))
										}
									>
										<code>
											{conflict.file}
											{conflict.line ? `:${conflict.line}` : ""}
										</code>
										{conflict.theirsAuthor && (
											<span className="pr-conflict-author">{conflict.theirsAuthor}</span>
										)}
									</button>
									{isOpen && (
										<ConflictComparisonPopover
											conflict={conflict}
											baseBranch={surface.baseBranch}
											headBranch={surface.headBranch}
											onFile={onFile}
										/>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}

			{surface.checks.length > 0 && (
				<div className="pr-checks-strip">
					<div className="pr-checks-pills">
						{surface.checks.map((check) => (
							<CheckPill
								key={check.id}
								check={check}
								busy={busy || surface.phase === "fixing"}
								onFix={
									isFailedCheck(check)
										? () => void dispatch({ type: "fix_ci", checkName: check.name })
										: undefined
								}
							/>
						))}
					</div>
					<button
						type="button"
						className="pr-waterfall-btn"
						disabled={busy}
						onClick={() => void dispatch({ type: "set_pr_view_mode", viewMode: "docked_expanded" })}
					>
						詳細 ({passedCount}/{surface.checks.length})
					</button>
				</div>
			)}

			<footer className="pr-card-footer">
				<div className="pr-card-stats">
					{(surface.additions > 0 || surface.deletions > 0 || surface.filesChanged > 0) && (
						<span className="pr-diffstat">
							<span className="is-add">+{surface.additions}</span>{" "}
							<span className="is-del">-{surface.deletions}</span>
							{surface.filesChanged > 0 && <span className="pr-files-count"> · {surface.filesChanged} ファイル</span>}
						</span>
					)}
					{surface.checks.length > 0 && (
						<span className="pr-checks-tally">
							Checks {passedCount}/{surface.checks.length}
						</span>
					)}
				</div>
				<div className="pr-card-actions">
					{merged ? (
						<span className="pr-merged-pill">
							<Icon name="gitMerge" size="inline" />
							<span>{surface.baseBranch} にマージ済み</span>
						</span>
					) : surface.phase === "check_failed" && failedCheck ? (
						<button
							type="button"
							className="pr-cta-btn is-danger"
							disabled={busy}
							onClick={() => void dispatch({ type: "fix_ci", checkName: failedCheck.name })}
						>
							{failedCheck.name} を修正
						</button>
					) : (
						surface.phase === "ready" &&
						surface.prNumber !== undefined && (
							<button
								type="button"
								className="pr-cta-btn is-primary"
								disabled={busy}
								onClick={() => void dispatch({ type: "merge_pr", method: "merge" })}
							>
								<Icon name="gitMerge" size="inline" />
								<span>Merge</span>
							</button>
						)
					)}
				</div>
			</footer>
		</section>
	);
}
