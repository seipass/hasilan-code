import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "../api.ts";
import { MobileSheet, useMobileLayout } from "../MobileSheet.tsx";
import { MotionItems, Presence, useChildrenMotion } from "../Motion.tsx";
import { usePreferenceState } from "../preferences.ts";
import { draftKey, isDraftDirty, subscribeDraftStatus, draftStatusVersion } from "./file-drafts.ts";
import { FileIcon } from "./FileIcon.tsx";
import { QuickOpen } from "./QuickOpen.tsx";
import "./FilePane.css";

interface FileEntry { name: string; path: string; kind: "file" | "directory" | "symlink"; size: number }
export interface FileTarget { path: string; line?: number; requestId: string }
interface FilePaneProps {
	workspaceId: string; activePath?: string; refreshToken: number; visible: boolean; treeVisible: boolean;
	children: ReactNode;
	onOpen: (path: string, line?: number) => void;
}
const MIN_PREVIEW_WIDTH = 300;
const MIN_TREE_WIDTH = 180;
const COMPACT_MIN_PREVIEW_WIDTH = 180;
const COMPACT_MIN_TREE_WIDTH = 100;
const MAX_TREE_WIDTH = 480;
const SPLIT_WIDTH = 8;

function Directory({ workspaceId, path, refreshKey, activePath, visible, onOpen, open, onToggle, filter = "" }: {
	workspaceId: string; path: string; refreshKey: string; activePath?: string; visible: boolean; onOpen: (path: string) => void; open: string[]; onToggle: (path: string) => void; filter?: string;
}) {
	const [entries, setEntries] = useState<FileEntry[]>();
	const [error, setError] = useState<string>();
	useSyncExternalStore(subscribeDraftStatus, draftStatusVersion, draftStatusVersion);
	useEffect(() => {
		if (!visible) return;
		const controller = new AbortController();
		api<FileEntry[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`, { signal: controller.signal })
			.then((value) => { if (!controller.signal.aborted) { setEntries(value); setError(undefined); } })
			.catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, [workspaceId, path, refreshKey, visible]);
	const matches = (entry: FileEntry) => !filter || entry.name.toLowerCase().includes(filter);
	const shown = (entries ?? []).filter(matches);
	return <ul className="files-tree-list">
		<Presence show={!!error}><li className="files-tree-message error">{error}</li></Presence>
		<Presence show={!entries && !error}><li className="files-tree-message muted">読み込み中…</li></Presence>
		<Presence show={entries?.length === 0}><li className="files-tree-message muted">空のディレクトリ</li></Presence>
		<Presence show={(entries?.length ?? 0) > 0 && shown.length === 0}><li className="files-tree-message muted">一致する項目がありません</li></Presence>
		<MotionItems items={shown} itemKey={(entry) => entry.path}>{(entry) => <li key={entry.path}>
			<button className="files-tree-entry" title={entry.path} aria-current={entry.path === activePath ? "true" : undefined} aria-expanded={entry.kind === "directory" ? open.includes(entry.path) : undefined} onClick={() => {
				if (entry.kind === "directory") onToggle(entry.path);
				else onOpen(entry.path);
			}}>{entry.kind === "file" ? <FileIcon name={entry.name} /> : <span className="files-tree-marker" aria-hidden="true">{entry.kind === "directory" ? "▸" : "↗"}</span>}<span>{entry.name}</span>{entry.kind === "file" && isDraftDirty(draftKey(workspaceId, entry.path)) && <span className="files-tree-dirty" aria-label="未保存の変更">●</span>}</button>
			{entry.kind === "directory" && (() => { const expanded = !!filter || open.includes(entry.path); return <div className="files-tree-children" data-open={expanded} aria-hidden={!expanded} inert={!expanded}><div><Directory workspaceId={workspaceId} path={entry.path} refreshKey={refreshKey} activePath={activePath} visible={visible && expanded} onOpen={onOpen} open={open} onToggle={onToggle} filter={filter} /></div></div>; })()}
		</li>}</MotionItems>
	</ul>;
}

export function FilePane({ workspaceId, activePath, refreshToken, visible, treeVisible, children, onOpen }: FilePaneProps) {
	const mobile = useMobileLayout();
	const [treeOpen, setTreeOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const [refreshing, setRefreshing] = useState(false);
	const [localRefresh, setLocalRefresh] = useState(0);
	const [quickOpen, setQuickOpen] = useState(false);
	const [treePreferences, setTreePreferences] = usePreferenceState(`pi-web-tree:${workspaceId}`, { width: 240, open: [] as string[] });
	const treeWidth = treePreferences.width;
	const [availableWidth, setAvailableWidth] = useState(0);
	const [resizing, setResizing] = useState(false);
	const pane = useRef<HTMLElement>(null);
	const layout = useRef<HTMLDivElement>(null);
	useChildrenMotion(layout, `${mobile}:${treeVisible}`, !resizing);
	const drag = useRef<{ pointerId: number; startX: number; width: number } | undefined>(undefined);
	const treeId = useId();
	const splitWidth = Math.min(SPLIT_WIDTH, availableWidth);
	const contentWidth = Math.max(0, availableWidth - splitWidth);
	const compact = availableWidth < MIN_PREVIEW_WIDTH + SPLIT_WIDTH + MIN_TREE_WIDTH;
	const previewMinimum = compact ? COMPACT_MIN_PREVIEW_WIDTH : MIN_PREVIEW_WIDTH;
	const treeMinimum = compact ? COMPACT_MIN_TREE_WIDTH : MIN_TREE_WIDTH;
	const minimumScale = Math.min(1, contentWidth / (previewMinimum + treeMinimum));
	const minPreviewWidth = Math.floor(previewMinimum * minimumScale);
	const minTreeWidth = Math.floor(treeMinimum * minimumScale);
	const maxTreeWidth = Math.max(minTreeWidth, Math.min(MAX_TREE_WIDTH, contentWidth - minPreviewWidth));
	const displayedTreeWidth = Math.max(minTreeWidth, Math.min(maxTreeWidth, treeWidth));
	useEffect(() => { if (!mobile || !visible || !treeVisible) setTreeOpen(false); }, [mobile, visible, treeVisible]);
	useEffect(() => {
		const openQuick = () => setQuickOpen(true);
		window.addEventListener("hasilan:quick-open", openQuick);
		return () => window.removeEventListener("hasilan:quick-open", openQuick);
	}, []);
	useEffect(() => {
		const element = pane.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setAvailableWidth(element.clientWidth));
		observer.observe(element);
		setAvailableWidth(element.clientWidth);
		return () => observer.disconnect();
	}, []);
	function resizeTree(width: number) { setTreePreferences((previous) => ({ ...previous, width: Math.max(minTreeWidth, Math.min(maxTreeWidth, width)) })); }
	const refreshTree = async () => {
		if (refreshing) return;
		setRefreshing(true);
		try {
			const value = await api<FileEntry[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files?path=`);
			setLocalRefresh((current) => current + 1);
			if (!value.length) setFilter("");
		} catch (reason) {
			console.warn(reason);
		} finally {
			setRefreshing(false);
		}
	};
	const tree = <nav className="files-tree" id={treeId} aria-label="作業フォルダーのファイル" style={{ width: mobile ? undefined : displayedTreeWidth }} hidden={!treeVisible}>
		<div className="files-tree-toolbar">
			<input type="search" className="files-tree-filter" aria-label="ファイル名で絞り込み" placeholder="ファイル名で絞り込み" value={filter} onChange={(event) => setFilter(event.target.value.toLowerCase())} />
			<button type="button" className="files-tree-action" aria-label="ファイル一覧を更新" title="ファイル一覧を更新" disabled={refreshing} onClick={() => { void refreshTree(); }}>{refreshing ? "…" : "↻"}</button>
			<button type="button" className="files-tree-action" aria-label="ファイル名から開く" title="ファイル名から開く（Ctrl / Cmd + P）" onClick={() => setQuickOpen(true)}>⌕</button>
		</div>
		<Directory workspaceId={workspaceId} path="" refreshKey={`${refreshToken}:${localRefresh}`} activePath={activePath} visible={visible && treeVisible && (!mobile || treeOpen)} onOpen={(path) => { onOpen(path); setTreeOpen(false); }} open={treePreferences.open} filter={filter} onToggle={(path) => setTreePreferences((previous) => ({ ...previous, open: previous.open.includes(path) ? previous.open.filter((value) => value !== path) : [...previous.open, path] }))} />
	</nav>;
	return <section className="files-pane" ref={pane} aria-label="作業ビューア">
		{mobile && treeVisible && <button type="button" className="files-tree-toggle" aria-haspopup="dialog" aria-expanded={treeOpen} aria-controls={treeId} onClick={() => setTreeOpen(true)}>ファイル一覧を開く</button>}
		<div ref={layout} className="files-layout" style={{ gridTemplateColumns: mobile || !treeVisible ? "minmax(0, 1fr)" : `minmax(0, 1fr) ${splitWidth}px minmax(0, ${displayedTreeWidth}px)` }}>
			<div className="files-preview">{children}</div>
			{!mobile && treeVisible && <div className="files-splitter" role="separator" tabIndex={0} aria-label="ファイルツリーの幅" aria-orientation="vertical" aria-controls={treeId} aria-valuemin={minTreeWidth} aria-valuemax={maxTreeWidth} aria-valuenow={displayedTreeWidth} aria-valuetext={`${displayedTreeWidth} ピクセル`} data-resizing={resizing} onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { pointerId: event.pointerId, startX: event.clientX, width: displayedTreeWidth }; setResizing(true);
			}} onPointerMove={(event) => { if (drag.current?.pointerId === event.pointerId) resizeTree(drag.current.width + drag.current.startX - event.clientX); }} onPointerUp={(event) => {
				if (drag.current?.pointerId !== event.pointerId) return;
				event.currentTarget.releasePointerCapture(event.pointerId); drag.current = undefined; setResizing(false);
			}} onLostPointerCapture={() => { drag.current = undefined; setResizing(false); }} onKeyDown={(event) => {
				if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
				event.preventDefault(); const step = event.shiftKey ? 48 : 16;
				resizeTree(event.key === "Home" ? minTreeWidth : event.key === "End" ? maxTreeWidth : displayedTreeWidth + (event.key === "ArrowLeft" ? step : -step));
			}} />}
			{mobile ? <MobileSheet open={treeOpen && visible && treeVisible} side="right" title="ファイル一覧" onClose={() => setTreeOpen(false)}>{tree}</MobileSheet> : <Presence show={treeVisible}>{tree}</Presence>}
		</div>
		<QuickOpen workspaceId={workspaceId} open={quickOpen} onClose={() => setQuickOpen(false)} onOpen={(path, line) => onOpen(path, line)} />
	</section>;
}
