import { useCallback, useEffect, useId, useMemo, useRef, useState, type SubmitEvent } from "react";
import { Content } from "./Content.tsx";
import { transitionItems } from "./item-transition.ts";
import { layoutTeamGraph, selectedTeamAgents, TEAM_NODE_HEIGHT, TEAM_NODE_WIDTH } from "./team-graph.ts";
import type { Run, RunStatus, SessionSummary, TeamAgent, TeamSnapshot } from "./types.ts";
import "./TeamPane.css";

export const RUN_LABELS: Record<RunStatus, string> = {
	queued: "開始待ち", running: "作業中", waiting: "結果待ち", cancelling: "停止中",
	completed: "完了", failed: "失敗", cancelled: "中止", interrupted: "中断",
};

type TeamPaneProps = {
	snapshot?: TeamSnapshot;
	sessions: SessionSummary[];
	selectedSessionId?: string;
	onSelect: (sessionId: string) => void;
	onStop: (sessionId: string) => void;
	onMessage: (agentId: string, message: string) => Promise<void>;
	onFile: (path: string, line?: number) => void;
};

function label(agent: TeamAgent): string {
	return !agent.parentAgentId && agent.name === "Root" ? "親AI" : agent.name;
}

function status(agent: TeamAgent): RunStatus | "idle" {
	return agent.currentRun?.status ?? agent.latestRun?.status ?? "idle";
}

function taskText(run: Run): string {
	return run.task.replace(/^\[Team message inputId=[^\]\r\n]*\]\r?\n/, "");
}

function elapsed(run: Run, now: number): string | undefined {
	if (!run.startedAt) return undefined;
	const start = Date.parse(run.startedAt);
	const end = run.settledAt ? Date.parse(run.settledAt) : now;
	if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
	const minutes = Math.floor(Math.max(0, end - start) / 60_000);
	return minutes < 1 ? "1分未満" : minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

function MessageForm({ agent, onMessage }: { agent: TeamAgent; onMessage: TeamPaneProps["onMessage"] }) {
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string }>();
	async function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (sending || !draft.trim()) return;
		setSending(true);
		setNotice(undefined);
		try {
			await onMessage(agent.agentId, draft.trim());
			setDraft("");
			setNotice({ kind: "success", text: "送信しました" });
		} catch (error) {
			setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
		} finally {
			setSending(false);
		}
	}
	return <form className="team-message-form" onSubmit={(event) => { void submit(event); }}>
		<label htmlFor={`team-message-${agent.agentId}`}>依頼や補足</label>
		<textarea id={`team-message-${agent.agentId}`} value={draft} onChange={(event) => { setDraft(event.target.value); setNotice(undefined); }} rows={3} placeholder={`${label(agent)}に伝える内容`} disabled={sending} />
		<div className="team-message-actions"><button type="submit" disabled={sending || !draft.trim()}>{sending ? "送信中…" : `${label(agent)}に送信`}</button>{notice && <span role={notice.kind === "error" ? "alert" : "status"} className={notice.kind === "error" ? "error" : "team-message-success"}>{notice.text}</span>}</div>
	</form>;
}

