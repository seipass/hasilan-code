import { useRef, useState } from "react";
import type { Swarm, SwarmCheckStatus, SwarmTaskStatus } from "../shared/swarm.ts";
import { errorMessage } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { Presence } from "./Motion.tsx";
import "./HyakkiPanel.css";

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

export function HyakkiPanel({
	swarm,
	runningWorkers,
	busy,
	connected,
	unavailable,
	onPause,
	onContinue,
	onOpenBoard,
	onDismiss,
}: {
	swarm: Swarm;
	runningWorkers: number;
	busy: boolean;
	connected: boolean;
	unavailable: boolean;
	onPause: () => Promise<void>;
	onContinue: () => Promise<void>;
	onOpenBoard: () => void;
	onDismiss: () => void;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const acting = useRef(false);
	const disabled = pending || !connected || unavailable;
	const tasks = swarm.tasks ?? [];
	const checks = swarm.checks ?? [];
	const activeTasks = tasks.filter((task) => task.status !== "cancelled");
	const doneTasks = activeTasks.filter((task) => task.status === "done").length;
	const passedChecks = checks.filter((check) => check.status === "passed").length;
	const failedChecks = checks.filter((check) => check.status === "failed").length;
	const canResume = swarm.status === "paused" || swarm.status === "blocked";

	async function runAction(action: () => Promise<void>) {
		if (acting.current) return;
		acting.current = true;
		setPending(true);
		setError(undefined);
		try {
			await action();
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			acting.current = false;
			setPending(false);
		}
	}

	return (
		<div className="hyakki-panel-slot">
			<details className="hyakki-panel">
				<summary>
					<span className="hyakki-summary-title">Hyakki-Yako</span>
					<span className="hyakki-summary-chips">
						{activeTasks.length > 0 && (
							<span className={`hyakki-chip${doneTasks === activeTasks.length ? " is-ok" : ""}`}>
								タスク {doneTasks}/{activeTasks.length}
							</span>
						)}
						{checks.length > 0 && (
							<span
								className={`hyakki-chip${failedChecks > 0 ? " is-fail" : passedChecks === checks.length ? " is-ok" : ""}`}
							>
								検証 {passedChecks}/{checks.length}
							</span>
						)}
						{runningWorkers > 0 && <span className="hyakki-chip is-active">稼働 {runningWorkers}人</span>}
					</span>
					<span key={swarm.status} className={`hyakki-status hyakki-status-${swarm.status} motion-label`} role="status">
						{SWARM_STATUS_LABELS[swarm.status]}
					</span>
				</summary>
				<div className="hyakki-panel-body">
					<p className="hyakki-objective">{swarm.objective}</p>
					<Presence show={!!swarm.reason} collapse>
						<p className="hyakki-reason">{swarm.reason}</p>
					</Presence>
					{tasks.length > 0 && (
						<div className="hyakki-section">
							<span className="hyakki-section-title">タスクボード</span>
							<ul className="hyakki-task-list">
								{tasks.map((task) => {
									const latestReview = task.reviews?.at(-1);
									return (
										<li key={task.id} className="hyakki-task-row">
											<span className="hyakki-task-id">{task.id}</span>
											<span className="hyakki-task-title">{task.title}</span>
											{task.ownerName && <span className="hyakki-task-owner">{task.ownerName}</span>}
											{latestReview && (
												<span className={`hyakki-chip ${latestReview.verdict === "approved" ? "is-ok" : "is-fail"}`}>
													{latestReview.verdict === "approved" ? "承認済" : "修正依頼"}
												</span>
											)}
											<span className={`hyakki-task-state is-${task.status}`}>
												{TASK_STATUS_LABELS[task.status]}
											</span>
											{!!task.ownedPaths?.length && (
												<span className="hyakki-paths">
													{task.ownedPaths.slice(0, 4).map((path) => (
														<code key={path} className="hyakki-path">
															{path}
														</code>
													))}
													{task.ownedPaths.length > 4 && (
														<span className="hyakki-path">+{task.ownedPaths.length - 4}</span>
													)}
												</span>
											)}
										</li>
									);
								})}
							</ul>
						</div>
					)}
					{checks.length > 0 && (
						<div className="hyakki-section">
							<span className="hyakki-section-title">検証ゲート</span>
							<ul className="hyakki-check-list">
								{checks.map((check) => (
									<li key={check.id} className="hyakki-check-row">
										<span className={`hyakki-check-state is-${check.status}`}>
											{CHECK_STATUS_LABELS[check.status]}
										</span>
										<span>{check.name}</span>
										<code className="hyakki-check-command" title={check.command}>
											{check.command}
										</code>
										{check.exitCode !== undefined && (
											<span className="hyakki-task-id">exit {check.exitCode}</span>
										)}
									</li>
								))}
							</ul>
						</div>
					)}
					<div className="hyakki-actions">
						<button type="button" onClick={onOpenBoard}>
							チーム・ボードを開く
						</button>
						<Presence show={swarm.status === "active"}>
							<button
								type="button"
								disabled={disabled}
								onClick={() => {
									void runAction(onPause);
								}}
							>
								一時停止
							</button>
						</Presence>
						<Presence show={canResume}>
							<button
								type="button"
								disabled={disabled || busy}
								onClick={() => {
									void runAction(onContinue);
								}}
							>
								再開
							</button>
						</Presence>
					</div>
					<Presence show={!!error}>
						<p className="error" role="alert">
							{error}
						</p>
					</Presence>
				</div>
			</details>
			{swarm.status === "complete" && (
				<button
					type="button"
					className="hyakki-dismiss"
					aria-label="完了した Hyakki-Yako パネルを閉じる"
					onClick={onDismiss}
				>
					<Icon name="close" size="inline" />
				</button>
			)}
		</div>
	);
}
