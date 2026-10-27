import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Content } from "./Content.tsx";
import { useAnimatedView } from "./animated-view.ts";
import { TeamGestures } from "./team-gestures.ts";
import { MobileSheet, useMobileLayout } from "./MobileSheet.tsx";
import { MotionItems, Presence } from "./Motion.tsx";
import { MotionLabel, MotionSize, MotionSwap } from "./MotionSwap.tsx";
import { layoutTeamGraph, selectedTeamAgents, teamEdgePath, TEAM_NODE_HEIGHT, TEAM_NODE_WIDTH } from "./team-graph.ts";
import type { Run, RunStatus, SessionSummary, TeamAgent, TeamSnapshot } from "./types.ts";
import { UsagePanel } from "./UsagePanel.tsx";
import "./TeamPane.css";

export const RUN_LABELS: Record<RunStatus, string> = {
	queued: "開始待ち", running: "作業中", waiting: "結果待ち", cancelling: "停止中",
	completed: "完了", failed: "失敗", cancelled: "中止", interrupted: "中断",
};

type AgentState = RunStatus | "idle" | "ready" | "coordinating" | "paused" | "blocked";
const AGENT_LABELS: Record<AgentState, string> = { ...RUN_LABELS, idle: "作業なし", ready: "指示待ち", coordinating: "調整中", paused: "一時停止", blocked: "判断待ち" };

type TeamPaneProps = {
	snapshot?: TeamSnapshot;
	sessions: SessionSummary[];
	selectedSessionId?: string;
	onSelect: (sessionId: string) => void;
	visible?: boolean;
	onStop: (sessionId: string) => void;
	onFile: (path: string, line?: number) => void;
};

function label(agent: TeamAgent): string {
	return !agent.parentAgentId && agent.name === "Root" ? "親AI" : agent.name;
}

function status(agent: TeamAgent, swarm?: SessionSummary["swarm"], managerId?: string): AgentState {
	if (agent.currentRun) return agent.currentRun.status;
	if (swarm && !agent.parentAgentId) {
		if (swarm.status === "active") return "coordinating";
		if (swarm.status === "paused" || swarm.status === "blocked") return swarm.status;
		return "completed";
	}
	if (managerId && agent.parentAgentId === managerId && (!agent.latestRun || agent.latestRun.status === "completed")) return "ready";
	return agent.latestRun?.status ?? "idle";
}

function taskText(run: Run): string {
	return run.task.replace(/^\[Team (?:message inputId=|handoff from=)[^\]\r\n]*\]\r?\n/, "");
}