function TeamGraph({ agents, snapshot, focusedId, focus }: {
	agents: TeamAgent[];
	snapshot: TeamSnapshot;
	focusedId: string;
	focus: (id: string) => void;
}) {
	const graph = useMemo(() => layoutTeamGraph(agents, snapshot), [agents, snapshot]);
	const waitingByAgent = useMemo(() => {
		const waiting = new Map<string, string[]>();
		for (const edge of graph.edges) {
			if (edge.kind !== "waiting") continue;
			const names = waiting.get(edge.from.agent.agentId);
			if (names) names.push(label(edge.to.agent));
			else waiting.set(edge.from.agent.agentId, [label(edge.to.agent)]);
		}
		return waiting;
	}, [graph]);
	const [zoom, setZoom] = useState(1);
	const viewport = useRef<HTMLDivElement>(null);
	const markerId = useId();
	const helpId = useId();
	const focused = graph.nodes.find((node) => node.agent.agentId === focusedId);
	const focusedX = focused?.x;
	const focusedY = focused?.y;
	const fitGraph = useCallback(() => {
		const element = viewport.current;
		if (element) setZoom(Math.max(0.65, Math.min(1, (element.clientWidth - 12) / graph.width, (element.clientHeight - 12) / graph.height)));
	}, [graph.width, graph.height]);
	useEffect(fitGraph, [fitGraph]);
	function centerSelected() {
		if (!viewport.current || focusedX === undefined || focusedY === undefined) return;
		viewport.current.scrollTo({
			left: (focusedX + TEAM_NODE_WIDTH / 2) * zoom - viewport.current.clientWidth / 2,
			top: (focusedY + TEAM_NODE_HEIGHT / 2) * zoom - viewport.current.clientHeight / 2,
		});
	}
	useEffect(() => {
		if (!viewport.current || focusedX === undefined || focusedY === undefined) return;
		viewport.current.scrollTo({
			left: (focusedX + TEAM_NODE_WIDTH / 2) * zoom - viewport.current.clientWidth / 2,
			top: (focusedY + TEAM_NODE_HEIGHT / 2) * zoom - viewport.current.clientHeight / 2,
		});
	}, [focusedX, focusedY, zoom]);
	return <section className="team-graph" aria-label="エージェントの親子関係">
		<div className="team-graph-heading"><div><h3>チームの関係図</h3><p>親AIと並行して動く担当</p></div><span className="team-graph-total">{agents.length} ノード</span></div>
		<div className="team-graph-toolbar" role="group" aria-label="関係図の表示">
			<div className="team-graph-zoom"><button type="button" aria-label="関係図を縮小" disabled={zoom <= 0.65} onClick={() => setZoom((value) => Math.max(0.65, Math.round((value - 0.1) * 100) / 100))}>−</button><output aria-label="関係図の拡大率">{Math.round(zoom * 100)}%</output><button type="button" aria-label="関係図を拡大" disabled={zoom >= 1.4} onClick={() => setZoom((value) => Math.min(1.4, Math.round((value + 0.1) * 100) / 100))}>＋</button></div>
			<button type="button" onClick={() => setZoom(1)}>等倍</button>
			<button type="button" onClick={fitGraph}>全体表示</button>
			<button type="button" onClick={centerSelected}>選択へ</button>
		</div>
		<p id={helpId} className="team-graph-help">スクロールで移動 · ノードを選ぶと下に詳細を表示</p>
		<div ref={viewport} className="team-graph-viewport" tabIndex={0} role="region" aria-label="チーム関係図のスクロール領域" aria-describedby={helpId}>
			<div className="team-graph-extent" style={{ width: graph.width * zoom, height: graph.height * zoom }}>
				<div className="team-graph-canvas" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}>
					<svg className="team-graph-edges" width={graph.width} height={graph.height} aria-hidden="true">
						<defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="context-stroke" strokeWidth="1.5" /></marker></defs>
						{graph.edges.map((edge) => {
							const waiting = edge.kind === "waiting";
							const x1 = edge.from.x + (waiting ? TEAM_NODE_WIDTH : TEAM_NODE_WIDTH / 2);
							const y1 = edge.from.y + (waiting ? TEAM_NODE_HEIGHT / 2 : TEAM_NODE_HEIGHT);
							const x2 = edge.to.x + (waiting ? TEAM_NODE_WIDTH : TEAM_NODE_WIDTH / 2);
							const y2 = edge.to.y + (waiting ? TEAM_NODE_HEIGHT / 2 : 0);
							const bendX = Math.max(x1, x2) + 20;
							const middleY = (y1 + y2) / 2;
							const path = waiting ? `M ${x1} ${y1} C ${bendX} ${y1}, ${bendX} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} C ${x1} ${middleY}, ${x2} ${middleY}, ${x2} ${y2}`;
							return <path key={`${edge.kind}-${edge.from.agent.agentId}-${edge.to.agent.agentId}`} className={`team-graph-edge is-${edge.kind}`} d={path} markerEnd={`url(#${markerId})`} />;
						})}
					</svg>
					{graph.nodes.map(({ agent, x, y }) => {
						const run = agent.currentRun ?? agent.latestRun;
						const state = status(agent);
						const stateLabel = state === "idle" ? "作業なし" : RUN_LABELS[state];
						const waiting = waitingByAgent.get(agent.agentId) ?? [];
						const task = run ? taskText(run) : "まだ作業はありません";
						return <button key={agent.agentId} type="button" className={`team-graph-node status-${state} ${!agent.parentAgentId ? "is-root" : "is-child"} ${focusedId === agent.agentId ? "is-selected" : ""}`} style={{ left: x, top: y, width: TEAM_NODE_WIDTH, height: TEAM_NODE_HEIGHT }} aria-pressed={focusedId === agent.agentId} aria-label={`${label(agent)}、${!agent.parentAgentId ? "親AI" : "子の担当"}、${stateLabel}。${task}${waiting.length ? `。${waiting.join("、")}の結果待ち` : ""}`} title={`${label(agent)}\n${task}`} onClick={() => focus(agent.agentId)}>
							<span className="team-graph-node-role">{!agent.parentAgentId ? "親AI / チームの起点" : "子の担当"}<span>{focusedId === agent.agentId ? "選択中" : ""}</span></span>
							<span className="team-graph-node-name">{label(agent)}</span>
							<span className="team-graph-node-task">{task}</span>
							<span className="team-graph-node-footer"><span className={`team-map-state status-${state}`}>{stateLabel}</span>{waiting.length > 0 && <span className="team-graph-node-wait" title={`${waiting.join("、")}の結果待ち`}>{waiting.length}人の結果待ち</span>}</span>
						</button>;
					})}
				</div>
			</div>
		</div>
		<div className="team-graph-legend" aria-label="関係図の凡例"><span><i className="team-graph-line" />親 → 子</span><span><i className="team-graph-line is-waiting" />結果を待つ相手 →</span><span><i className="team-graph-selection" />選択中</span></div>
	</section>;
}

