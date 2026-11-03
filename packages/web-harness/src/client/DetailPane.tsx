import { type ReactNode, useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TerminalSummary } from "../shared/terminal-protocol.ts";
import { api, command, errorMessage } from "./api.ts";
import { BrowserPane } from "./BrowserPane.tsx";
import { type DetailTab, detailTabsReducer, emptyDetailTabs } from "./detail-tabs.ts";
import { restoreDetailTabs, saveDetailTabs } from "./detail-preferences.ts";
import { useSyncExternalStore } from "react";
import { discardDraft, draftKey, draftStatusVersion, isDraftDirty, subscribeDraftStatus } from "./files/file-drafts.ts";
import { FilePane, type FileTarget } from "./files/FilePane.tsx";
import { FilePreview } from "./files/FilePreview.tsx";
import { Icon } from "./Icon.tsx";
import { nextClientId } from "./ids.ts";
import { MotionItems, Presence } from "./Motion.tsx";
import { MotionSwap, useMeasuredSize } from "./MotionSwap.tsx";
import { preferences, usePreferenceString } from "./preferences.ts";
import { type PaneIndex, SplitActions, SplitLayout } from "./SplitLayout.tsx";
import { TerminalView, type TerminalViewState } from "./terminal/TerminalPane.tsx";
import "./DetailPane.css";

export type DetailView = "tabs" | "team" | "tools";


