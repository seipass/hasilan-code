import { useEffect, useState, type SubmitEvent } from "react";
import { Content } from "./Content.tsx";
import type { Run, RunStatus, SessionSummary, TeamAgent, TeamSnapshot } from "./types.ts";

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
	return !agent.parentAgentId && agent.name === "Root" ? "調整役" : agent.name;
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

function TeamNode({ agent, agents, runs, focusedId, focus }: {
	agent: TeamAgent;
	agents: TeamAgent[];
	runs: Run[];
	focusedId: string;
	focus: (id: string) => void;
}) {
	const run = agent.currentRun ?? agent.latestRun;
	const children = agents.filter((child) => child.parentAgentId === agent.agentId);
	const waiting = agent.currentRun?.waitingOnRunIds?.map((id) => {
		const target = runs.find((entry) => entry.runId === id);
		return agents.find((entry) => entry.agentId === target?.agentId);
	}).filter((entry): entry is TeamAgent => entry !== undefined);
	return <li className="team-map-branch">
		<button type="button" className={`team-map-node status-${status(agent)} ${focusedId === agent.agentId ? "focused" : ""}`} aria-pressed={focusedId === agent.agentId} onClick={() => focus(agent.agentId)}>
			<span className="team-map-node-heading"><strong>{label(agent)}</strong><span className={`team-map-state status-${status(agent)}`}>{status(agent) === "idle" ? "作業なし" : RUN_LABELS[status(agent) as RunStatus]}</span></span>
			<span className="team-map-task">{run ? taskText(run).split(/\r?\n/, 1)[0] : "まだ作業はありません"}</span>
			{waiting && waiting.length > 0 && <span className="team-map-wait">↳ {waiting.map(label).join("、")}の結果待ち</span>}
		</button>
		{children.length > 0 && <ul className="team-map-children">{children.map((child) => <TeamNode key={child.agentId} agent={child} agents={agents} runs={runs} focusedId={focusedId} focus={focus} />)}</ul>}
	</li>;
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
		{run.status === "queued" && <p className="team-inline-note">順番を待っています。開始前のため経過時間はありません。</p>}
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
	const agents = snapshot?.agents.filter((agent) => !selected || agent.teamId === selected.teamId) ?? [];
	const roots = agents.filter((agent) => !agent.parentAgentId);
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
	const situation = problems ? "失敗・中断した作業があります" : counts.running ? "担当が作業中です" : counts.waiting || rootState === "waiting" ? "子の結果を待っています" : counts.queued ? "担当の開始待ちです" : counts.stopping || rootState === "cancelling" ? "停止処理中です" : rootState === "cancelled" ? "チームの作業を中止しました" : rootState === "completed" ? "作業を完了しました" : rootState === "running" ? "調整役が作業中です" : "現在進行中の作業はありません";
	const run = focused?.currentRun ?? focused?.latestRun;
	const parent = agents.find((agent) => agent.agentId === focused?.parentAgentId);
	const directChildren = agents.filter((agent) => agent.parentAgentId === focused?.agentId).length;
	const model = sessions.find((session) => session.sessionId === focused?.sessionId)?.model;
	const previous = focused ? snapshot?.runs.filter((item) => item.agentId === focused.agentId && item.runId !== run?.runId) ?? [] : [];
	return <section className="team-pane" aria-label="チームの進行状況">
		{roots.length === 0 ? <div className="team-empty"><h2>チームの作業はまだありません</h2><p>担当が起動すると、親子関係と作業状況がここに表示されます。</p></div> : <>
			<header className="team-overview"><span className="team-section-label">チームの現在地</span><h2>{situation}</h2><p>担当 {workers.length}人 <span>·</span> 作業中 {counts.running} <span>·</span> 結果待ち {counts.waiting} <span>·</span> 開始待ち {counts.queued} <span>·</span> 完了 {counts.completed}{counts.cancelled > 0 && <> <span>·</span> 中止 {counts.cancelled}</>}</p>{problems > 0 && <strong className="team-attention">確認が必要な作業 {problems}件</strong>}</header>
			<section className="team-map" aria-label="エージェントの親子関係"><div className="team-section-heading"><h3>チームの関係図</h3><span>担当を選ぶと下に詳細を表示</span></div><div className="team-map-scroll"><ul className="team-map-roots">{snapshot && roots.map((agent) => <TeamNode key={agent.agentId} agent={agent} agents={agents} runs={snapshot.runs} focusedId={focused?.agentId ?? ""} focus={setFocusedId} />)}</ul></div></section>
			{focused && snapshot && <section className="team-focus" aria-label={`${label(focused)}の詳細`}>
				<header className="team-focus-header"><div><span className="team-section-label">選択中の担当</span><h3>{label(focused)}</h3></div><button type="button" className="text-link" onClick={() => onSelect(focused.sessionId)}>会話を開く ↗</button></header>
				<div className="team-relationship">{parent ? <>親: <button type="button" className="text-link" onClick={() => setFocusedId(parent.agentId)}>{label(parent)}</button></> : "チームの調整役"}{directChildren > 0 && <span> · 子 {directChildren}人</span>}{model && <span> · {model.name ?? model.id}</span>}</div>
				{run ? <RunDetail run={run} snapshot={snapshot} focus={setFocusedId} onFile={onFile} now={now} /> : <p className="team-inline-note">まだ作業はありません。</p>}
				<div className="team-focus-actions">{focused.parentAgentId && <details><summary>{label(focused)}にメッセージを送る</summary><MessageForm key={focused.agentId} agent={focused} onMessage={onMessage} /></details>}{focused.currentRun && <button className="danger" type="button" onClick={() => onStop(focused.sessionId)}>{focused.parentAgentId ? "この担当と子を停止" : "チームを停止"}</button>}</div>
				{previous.length > 0 && <details className="team-run-history"><summary>以前の作業 {previous.length}件</summary>{previous.map((item) => <div key={item.runId} className="team-history-item"><RunDetail run={item} snapshot={snapshot} focus={setFocusedId} onFile={onFile} now={now} /></div>)}</details>}
			</section>}
		</>}
	</section>;
}
