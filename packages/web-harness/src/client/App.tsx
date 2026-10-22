import type { ThinkingLevel } from "@hasilan-code/pi-agent-core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Goal, GoalAction } from "../shared/goals.ts";
import { api, command, errorMessage } from "./api.ts";
import { ChatPane } from "./ChatPane.tsx";
import { CanvasPane } from "./CanvasPane.tsx";
import { DetailPane, type DetailView } from "./DetailPane.tsx";
import type { FileTarget } from "./files/FilePane.tsx";
import { GoalPanel } from "./GoalPanel.tsx";
import { nextClientId } from "./ids.ts";
import { ModelMenu } from "./ModelMenu.tsx";
import { PanelResize } from "./PanelResize.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { useChannel } from "./subscriptions.ts";
import { parseComposerCommand } from "./slash-command.ts";
import { RUN_LABELS, TeamPane } from "./TeamPane.tsx";
import { selectedTeamAgents } from "./team-graph.ts";
import { ToolInspector } from "./ToolInspector.tsx";
import type { Model, ModelCatalog, PendingInputAction, SessionDetail, SessionSummary, Workspace, WorkspaceProjection } from "./types.ts";
import "./WorkspaceModes.css";

function WorkspaceFeed({ id, onUpdate, onFiles }: { id: string; onUpdate: (id: string, data: WorkspaceProjection) => void; onFiles: () => void }) {
	const channel = useChannel<WorkspaceProjection>("workspace", id, onFiles);
	useEffect(() => { if (channel.data) onUpdate(id, channel.data); }, [id, channel.data, onUpdate]);
	return null;
}