function elapsed(run: Run, now: number): string | undefined {
	if (!run.startedAt) return undefined;
	const start = Date.parse(run.startedAt);
	const end = run.settledAt ? Date.parse(run.settledAt) : now;
	if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
	const minutes = Math.floor(Math.max(0, end - start) / 60_000);
	return minutes < 1 ? "1分未満" : minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

function TeamGraph({ agents, snapshot, focusedId, focus, overview, swarm, visible }: {
	agents: TeamAgent[];
	snapshot: TeamSnapshot;
	focusedId: string;
	focus: (id: string) => void;
	overview: ReactNode;
	swarm: SessionSummary["swarm"];
	visible: boolean;
}) {
	const managed = snapshot.teams.some((team) => team.scope === "workspace" && team.teamId === agents[0]?.teamId) || !!swarm;
	const managerId = managed ? agents.find((member) => !member.parentAgentId)?.agentId : undefined;
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
	const { view, setView, animateView, viewRef } = useAnimatedView({ x: 0, y: 0, zoom: 1 });
	const [dragging, setDragging] = useState(false);
	const { zoom } = view;
	const viewport = useRef<HTMLDivElement>(null);
	const gesture = useRef(new TeamGestures());
	const suppressClick = useRef(false);
	const initialized = useRef(false);
	const markerId = useId();
	const focused = graph.nodes.find((node) => node.agent.agentId === focusedId);
	const fitGraph = useCallback((target = graph, smooth = true) => {
		const element = viewport.current;
		if (!element || !element.clientWidth || !element.clientHeight) return false;
		const nextZoom = Math.min(1, (element.clientWidth - 12) / target.width, (element.clientHeight - 12) / target.height);
		(smooth ? animateView : setView)({
			zoom: nextZoom,
			x: element.clientWidth / 2 - (target.x + target.width / 2) * nextZoom,
			y: element.clientHeight / 2 - (target.y + target.height / 2) * nextZoom,
		});
		return true;
	}, [graph, animateView, setView]);
	useEffect(() => {
		const element = viewport.current;
		if (!visible || !element || initialized.current) return;
		const fit = () => { if (!initialized.current && fitGraph(graph, false)) initialized.current = true; };
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(element);
		return () => observer.disconnect();
	}, [fitGraph, graph, visible]);
	useEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			const bounds = element.getBoundingClientRect();
			const x = event.clientX - bounds.left;
			const y = event.clientY - bounds.top;
			setView((current) => {
				const zoom = Math.max(0.01, Math.min(2, current.zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
				return { zoom, x: x - (x - current.x) * zoom / current.zoom, y: y - (y - current.y) * zoom / current.zoom };
			});
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, []);
	function zoomTo(nextZoom: number) {
		const element = viewport.current;
		if (!element) return;
		const x = element.clientWidth / 2;
		const y = element.clientHeight / 2;
		animateView((current) => {
			const next = Math.max(0.01, Math.min(2, nextZoom));
			return { zoom: next, x: x - (x - current.x) * next / current.zoom, y: y - (y - current.y) * next / current.zoom };
		});
	}
	function centerNode(x: number, y: number) {
		const element = viewport.current;
		if (!element) return;
		animateView((current) => ({
			...current,
			x: element.clientWidth / 2 - (x + TEAM_NODE_WIDTH / 2) * current.zoom,
			y: element.clientHeight / 2 - (y + TEAM_NODE_HEIGHT / 2) * current.zoom,
		}));
	}
	function beginGesture(event: ReactPointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		const touch = event.pointerType === "touch";
		if (!touch && event.target instanceof Element && event.target.closest("button")) return;
		if (!touch && gesture.current.pointers.size) return;
		setView((current) => current);
		const bounds = event.currentTarget.getBoundingClientRect();
		gesture.current.start(event.pointerId, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, viewRef.current);
		suppressClick.current = gesture.current.moved;
		if (!touch || gesture.current.pointers.size > 1) {
			event.preventDefault();
			for (const pointerId of gesture.current.pointers.keys()) event.currentTarget.setPointerCapture(pointerId);
		}
		if (!touch) event.currentTarget.focus({ preventScroll: true });
	}
	function moveGesture(event: ReactPointerEvent<HTMLDivElement>) {
		const bounds = event.currentTarget.getBoundingClientRect();
		const next = gesture.current.move(event.pointerId, { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
		if (!next) return;
		event.preventDefault();
		for (const pointerId of gesture.current.pointers.keys()) event.currentTarget.setPointerCapture(pointerId);
		suppressClick.current = true;
		setDragging(true);
		viewRef.current = next;
		setView(next);
	}
	function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
		gesture.current.end(event.pointerId, viewRef.current);
		if (!gesture.current.pointers.size) setDragging(false);
	}
	return <section className="team-graph" aria-label="エージェントの親子関係">
		<div className="team-graph-top">
			{overview}
			<div className="team-graph-controls">
		<div className="team-graph-toolbar" role="group" aria-label="関係図の表示">
			<div className="team-graph-zoom"><button type="button" aria-label="関係図を縮小" disabled={zoom <= 0.01} onClick={() => zoomTo(zoom / 1.2)}>−</button><output aria-label="関係図の拡大率">{Math.round(zoom * 100)}%</output><button type="button" aria-label="関係図を拡大" disabled={zoom >= 2} onClick={() => zoomTo(zoom * 1.2)}>＋</button></div>
			<button type="button" onClick={() => zoomTo(1)}>等倍</button>
			<button type="button" onClick={() => fitGraph()}>全体表示</button>
			<button type="button" disabled={!focused} onClick={() => { if (focused) centerNode(focused.x, focused.y); }}>選択へ</button>
		</div>
				<div className="team-graph-legend" aria-label="関係図の凡例"><span><i className="team-graph-line" />親 → 子</span><span><i className="team-graph-line is-waiting" />結果を待つ相手 →</span><span><i className="team-graph-selection" />選択中</span></div>
			</div>
		</div>
		<div ref={viewport} className={`team-graph-viewport${dragging ? " is-dragging" : ""}`} tabIndex={0} role="region" aria-label="チーム関係図。ドラッグして移動、2本指のピンチまたはホイールで拡大縮小、Tab・Enterで担当を選択。"
			onPointerDownCapture={beginGesture} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture} onLostPointerCapture={(event) => { if (event.target === event.currentTarget) endGesture(event); }}
			onClickCapture={(event) => {
				if (event.detail && suppressClick.current) { event.preventDefault(); event.stopPropagation(); }
				suppressClick.current = false;
			}}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget) return;
				let dx = 0;
				let dy = 0;
				if (event.key === "ArrowLeft") dx = 40;
				else if (event.key === "ArrowRight") dx = -40;
				else if (event.key === "ArrowUp") dy = 40;
				else if (event.key === "ArrowDown") dy = -40;
				else return;
				event.preventDefault();
				animateView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
			}}>
				<div className="team-graph-canvas" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})` }}>
					<svg className="team-graph-edges" aria-hidden="true">
						<defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="context-stroke" strokeWidth="1.5" /></marker></defs>
						<MotionItems items={graph.edges} itemKey={(edge) => edge.id} enabled={false}>{(edge) => <path key={edge.id} className={`team-graph-edge is-${edge.kind}`} d={teamEdgePath(edge)} markerEnd={`url(#${markerId})`} />}</MotionItems>
					</svg>
					<MotionItems items={graph.nodes} itemKey={(node) => node.agent.agentId} enabled={false}>{({ agent, x, y }) => {
						const run = agent.currentRun ?? agent.latestRun;
						const state = status(agent, swarm, managerId);
						const stateLabel = AGENT_LABELS[state];
						const role = !agent.parentAgentId ? managed ? "親AI / マネージャー" : "親AI / チームの起点" : managed ? agent.parentAgentId === managerId ? "担当者" : "補助エージェント" : "子の担当";
						const waiting = waitingByAgent.get(agent.agentId) ?? [];
						const task = run ? taskText(run) : "まだ作業はありません";
						return <button key={agent.agentId} type="button" className={`team-graph-node status-${state} ${!agent.parentAgentId ? "is-root" : "is-child"} ${focusedId === agent.agentId ? "is-selected" : ""}`} style={{ left: x, top: y, width: TEAM_NODE_WIDTH, height: TEAM_NODE_HEIGHT }} aria-pressed={focusedId === agent.agentId} aria-label={`${label(agent)}、${role}、${stateLabel}。${task}${waiting.length ? `。${waiting.join("、")}の結果待ち` : ""}`} title={`${label(agent)}\n${task}`} onFocus={(event) => { if (!gesture.current.pointers.size && event.currentTarget.matches(":focus-visible")) centerNode(x, y); }} onClick={() => focus(agent.agentId)}>
							<span className="team-graph-node-role">{role}</span>
							<span className="team-graph-node-name">{label(agent)}</span>
							<MotionSwap identity={task} className="team-node-task-swap" inline><span className="team-graph-node-task">{task}</span></MotionSwap>
							<span className="team-graph-node-footer"><span className={`team-map-state status-${state}`}><MotionLabel value={stateLabel} /></span><Presence show={waiting.length > 0}><span className="team-graph-node-wait" title={`${waiting.join("、")}の結果待ち`}><MotionLabel value={`${waiting.length}人の結果待ち`} /></span></Presence></span>
						</button>;
					}}</MotionItems>
				</div>
		</div>
	</section>;
}