function RunDetail({ run, snapshot, focus, onFile, now }: {
	run: Run;
	snapshot: TeamSnapshot;
	focus: (id: string) => void;
	onFile: TeamPaneProps["onFile"];
	now: number;
}) {
	const waiting = run.waitingOnRunIds?.map((id) => {
		const target = snapshot.runs.find((entry) => entry.runId === id);
		return { agent: snapshot.agents.find((entry) => entry.agentId === target?.agentId), state: target?.status };
	});
	const firstLine = run.result?.split(/\r?\n/).find((line) => line.trim())?.trim();
	return <div className="team-run-detail">
		<div className="team-run-meta"><span className={`team-map-state status-${run.status}`}>{RUN_LABELS[run.status]}</span>{elapsed(run, now) && <span>{run.settledAt ? "所要" : "経過"} {elapsed(run, now)}</span>}</div>
		<h4>担当していること</h4>
		<p className="team-run-task">{taskText(run)}</p>
		{run.status === "waiting" && <div className="team-dependency"><strong>結果を待っている相手</strong>{waiting?.length ? <ul>{waiting.map(({ agent, state }, index) => <li key={`${run.runId}-${index}`}>
			{agent ? <button className="text-link" type="button" onClick={() => focus(agent.agentId)}>{label(agent)}</button> : "不明な担当"}<span> · {state ? RUN_LABELS[state] : "状態不明"}</span>
		</li>)}</ul> : <p>子の結果を待っています。</p>}</div>}
		{run.error && <div className="team-run-error"><strong>失敗・中断の理由</strong><p>{run.error}</p></div>}
		{run.result !== undefined && <div className="team-run-result"><strong>作業の結果</strong><p>{firstLine || "本文は空です"}</p><details><summary>結果の全文を読む</summary><div className="team-result-content"><Content value={run.result} onFile={onFile} /></div></details></div>}
	</div>;
}

