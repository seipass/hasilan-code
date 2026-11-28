import { HyakkiPanel } from "../HyakkiPanel.tsx";
import { usePreferenceState } from "../preferences.ts";
import type { SessionDetail, TeamSnapshot } from "../types.ts";

export function HyakkiControl({
	session,
	team,
	connected,
	onPause,
	onContinue,
	onOpenBoard,
}: {
	session: SessionDetail;
	team?: TeamSnapshot;
	connected: boolean;
	onPause: () => Promise<void>;
	onContinue: () => Promise<void>;
	onOpenBoard: () => void;
}) {
	const [dismissed, dismiss] = usePreferenceState<string | null>(`pi-web-dismissed-swarm:${session.sessionId}`, null);
	const swarm = session.swarm;
	if (!swarm || session.parentSessionId || (swarm.status === "complete" && swarm.id === dismissed)) return null;
	const root = team?.agents.find((agent) => agent.sessionId === session.sessionId);
	const teamAgents = root ? (team?.agents.filter((agent) => agent.teamId === root.teamId) ?? []) : [];
	const runningWorkers = teamAgents.filter((agent) => agent.parentAgentId && !!agent.currentRun).length;
	const anyRunning = !!session.currentRun || runningWorkers > 0;
	return (
		<HyakkiPanel
			key={swarm.id}
			swarm={swarm}
			runningWorkers={runningWorkers}
			busy={anyRunning}
			connected={connected}
			unavailable={session.availability === "missing"}
			onPause={onPause}
			onContinue={onContinue}
			onOpenBoard={onOpenBoard}
			onDismiss={() => dismiss(swarm.id)}
		/>
	);
}