export function App() {
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [mode, setMode] = useState<"chat" | "canvas">("chat");
	const [canvasTarget, setCanvasTarget] = useState<"chat" | "swarm">("chat");
	const [canvasDirty, setCanvasDirty] = useState(false);
	const [canvasOpened, setCanvasOpened] = useState(false);
	const [draftInsertion, setDraftInsertion] = useState<{ id: string; text: string }>();
	const [workspaceId, setWorkspaceId] = useState<string>();
	const [sessionId, setSessionId] = useState<string | undefined>(() => { try { return localStorage.getItem("pi-web-selected-session") || undefined; } catch { return undefined; } });
	const [projections, setProjections] = useState<Record<string, WorkspaceProjection>>({});
	const [initialSessions, setInitialSessions] = useState<SessionSummary[]>([]);
	const [error, setError] = useState<string>();
	const [catalog, setCatalog] = useState<ModelCatalog>();
	const [catalogVersion, setCatalogVersion] = useState(0);
	const [savedSelection] = useState<{ model?: Model; thinkingLevel?: ThinkingLevel }>(() => {
		try {
			const saved = JSON.parse(localStorage.getItem("pi-web-model-selection") ?? "null") as { model?: Model; thinkingLevel?: ThinkingLevel } | null;
			if (!saved || typeof saved.model?.provider !== "string" || typeof saved.model?.id !== "string") return {};
			return {
				model: { provider: saved.model.provider, id: saved.model.id },
				thinkingLevel: saved.thinkingLevel && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(saved.thinkingLevel) ? saved.thinkingLevel : undefined,
			};
		} catch { return {}; }
	});
	const [draftModel, setDraftModel] = useState<Model | undefined>(savedSelection.model);
	const [draftThinking, setDraftThinking] = useState<ThinkingLevel | undefined>(savedSelection.thinkingLevel);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [modelClosing, setModelClosing] = useState(false);
	const [modelMenuKey, setModelMenuKey] = useState(0);
	const [addingWorkspace, setAddingWorkspace] = useState(false);
	const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
	const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 900);
	const [historyQuery, setHistoryQuery] = useState("");
	const [rightTab, setRightTab] = useState<DetailView>("tabs");
	const [rightOpen, setRightOpen] = useState(false);
	const [rightWidth, setRightWidth] = useState(660);
	const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
	const [fileTarget, setFileTarget] = useState<FileTarget>();
	const [filesVersion, setFilesVersion] = useState(0);
	const draftSession = useRef<string | undefined>(undefined);
	const searchInput = useRef<HTMLInputElement>(null);
	const commandPending = useRef(false);
	const clearDraftInsertion = useCallback(() => setDraftInsertion(undefined), []);
	const sidebarRef = useRef<HTMLElement>(null);
	const sidebarOpener = useRef<HTMLButtonElement>(null);
	const rightPanelRef = useRef<HTMLElement>(null);
	const rightPanelToggle = useRef<HTMLButtonElement>(null);
	const workspaceChannel = useChannel<WorkspaceProjection>("workspace", workspaceId, () => setFilesVersion((value) => value + 1));
	const sessionChannel = useChannel<SessionDetail>("session", sessionId);
	const session = sessionChannel.data;
	const model = session?.model ?? draftModel;
	const selectedModel = catalog?.models.find((entry) => entry.provider === model?.provider && entry.id === model.id) ?? model;
	const modelNeedsAuthentication = model
		? catalog?.providers.find((entry) => entry.id === model.provider)?.configured === false
		: !!catalog?.providers.length && catalog.providers.every((entry) => entry.configured === false);
	const modelSetup = modelNeedsAuthentication ? "authentication" : !model ? "selection" : undefined;
	const workspace = workspaces.find((entry) => entry.workspaceId === workspaceId);
	const summaries = [...initialSessions.filter((entry) => !projections[entry.workspaceId]), ...Object.values(projections).flatMap((projection) => projection.sessions)];
	const team = workspaceChannel.data?.teams;
	const selectedAgent = team?.agents.find((agent) => agent.sessionId === sessionId);
	const teamAgents = selectedTeamAgents(team, sessionId);
	const workspaceTeam = team?.teams.find((entry) => entry.scope === "workspace");
	const showingWorkspaceTeam = !!workspaceTeam && teamAgents[0]?.teamId === workspaceTeam.teamId;
	const workingAgents = teamAgents.filter((agent) => agent.parentAgentId && agent.currentRun?.status === "running").length;
	const roots = summaries.filter((entry) => !entry.parentSessionId);
	const history = roots.filter((entry) => `${entry.title ?? ""} ${workspaces.find((item) => item.workspaceId === entry.workspaceId)?.path ?? ""}`.toLowerCase().includes(historyQuery.toLowerCase())).sort((a, b) => Number(!!b.currentRun) - Number(!!a.currentRun) || String(b.latestRun?.startedAt ?? "").localeCompare(String(a.latestRun?.startedAt ?? "")));
	const updateProjection = useCallback((id: string, data: WorkspaceProjection) => setProjections((previous) => ({ ...previous, [id]: data })), []);
	const filesChanged = useCallback(() => setFilesVersion((value) => value + 1), []);
	useEffect(() => {
		const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	useEffect(() => {
		if (!sidebarOpen && sidebarRef.current?.contains(document.activeElement)) sidebarOpener.current?.focus();
	}, [sidebarOpen]);
	useEffect(() => {
		if (!rightOpen && rightPanelRef.current?.contains(document.activeElement)) rightPanelToggle.current?.focus();
	}, [rightOpen]);
	useEffect(() => { if (workspaceId && workspaceChannel.data) updateProjection(workspaceId, workspaceChannel.data); }, [workspaceId, workspaceChannel.data, updateProjection]);
	useEffect(() => {
		const controller = new AbortController();
		Promise.all([api<Workspace[]>("/api/workspaces", { signal: controller.signal }), api<SessionSummary[]>("/api/sessions", { signal: controller.signal })]).then(([folders, sessions]) => {
			setWorkspaces(folders); setInitialSessions(sessions);
			let previousSession: string | null = null; let previousWorkspace: string | null = null;
			try { previousSession = localStorage.getItem("pi-web-selected-session"); previousWorkspace = localStorage.getItem("pi-web-workspace"); } catch { /* Browser storage is optional. */ }
			const restored = sessions.find((entry) => entry.sessionId === previousSession);
			setSessionId(restored?.sessionId);
			setMode("chat");
			setWorkspaceId(restored?.workspaceId ?? folders.find((entry) => entry.workspaceId === previousWorkspace)?.workspaceId ?? folders[0]?.workspaceId);
		}).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, []);
	useEffect(() => {
		if (!workspaceId) return;
		const controller = new AbortController();
		api<ModelCatalog>("/api/models", { signal: controller.signal }).then(setCatalog).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, [catalogVersion, workspaceId]);
	useEffect(() => {
		try { if (sessionId) localStorage.setItem("pi-web-selected-session", sessionId); else localStorage.removeItem("pi-web-selected-session"); if (workspaceId) localStorage.setItem("pi-web-workspace", workspaceId); } catch { /* Selection remains functional without storage. */ }
	}, [sessionId, workspaceId]);
	useEffect(() => {
		try { localStorage.setItem("pi-web-model-selection", JSON.stringify({ model: draftModel, thinkingLevel: draftThinking })); }
		catch { /* Selection remains functional without browser storage. */ }
	}, [draftModel, draftThinking]);
	useEffect(() => {
		const keydown = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); } if (event.key === "Escape") { setModelOpen(false); setRightOpen(false); } };
		window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
	}, []);
	function selectSession(id: string) {
		if (commandPending.current) return;
		const summary = summaries.find((entry) => entry.sessionId === id);
		if (summary && summary.workspaceId !== workspaceId && canvasDirty && !window.confirm("Canvasの未保存の変更を破棄して移動しますか？")) return;
		setDraftInsertion(undefined);
		if (summary && summary.workspaceId !== workspaceId) { setCanvasDirty(false); setCanvasOpened(false); }
		draftSession.current = undefined;
		if (summary) setWorkspaceId(summary.workspaceId);
		if (summary) setExpandedWorkspaces((previous) => ({ ...previous, [summary.workspaceId]: true }));
		setMode("chat");
		setSessionId(id); setError(undefined); setFileTarget(undefined); setModelOpen(false);
		if (window.innerWidth < 900) setSidebarOpen(false);
	}
	function selectWorkspace(id: string) {
		if (commandPending.current) return;
		if (id !== workspaceId && canvasDirty && !window.confirm("Canvasの未保存の変更を破棄して移動しますか？")) return;
		setDraftInsertion(undefined);
		setExpandedWorkspaces((previous) => ({ ...previous, [id]: true }));
		if (id === workspaceId) return;
		setWorkspaceId(id); setSessionId(undefined); draftSession.current = undefined; setFileTarget(undefined); setModelOpen(false); setError(undefined); setCanvasDirty(false); setCanvasOpened(false); setMode("chat");
	}
	function newConversation() { if (commandPending.current) return; setMode("chat"); setSessionId(undefined); draftSession.current = undefined; setDraftInsertion(undefined); setDraftModel(model); setDraftThinking(session?.thinkingLevel ?? draftThinking); setRightOpen(false); setFileTarget(undefined); setError(undefined); if (window.innerWidth < 900) setSidebarOpen(false); }
	function openFile(path: string, line?: number) { setFileTarget({ path, line, requestId: nextClientId() }); setRightTab("tabs"); setRightOpen(true); }
	async function addWorkspace() {
		if (addingWorkspace) return;
		setAddingWorkspace(true); setError(undefined);
		try {
			let added: Workspace;
			if (window.location.hostname !== "127.0.0.1") {
				const path = window.prompt("サーバー上の作業フォルダーの絶対パス", workspace?.path ?? "");
				if (!path?.trim()) return;
				added = await command<Workspace>("/api/workspaces", { path });
			} else {
				const picked = await command<{ workspace: Workspace | null }>("/api/workspaces/pick", {});
				if (!picked.workspace) return;
				added = picked.workspace;
			}
			setWorkspaces((previous) => previous.some((entry) => entry.workspaceId === added.workspaceId) ? previous : [...previous, added]);
			selectWorkspace(added.workspaceId);
			setHistoryQuery("");
		} catch (reason) { setError(errorMessage(reason)); } finally { setAddingWorkspace(false); }
	}
	async function inputSession(): Promise<string> {
		if (!workspaceId) throw new Error("作業フォルダーを準備できません。フォルダーを選択してください。");
		if (modelNeedsAuthentication) { setSettingsOpen(true); throw new Error("プロバイダーの認証を設定してください。"); }
		if (!model) { setModelOpen(true); throw new Error("送信するモデルを選択してください。"); }
		let target = sessionId ?? draftSession.current;
		if (!target) { const created = await command<SessionSummary>("/api/sessions", { workspaceId, model: { provider: model.provider, id: model.id }, ...(draftThinking ? { thinkingLevel: draftThinking } : {}) }); target = created.sessionId; draftSession.current = target; }
		return target;
	}
	async function send(text: string, executionMode: "prompt" | "steer" | "followUp"): Promise<{ disposition?: "queued" | "started"; notice?: string }> {
		if (commandPending.current) throw new Error("送信処理中です。完了してから送信してください。");
		commandPending.current = true;
		try {
			const parsed = parseComposerCommand(text);
			if (parsed.kind === "canvas") {
				if (!workspaceId) throw new Error("ワークスペースを選択してください。");
				setCanvasOpened(true); setMode("canvas"); setModelOpen(false);
				return {};
			}
			if (parsed.kind === "chat") { setMode("chat"); setModelOpen(false); return {}; }
			if (sessionId ? sessionChannel.connection !== "connected" : workspaceChannel.connection !== "connected") throw new Error("接続が完了してから送信してください。");
			if (session?.availability === "missing") throw new Error("保存された会話が見つかりません。新しい会話を開始してください。");
			let result: { disposition?: "queued" | "started"; notice?: string };
			if (parsed.kind === "hyakki") {
				await startSwarm(parsed.objective);
				result = { notice: "スウォームを開始しました。追加指示はこの入力欄から送れます。" };
			} else if (parsed.kind === "goal") {
				const goal = await goalAction(parsed.action);
				result = { notice: goal ? `Goal: ${goal.objective}` : "Goal は設定されていません。" };
			} else {
				const target = await inputSession();
				result = await command<{ runId: string; disposition: "queued" | "started" }>(`/api/sessions/${encodeURIComponent(target)}/prompt`, { text: parsed.text, mode: executionMode });
				setSessionId(target);
			}
			try { localStorage.removeItem(`pi-web-draft:${sessionId ?? `new:${workspaceId}`}`); } catch { /* Storage is optional. */ }
			return result;
		} finally { commandPending.current = false; }
	}
	async function stop(id: string) { try { await command(`/api/sessions/${encodeURIComponent(id)}/abort`, {}); } catch (reason) { setError(errorMessage(reason)); } }
	async function goalAction(action: GoalAction): Promise<Goal | null> {
		const target = action.op === "create" ? await inputSession() : sessionId;
		if (!target) {
			if (action.op === "get") return null;
			throw new Error("会話を選択してください。");
		}
		const result = await command<Goal | null>(`/api/sessions/${encodeURIComponent(target)}/goal`, action);
		if (action.op === "create") setSessionId(target);
		return result;
	}
	async function startSwarm(objective: string): Promise<void> {
		if (!workspaceId) throw new Error("ワークスペースを選択してください。");
		const manager = team?.agents.find((agent) => agent.agentId === workspaceTeam?.rootAgentId);
		if (!manager && modelSetup) {
			if (modelSetup === "authentication") setSettingsOpen(true); else setModelOpen(true);
			throw new Error(modelSetup === "authentication" ? "プロバイダーの認証を設定してください。" : "送信するモデルを選択してください。");
		}
		const result = await command<{ sessionId: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/swarm`, {
			objective,
			...(!manager ? {
				...(sessionId && !session?.parentSessionId ? { sessionId } : {}),
				model: model && { provider: model.provider, id: model.id },
				...(draftThinking ? { thinkingLevel: draftThinking } : {}),
			} : {}),
		});
		draftSession.current = undefined;
		setSessionId(result.sessionId);
		setMode("chat");
		setRightTab("team");
		if (window.innerWidth >= 1100) setRightOpen(true);
	}
	function composeCanvasDesign(path: string): void {
		if (commandPending.current) throw new Error("送信が完了してから設計を入力欄に追加してください。");
		const text = `設計ファイル ${JSON.stringify(path)} を読み、内容に沿って進めてください。`;
		setDraftInsertion({ id: nextClientId(), text: canvasTarget === "swarm" ? `/hyakki ${text}` : text });
		setMode("chat");
	}

	async function mutatePendingInput(inputId: string, action: PendingInputAction): Promise<void> {
		if (!sessionId) throw new Error("会話を選択してください。");
		await command(
			`/api/sessions/${encodeURIComponent(sessionId)}/pending-inputs/${encodeURIComponent(inputId)}`,
			action,
			"PATCH",
		);
	}
	async function messageAgent(agentId: string, message: string): Promise<void> {
		const recipient = team?.agents.find((agent) => agent.agentId === agentId);
		if (!recipient) throw new Error("送信先のエージェントが見つかりません。");
		const root = team?.teams.find((entry) => entry.teamId === recipient.teamId);
		const target = team?.agents.find((agent) => agent.agentId === root?.rootAgentId)?.sessionId;
		if (!target) throw new Error("送信元の会話が見つかりません。");
		await command(`/api/sessions/${encodeURIComponent(target)}/team-message`, { agentId, message });
	}
	async function changeResponsibility(agentId: string, responsibility: string): Promise<void> {
		if (!workspaceId) throw new Error("ワークスペースを選択してください。");
		await command(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`, { responsibility }, "PATCH");
	}
	async function changeModel(selection: { provider: string; id: string }) {
		const updated = sessionId ? await command<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, selection) : undefined;
		setDraftModel(selection);
		draftSession.current = undefined;
		const levels = catalog?.models.find((entry) => entry.provider === selection.provider && entry.id === selection.id)?.thinkingLevels;
		const thinking = updated?.thinkingLevel ?? draftThinking;
		setDraftThinking(thinking && levels?.includes(thinking) ? thinking : undefined);
	}
	async function changeThinking(level: ThinkingLevel) {
		if (sessionId) await command(`/api/sessions/${encodeURIComponent(sessionId)}/thinking`, { level }, "PATCH");
		setDraftThinking(level);
		if (session?.model) setDraftModel(session.model);
		draftSession.current = undefined;
	}
	const modelControl = <div className="model-control">
		<button className="composer-chip model-trigger" type="button" aria-haspopup="dialog" aria-expanded={modelOpen} disabled={!!session?.currentRun} title="モデル・Thinkingを選択" onClick={() => { if (modelClosing) { setModelClosing(false); setModelMenuKey((value) => value + 1); } else setModelOpen((value) => !value); }}>{selectedModel?.name ?? selectedModel?.id ?? "モデルを選択"}<span className="model-trigger-thinking">Thinking: {session?.thinkingLevel ?? draftThinking ?? "自動"}</span><span aria-hidden="true">⌄</span></button>
	</div>;
	const rightMaximum = Math.max(480, viewport.width - (sidebarOpen ? viewport.width <= 1100 ? 230 : 260 : 0) - 320);
	const actualRightWidth = Math.min(rightWidth, rightMaximum);
	return <div className={`app-shell ${sidebarOpen ? "sidebar-open" : "sidebar-closed"} ${rightOpen ? "inspector-open" : ""}`}>
		{workspaces.filter((entry) => entry.workspaceId !== workspaceId).map((entry) => <WorkspaceFeed key={entry.workspaceId} id={entry.workspaceId} onUpdate={updateProjection} onFiles={filesChanged} />)}
		<button ref={sidebarOpener} className="icon-button sidebar-toggle" aria-label={sidebarOpen ? "履歴を閉じる" : "履歴を開く"} aria-controls="conversation-history" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((value) => !value)}><span aria-hidden="true">{sidebarOpen ? "‹" : "☰"}</span></button>
		<button className="navigation-scrim" aria-label="履歴を閉じる" aria-hidden={!sidebarOpen} inert={!sidebarOpen} onClick={() => setSidebarOpen(false)} />
		<aside ref={sidebarRef} id="conversation-history" className="sidebar" aria-label="会話の履歴" aria-hidden={!sidebarOpen} inert={!sidebarOpen}>
			<div className="sidebar-brand"><button className="brand" aria-label="新しい会話" onClick={newConversation}><img className="brand-symbol" src="/icon.svg" alt="" /></button></div>
			<button className="new-conversation" onClick={newConversation}><span aria-hidden="true">＋</span>新しい会話</button>
			<label className="history-search"><span className="sr-only">会話を検索</span><input ref={searchInput} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="会話を検索" /><kbd>⌘ / Ctrl K</kbd></label>
			<div className="history-heading"><span>会話</span><button className="icon-button workspace-add-button" aria-label="ワークスペースを追加" title="フォルダーを選択してワークスペースを追加" disabled={addingWorkspace} onClick={() => { void addWorkspace(); }}>{addingWorkspace ? "…" : "+"}</button></div>
			<nav className="history-navigation" aria-label="ワークスペースと会話">
				{workspaces.filter((entry) => !historyQuery.trim() || entry.path.toLowerCase().includes(historyQuery.toLowerCase()) || history.some((item) => item.workspaceId === entry.workspaceId)).map((entry) => {
					const conversations = history.filter((item) => item.workspaceId === entry.workspaceId);
					const open = !!historyQuery.trim() || (expandedWorkspaces[entry.workspaceId] ?? workspaceId === entry.workspaceId);
					return <details className="workspace-accordion" key={entry.workspaceId} data-workspace-id={entry.workspaceId} data-selected={workspaceId === entry.workspaceId} open={open}>
						<summary title={entry.path} onClick={(event) => {
							event.preventDefault();
							if (!historyQuery.trim()) setExpandedWorkspaces((previous) => ({ ...previous, [entry.workspaceId]: !open }));
						}}><span className="workspace-name">{entry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.path}</span></summary>
						<ul className="session-list">{conversations.map((summary) => {
							const title = (summary.title ?? "新しい会話").replace(/\s+/g, " ").slice(0, 90);
							const status = summary.availability === "missing" ? "missing" : summary.currentRun?.status ?? (summary.latestRun?.status === "failed" || summary.latestRun?.status === "interrupted" ? summary.latestRun.status : "idle");
							return <li key={summary.sessionId}><button className={`session-button ${summary.sessionId === sessionId ? "selected" : ""}`} aria-current={summary.sessionId === sessionId ? "page" : undefined} onClick={() => selectSession(summary.sessionId)} title={title}><span className="session-title">{title}</span>{status !== "idle" && <span className={`status-dot status-${status}`} aria-label={status === "missing" ? "履歴が見つかりません" : RUN_LABELS[status]} title={status === "missing" ? "履歴が見つかりません" : RUN_LABELS[status]} />}</button></li>;
						})}</ul>{conversations.length === 0 && <p className="history-empty">{historyQuery ? "一致する会話がありません" : "会話はありません。"}</p>}
					</details>;
				})}
			</nav>
			<div className="sidebar-bottom"><button onClick={() => setSettingsOpen(true)}>設定</button></div>
		</aside>
		<div className="workspace-surface"><header className="topbar"><div className="topbar-leading"><span className="page-title">{mode === "canvas" ? "設計キャンバス" : selectedAgent && workspaceTeam?.teamId === selectedAgent.teamId ? selectedAgent.parentAgentId ? selectedAgent.name : "マネージャー" : session?.parentSessionId ? "エージェントの会話" : session?.title?.replace(/\s+/g, " ").slice(0, 70) ?? "新しい会話"}</span></div><div className="topbar-actions">{(workspaceTeam || session?.swarm || teamAgents.some((agent) => agent.parentAgentId)) && <button className="team-activity-button" aria-controls="detail-sidebar" aria-expanded={rightOpen && rightTab === "team"} onClick={() => { setRightTab("team"); setRightOpen((open) => rightTab !== "team" || !open); }}><span className={`status-dot ${workingAgents ? "status-running" : "status-idle"}`} aria-hidden="true" />{showingWorkspaceTeam || session?.swarm ? "百鬼夜行" : "チーム"}<span>{workingAgents ? `${workingAgents}人が作業中` : "状況を見る"}</span></button>}<button ref={rightPanelToggle} className="quiet-button" aria-controls="detail-sidebar" aria-expanded={rightOpen} onClick={() => setRightOpen((value) => !value)}>詳細</button></div></header>
			{(error || workspaceChannel.error || sessionChannel.error) && <div className="global-error" role="alert"><span>{error ?? workspaceChannel.error ?? sessionChannel.error}</span><button onClick={() => setError(undefined)}>閉じる</button></div>}
			<div className="main-layout"><main className="chat-column">{sessionId && sessionChannel.connection !== "connected" && <p className="connection-warning">{sessionChannel.connection === "connecting" ? "会話を読み込んでいます…" : "再接続中です。サーバーの実行は継続しています。"}</p>}
				{canvasOpened && <div className="mode-page" hidden={mode !== "canvas"} inert={mode !== "canvas"}>
					{workspaceId && <CanvasPane key={workspaceId} workspaceId={workspaceId} destinationControl={<label className="canvas-destination"><span className="sr-only">入力欄に追加する設計の送信先</span><select aria-label="入力欄に追加する設計の送信先" value={canvasTarget} onChange={(event) => setCanvasTarget(event.target.value === "swarm" ? "swarm" : "chat")}><option value="chat">会話</option><option value="swarm">Hyakki-Yako</option></select></label>} onComposeDesign={composeCanvasDesign} onDirtyChange={setCanvasDirty} />}
				</div>}
				<ChatPane key={sessionId ?? `new:${workspaceId ?? "loading"}`} draftKey={sessionId ?? `new:${workspaceId ?? "loading"}`} workspacePath={workspace?.path} session={session} surface={mode !== "chat"} draftInsertion={draftInsertion} onDraftInserted={clearDraftInsertion} contextWindow={catalog?.models.find((entry) => entry.provider === model?.provider && entry.id === model.id)?.contextWindow} connected={sessionId ? sessionChannel.connection === "connected" : workspaceChannel.connection === "connected"} modelSetup={modelSetup} modelControl={modelControl} goalControl={!session?.parentSessionId && session?.goal && <GoalPanel key={sessionId} goal={session.goal} busy={!!session.currentRun} connected={sessionChannel.connection === "connected"} unavailable={session.availability === "missing"} onAction={async (action) => { await goalAction(action); }} />} onSend={send} onPendingInputAction={mutatePendingInput} onFile={openFile} onStop={() => { if (sessionId) void stop(sessionId); }} onParent={selectSession} onModelSelect={() => setModelOpen(true)} onProviderSettings={() => setSettingsOpen(true)} />
				{modelOpen && <ModelMenu key={modelMenuKey} catalog={catalog} value={model} thinkingLevel={session?.thinkingLevel ?? draftThinking} onChange={changeModel} onThinkingChange={changeThinking} onSettings={() => { setModelOpen(false); setModelClosing(false); setSettingsOpen(true); }} onClosingChange={setModelClosing} onClose={() => { setModelOpen(false); setModelClosing(false); }} disabled={!!session?.currentRun} />}
			</main><div className="detail-resize-slot" aria-hidden={!rightOpen} inert={!rightOpen}><PanelResize value={actualRightWidth} minimum={480} maximum={rightMaximum} label="詳細パネルの幅" onChange={setRightWidth} /></div>
				<aside ref={rightPanelRef} id="detail-sidebar" className="right-panel" aria-hidden={!rightOpen} inert={!rightOpen} style={{ width: viewport.width > 900 ? actualRightWidth : undefined, marginRight: viewport.width > 900 ? rightOpen ? 0 : -actualRightWidth : undefined }}>
					<div className="right-panel-body detail-panel-body">
						{workspaceId && <DetailPane key={workspaceId} workspaceId={workspaceId} target={fileTarget} refreshToken={filesVersion} visible={rightOpen} view={rightTab} onViewChange={setRightTab}
							team={<TeamPane snapshot={team} sessions={summaries} selectedSessionId={sessionId} visible={rightOpen && rightTab === "team"} onSelect={selectSession} onStop={(id) => { void stop(id); }} onMessage={messageAgent} onResponsibility={changeResponsibility} onFile={openFile} />}
							tools={<ToolInspector tools={session?.toolCalls ?? []} onFile={openFile} />} />}
					</div>
				</aside>
			</div>
		</div>{settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={() => { setCatalogVersion((value) => value + 1); }} />}
	</div>;
}