export function TeamPane({ snapshot, sessions, selectedSessionId, onSelect, onStop, onMessage, onFile }: TeamPaneProps) {
	const [focusedId, setFocusedId] = useState<string>();
	const [now, setNow] = useState(() => Date.now());
	const selected = snapshot?.agents.find((agent) => agent.sessionId === selectedSessionId);
	useEffect(() => { setFocusedId(selected?.agentId); }, [selectedSessionId, selected?.agentId]);
	const agents = useMemo(() => selectedTeamAgents(snapshot, selectedSessionId), [snapshot, selectedSessionId]);
	const roots = agents.filter((agent) => !agent.parentAgentId || !agents.some((parent) => parent.agentId === agent.parentAgentId));
	const focused = agents.find((agent) => agent.agentId === focusedId) ?? selected ?? roots[0];
	const workers = agents.filter((agent) => agent.parentAgentId);
	const active = agents.some((agent) => !!agent.currentRun?.startedAt);
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, [active]);
	const counts = { running: 0, waiting: 0, queued: 0, completed: 0, cancelled: 0, problem: 0, stopping: 0 };
	for (const agent of workers) {
		const current = status(agent);
		if (current === "running" || current === "waiting" || current === "queued" || current === "completed" || current === "cancelled") counts[current]++;
		else if (current === "failed" || current === "interrupted") counts.problem++;
		else if (current === "cancelling") counts.stopping++;
	}
	const rootState = roots[0] ? status(roots[0]) : "idle";
	const problems = counts.problem + (rootState === "failed" || rootState === "interrupted" ? 1 : 0);
	const situation = problems ? "失敗・中断した作業があります" : counts.running ? "子の担当が作業中です" : counts.waiting || rootState === "waiting" ? "子の結果を待っています" : counts.queued ? "担当の開始待ちです" : counts.stopping || rootState === "cancelling" ? "停止処理中です" : rootState === "cancelled" ? "チームの作業を中止しました" : rootState === "completed" ? "作業を完了しました" : rootState === "running" ? "親AIが作業中です" : "現在進行中の作業はありません";
	const run = focused?.currentRun ?? focused?.latestRun;
	const parent = agents.find((agent) => agent.agentId === focused?.parentAgentId);
	const directChildren = agents.filter((agent) => agent.parentAgentId === focused?.agentId).length;
	const model = sessions.find((session) => session.sessionId === focused?.sessionId)?.model;
	const previous = focused ? snapshot?.runs.filter((item) => item.agentId === focused.agentId && item.runId !== run?.runId) ?? [] : [];
	function focusAgent(id: string) {
		if (id !== focused?.agentId) transitionItems(() => setFocusedId(id));
	}
	return <section className="team-pane" aria-label="チームの進行状況">
		{agents.length === 0 ? <div className="team-empty"><h2>この会話のチームはまだありません</h2><p>会話を始めると親AIを、担当が起動すると親子関係と実際の作業状況をここに表示します。</p></div> : <>
			<header className="team-overview"><span className="team-section-label">ライブ · この会話のチーム</span><h2 role="status">{situation}</h2><p>子の担当 {workers.length}人 <span>·</span> 作業中 {counts.running} <span>·</span> 結果待ち {counts.waiting} <span>·</span> 開始待ち {counts.queued} <span>·</span> 完了 {counts.completed}{counts.cancelled > 0 && <> <span>·</span> 中止 {counts.cancelled}</>}{counts.stopping > 0 && <> <span>·</span> 停止中 {counts.stopping}</>}</p>{problems > 0 && <strong className="team-attention">確認が必要な作業 {problems}件</strong>}</header>
			{snapshot && <TeamGraph key={selected?.teamId} agents={agents} snapshot={snapshot} focusedId={focused?.agentId ?? ""} focus={focusAgent} />}
			{focused && snapshot && <section className="team-focus" aria-label={`${label(focused)}の詳細`}>
				<header className="team-focus-header"><div><span className="team-section-label">選択中の担当</span><h3>{label(focused)}</h3></div><button type="button" className="text-link" onClick={() => onSelect(focused.sessionId)}>会話を開く ↗</button></header>
				<div className="team-relationship">{parent ? <>親: <button type="button" className="text-link" onClick={() => focusAgent(parent.agentId)}>{label(parent)}</button></> : "親AI · チームの起点"}{directChildren > 0 && <span> · 子 {directChildren}人</span>}{model && <span> · {model.name ?? model.id}</span>}</div>
				{run ? <RunDetail run={run} snapshot={snapshot} focus={focusAgent} onFile={onFile} now={now} /> : <p className="team-inline-note">まだ作業はありません。</p>}
				<div className="team-focus-actions">{focused.parentAgentId && <details><summary>{label(focused)}にメッセージを送る</summary><MessageForm key={focused.agentId} agent={focused} onMessage={onMessage} /></details>}{focused.currentRun && <button className="danger" type="button" onClick={() => onStop(focused.sessionId)}>{focused.parentAgentId ? "この担当と子を停止" : "チームを停止"}</button>}</div>
				{previous.length > 0 && <details className="team-run-history"><summary>以前の作業 {previous.length}件</summary>{previous.map((item) => <div key={item.runId} className="team-history-item"><RunDetail run={item} snapshot={snapshot} focus={focusAgent} onFile={onFile} now={now} /></div>)}</details>}
			</section>}
		</>}
	</section>;
}
