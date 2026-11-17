import type { GoalAction } from "../../shared/goals.ts";
import { GoalPanel } from "../GoalPanel.tsx";
import { usePreferenceState } from "../preferences.ts";
import type { SessionDetail } from "../types.ts";

export function GoalControl({ session, connected, onAction }: {
	session: SessionDetail;
	connected: boolean;
	onAction: (action: GoalAction) => Promise<void>;
}) {
	const [dismissed, dismiss] = usePreferenceState<string | null>(`pi-web-dismissed-goal:${session.sessionId}`, null);
	const goal = session.goal;
	if (!goal || session.parentSessionId || (goal.status === "complete" && goal.id === dismissed)) return null;
	return <GoalPanel key={goal.id} goal={goal} onDismiss={() => dismiss(goal.id)}
		busy={!!session.currentRun} connected={connected} unavailable={session.availability === "missing"} onAction={onAction} />;
}