function RunDetail({ run, snapshot, focus, onFile, now, onOpen }: {
	run: Run;
	snapshot: TeamSnapshot;
	focus: (id: string) => void;
	onFile: TeamPaneProps["onFile"];
	now: number;
	onOpen: () => void;
}) {
	const waiting = run.waitingOnRunIds?.map((id) => {
		const target = snapshot.runs.find((entry) => entry.runId === id);
		return { id, agent: snapshot.agents.find((entry) => entry.agentId === target?.agentId), state: target?.status };
	});
	const firstLine = run.result?.split(/\r?\n/).find((line) => line.trim())?.trim();
	const transferred = run.handoffToRunId ? snapshot.runs.find((entry) => entry.runId === run.handoffToRunId) : undefined;
	const owner = snapshot.agents.find((agent) => agent.agentId === transferred?.agentId);
	return <div className="team-run-detail">
		<div className="team-run-meta"><span className={`team-map-state status-${run.status}`}><MotionLabel value={run.handoffToRunId ? "引き継ぎ済み" : run.status === "completed" ? "作業完了" : RUN_LABELS[run.status]} /></span>{elapsed(run, now) && <span><MotionLabel value={`${run.settledAt ? "所要" : "経過"} ${elapsed(run, now)}`} /></span>}</div>
		<div className="team-task-heading"><h4>{run.settledAt ? "作業内容" : "担当していること"}</h4><button type="button" className="text-link" onClick={onOpen}>会話を開く ↗</button></div>
		<MotionSwap identity={taskText(run)}><p className="team-run-task">{taskText(run)}</p></MotionSwap>
		<MotionSwap identity={owner?.agentId ?? "none"}>{owner ? <p className="team-dependency">引き継ぎ先: <button type="button" className="text-link" onClick={() => focus(owner.agentId)}>{label(owner)}</button></p> : null}</MotionSwap>
		<Presence show={run.status === "waiting"}><div className="team-dependency"><strong>結果を待っている相手</strong><ul><MotionItems items={waiting ?? []} itemKey={(entry) => entry.id}>{({ id, agent, state }) => <li key={id}>
			{agent ? <button className="text-link" type="button" onClick={() => focus(agent.agentId)}>{label(agent)}</button> : "不明な担当"}<span> · <MotionLabel value={state ? RUN_LABELS[state] : "状態不明"} /></span>
		</li>}</MotionItems></ul><Presence show={!waiting?.length}><p>子の結果を待っています。</p></Presence></div></Presence>
		<Presence show={!!run.error}><div className="team-run-error"><strong>失敗・中断の理由</strong><MotionSwap identity={run.error ?? ""}><p>{run.error}</p></MotionSwap></div></Presence>
		<Presence show={run.result !== undefined}><div className="team-run-result"><strong>作業の結果</strong><MotionSwap identity={firstLine ?? ""}><p>{firstLine || "本文は空です"}</p></MotionSwap><details><summary>結果の全文を読む</summary><div className="team-result-content"><Content value={run.result} onFile={onFile} /></div></details></div></Presence>
	</div>;
}

