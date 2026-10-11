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
			<header className="agent-header"><div className="agent-identity"><button className="text-link agent-name" onClick={() => onSelect(agent.sessionId)}>{agent.name}</button>{agent.role.toLowerCase() !== agent.name.toLowerCase() && <span className="agent-role">{agent.role}</span>}</div>{run && <span className={`badge agent-status status-${run.status}`}>{RUN_LABELS[run.status]}</span>}</header>
			{run && <RunView run={run} snapshot={snapshot} onFile={onFile} />}
			{agent.currentRun && <button className="danger" onClick={() => onStop(agent.sessionId)}>この枝を停止</button>}
			{history.length > 0 && <details className="agent-history"><summary>過去の実行 <span>{history.length}</span></summary>{history.map((previous) => <RunView key={previous.runId} run={previous} snapshot={snapshot} onFile={onFile} showStatus />)}</details>}
			<details className="agent-metadata"><summary>識別子</summary><div>エージェント <code>{agent.agentId}</code></div>{run && <div>実行 <code>{run.runId}</code></div>}</details>
		</article>
		{children.length > 0 && <ul className="team-tree">{children.map((child) => <AgentNode key={child.agentId} agent={child} snapshot={snapshot} selectedSessionId={selectedSessionId} onSelect={onSelect} onStop={onStop} onFile={onFile} />)}</ul>}
	</li>;
}

function RunView({ run, snapshot, onFile, showStatus = false }: { run: Run; snapshot: TeamSnapshot; onFile: (path: string, line?: number) => void; showStatus?: boolean }) {
	return <div className="run-detail">
		<div className="run-heading"><span className="run-task-label">作業</span>{showStatus && <span className={`badge status-${run.status}`}>{RUN_LABELS[run.status]}</span>}</div>
		<p className="task-text">{run.task}</p>
		{run.waitingOnRunIds?.length ? <p className="waiting-targets">待機対象: {run.waitingOnRunIds.map((id) => {
			const target = snapshot.runs.find((value) => value.runId === id);
			return `${snapshot.agents.find((agent) => agent.agentId === target?.agentId)?.name ?? id}`;
		}).join(", ")}</p> : null}
		{run.error && <p className="error">{run.error}</p>}
		{run.result !== undefined && <details className="run-result"><summary>結果を表示</summary><div className="run-result-content"><Content value={run.result} onFile={onFile} /></div></details>}
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
