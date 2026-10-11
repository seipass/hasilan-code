import { useCallback, useEffect, useRef, useState } from "react";
import { api, command, errorMessage } from "./api.ts";
import { ChatPane } from "./ChatPane.tsx";
import { FilePane, type FileTarget } from "./files/FilePane.tsx";
import { ModelMenu } from "./ModelMenu.tsx";
import { PanelResize } from "./PanelResize.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { useChannel } from "./subscriptions.ts";
import { RUN_LABELS, TeamPane } from "./TeamPane.tsx";
import { TerminalPane } from "./terminal/TerminalPane.tsx";
import { ToolInspector } from "./ToolInspector.tsx";
import type { Model, ModelCatalog, SessionDetail, SessionSummary, Settings, Workspace, WorkspaceProjection } from "./types.ts";

function WorkspaceFeed({ id, onUpdate, onFiles }: { id: string; onUpdate: (id: string, data: WorkspaceProjection) => void; onFiles: () => void }) {
	const channel = useChannel<WorkspaceProjection>("workspace", id, onFiles);
	useEffect(() => { if (channel.data) onUpdate(id, channel.data); }, [id, channel.data, onUpdate]);
	return null;
}

export function App() {
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [workspaceId, setWorkspaceId] = useState<string>();
	const [sessionId, setSessionId] = useState<string | undefined>(() => { try { return localStorage.getItem("pi-web-selected-session") || undefined; } catch { return undefined; } });
	const [projections, setProjections] = useState<Record<string, WorkspaceProjection>>({});
	const [initialSessions, setInitialSessions] = useState<SessionSummary[]>([]);
	const [error, setError] = useState<string>();
	const [catalog, setCatalog] = useState<ModelCatalog>();
	const [catalogVersion, setCatalogVersion] = useState(0);
	const [defaultModel, setDefaultModel] = useState<Model>();
	const [draftModel, setDraftModel] = useState<Model>();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [modelClosing, setModelClosing] = useState(false);
	const [modelMenuKey, setModelMenuKey] = useState(0);
	const [addingWorkspace, setAddingWorkspace] = useState(false);
	const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
	const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 900);
	const [historyQuery, setHistoryQuery] = useState("");
	const [rightTab, setRightTab] = useState<"files" | "team" | "tools" | "terminal">("team");
	const [rightOpen, setRightOpen] = useState(false);
	const [rightWidth, setRightWidth] = useState(660);
	const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
	const [fileTarget, setFileTarget] = useState<FileTarget>();
	const [filesVersion, setFilesVersion] = useState(0);
	const draftSession = useRef<string | undefined>(undefined);
	const searchInput = useRef<HTMLInputElement>(null);
	const workspaceChannel = useChannel<WorkspaceProjection>("workspace", workspaceId, () => setFilesVersion((value) => value + 1));
	const sessionChannel = useChannel<SessionDetail>("session", sessionId);
	const session = sessionChannel.data;
	const model = session?.model ?? draftModel ?? defaultModel;
	const selectedModel = catalog?.models.find((entry) => entry.provider === model?.provider && entry.id === model.id) ?? model;
	const workspace = workspaces.find((entry) => entry.workspaceId === workspaceId);
	const summaries = [...initialSessions.filter((entry) => !projections[entry.workspaceId]), ...Object.values(projections).flatMap((projection) => projection.sessions)];
	const team = workspaceChannel.data?.teams;
	const roots = summaries.filter((entry) => !entry.parentSessionId);
	const history = roots.filter((entry) => `${entry.latestRun?.task ?? ""} ${workspaces.find((item) => item.workspaceId === entry.workspaceId)?.path ?? ""}`.toLowerCase().includes(historyQuery.toLowerCase())).sort((a, b) => Number(!!b.currentRun) - Number(!!a.currentRun) || String(b.latestRun?.startedAt ?? "").localeCompare(String(a.latestRun?.startedAt ?? "")));
	const updateProjection = useCallback((id: string, data: WorkspaceProjection) => setProjections((previous) => ({ ...previous, [id]: data })), []);
	const filesChanged = useCallback(() => setFilesVersion((value) => value + 1), []);
	useEffect(() => {
		const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	useEffect(() => { if (workspaceId && workspaceChannel.data) updateProjection(workspaceId, workspaceChannel.data); }, [workspaceId, workspaceChannel.data, updateProjection]);
	useEffect(() => {
		const controller = new AbortController();
		Promise.all([api<Workspace[]>("/api/workspaces", { signal: controller.signal }), api<SessionSummary[]>("/api/sessions", { signal: controller.signal })]).then(([folders, sessions]) => {
			setWorkspaces(folders); setInitialSessions(sessions);
			let previousSession: string | null = null; let previousWorkspace: string | null = null;
			try { previousSession = localStorage.getItem("pi-web-selected-session"); previousWorkspace = localStorage.getItem("pi-web-workspace"); } catch { /* Browser storage is optional. */ }
			const restored = sessions.find((entry) => entry.sessionId === previousSession);
			setSessionId(restored?.sessionId);
			setWorkspaceId(restored?.workspaceId ?? folders.find((entry) => entry.workspaceId === previousWorkspace)?.workspaceId ?? folders[0]?.workspaceId);
		}).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, []);
	useEffect(() => {
		if (!workspaceId) return;
		const controller = new AbortController();
		Promise.all([api<ModelCatalog>("/api/models", { signal: controller.signal }), api<Settings>(`/api/settings${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`, { signal: controller.signal })]).then(([models, settings]) => { setCatalog(models); setDefaultModel(settings.llm.defaultModel); }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, [catalogVersion, workspaceId]);
	useEffect(() => {
		try { if (sessionId) localStorage.setItem("pi-web-selected-session", sessionId); else localStorage.removeItem("pi-web-selected-session"); if (workspaceId) localStorage.setItem("pi-web-workspace", workspaceId); } catch { /* Selection remains functional without storage. */ }
	}, [sessionId, workspaceId]);
	useEffect(() => {
		const keydown = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); } if (event.key === "Escape") { setModelOpen(false); setRightOpen(false); } };
		window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
	}, []);
	function selectSession(id: string) {
		const summary = summaries.find((entry) => entry.sessionId === id); if (summary) setWorkspaceId(summary.workspaceId);
		if (summary) setExpandedWorkspaces((previous) => ({ ...previous, [summary.workspaceId]: true }));
		setSessionId(id); setError(undefined); setFileTarget(undefined); setModelOpen(false);
		if (window.innerWidth < 900) setSidebarOpen(false);
	}
	function selectWorkspace(id: string) {
		setExpandedWorkspaces((previous) => ({ ...previous, [id]: true }));
		if (id === workspaceId) return;
		setWorkspaceId(id); setSessionId(undefined); draftSession.current = undefined; setDraftModel(undefined); setFileTarget(undefined); setModelOpen(false); setError(undefined);
	}
	function newConversation() { setSessionId(undefined); draftSession.current = undefined; setDraftModel(session?.model ?? defaultModel); setRightOpen(false); setFileTarget(undefined); setError(undefined); if (window.innerWidth < 900) setSidebarOpen(false); }
	function openFile(path: string, line?: number) { setFileTarget({ path, line, requestId: crypto.randomUUID() }); setRightTab("files"); setRightOpen(true); }
	async function addWorkspace() {
		if (addingWorkspace) return;
		setAddingWorkspace(true); setError(undefined);
		try {
			const { workspace: added } = await command<{ workspace: Workspace | null }>("/api/workspaces/pick", {});
			if (!added) return;
			setWorkspaces((previous) => previous.some((entry) => entry.workspaceId === added.workspaceId) ? previous : [...previous, added]);
			selectWorkspace(added.workspaceId);
			setHistoryQuery("");
		} catch (reason) { setError(errorMessage(reason)); } finally { setAddingWorkspace(false); }
	}
	async function send(text: string, mode: "prompt" | "steer" | "followUp") {
		if (!workspaceId) throw new Error("作業フォルダーを準備できません。フォルダーを選択してください。");
		if (!model || catalog?.providers.find((entry) => entry.id === model.provider)?.configured === false) { setModelOpen(true); throw new Error("モデルを接続すると送信できます。"); }
		let target = sessionId ?? draftSession.current;
		if (!target) { const created = await command<SessionSummary>("/api/sessions", { workspaceId, model: { provider: model.provider, id: model.id } }); target = created.sessionId; draftSession.current = target; }
		const result = await command<{ runId: string; disposition: "queued" | "started" }>(`/api/sessions/${encodeURIComponent(target)}/prompt`, { text, mode });
		try { localStorage.removeItem(`pi-web-draft:new:${workspaceId}`); } catch { /* Storage is optional. */ }
		setSessionId(target); return result;
	}
	async function stop(id: string) { try { await command(`/api/sessions/${encodeURIComponent(id)}/abort`, {}); } catch (reason) { setError(errorMessage(reason)); } }
	async function changeModel(selection: { provider: string; id: string }) {
		if (!sessionId) { setDraftModel(selection); draftSession.current = undefined; }
		else await command(`/api/sessions/${encodeURIComponent(sessionId)}/model`, selection);
		setModelOpen(false);
		requestAnimationFrame(() => document.getElementById("message")?.focus());
	}
	const modelControl = <button className="composer-chip model-trigger" type="button" aria-haspopup="dialog" aria-expanded={modelOpen} disabled={!!session?.currentRun} onClick={() => { if (modelClosing) { setModelClosing(false); setModelMenuKey((value) => value + 1); } else setModelOpen((value) => !value); }}>{selectedModel?.name ?? selectedModel?.id ?? "モデルを選択"}<span aria-hidden="true">⌄</span></button>;
	const rightMaximum = Math.max(480, viewport.width - (sidebarOpen ? viewport.width <= 1100 ? 230 : 260 : 0) - 320);
	const actualRightWidth = Math.min(rightWidth, rightMaximum);
	return <div className={`app-shell ${sidebarOpen ? "sidebar-open" : "sidebar-closed"} ${rightOpen ? "inspector-open" : ""}`}>
		{workspaces.filter((entry) => entry.workspaceId !== workspaceId).map((entry) => <WorkspaceFeed key={entry.workspaceId} id={entry.workspaceId} onUpdate={updateProjection} onFiles={filesChanged} />)}
		{sidebarOpen && <button className="navigation-scrim" aria-label="履歴を閉じる" onClick={() => setSidebarOpen(false)} />}
		<aside className="sidebar" aria-label="会話の履歴">
			<div className="sidebar-brand"><button className="brand" aria-label="新しい会話" onClick={newConversation}><img className="brand-symbol" src="/icon.svg" alt="" /></button><button className="icon-button" aria-label="履歴を閉じる" onClick={() => setSidebarOpen(false)}>‹</button></div>
			<button className="new-conversation" onClick={newConversation}><span aria-hidden="true">＋</span>新しい会話</button>
			<label className="history-search"><span className="sr-only">会話を検索</span><input ref={searchInput} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="会話を検索" /><kbd>⌘ / Ctrl K</kbd></label>
			<div className="history-heading"><span>会話</span><button className="icon-button workspace-add-button" aria-label="ワークスペースを追加" title="フォルダーを選択してワークスペースを追加" disabled={addingWorkspace} onClick={() => { void addWorkspace(); }}>{addingWorkspace ? "…" : "+"}</button></div>
			<nav className="history-navigation" aria-label="ワークスペースと会話">
				{workspaces.filter((entry) => !historyQuery.trim() || entry.path.toLowerCase().includes(historyQuery.toLowerCase()) || history.some((item) => item.workspaceId === entry.workspaceId)).map((entry) => {
					const conversations = history.filter((item) => item.workspaceId === entry.workspaceId);
					return <details className="workspace-accordion" key={entry.workspaceId} data-workspace-id={entry.workspaceId} data-selected={workspaceId === entry.workspaceId} open={!!historyQuery.trim() || (expandedWorkspaces[entry.workspaceId] ?? workspaceId === entry.workspaceId)} onToggle={(event) => {
						if (historyQuery.trim()) return;
						const open = event.currentTarget.open;
						setExpandedWorkspaces((previous) => previous[entry.workspaceId] === open ? previous : { ...previous, [entry.workspaceId]: open });
					}}>
						<summary title={entry.path} onClick={() => { if (entry.workspaceId !== workspaceId) selectWorkspace(entry.workspaceId); }}><span className="workspace-name">{entry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.path}</span></summary>
						<ul className="session-list">{conversations.map((summary) => {
							const title = (summary.latestRun?.task ?? "新しい会話").replace(/\s+/g, " ").slice(0, 90);
							const status = summary.availability === "missing" ? "missing" : summary.currentRun?.status ?? (summary.latestRun?.status === "failed" || summary.latestRun?.status === "interrupted" ? summary.latestRun.status : "idle");
							return <li key={summary.sessionId}><button className={`session-button ${summary.sessionId === sessionId ? "selected" : ""}`} aria-current={summary.sessionId === sessionId ? "page" : undefined} onClick={() => selectSession(summary.sessionId)} title={title}><span className="session-title">{title}</span>{status !== "idle" && <span className={`status-dot status-${status}`} aria-label={status === "missing" ? "履歴が見つかりません" : RUN_LABELS[status]} title={status === "missing" ? "履歴が見つかりません" : RUN_LABELS[status]} />}</button></li>;
						})}</ul>{conversations.length === 0 && <p className="history-empty">{historyQuery ? "一致する会話がありません" : "会話はありません。"}</p>}
					</details>;
				})}
			</nav>
			<div className="sidebar-bottom"><button onClick={() => setSettingsOpen(true)}>設定</button></div>
		</aside>
		<div className="workspace-surface"><header className="topbar"><div className="topbar-leading">{!sidebarOpen && <button className="icon-button" aria-label="履歴を開く" onClick={() => setSidebarOpen(true)}>☰</button>}<span className="page-title">{session?.parentSessionId ? "エージェントの会話" : session?.latestRun?.task.replace(/\s+/g, " ").slice(0, 70) ?? "新しい会話"}</span></div><div className="topbar-actions"><button className="quiet-button" aria-expanded={rightOpen} onClick={() => setRightOpen((value) => !value)}>詳細</button></div></header>
			{(error || workspaceChannel.error || sessionChannel.error) && <div className="global-error" role="alert"><span>{error ?? workspaceChannel.error ?? sessionChannel.error}</span><button onClick={() => setError(undefined)}>閉じる</button></div>}
			<div className="main-layout"><main className="chat-column">{sessionId && sessionChannel.connection !== "connected" && <p className="connection-warning">{sessionChannel.connection === "connecting" ? "会話を読み込んでいます…" : "再接続中です。サーバーの実行は継続しています。"}</p>}
				<ChatPane key={sessionId ?? `new:${workspaceId ?? "loading"}`} draftKey={sessionId ?? `new:${workspaceId ?? "loading"}`} workspacePath={workspace?.path} session={session} contextWindow={catalog?.models.find((entry) => entry.provider === model?.provider && entry.id === model.id)?.contextWindow} connected={sessionId ? sessionChannel.connection === "connected" : workspaceChannel.connection === "connected"} modelReady={!!model && catalog?.providers.find((entry) => entry.id === model.provider)?.configured !== false} modelControl={modelControl} onSend={send} onFile={openFile} onStop={() => { if (sessionId) void stop(sessionId); }} onParent={selectSession} onSettings={() => setModelOpen(true)} />
				{modelOpen && <ModelMenu key={modelMenuKey} catalog={catalog} value={model} onChange={changeModel} onConnected={setCatalog} onClosingChange={setModelClosing} onClose={() => { setModelOpen(false); setModelClosing(false); }} disabled={!!session?.currentRun} />}
			</main>{rightOpen && <PanelResize value={actualRightWidth} minimum={480} maximum={rightMaximum} label="詳細パネルの幅" onChange={setRightWidth} />}
				<aside className="right-panel" hidden={!rightOpen} style={{ width: viewport.width > 900 ? actualRightWidth : undefined }}>
					<div className="panel-tabs" role="tablist" aria-label="詳細パネル">{(["files", "team", "tools", "terminal"] as const).map((tab) => <button key={tab} id={`detail-tab-${tab}`} role="tab" aria-controls="detail-panel" aria-selected={rightTab === tab} onClick={() => setRightTab(tab)}>{tab === "files" ? "ファイル" : tab === "team" ? "チーム" : tab === "tools" ? "ツール" : "端末"}</button>)}</div>
					<div id="detail-panel" className={`right-panel-body ${rightTab === "files" ? "file-panel-body" : rightTab === "terminal" ? "terminal-panel-body" : ""}`} role="tabpanel" aria-labelledby={`detail-tab-${rightTab}`}>
						{workspaceId && <FilePane key={workspaceId} workspaceId={workspaceId} target={fileTarget} refreshToken={filesVersion} onOpen={openFile} onClear={() => setFileTarget(undefined)} visible={rightOpen && rightTab === "files"} />}
						{rightTab === "team" && <TeamPane snapshot={team} selectedSessionId={sessionId} onSelect={selectSession} onStop={(id) => { void stop(id); }} onFile={openFile} />}
						{rightTab === "tools" && <ToolInspector tools={session?.toolCalls ?? []} onFile={openFile} />}
						<TerminalPane workspaceId={workspaceId} visible={rightOpen && rightTab === "terminal"} />
					</div>
				</aside>
			</div>
		</div>{settingsOpen && <SettingsDialog workspaceId={workspaceId} onClose={() => setSettingsOpen(false)} onSaved={() => { setCatalogVersion((value) => value + 1); setDraftModel(undefined); }} />}
	</div>;
}
