import { useCallback, useEffect, useState } from "react";
import type {
	Swarm,
	SwarmCheckStatus,
	SwarmNoteKind,
	SwarmTaskStatus,
} from "../shared/swarm.ts";
import { api, errorMessage } from "./api.ts";
import type { TeamAgent } from "./types.ts";
import "./SwarmBoard.css";

const SWARM_STATUS_LABELS: Record<Swarm["status"], string> = {
	active: "稼働中",
	paused: "一時停止",
	blocked: "判断待ち",
	complete: "完了",
};

const TASK_STATUS_LABELS: Record<SwarmTaskStatus, string> = {
	todo: "未着手",
	in_progress: "作業中",
	in_review: "レビュー待ち",
	done: "完了",
	blocked: "ブロック",
	cancelled: "中止",
};

const CHECK_STATUS_LABELS: Record<SwarmCheckStatus, string> = {
	pending: "未実行",
	passed: "合格",
	failed: "失敗",
};

const NOTE_KIND_LABELS: Record<SwarmNoteKind, string> = {
	decision: "決定",
	contract: "契約",
	finding: "発見",
	blocker: "ブロッカー",
	handoff: "引き継ぎ",
};

const WORKTREE_LABELS: Record<"active" | "adopted" | "discarded", string> = {
	active: "分離中",
	adopted: "採用済み",
	discarded: "破棄済み",
};

function formatClock(iso: string): string {
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed)) return "";
	return new Date(parsed).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function taskTone(status: SwarmTaskStatus): string {
	if (status === "done") return "is-ok";
	if (status === "in_progress") return "is-active";
	if (status === "in_review" || status === "blocked") return "is-warn";
	return "";
}

function checkTone(status: SwarmCheckStatus): string {
	if (status === "passed") return "is-ok";
	if (status === "failed") return "is-fail";
	return "";
}

