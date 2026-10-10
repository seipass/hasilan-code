import { useCallback, useEffect, useRef, useState } from "react";
import { api, command, errorMessage } from "./api.ts";
import { ChatPane } from "./ChatPane.tsx";
import { FilePane, type FileTarget } from "./files/FilePane.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
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
	const [folderOpen, setFolderOpen] = useState(false);
	const [newPath, setNewPath] = useState("");
	const [addingWorkspace, setAddingWorkspace] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 900);
	const [historyQuery, setHistoryQuery] = useState("");
	const [rightTab, setRightTab] = useState<"files" | "team" | "tools">("team");
	const [rightOpen, setRightOpen] = useState(false);
	const [terminalVisible, setTerminalVisible] = useState(false);
	const [rightWidth, setRightWidth] = useState(660);
	const [terminalHeight, setTerminalHeight] = useState(320);
	const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
	const [fileTarget, setFileTarget] = useState<FileTarget>();
	const [filesVersion, setFilesVersion] = useState(0);
	const draftSession = useRef<string | undefined>(undefined);
	const searchInput = useRef<HTMLInputElement>(null);
	const workspaceChannel = useChannel<WorkspaceProjection>("workspace", workspaceId, () => setFilesVersion((value) => value + 1));
	const sessionChannel = useChannel<SessionDetail>("session", sessionId);
	const session = sessionChannel.data;
	const workspace = workspaces.find((entry) => entry.workspaceId === workspaceId);
	const model = session?.model ?? draftModel ?? defaultModel;
	const selectedModel = catalog?.models.find((entry) => entry.provider === model?.provider && entry.id === model.id) ?? model;
	const summaries = [...initialSessions.filter((entry) => !projections[entry.workspaceId]), ...Object.values(projections).flatMap((projection) => projection.sessions)];
	const team = workspaceChannel.data?.teams;
	const roots = summaries.filter((entry) => !entry.parentSessionId && (entry.materialized || entry.latestRun || entry.sessionId === sessionId));
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
		const keydown = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); } if (event.key === "Escape") { setModelOpen(false); setFolderOpen(false); setRightOpen(false); } };
		window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
	}, []);
	function selectSession(id: string) {
		const summary = summaries.find((entry) => entry.sessionId === id); if (summary) setWorkspaceId(summary.workspaceId);
		setSessionId(id); setError(undefined); setFileTarget(undefined); setModelOpen(false); setFolderOpen(false);
		if (window.innerWidth < 900) setSidebarOpen(false);
	}
	function newConversation() { setSessionId(undefined); draftSession.current = undefined; setDraftModel(session?.model ?? defaultModel); setRightOpen(false); setFileTarget(undefined); setError(undefined); if (window.innerWidth < 900) setSidebarOpen(false); }
	function openFile(path: string, line?: number) { setFileTarget({ path, line, requestId: crypto.randomUUID() }); setRightTab("files"); setRightOpen(true); }
	async function addWorkspace() {
		setAddingWorkspace(true); setError(undefined);
		try { const added = await command<Workspace>("/api/workspaces", { path: newPath }); setWorkspaces((previous) => previous.some((entry) => entry.workspaceId === added.workspaceId) ? previous : [...previous, added]); setWorkspaceId(added.workspaceId); setSessionId(undefined); draftSession.current = undefined; setFileTarget(undefined); setFolderOpen(false); setNewPath(""); }
		catch (reason) { setError(errorMessage(reason)); } finally { setAddingWorkspace(false); }
	}
	async function send(text: string, mode: "prompt" | "steer" | "followUp") {
		if (!workspaceId) throw new Error("作業フォルダーを準備できません。フォルダーを選択してください。");
		if (!model) { setSettingsOpen(true); throw new Error("モデルを接続すると送信できます。下書きはそのまま保持しています。"); }
		let target = sessionId ?? draftSession.current;
		if (!target) { const created = await command<SessionSummary>("/api/sessions", { workspaceId, model: { provider: model.provider, id: model.id } }); target = created.sessionId; draftSession.current = target; }
		const result = await command<{ runId: string; disposition: "queued" | "started" }>(`/api/sessions/${encodeURIComponent(target)}/prompt`, { text, mode });
		try { localStorage.removeItem(`pi-web-draft:new:${workspaceId}`); } catch { /* Storage is optional. */ }
		setSessionId(target); return result;
	}
	async function stop(id: string) { try { await command(`/api/sessions/${encodeURIComponent(id)}/abort`, {}); } catch (reason) { setError(errorMessage(reason)); } }
	async function changeModel(selection: { provider: string; id: string }) {
		if (!sessionId) { setDraftModel(selection); draftSession.current = undefined; setModelOpen(false); return; }
		try { await command(`/api/sessions/${encodeURIComponent(sessionId)}/model`, selection); setModelOpen(false); } catch (reason) { setError(errorMessage(reason)); }
	}
	const folderName = workspace?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "作業フォルダー";
	const modelControl = <button className="composer-chip model-trigger" type="button" aria-expanded={modelOpen} onClick={() => { setModelOpen((value) => !value); setFolderOpen(false); }}>{selectedModel?.name ?? selectedModel?.id ?? "モデルを接続"}<span aria-hidden="true">⌄</span></button>;
	const folderControl = <button className="composer-chip folder-trigger" type="button" title={workspace?.path} aria-expanded={folderOpen} onClick={() => { setFolderOpen((value) => !value); setModelOpen(false); }}><span aria-hidden="true">▱</span>{folderName}<span aria-hidden="true">⌄</span></button>;
	const rightMaximum = Math.max(480, viewport.width - (sidebarOpen ? viewport.width <= 1100 ? 230 : 260 : 0) - 320);
	const actualRightWidth = Math.min(rightWidth, rightMaximum);
	const terminalMaximum = Math.max(160, viewport.height - 300);
	const actualTerminalHeight = Math.min(terminalHeight, terminalMaximum);
	return <div className={`app-shell ${sidebarOpen ? "sidebar-open" : "sidebar-closed"} ${rightOpen ? "inspector-open" : ""} ${terminalVisible ? "terminal-open" : ""}`}>
		{workspaces.filter((entry) => entry.workspaceId !== workspaceId).map((entry) => <WorkspaceFeed key={entry.workspaceId} id={entry.workspaceId} onUpdate={updateProjection} onFiles={filesChanged} />)}
		{sidebarOpen && <button className="navigation-scrim" aria-label="履歴を閉じる" onClick={() => setSidebarOpen(false)} />}
		<aside className="sidebar" aria-label="会話の履歴">
			<div className="sidebar-brand"><button className="brand" onClick={newConversation}><img className="brand-symbol" src="/icon.svg" alt="" /><span>Hasilan Code</span></button><button className="icon-button" aria-label="履歴を閉じる" onClick={() => setSidebarOpen(false)}>‹</button></div>
			<button className="new-conversation" onClick={newConversation}><span aria-hidden="true">＋</span>新しい会話</button>
			<label className="history-search"><span className="sr-only">会話を検索</span><input ref={searchInput} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="会話を検索" /><kbd>⌘ / Ctrl K</kbd></label>
			<div className="history-heading">最近の会話{roots.some((entry) => entry.currentRun) && <span>{roots.filter((entry) => entry.currentRun).length} 件実行中</span>}</div>
			<nav className="history-navigation"><ul className="session-list">{history.map((summary) => {
				const title = (summary.latestRun?.task ?? "新しい会話").replace(/\s+/g, " ").slice(0, 90);
				const status = summary.availability === "missing" ? "missing" : summary.currentRun?.status ?? (summary.latestRun?.status === "failed" || summary.latestRun?.status === "interrupted" ? summary.latestRun.status : "idle");
				return <li key={summary.sessionId}><button className={`session-button ${summary.sessionId === sessionId ? "selected" : ""}`} aria-current={summary.sessionId === sessionId ? "page" : undefined} onClick={() => selectSession(summary.sessionId)} title={title}><span className="session-title">{title}</span>{status !== "idle" && <span className={`status-dot status-${status}`} aria-label={status === "missing" ? "履歴が見つかりません" : RUN_LABELS[status]} title={status === "missing" ? "履歴が見つかりません" : RUN_LABELS[status]} />}</button></li>;
			})}</ul>{history.length === 0 && <p className="history-empty">{historyQuery ? "一致する会話がありません" : "会話を始めると、ここに履歴が残ります。"}</p>}</nav>
			<div className="sidebar-bottom"><button onClick={() => setSettingsOpen(true)}>設定</button></div>
		</aside>
		<div className="workspace-surface"><header className="topbar"><div className="topbar-leading">{!sidebarOpen && <button className="icon-button" aria-label="履歴を開く" onClick={() => setSidebarOpen(true)}>☰</button>}<span className="page-title">{session?.parentSessionId ? "エージェントの会話" : session?.latestRun?.task.replace(/\s+/g, " ").slice(0, 70) ?? "新しい会話"}</span></div><div className="topbar-actions"><button className={`quiet-button ${terminalVisible ? "active" : ""}`} aria-expanded={terminalVisible} onClick={() => setTerminalVisible((value) => !value)}>端末</button><button className={`quiet-button ${rightOpen ? "active" : ""}`} aria-expanded={rightOpen} onClick={() => setRightOpen((value) => !value)}>詳細</button></div></header>
			{(error || workspaceChannel.error || sessionChannel.error) && <div className="global-error" role="alert"><span>{error ?? workspaceChannel.error ?? sessionChannel.error}</span><button onClick={() => setError(undefined)}>閉じる</button></div>}
			<div className="main-layout"><main className="chat-column">{sessionId && sessionChannel.connection !== "connected" && <p className="connection-warning">{sessionChannel.connection === "connecting" ? "会話を読み込んでいます…" : "再接続中です。サーバーの実行は継続しています。"}</p>}
				<ChatPane key={sessionId ?? `new:${workspaceId ?? "loading"}`} draftKey={sessionId ?? `new:${workspaceId ?? "loading"}`} session={session} connected={sessionId ? sessionChannel.connection === "connected" : workspaceChannel.connection === "connected"} modelReady={!!model} modelControl={modelControl} folderControl={folderControl} onSend={send} onFile={openFile} onStop={() => { if (sessionId) void stop(sessionId); }} onParent={selectSession} onSettings={() => setSettingsOpen(true)} />
				{modelOpen && <div className="composer-popover model-popover"><header><strong>モデルを選択</strong><button className="icon-button" aria-label="モデル選択を閉じる" onClick={() => setModelOpen(false)}>×</button></header><ModelPicker catalog={catalog} value={model} onChange={(selection) => { void changeModel(selection); }} disabled={!!session?.currentRun} /><button className="text-link" onClick={() => { setModelOpen(false); setSettingsOpen(true); }}>接続先・API キーを設定</button></div>}
				{folderOpen && <div className="composer-popover folder-popover"><header><strong>作業フォルダー</strong><button className="icon-button" aria-label="フォルダー選択を閉じる" onClick={() => setFolderOpen(false)}>×</button></header><p className="muted">ファイル操作と端末は、このフォルダーで実行します。</p><div className="folder-options">{workspaces.map((entry) => <button key={entry.workspaceId} aria-pressed={entry.workspaceId === workspaceId} onClick={() => { if (entry.workspaceId !== workspaceId) { setSessionId(undefined); setWorkspaceId(entry.workspaceId); draftSession.current = undefined; setFileTarget(undefined); } setFolderOpen(false); }}><strong>{entry.path.split(/[\\/]/).filter(Boolean).at(-1)}</strong><small>{entry.path}</small></button>)}</div><form className="workspace-add" onSubmit={(event) => { event.preventDefault(); void addWorkspace(); }}><label>別のフォルダーを追加<input value={newPath} required onChange={(event) => setNewPath(event.target.value)} placeholder="フォルダーの絶対パス" /></label><button disabled={addingWorkspace || !newPath.trim()}>{addingWorkspace ? "追加中…" : "追加して使う"}</button></form></div>}
			</main>{rightOpen && <PanelResize axis="x" value={actualRightWidth} minimum={480} maximum={rightMaximum} label="詳細パネルの幅" onChange={setRightWidth} />}
				<aside className="right-panel" hidden={!rightOpen} style={{ width: viewport.width > 900 ? actualRightWidth : undefined }}>
					<div className="panel-tabs" role="tablist" aria-label="詳細パネル">{(["files", "team", "tools"] as const).map((tab) => <button key={tab} role="tab" aria-selected={rightTab === tab} onClick={() => setRightTab(tab)}>{tab === "files" ? "ファイル" : tab === "team" ? "チーム" : "ツール"}</button>)}</div>
					<div className={`right-panel-body ${rightTab === "files" ? "file-panel-body" : ""}`} role="tabpanel">
						{workspaceId && <FilePane key={workspaceId} workspaceId={workspaceId} target={fileTarget} refreshToken={filesVersion} onOpen={openFile} onClear={() => setFileTarget(undefined)} visible={rightOpen && rightTab === "files"} />}
						{rightTab === "team" && <TeamPane snapshot={team} selectedSessionId={sessionId} onSelect={selectSession} onStop={(id) => { void stop(id); }} onFile={openFile} />}
						{rightTab === "tools" && <ToolInspector tools={session?.toolCalls ?? []} onFile={openFile} />}
					</div>
				</aside>
			</div>
			<div className="terminal-panel" style={{ display: terminalVisible ? "flex" : "none", height: actualTerminalHeight }}>
				<PanelResize axis="y" value={actualTerminalHeight} minimum={160} maximum={terminalMaximum} label="端末パネルの高さ" onChange={setTerminalHeight} />
				<TerminalPane workspaceId={workspaceId} visible={terminalVisible} />
			</div>
		</div>{settingsOpen && <SettingsDialog workspaceId={workspaceId} onClose={() => setSettingsOpen(false)} onSaved={() => { setCatalogVersion((value) => value + 1); setDraftModel(undefined); }} />}
	</div>;
}
