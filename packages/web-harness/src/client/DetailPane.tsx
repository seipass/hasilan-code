import { type ReactNode, useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import type { TerminalSummary } from "../shared/terminal-protocol.ts";
import { api, command, errorMessage } from "./api.ts";
import { type DetailTab, detailTabsReducer, emptyDetailTabs } from "./detail-tabs.ts";
import { FilePane, type FileTarget } from "./files/FilePane.tsx";
import { FilePreview } from "./files/FilePreview.tsx";
import { nextClientId } from "./ids.ts";
import { transitionItems } from "./item-transition.ts";
import { type PaneIndex, SplitActions, SplitLayout } from "./SplitLayout.tsx";
import { TerminalView, type TerminalViewState } from "./terminal/TerminalPane.tsx";
import "./DetailPane.css";

export type DetailView = "tabs" | "team" | "tools";

export function DetailPane({ workspaceId, target, refreshToken, visible, view, onViewChange, team, tools }: {
	workspaceId: string;
	target?: FileTarget;
	refreshToken: number;
	visible: boolean;
	view: DetailView;
	onViewChange: (view: DetailView) => void;
	team: ReactNode;
	tools: ReactNode;
}) {
	const [layout, dispatch] = useReducer(detailTabsReducer, { ...emptyDetailTabs, tabs: [{ id: "initial-files", kind: "file", pane: 0 }], selected: ["initial-files", undefined] });
	const [error, setError] = useState<string>();
	const [listFailed, setListFailed] = useState(false);
	const [listAttempt, setListAttempt] = useState(0);
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
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	const mounted = useRef(false);
	const dismissed = useRef(new Set<string>());
	const creatingIds = useRef(new Set<string>());
	const closingIds = useRef(new Set<string>());
	const terminalNumber = useRef(0);
	const handledRequest = useRef<string | undefined>(undefined);
	const id = useId();
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	useEffect(() => {
		const controller = new AbortController();
		void api<TerminalSummary[]>(`/api/terminals?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }).then((items) => {
			if (controller.signal.aborted) return;
			dispatch({ type: "restoreTerminals", tabs: items.filter((item) => !dismissed.current.has(item.terminalId)).map((summary) => ({ id: `terminal-${summary.terminalId}`, pane: 0, kind: "terminal", summary, number: ++terminalNumber.current })) });
			setListFailed(false);
		}).catch((reason: unknown) => { if (!controller.signal.aborted) { setError(errorMessage(reason)); setListFailed(true); } });
		return () => controller.abort();
	}, [workspaceId, listAttempt]);
	useEffect(() => {
		if (!target || target.requestId === handledRequest.current) return;
		handledRequest.current = target.requestId;
		dispatch({ type: "openFile", ...target, id: nextClientId() });
	}, [target]);
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
		if (tab.kind === "file" && tab.file) dispatch({ type: "openFile", path: tab.file.path, line: tab.file.line, id: tab.id, requestId: nextClientId() });
		else dispatch({ type: "select", id: tab.id });
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
		if (tab.kind !== "terminal") { transitionItems(() => dispatch({ type: "remove", id: tab.id })); return; }
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
		return tab.kind === "terminal" ? `端末 ${tab.number}` : tab.kind === "file" ? tab.file?.path.split(/[\\/]/).at(-1) || "ファイルを選択" : "新しいタブ";
	}
	function choices(tab: DetailTab | undefined, pane: PaneIndex) {
		return <div className="detail-new-tab"><h2>新しいタブ</h2><div className="detail-new-choices"><button type="button" disabled={!!tab && creating.includes(tab.id)} onClick={() => chooseFile(tab, pane)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6l2 3h8v13H4z" /></svg><span>ファイル</span></button><button type="button" disabled={creating.includes(tab?.id ?? "")} onClick={() => { void createTerminal(tab, pane); }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></svg><span>{tab && creating.includes(tab.id) ? "作成中…" : "端末"}</span></button></div></div>;
	}
	const selectedFiles = layout.tabs.filter((tab) => tab.kind === "file" && layout.selected[tab.pane] === tab.id && (tab.pane === 0 || layout.mode !== "single"));
	const activeFile = selectedFiles.find((tab) => tab.pane === layout.focused) ?? selectedFiles[0];
	return <div className="detail-workspace">
		<header className="detail-toolbar">
			<div className="detail-tab-strip" ref={strip}><div className="detail-tabs" role="tablist" aria-label="作業タブ">
				{layout.tabs.map((tab, index) => <div key={tab.id} className="detail-tab" data-kind={tab.kind} data-active={view === "tabs" && layout.selected[tab.pane] === tab.id} data-focused={layout.focused === tab.pane} data-dragging={dragging === tab.id || undefined} data-drop={dropTarget?.id === tab.id ? dropTarget.after ? "after" : "before" : undefined} draggable={!closing.includes(tab.id) && !creating.includes(tab.id)} onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); void closeTab(tab); } }} onDragStart={(event) => { dragged.current = tab.id; setDragging(tab.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-hasilan-detail-tab", tab.id); }} onDragEnd={endDrag} onDragOver={(event) => { if (!dragged.current) return; event.preventDefault(); event.stopPropagation(); setDropTarget({ id: tab.id, after: event.clientX >= event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2 }); }} onDrop={(event) => {
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
					}}><span className="detail-tab-kind" aria-hidden="true">{tab.kind === "terminal" ? ">_" : tab.kind === "file" ? "▤" : "+"}</span><span className="detail-tab-title">{title(tab)}</span>{tab.kind === "terminal" && tab.summary.status === "exited" && <span className="terminal-tab-exit">終了 {tab.summary.exitCode ?? "?"}</span>}</button>
					<button type="button" className="detail-tab-close" draggable={false} aria-label={`${title(tab)}を閉じる`} disabled={closing.includes(tab.id) || creating.includes(tab.id)} onClick={() => { void closeTab(tab); }}>×</button>
				</div>)}
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
			}} onPointerCancel={() => { tabPress.current = undefined; suppressTabClick.current = true; setTabGesture(undefined); setShowTabHints(false); }} onLostPointerCapture={() => { tabPress.current = undefined; setTabGesture(undefined); setShowTabHints(false); }} onClick={(event) => { if (suppressTabClick.current && event.detail !== 0) { suppressTabClick.current = false; return; } addTab(); }}>＋</button>{showTabHints && <div className="detail-gesture-hints" role="status"><span className="detail-gesture-hint is-down" data-active={tabGesture === "terminal"}>↓ 端末</span><span className="detail-gesture-hint is-right" data-active={tabGesture === "file"}>→ ファイル</span></div>}</div>
			<SplitActions label="作業タブ" mode={layout.mode} onChange={(mode) => { onViewChange("tabs"); dispatch({ type: "split", mode }); }} />
			<div className="detail-panel-actions" role="group" aria-label="詳細パネル">
				<button type="button" className="detail-panel-icon" aria-label="チーム" title="チーム" aria-pressed={view === "team"} aria-controls={`${id}-team`} onClick={() => onViewChange(view === "team" ? "tabs" : "team")}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 3 4v2" /></svg></button>
				<button type="button" className="detail-panel-icon" aria-label="ツール" title="ツール" aria-pressed={view === "tools"} aria-controls={`${id}-tools`} onClick={() => onViewChange(view === "tools" ? "tabs" : "tools")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 6a5 5 0 0 0-6 6L3 17a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3z" /></svg></button>
			</div>
		</header>
		{error && <div className="detail-error" role="alert">{error}{listFailed && <button type="button" onClick={() => { setError(undefined); setListAttempt((value) => value + 1); }}>端末一覧を再取得</button>}<button type="button" aria-label="エラーを閉じる" onClick={() => setError(undefined)}>×</button></div>}
		<div className="detail-resource-area" hidden={view !== "tabs"}>
			<FilePane workspaceId={workspaceId} activePath={activeFile?.kind === "file" ? activeFile.file?.path : undefined} refreshToken={refreshToken} visible={visible && view === "tabs"} treeVisible={selectedFiles.length > 0} onOpen={openFile}>
			<SplitLayout mode={layout.mode} label="作業タブ" dragging={!!dragging && layout.tabs.length > 1} onEdgeDrop={(edge) => { if (dragged.current) dispatch({ type: "edge", id: dragged.current, edge }); endDrag(); }}>
				{layout.tabs.map((tab) => {
					const selected = layout.selected[tab.pane] === tab.id && (tab.pane === 0 || layout.mode !== "single");
					const active = visible && view === "tabs" && selected;
					if (tab.kind === "terminal") return <TerminalView key={tab.summary.terminalId} summary={tab.summary} pane={tab.pane} selected={selected} visible={active} id={`${id}-body-${tab.id}`} labelledBy={`${id}-tab-${tab.id}`} focusRequest={focusRequest.id === tab.id ? focusRequest.number : 0} onSummary={updateSummary} onState={updateViewState} onActivate={() => dispatch({ type: "focus", pane: tab.pane })} dragging={!!dragging} onTabDrop={() => dropOnPane(tab.pane)} />;
					return <div key={tab.id} className="detail-tab-body split-tab-body" data-pane={tab.pane} data-focused={layout.focused === tab.pane} hidden={!selected} onPointerDownCapture={() => dispatch({ type: "focus", pane: tab.pane })} onFocusCapture={() => dispatch({ type: "focus", pane: tab.pane })} onDragOver={(event) => { if (dragged.current) event.preventDefault(); }} onDrop={(event) => { if (dragged.current) { event.preventDefault(); dropOnPane(tab.pane); } }}>
						{tab.kind === "file" ? tab.file ? <FilePreview workspaceId={workspaceId} file={tab.file} refreshKey={`${refreshToken}:${tab.requestId ?? ""}`} visible={active} id={`${id}-body-${tab.id}`} labelledBy={`${id}-tab-${tab.id}`} onOpen={openFile} onChange={(_path, patch) => dispatch({ type: "patchFile", id: tab.id, patch })} /> : <div className="detail-file-empty" id={`${id}-body-${tab.id}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab.id}`}>ファイルを選択してください。</div> : <div id={`${id}-body-${tab.id}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab.id}`}>{choices(tab, tab.pane)}</div>}
					</div>;
				})}
				{([0, 1] as const).map((pane) => !layout.tabs.some((tab) => tab.pane === pane) && <div key={`empty-${pane}`} className="detail-tab-body split-tab-body" data-pane={pane} hidden={pane === 1 && layout.mode === "single"} onPointerDownCapture={() => dispatch({ type: "focus", pane })} onDragOver={(event) => { if (dragged.current) event.preventDefault(); }} onDrop={(event) => { if (dragged.current) { event.preventDefault(); dropOnPane(pane); } }}>{choices(undefined, pane)}</div>)}
			</SplitLayout>
			</FilePane>
		</div>
		<div id={`${id}-team`} className="detail-auxiliary" hidden={view !== "team"}>{team}</div>
		<div id={`${id}-tools`} className="detail-auxiliary detail-tools" hidden={view !== "tools"}>{tools}</div>
	</div>;
}