export function SwarmBoard({
	swarm,
	agents,
	busy,
	onFocusAgent,
	onFile,
	onPauseSwarm,
	onContinueSwarm,
}: {
	swarm: Swarm;
	agents: TeamAgent[];
	busy: boolean;
	onFocusAgent: (agentId: string) => void;
	onFile: (path: string, line?: number) => void;
	onPauseSwarm?: () => Promise<void>;
	onContinueSwarm?: () => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const tasks = swarm.tasks ?? [];
	const checks = swarm.checks ?? [];
	const notes = swarm.notes ?? [];
	const events = swarm.events ?? [];
	const activeTasks = tasks.filter((task) => task.status !== "cancelled");
	const doneTasks = activeTasks.filter((task) => task.status === "done").length;
	const passedChecks = checks.filter((check) => check.status === "passed").length;
	const failedChecks = checks.filter((check) => check.status === "failed").length;
	const agentIds = new Set(agents.map((agent) => agent.agentId));

	async function trigger(action?: () => Promise<void>) {
		if (!action || pending) return;
		setPending(true);
		setError(undefined);
		try {
			await action();
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="team-board-layout" aria-label="Hyakki-Yako 共有ボード">
			<header className="swarm-board-header">
				<div className="swarm-board-header-top">
					<h2 className="swarm-board-title">Hyakki-Yako ミッションボード</h2>
					<span
						className={`swarm-board-pill ${
							swarm.status === "active"
								? "is-active"
								: swarm.status === "complete"
									? "is-ok"
									: "is-warn"
						}`}
					>
						{SWARM_STATUS_LABELS[swarm.status]}
					</span>
				</div>
				<p className="swarm-board-objective">{swarm.objective}</p>
				{swarm.reason && <p className="swarm-board-reason">{swarm.reason}</p>}
				<div className="swarm-board-stats">
					<span className={`swarm-board-pill${activeTasks.length > 0 && doneTasks === activeTasks.length ? " is-ok" : ""}`}>
						タスク {doneTasks}/{activeTasks.length}
					</span>
					<span
						className={`swarm-board-pill${
							failedChecks > 0 ? " is-fail" : checks.length > 0 && passedChecks === checks.length ? " is-ok" : ""
						}`}
					>
						検証 {passedChecks}/{checks.length}
					</span>
					<span className="swarm-board-pill">共有ノート {notes.length}件</span>
				</div>
				{(onPauseSwarm || onContinueSwarm) && (swarm.status === "active" || swarm.status === "paused" || swarm.status === "blocked") && (
					<div className="swarm-board-controls">
						{swarm.status === "active" && onPauseSwarm && (
							<button type="button" disabled={pending} onClick={() => { void trigger(onPauseSwarm); }}>
								スウォームを一時停止
							</button>
						)}
						{(swarm.status === "paused" || swarm.status === "blocked") && onContinueSwarm && (
							<button type="button" disabled={pending || busy} onClick={() => { void trigger(onContinueSwarm); }}>
								スウォームを再開
							</button>
						)}
					</div>
				)}
				{error && <p className="error" role="alert">{error}</p>}
			</header>

			<section className="swarm-board-section" aria-label="タスクボード">
				<h3>タスクボード ({tasks.length})</h3>
				{tasks.length === 0 ? (
					<p className="swarm-board-empty">まだ構造化タスクが登録されていません。マネージャーが board plan で作成するとここに表示されます。</p>
				) : (
					<ul className="swarm-board-list">
						{tasks.map((task) => (
							<li key={task.id} className="swarm-board-card">
								<div className="swarm-board-card-head">
									<span className="swarm-board-card-id">{task.id}</span>
									<span className="swarm-board-card-title">{task.title}</span>
									<span className={`swarm-board-pill ${taskTone(task.status)}`}>
										{TASK_STATUS_LABELS[task.status]}
									</span>
								</div>
								{task.description && <p className="swarm-board-card-desc">{task.description}</p>}
								<div className="swarm-board-meta-row">
									{task.ownerName && (
										<span>
											担当:{" "}
											{task.ownerAgentId && agentIds.has(task.ownerAgentId) ? (
												<button
													type="button"
													className="text-link"
													onClick={() => onFocusAgent(task.ownerAgentId!)}
												>
													{task.ownerName}
												</button>
											) : (
												task.ownerName
											)}
										</span>
									)}
									{!!task.dependsOn?.length && <span>依存: {task.dependsOn.join(", ")}</span>}
									{task.needsReview && <span>独立レビュー必須</span>}
								</div>
								{!!task.ownedPaths?.length && (
									<div className="swarm-board-meta-row">
										{task.ownedPaths.map((path) => (
											<button
												key={path}
												type="button"
												className="swarm-board-path"
												onClick={() => onFile(path)}
											>
												{path}
											</button>
										))}
									</div>
								)}
								{!!task.acceptanceCriteria?.length && (
									<ul className="swarm-board-criteria">
										{task.acceptanceCriteria.map((criterion, index) => (
											<li key={index}>{criterion}</li>
										))}
									</ul>
								)}
								{task.resultSummary && <p className="swarm-board-card-desc">結果: {task.resultSummary}</p>}
								{!!task.reviews?.length && (
									<div className="swarm-board-reviews">
										{task.reviews.map((review) => (
											<div key={review.id} className="swarm-board-review">
												<span
													className={`swarm-board-pill ${review.verdict === "approved" ? "is-ok" : "is-fail"}`}
												>
													{review.verdict === "approved" ? "承認" : "修正依頼"}
												</span>
												<span>{review.reviewerName}:</span>
												<span>{review.summary}</span>
											</div>
										))}
									</div>
								)}
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="swarm-board-section" aria-label="検証ゲート">
				<h3>検証ゲート ({checks.length})</h3>
				{checks.length === 0 ? (
					<p className="swarm-board-empty">検証コマンドは未登録です。</p>
				) : (
					<ul className="swarm-board-list">
						{checks.map((check) => (
							<li key={check.id} className="swarm-board-card">
								<div className="swarm-board-card-head">
									<span className="swarm-board-card-id">{check.id}</span>
									<span className="swarm-board-card-title">{check.name}</span>
									<span className={`swarm-board-pill ${checkTone(check.status)}`}>
										{CHECK_STATUS_LABELS[check.status]}
										{check.exitCode !== undefined ? ` (${check.exitCode})` : ""}
									</span>
								</div>
								<code className="swarm-board-check-cmd">{check.command}</code>
								{check.runByName && (
									<div className="swarm-board-meta-row">
										<span>実行者: {check.runByName}</span>
										<span>{formatClock(check.updatedAt)}</span>
									</div>
								)}
								{check.summary && (
									<details>
										<summary>実行出力を表示</summary>
										<pre className="swarm-board-check-output">{check.summary}</pre>
									</details>
								)}
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="swarm-board-section" aria-label="共有ノート">
				<h3>共有ノート ({notes.length})</h3>
				{notes.length === 0 ? (
					<p className="swarm-board-empty">チーム間で共有された決定・契約・発見はまだありません。</p>
				) : (
					<ul className="swarm-board-list">
						{[...notes].reverse().map((note) => (
							<li key={note.id} className="swarm-board-card">
								<div className="swarm-board-card-head">
									<span className={`swarm-board-pill${note.kind === "blocker" ? " is-fail" : note.kind === "decision" || note.kind === "contract" ? " is-active" : ""}`}>
										{NOTE_KIND_LABELS[note.kind]}
									</span>
									<span className="swarm-board-card-title">{note.title}</span>
									<span className="swarm-board-card-id">{note.authorName}</span>
								</div>
								<p className="swarm-board-card-desc">{note.body}</p>
								{!!note.paths?.length && (
									<div className="swarm-board-meta-row">
										{note.paths.map((path) => (
											<button
												key={path}
												type="button"
												className="swarm-board-path"
												onClick={() => onFile(path)}
											>
												{path}
											</button>
										))}
									</div>
								)}
							</li>
						))}
					</ul>
				)}
			</section>

			{events.length > 0 && (
				<section className="swarm-board-section" aria-label="アクティビティ">
					<h3>アクティビティ ({events.length})</h3>
					<ul className="swarm-board-timeline">
						{[...events].reverse().slice(0, 40).map((event) => (
							<li key={event.id} className="swarm-board-event">
								<span className="swarm-board-event-time">{formatClock(event.createdAt)}</span>
								<span className="swarm-board-event-summary">
									{event.actorName ? <strong>{event.actorName}: </strong> : null}
									{event.summary}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

export function AgentWorktreeInspector({
	sessionId,
	worktree,
	busy,
}: {
	sessionId: string;
	worktree: "active" | "adopted" | "discarded";
	busy: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [diffResult, setDiffResult] = useState<{ diff: string; changed: boolean; truncated: boolean }>();
	const [error, setError] = useState<string>();

	const loadDiff = useCallback(async () => {
		if (busy) return;
		setLoading(true);
		setError(undefined);
		try {
			const data = await api<{ status: string; diff: string; truncated: boolean; changed: boolean }>(
				`/api/work/${encodeURIComponent(sessionId)}/diff`,
			);
			setDiffResult({ diff: data.diff, changed: data.changed, truncated: data.truncated });
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setLoading(false);
		}
	}, [sessionId, busy]);

	useEffect(() => {
		setDiffResult(undefined);
		setError(undefined);
		setOpen(false);
	}, [sessionId, worktree]);

	useEffect(() => {
		if (open && !busy && !diffResult && !loading) {
			void loadDiff();
		}
	}, [open, busy, diffResult, loading, loadDiff]);

	return (
		<section className="team-worktree-section" aria-label="分離ワークツリー">
			<div className="team-worktree-head">
				<span className={`swarm-board-pill ${worktree === "adopted" ? "is-ok" : worktree === "discarded" ? "is-warn" : "is-active"}`}>
					作業ツリー: {WORKTREE_LABELS[worktree]}
				</span>
				{open && !busy && (
					<button type="button" className="text-link" disabled={loading} onClick={() => { void loadDiff(); }}>
						{loading ? "読み込み中…" : "更新"}
					</button>
				)}
			</div>
			<details
				className="team-worktree-diff"
				open={open}
				onToggle={(event) => setOpen(event.currentTarget.open)}
			>
				<summary>分離ワークツリーの差分を表示</summary>
				{busy ? (
					<p className="team-inline-note">エージェントの作業完了後に差分を確認できます。</p>
				) : error ? (
					<p className="error" role="alert">{error}</p>
				) : loading ? (
					<p className="team-inline-note">差分を読み込んでいます…</p>
				) : diffResult ? (
					diffResult.changed ? (
						<>
							<pre className="team-worktree-diff-pre">{diffResult.diff}</pre>
							{diffResult.truncated && <p className="team-inline-note">差分が大きいため先頭のみ表示しています。</p>}
						</>
					) : (
						<p className="team-inline-note">未採用の変更はありません。</p>
					)
				) : null}
			</details>
		</section>
	);
}