export function TeamPane({ snapshot, sessions, selectedSessionId, visible = true, onSelect, onStop, onFile }: TeamPaneProps) {
	const mobile = useMobileLayout();
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [focusedId, setFocusedId] = useState<string>();
	const [now, setNow] = useState(() => Date.now());
	const agents = useMemo(() => selectedTeamAgents(snapshot, selectedSessionId), [snapshot, selectedSessionId]);
	const selected = agents.find((agent) => agent.sessionId === selectedSessionId);
	useEffect(() => { setFocusedId(selected?.agentId); setDetailsOpen(false); }, [selectedSessionId, selected?.agentId]);
	useEffect(() => { if (!mobile || !visible) setDetailsOpen(false); }, [mobile, visible]);
	const roots = agents.filter((agent) => !agent.parentAgentId || !agents.some((parent) => parent.agentId === agent.parentAgentId));
	const swarm = sessions.find((session) => session.sessionId === roots[0]?.sessionId)?.swarm;
	const managed = !!swarm || snapshot?.teams.some((team) => team.scope === "workspace" && team.rootAgentId === roots[0]?.agentId);
	const focused = agents.find((agent) => agent.agentId === focusedId) ?? selected ?? roots[0];
	const workers = agents.filter((agent) => agent.parentAgentId);
	const specialists = workers.filter((agent) => agent.parentAgentId === roots[0]?.agentId);
	const helpers = workers.length - specialists.length;
	const active = agents.some((agent) => !!agent.currentRun?.startedAt);
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, [active]);
	const counts = { running: 0, waiting: 0, queued: 0, completed: 0, ready: 0, cancelled: 0, problem: 0, stopping: 0 };
	for (const agent of workers) {
		const current = status(agent, swarm, managed ? roots[0]?.agentId : undefined);
		if (current === "running" || current === "waiting" || current === "queued" || current === "completed" || current === "ready" || current === "cancelled") counts[current]++;
		else if (current === "failed" || current === "interrupted") counts.problem++;
		else if (current === "cancelling") counts.stopping++;
	}
	const rootState = roots[0] ? status(roots[0], swarm, managed ? roots[0].agentId : undefined) : "idle";
	const problems = counts.problem + (rootState === "failed" || rootState === "interrupted" ? 1 : 0);
	let situation: string;
	if (swarm?.status === "complete" && !agents.some((agent) => agent.currentRun)) situation = "チームの作業を完了しました";
	else if (swarm?.status === "paused") situation = "チームを一時停止しています";
	else if (swarm?.status === "blocked") situation = "判断・追加情報を待っています";
	else if (problems) situation = "失敗・中断した作業があります";
	else if (counts.running) situation = managed ? "担当者が作業中です" : "子の担当が作業中です";
	else if (counts.waiting || rootState === "waiting") situation = "担当の結果を待っています";
	else if (counts.queued) situation = "担当の開始待ちです";
	else if (counts.stopping || rootState === "cancelling") situation = "停止処理中です";
	else if (swarm?.status === "active") situation = "マネージャーが次の作業を確認しています";
	else if (rootState === "cancelled") situation = "チームの作業を中止しました";
	else if (rootState === "completed") situation = "作業を完了しました";
	else if (rootState === "running") situation = managed ? "マネージャーが対応中です" : "親AIが作業中です";
	else situation = "現在進行中の作業はありません";
	const run = focused?.currentRun ?? focused?.latestRun;
	const detailId = `${focused?.agentId ?? "none"}:${run?.runId ?? "idle"}`;
	function focusAgent(id: string) {
		if (id !== focused?.agentId) setFocusedId(id);
		if (mobile) setDetailsOpen(true);
	}
	const sessionUsage = new Map(sessions.map((session) => [session.sessionId, session.usage]));
	const summary = [`${managed ? "担当者" : "子の担当"} ${managed ? specialists.length : workers.length}人`, ...(managed && helpers > 0 ? [`補助 ${helpers}人`] : []), `作業中 ${counts.running}`, `結果待ち ${counts.waiting}`, `開始待ち ${counts.queued}`, managed ? `指示待ち ${counts.ready}` : `完了 ${counts.completed}`, ...(counts.cancelled > 0 ? [`中止 ${counts.cancelled}`] : []), ...(counts.stopping > 0 ? [`停止中 ${counts.stopping}`] : [])].join(" · ");
	const overview = <header className="team-overview"><MotionSize><MotionSwap identity={situation}><h2 role="status">{situation}</h2></MotionSwap><MotionSwap identity={summary}><p>{summary}</p></MotionSwap><Presence show={problems > 0}><strong className="team-attention"><MotionLabel value={`確認が必要な作業 ${problems}件`} /></strong></Presence><UsagePanel title="チームの使用量" groups={agents.map((agent) => ({ id: agent.agentId, label: label(agent), usage: sessionUsage.get(agent.sessionId) }))} /></MotionSize></header>;
	const details = focused && snapshot && <section className="team-focus" aria-label={`${label(focused)}の詳細`}>
				<MotionSize><MotionSwap identity={detailId} enabled={visible}><div key={detailId} className="team-focus-content">
				<Presence show={!!focused.responsibility}><section className="team-responsibility"><h4>担当範囲</h4><MotionSwap identity={focused.responsibility ?? ""}><p>{focused.responsibility}</p></MotionSwap></section></Presence>
				{run ? <RunDetail run={run} snapshot={snapshot} focus={focusAgent} onFile={onFile} now={now} onOpen={() => { setDetailsOpen(false); onSelect(focused.sessionId); }} /> : <p className="team-inline-note">まだ作業はありません。<button type="button" className="text-link" onClick={() => { setDetailsOpen(false); onSelect(focused.sessionId); }}>会話を開く ↗</button></p>}
				<Presence show={!!focused.currentRun}><div className="team-focus-actions"><button className="danger" type="button" onClick={() => onStop(focused.sessionId)}>{focused.parentAgentId ? "この担当と子を停止" : "チームを停止"}</button></div></Presence>
				</div></MotionSwap></MotionSize>
			</section>;
	return <section className="team-pane" aria-label="チームの進行状況">
		<Presence show={agents.length === 0}><div className="team-empty"><h2>この会話のチームはまだありません</h2></div></Presence>
			<Presence show={!!snapshot && agents.length > 0}><div className="motion-contents"><MotionSwap identity={roots[0]?.teamId ?? "none"} className="team-graph-swap" enabled={visible}>{snapshot && <TeamGraph key={roots[0]?.teamId} agents={agents} snapshot={snapshot} focusedId={focused?.agentId ?? ""} focus={focusAgent} overview={overview} swarm={swarm} visible={visible} />}</MotionSwap></div></Presence>
			{mobile ? <>
				<Presence show={!!focused}><button type="button" className="team-focus-trigger" aria-haspopup="dialog" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(true)}>{focused && label(focused)}の詳細</button></Presence>
				<MobileSheet open={detailsOpen && visible && agents.length > 0} side="bottom" title="担当の詳細" onClose={() => setDetailsOpen(false)}>{details}</MobileSheet>
			</> : <Presence show={!!details}>{details}</Presence>}
	</section>;
}
