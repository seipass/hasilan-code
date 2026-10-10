import { Content } from "./Content.tsx";
import type { Run, RunStatus, TeamAgent, TeamSnapshot } from "./types.ts";

export const RUN_LABELS: Record<RunStatus, string> = {
	queued: "待機列", running: "実行中", waiting: "子の結果を待機中", cancelling: "停止中",
	completed: "完了", failed: "失敗", cancelled: "キャンセル", interrupted: "再起動で中断",
};

function AgentNode({ agent, snapshot, selectedSessionId, onSelect, onStop, onFile }: {
	agent: TeamAgent; snapshot: TeamSnapshot; selectedSessionId?: string; onSelect: (sessionId: string) => void;
	onStop: (sessionId: string) => void; onFile: (path: string, line?: number) => void;
}) {
	const run = agent.currentRun ?? agent.latestRun;
	const children = snapshot.agents.filter((value) => value.parentAgentId === agent.agentId);
	const history = snapshot.runs.filter((value) => value.agentId === agent.agentId && value.runId !== run?.runId);
	return <li>
		<article className={`agent-card ${agent.sessionId === selectedSessionId ? "selected" : ""}`}>
			<header><button className="text-link" onClick={() => onSelect(agent.sessionId)}>{agent.name}</button><span className="muted">{agent.role}</span></header>
			<code className="agent-id">{agent.agentId}</code>
			{run && <RunView run={run} snapshot={snapshot} onFile={onFile} />}
			{agent.currentRun && <button className="danger" onClick={() => onStop(agent.sessionId)}>この枝を停止</button>}
			{history.length > 0 && <details><summary>過去の実行 ({history.length})</summary>{history.map((previous) => <RunView key={previous.runId} run={previous} snapshot={snapshot} onFile={onFile} />)}</details>}
		</article>
		{children.length > 0 && <ul className="team-tree">{children.map((child) => <AgentNode key={child.agentId} agent={child} snapshot={snapshot} selectedSessionId={selectedSessionId} onSelect={onSelect} onStop={onStop} onFile={onFile} />)}</ul>}
	</li>;
}

function RunView({ run, snapshot, onFile }: { run: Run; snapshot: TeamSnapshot; onFile: (path: string, line?: number) => void }) {
	return <div className="run-detail">
		<span className={`badge status-${run.status}`}>{RUN_LABELS[run.status]}</span><code className="run-id">{run.runId}</code>
		<p className="task-text">{run.task}</p>
		{run.waitingOnRunIds?.length ? <p className="waiting-targets">待機対象: {run.waitingOnRunIds.map((id) => {
			const target = snapshot.runs.find((value) => value.runId === id);
			return `${snapshot.agents.find((agent) => agent.agentId === target?.agentId)?.name ?? id}`;
		}).join(", ")}</p> : null}
		{run.error && <p className="error">{run.error}</p>}
		{run.result !== undefined && <details><summary>最終結果</summary><Content value={run.result} onFile={onFile} /></details>}
	</div>;
}

export function TeamPane({ snapshot, selectedSessionId, onSelect, onStop, onFile }: {
	snapshot?: TeamSnapshot; selectedSessionId?: string; onSelect: (sessionId: string) => void;
	onStop: (sessionId: string) => void; onFile: (path: string, line?: number) => void;
}) {
	const selected = snapshot?.agents.find((agent) => agent.sessionId === selectedSessionId);
	const roots = snapshot?.agents.filter((agent) => !agent.parentAgentId && (!selected || agent.teamId === selected.teamId)) ?? [];
	return <section className="team-pane">
		{roots.length === 0 && <p className="muted">チームはありません。</p>}
		{snapshot && <ul className="team-tree">{roots.map((agent) => <AgentNode key={agent.agentId} agent={agent} snapshot={snapshot} selectedSessionId={selectedSessionId} onSelect={onSelect} onStop={onStop} onFile={onFile} />)}</ul>}
	</section>;
}
