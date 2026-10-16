import { useRef, useState } from "react";
import type { Goal, GoalAction } from "../shared/goals.ts";
import { errorMessage } from "./api.ts";
import "./GoalPanel.css";

const STATUS_LABELS: Record<Goal["status"], string> = {
	active: "実行中",
	paused: "一時停止",
	blocked: "入力待ち",
	complete: "達成",
	dropped: "終了",
};

export function GoalPanel({ goal, busy, connected, unavailable, onAction }: {
	goal: Goal;
	busy: boolean;
	connected: boolean;
	unavailable: boolean;
	onAction: (action: GoalAction) => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const acting = useRef(false);
	const disabled = pending || !connected || unavailable;
	const canResume = goal.status === "paused" || goal.status === "blocked";
	async function act(action: GoalAction) {
		if (acting.current) return;
		acting.current = true;
		setPending(true);
		setError(undefined);
		try { await onAction(action); }
		catch (reason) { setError(errorMessage(reason)); }
		finally { acting.current = false; setPending(false); }
	}
	return <details className="goal-panel">
		<summary><span>Goal</span><span className={`goal-status goal-status-${goal.status}`} role="status">{STATUS_LABELS[goal.status]}</span></summary>
		<div className="goal-panel-body">
			<div className="goal-current">
				<p className="goal-objective">{goal.objective}</p>
				{goal.reason && <p className="goal-reason">{goal.reason}</p>}
			</div>
			<p className="fine-print">目標の達成まで自動で続けます。新しい目標は /goal 目標、一時停止や入力待ちから再開するには /goal resume を入力してください。</p>
			{goal.status !== "complete" && goal.status !== "dropped" && <div className="goal-actions">
				{goal.status === "active" && <button type="button" disabled={disabled} onClick={() => { void act({ op: "pause" }); }}>Goal を一時停止</button>}
				{canResume && <button type="button" disabled={disabled || busy} onClick={() => { void act({ op: "resume" }); }}>Goal を再開</button>}
				<button type="button" disabled={disabled} onClick={() => { void act({ op: "drop" }); }}>Goal を終了</button>
			</div>}
			{error && <p className="error" role="alert">{error}</p>}
		</div>
	</details>;
}