export function DetailPane({ workspaceId, target, browserTarget, refreshToken, visible, view, onViewChange, team, tools }: {
	workspaceId: string;
	target?: FileTarget;
	browserTarget?: { id: string; url: string };
	refreshToken: number;
	visible: boolean;
	view: DetailView;
	onViewChange: (view: DetailView) => void;
	team: ReactNode;
	tools: ReactNode;
}) {
	const [layout, dispatch] = useReducer(detailTabsReducer, { ...emptyDetailTabs, tabs: [{ id: "initial-files", kind: "file", pane: 0 }], selected: ["initial-files", undefined] });
	const [error, setError] = useState<string>();
	const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number }>();
	const [transformRequest, setTransformRequest] = useState<{ id: string; path: string; operation: "translate" | "summarize"; requestId: string }>();
	const [listFailed, setListFailed] = useState(false);
	const [listAttempt, setListAttempt] = useState(0);
	const [restored, setRestored] = useState(false);
	const didRestore = useRef(false);
	const savedLayout = usePreferenceString(`pi-web-tabs:${workspaceId}`);
	const [creating, setCreating] = useState<string[]>([]);
	const [closing, setClosing] = useState<string[]>([]);
	const [viewStates, setViewStates] = useState(() => new Map<string, TerminalViewState>());
	const [focusRequest, setFocusRequest] = useState({ id: "", number: 0 });
	const [dragging, setDragging] = useState<string>();
	const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean }>();
	const [tabGesture, setTabGesture] = useState<"file" | "terminal">();
	const [showTabHints, setShowTabHints] = useState(false);
	const tabPress = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | undefined>(undefined);
	const suppressTabClick = useRef(false);
	const dragged = useRef<string | undefined>(undefined);
	const strip = useRef<HTMLDivElement>(null);
	const tabs = useRef<HTMLDivElement>(null);
	useMeasuredSize(strip, tabs, "width", !dragging);
	const previousMode = useRef(layout.mode);
	const modeChanged = previousMode.current !== layout.mode;
	previousMode.current = layout.mode;
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	const mounted = useRef(false);
	// Drafts live outside React so a tab can show unsaved state while its editor is unmounted.
	useSyncExternalStore(subscribeDraftStatus, draftStatusVersion, draftStatusVersion);
	const dismissed = useRef(new Set<string>());
	const creatingIds = useRef(new Set<string>());
	const closingIds = useRef(new Set<string>());
	const terminalNumber = useRef(0);
	const handledRequest = useRef<string | undefined>(undefined);
	const handledBrowserRequest = useRef<string | undefined>(undefined);
	const id = useId();
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	useEffect(() => {
		if (!contextMenu) return;
		const dismiss = () => setContextMenu(undefined);
		const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); dismiss(); } };
		document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", key, true);
		return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", key, true); };
	}, [contextMenu]);
	useEffect(() => {
		const controller = new AbortController();
		void api<TerminalSummary[]>(`/api/terminals?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }).then((items) => {
			if (controller.signal.aborted) return;
			const available = items.filter((item) => !dismissed.current.has(item.terminalId));
			if (!didRestore.current) {
				const saved = restoreDetailTabs(preferences.getItem(`pi-web-tabs:${workspaceId}`), available);
				terminalNumber.current = Math.max(0, ...saved.tabs.map((tab) => tab.kind === "terminal" ? tab.number : 0));
				dispatch({ type: "restoreLayout", layout: saved });
				setRestored(true);
				didRestore.current = true;
			} else dispatch({ type: "restoreTerminals", tabs: available.map((summary) => ({ id: `terminal-${summary.terminalId}`, pane: 0, kind: "terminal", summary, number: ++terminalNumber.current })) });
			setListFailed(false);
		}).catch((reason: unknown) => { if (!controller.signal.aborted) {
			setError(errorMessage(reason)); setListFailed(true);
			if (!didRestore.current) {
				dispatch({ type: "restoreLayout", layout: restoreDetailTabs(preferences.getItem(`pi-web-tabs:${workspaceId}`), []) });
				didRestore.current = true; setRestored(true);
			}
		} });
		return () => controller.abort();
	}, [workspaceId, listAttempt]);
	useEffect(() => { if (restored && !listFailed) preferences.setItem(`pi-web-tabs:${workspaceId}`, saveDetailTabs(layout)); }, [workspaceId, layout, restored, listFailed]);
	useEffect(() => {
		if (!restored || savedLayout === null || savedLayout === saveDetailTabs(layoutRef.current)) return;
		const controller = new AbortController();
		void api<TerminalSummary[]>(`/api/terminals?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }).then((items) => {
			if (controller.signal.aborted) return;
			const restored = restoreDetailTabs(savedLayout, items);
			terminalNumber.current = Math.max(terminalNumber.current, ...restored.tabs.map((tab) => tab.kind === "terminal" ? tab.number : 0));
			dispatch({ type: "restoreLayout", layout: restored });
		}).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, [workspaceId, savedLayout, restored]);
	useEffect(() => {
		if (!restored || !target || target.requestId === handledRequest.current) return;
		handledRequest.current = target.requestId;
		dispatch({ type: "openFile", ...target, id: nextClientId() });
	}, [target, restored]);
	useEffect(() => {
		if (!restored || !browserTarget || browserTarget.id === handledBrowserRequest.current) return;
		handledBrowserRequest.current = browserTarget.id;
		dispatch({ type: "add", tab: { id: browserTarget.id, pane: layoutRef.current.focused, kind: "browser", url: browserTarget.url } });
	}, [browserTarget, restored]);
	useEffect(() => {
		strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [layout.selected, layout.focused]);
	useEffect(() => {
		if (!dragging) return;
		const cancel = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			dragged.current = undefined; setDragging(undefined); setDropTarget(undefined);
		};
		document.addEventListener("keydown", cancel, true);
		return () => document.removeEventListener("keydown", cancel, true);
	}, [dragging]);
	const updateSummary = useCallback((id: string, status: TerminalSummary["status"], exitCode?: number, signal?: number) => dispatch({ type: "terminalStatus", id, status, exitCode, signal }), []);
	const updateViewState = useCallback((id: string, state: TerminalViewState) => setViewStates((previous) => new Map(previous).set(id, state)), []);

	function select(tab: DetailTab, focus = false) {
		onViewChange("tabs");
		dispatch({ type: "select", id: tab.id });
		if (focus && tab.kind === "terminal") setFocusRequest((previous) => ({ id: tab.id, number: previous.number + 1 }));
	}
	function addTab(pane = layout.focused) {
		onViewChange("tabs");
		dispatch({ type: "add", tab: { id: nextClientId(), pane, kind: "new" } });
	}
	function chooseFile(tab: DetailTab | undefined, pane: PaneIndex) {
		onViewChange("tabs");
		const next: DetailTab = { id: tab?.id ?? nextClientId(), pane, kind: "file" };
		dispatch(tab ? { type: "replace", tab: next } : { type: "add", tab: next });
	}
	function chooseBrowser(tab: DetailTab | undefined, pane: PaneIndex) {
		onViewChange("tabs");
		const next: DetailTab = { id: tab?.id ?? nextClientId(), pane, kind: "browser" };
		dispatch(tab ? { type: "replace", tab: next } : { type: "add", tab: next });
	}
	function openFile(path: string, line?: number) {
		onViewChange("tabs");
		dispatch({ type: "openFile", path, line, requestId: nextClientId(), id: nextClientId() });
	}
	async function createTerminal(tab: DetailTab | undefined, pane: PaneIndex) {
		onViewChange("tabs");
		const tabId = tab?.id ?? nextClientId();
		const requestId = tab?.id ?? `empty-pane-${pane}`;
		if (creatingIds.current.has(requestId)) return;
		creatingIds.current.add(requestId);
		creatingIds.current.add(tabId);
		if (!tab) dispatch({ type: "add", tab: { id: tabId, pane, kind: "new" } });
		setCreating((previous) => [...previous, tabId]);
		setError(undefined);
		try {
			const summary = await command<TerminalSummary>("/api/terminals", { workspaceId, cols: 80, rows: 24 });
			if (!mounted.current) return;
			const current = layoutRef.current.tabs.find((entry) => entry.id === tabId);
			const next: DetailTab = { id: tabId, pane: current?.pane ?? pane, kind: "terminal", summary, number: ++terminalNumber.current };
			dispatch(current ? { type: "replace", tab: next } : { type: "add", tab: next });
			setFocusRequest((previous) => ({ id: tabId, number: previous.number + 1 }));
		} catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
		finally { creatingIds.current.delete(tabId); creatingIds.current.delete(requestId); if (mounted.current) setCreating((previous) => previous.filter((id) => id !== tabId)); }
	}
	async function closeTab(tab: DetailTab) {
		if (closingIds.current.has(tab.id) || creatingIds.current.has(tab.id)) return;
		if (tab.kind === "file" && tab.file && isDraftDirty(draftKey(workspaceId, tab.file.path))) {
			const discard = window.confirm(`${tab.file.path} の未保存の変更を破棄して閉じますか？`);
			if (!discard) return;
			discardDraft(draftKey(workspaceId, tab.file.path));
		}
		if (tab.kind !== "terminal") { dispatch({ type: "remove", id: tab.id }); return; }
		closingIds.current.add(tab.id);
		setClosing((previous) => [...previous, tab.id]);
		setError(undefined);
		try {
			await api(`/api/terminals/${encodeURIComponent(tab.summary.terminalId)}`, { method: "DELETE" });
			dismissed.current.add(tab.summary.terminalId);
			if (mounted.current) {
				dispatch({ type: "remove", id: tab.id });
				setViewStates((previous) => { const next = new Map(previous); next.delete(tab.summary.terminalId); return next; });
			}
		} catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
		finally { closingIds.current.delete(tab.id); if (mounted.current) setClosing((previous) => previous.filter((id) => id !== tab.id)); }
	}
	function endDrag() { dragged.current = undefined; setDragging(undefined); setDropTarget(undefined); }
	function dropOnPane(pane: PaneIndex) {
		if (dragged.current) dispatch({ type: "move", id: dragged.current, pane });
		endDrag();
	}
	function title(tab: DetailTab): string {
		return tab.kind === "terminal" ? `端末 ${tab.number}` : tab.kind === "file" ? tab.file?.path.split(/[\\/]/).at(-1) || "ファイルを選択" : tab.kind === "browser" ? "ブラウザ" : "新しいタブ";
	}
	function choices(tab: DetailTab | undefined, pane: PaneIndex) {
		return <div className="detail-new-tab"><h2>新しいタブ</h2><div className="detail-new-choices"><button type="button" disabled={!!tab && creating.includes(tab.id)} onClick={() => chooseFile(tab, pane)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6l2 3h8v13H4z" /></svg><span>ファイル</span></button><button type="button" disabled={creating.includes(tab?.id ?? "")} onClick={() => { void createTerminal(tab, pane); }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></svg><span>{tab && creating.includes(tab.id) ? "作成中…" : "端末"}</span></button>{document.documentElement.dataset.desktopPlatform && <button type="button" onClick={() => chooseBrowser(tab, pane)}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18M12 3c-5 5-5 13 0 18" /></svg><span>ブラウザ</span></button>}</div></div>;
	}
	const selectedFiles = layout.tabs.filter((tab) => tab.kind === "file" && layout.selected[tab.pane] === tab.id && (tab.pane === 0 || layout.mode !== "single"));
	const activeFile = selectedFiles.find((tab) => tab.pane === layout.focused) ?? selectedFiles[0];
	const bodyIdentity = layout.selected.map((id) => { const tab = layout.tabs.find((entry) => entry.id === id); return `${id}:${tab?.kind}:${tab?.kind === "file" ? tab.file?.path ?? "empty" : ""}`; }).join("|");
	return <div className="detail-workspace">
		<header className="detail-toolbar" inert={!restored}>
			<div className="detail-tab-strip" ref={strip}><div className="detail-tabs" ref={tabs} role="tablist" aria-label="作業タブ">
				<MotionItems items={layout.tabs} itemKey={(tab) => tab.id} enabled={!dragging} resizeWidth>{(tab) => { const index = layout.tabs.indexOf(tab); return <div key={tab.id} className="detail-tab" data-kind={tab.kind} data-active={view === "tabs" && layout.selected[tab.pane] === tab.id} data-focused={layout.focused === tab.pane} data-dragging={dragging === tab.id || undefined} data-drop={dropTarget?.id === tab.id ? dropTarget.after ? "after" : "before" : undefined} draggable={!closing.includes(tab.id) && !creating.includes(tab.id)} onContextMenu={(event) => { if (tab.kind !== "file" || !tab.file) return; event.preventDefault(); setContextMenu({ id: tab.id, x: Math.min(event.clientX, window.innerWidth - 160), y: Math.min(event.clientY, window.innerHeight - 100) }); }} onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); void closeTab(tab); } }} onDragStart={(event) => { dragged.current = tab.id; setDragging(tab.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-hasilan-detail-tab", tab.id); }} onDragEnd={endDrag} onDragOver={(event) => { if (!dragged.current) return; event.preventDefault(); event.stopPropagation(); setDropTarget({ id: tab.id, after: event.clientX >= event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2 }); }} onDrop={(event) => {
					if (!dragged.current) return;
					event.preventDefault(); event.stopPropagation();
					if (dragged.current !== tab.id) dispatch({ type: "move", id: dragged.current, pane: tab.pane, before: tab.id, after: event.clientX >= event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2 });
					endDrag();
				}}>
					<button type="button" role="tab" id={`${id}-tab-${tab.id}`} aria-controls={`${id}-body-${tab.id}`} aria-selected={view === "tabs" && layout.selected[layout.focused] === tab.id} tabIndex={layout.selected[layout.focused] === tab.id ? 0 : -1} title={tab.kind === "file" ? tab.file?.path : tab.kind === "terminal" ? viewStates.get(tab.summary.terminalId)?.title || title(tab) : title(tab)} onClick={() => select(tab, true)} onKeyDown={(event) => {
						let next: number | undefined;
						if (event.key === "ArrowLeft") next = (index - 1 + layout.tabs.length) % layout.tabs.length;
						else if (event.key === "ArrowRight") next = (index + 1) % layout.tabs.length;
						else if (event.key === "Home") next = 0;
						else if (event.key === "End") next = layout.tabs.length - 1;
						else if (event.key === "Delete") { event.preventDefault(); void closeTab(tab); return; }
						if (next === undefined) return;
						event.preventDefault(); select(layout.tabs[next]); document.getElementById(`${id}-tab-${layout.tabs[next].id}`)?.focus();
					}}><span className="detail-tab-kind" aria-hidden="true">{tab.kind === "terminal" ? ">_" : tab.kind === "file" ? "▤" : "+"}</span><span className="detail-tab-title">{title(tab)}</span>{tab.kind === "file" && tab.file?.readOnly && <span className="detail-tab-readonly" title="このファイルは閲覧のみです">閲覧のみ</span>}{tab.kind === "file" && tab.file && isDraftDirty(draftKey(workspaceId, tab.file.path)) && <span className="detail-tab-dirty" aria-label="未保存の変更">●</span>}{tab.kind === "terminal" && tab.summary.status === "exited" && <span className="terminal-tab-exit">終了 {tab.summary.exitCode ?? "?"}</span>}</button>
					<button type="button" className="detail-tab-close" draggable={false} aria-label={`${title(tab)}を閉じる`} disabled={closing.includes(tab.id) || creating.includes(tab.id)} onClick={() => { void closeTab(tab); }}><Icon name="close" size={14} /></button>
				</div>; }}</MotionItems>
			</div></div><div className="detail-tab-add"><button type="button" className="detail-tab-new" aria-label="新しいタブを開く" title="クリックで新しいタブ・下へスライドで端末・右へスライドでファイル" data-gesture={tabGesture} onPointerDown={(event) => {
				if (event.button !== 0) return;
				setShowTabHints(false);
				tabPress.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
				suppressTabClick.current = false;
				event.currentTarget.setPointerCapture(event.pointerId);
			}} onPointerMove={(event) => {
				const press = tabPress.current;
				if (!press || press.pointerId !== event.pointerId) return;
				const x = event.clientX - press.x; const y = event.clientY - press.y;
				if (Math.hypot(x, y) >= 3) setShowTabHints(true);
				press.moved ||= Math.hypot(x, y) >= 18;
				setTabGesture(Math.max(x, y) < 18 ? undefined : x > Math.abs(y) ? "file" : y > Math.abs(x) ? "terminal" : undefined);
			}} onPointerUp={(event) => {
				const press = tabPress.current;
				if (!press || press.pointerId !== event.pointerId) return;
				const x = event.clientX - press.x; const y = event.clientY - press.y;
				suppressTabClick.current = press.moved || Math.hypot(x, y) >= 18;
				tabPress.current = undefined; setTabGesture(undefined); setShowTabHints(false);
				if (x >= 18 && x > Math.abs(y)) chooseFile(undefined, layout.focused);
				else if (y >= 18 && y > Math.abs(x)) void createTerminal(undefined, layout.focused);
			}} onPointerCancel={() => { tabPress.current = undefined; suppressTabClick.current = true; setTabGesture(undefined); setShowTabHints(false); }} onLostPointerCapture={() => { tabPress.current = undefined; setTabGesture(undefined); setShowTabHints(false); }} onClick={(event) => { if (suppressTabClick.current && event.detail !== 0) { suppressTabClick.current = false; return; } addTab(); }}><Icon name="plus" size={15} /></button><Presence show={showTabHints}><div className="detail-gesture-hints" role="status"><span className="detail-gesture-hint is-down" data-active={tabGesture === "terminal"}>↓ 端末</span><span className="detail-gesture-hint is-right" data-active={tabGesture === "file"}>→ ファイル</span></div></Presence></div>
			<SplitActions label="作業タブ" mode={layout.mode} onChange={(mode) => { onViewChange("tabs"); dispatch({ type: "split", mode }); }} />
			<div className="detail-panel-actions" role="group" aria-label="詳細パネル">
				<button type="button" className="detail-panel-icon" aria-label="チーム" title="チーム" aria-pressed={view === "team"} aria-controls={`${id}-team`} onClick={() => onViewChange(view === "team" ? "tabs" : "team")}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 3 4v2" /></svg></button>
				<button type="button" className="detail-panel-icon" aria-label="ツール" title="ツール" aria-pressed={view === "tools"} aria-controls={`${id}-tools`} onClick={() => onViewChange(view === "tools" ? "tabs" : "tools")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 6a5 5 0 0 0-6 6L3 17a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3z" /></svg></button>
			</div>
		</header>
		<Presence show={!!error}><div className="detail-error" role="alert">{error}{listFailed && <button type="button" onClick={() => { setError(undefined); setListAttempt((value) => value + 1); }}>端末一覧を再取得</button>}<button type="button" aria-label="エラーを閉じる" onClick={() => setError(undefined)}><Icon name="close" size={13} /></button></div></Presence>
		<div className="detail-views"><Presence show={view === "tabs"} keepMounted><div className="detail-resource-area">
			<FilePane workspaceId={workspaceId} activePath={activeFile?.kind === "file" ? activeFile.file?.path : undefined} refreshToken={refreshToken} visible={visible && view === "tabs"} treeVisible onOpen={openFile}>
			<MotionSwap identity={bodyIdentity} enabled={!dragging && !modeChanged} className="detail-tab-transition"><SplitLayout preferenceKey={`pi-web-split:${workspaceId}`} mode={layout.mode} label="作業タブ" dragging={!!dragging && layout.tabs.length > 1} onEdgeDrop={(edge) => { if (dragged.current) dispatch({ type: "edge", id: dragged.current, edge }); endDrag(); }}>
				{layout.tabs.map((tab) => {
					const selected = layout.selected[tab.pane] === tab.id && (tab.pane === 0 || layout.mode !== "single");
					const active = visible && view === "tabs" && selected;
					if (tab.kind === "terminal") return <TerminalView key={tab.summary.terminalId} summary={tab.summary} pane={tab.pane} selected={selected} visible={active} id={`${id}-body-${tab.id}`} labelledBy={`${id}-tab-${tab.id}`} focusRequest={focusRequest.id === tab.id ? focusRequest.number : 0} onSummary={updateSummary} onState={updateViewState} onActivate={() => dispatch({ type: "focus", pane: tab.pane })} dragging={!!dragging} onTabDrop={() => dropOnPane(tab.pane)} />;
					return <div key={tab.id} hidden={!selected} className="detail-tab-body split-tab-body" data-pane={tab.pane} data-focused={layout.focused === tab.pane} onPointerDownCapture={() => dispatch({ type: "focus", pane: tab.pane })} onFocusCapture={() => dispatch({ type: "focus", pane: tab.pane })} onDragOver={(event) => { if (dragged.current) event.preventDefault(); }} onDrop={(event) => { if (dragged.current) { event.preventDefault(); dropOnPane(tab.pane); } }}>
						{tab.kind === "file" ? tab.file ? <FilePreview workspaceId={workspaceId} file={tab.file} transformRequest={transformRequest?.id === tab.id ? transformRequest : undefined} onTransformHandled={(requestId) => setTransformRequest((current) => current?.requestId === requestId ? undefined : current)} refreshKey={`${refreshToken}:${tab.requestId ?? ""}`} visible={active} id={`${id}-body-${tab.id}`} labelledBy={`${id}-tab-${tab.id}`} onOpen={openFile} onChange={(_path, patch) => dispatch({ type: "patchFile", id: tab.id, patch })} /> : <div className="detail-file-empty" id={`${id}-body-${tab.id}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab.id}`}>ファイルを選択してください。</div> : tab.kind === "browser" ? <BrowserPane initialUrl={tab.url} /> : <div id={`${id}-body-${tab.id}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab.id}`}>{choices(tab, tab.pane)}</div>}
					</div>;
				})}
				{([0, 1] as const).map((pane) => !layout.tabs.some((tab) => tab.pane === pane) && <div key={`empty-${pane}`} className="detail-tab-body split-tab-body" data-pane={pane} hidden={pane === 1 && layout.mode === "single"} onPointerDownCapture={() => dispatch({ type: "focus", pane })} onDragOver={(event) => { if (dragged.current) event.preventDefault(); }} onDrop={(event) => { if (dragged.current) { event.preventDefault(); dropOnPane(pane); } }}>{choices(undefined, pane)}</div>)}
			</SplitLayout></MotionSwap>
			</FilePane>
		</div></Presence>
		<Presence show={view === "team"} keepMounted><div id={`${id}-team`} className="detail-auxiliary">{team}</div></Presence>
		<Presence show={view === "tools"} keepMounted><div id={`${id}-tools`} className="detail-auxiliary detail-tools">{tools}</div></Presence></div>
		{contextMenu && createPortal(<div className="detail-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>{(["translate", "summarize"] as const).map((operation) => <button key={operation} type="button" role="menuitem" onClick={() => { const tab = layout.tabs.find((entry) => entry.id === contextMenu.id); if (tab?.kind === "file" && tab.file) { select(tab); setTransformRequest({ id: tab.id, path: tab.file.path, operation, requestId: nextClientId() }); } setContextMenu(undefined); }}>{operation === "translate" ? "翻訳" : "要約"}</button>)}</div>, document.body)}
	</div>;
}
