import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../api.ts";
import { MobileSheet, useMobileLayout } from "../MobileSheet.tsx";
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

function Directory({ workspaceId, path, refreshKey, activePath, visible, onOpen }: {
	workspaceId: string; path: string; refreshKey: string; activePath?: string; visible: boolean; onOpen: (path: string) => void;
}) {
	const [entries, setEntries] = useState<FileEntry[]>();
	const [open, setOpen] = useState<string[]>([]);
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (!visible) return;
		const controller = new AbortController();
		api<FileEntry[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`, { signal: controller.signal })
			.then((value) => { if (!controller.signal.aborted) { setEntries(value); setError(undefined); } })
			.catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, [workspaceId, path, refreshKey, visible]);
	return <ul className="files-tree-list">
		{error && <li className="files-tree-message error">{error}</li>}
		{!entries && !error && <li className="files-tree-message muted">読み込み中…</li>}
		{entries?.length === 0 && <li className="files-tree-message muted">空のディレクトリ</li>}
		{entries?.map((entry) => <li key={entry.path}>
			<button className="files-tree-entry" title={entry.path} aria-current={entry.path === activePath ? "true" : undefined} aria-expanded={entry.kind === "directory" ? open.includes(entry.path) : undefined} onClick={() => {
				if (entry.kind === "directory") setOpen((previous) => previous.includes(entry.path) ? previous.filter((value) => value !== entry.path) : [...previous, entry.path]);
				else onOpen(entry.path);
			}}><span className="files-tree-marker" aria-hidden="true">{entry.kind === "directory" ? "▸" : entry.kind === "symlink" ? "↗" : "·"}</span><span>{entry.name}</span></button>
			{entry.kind === "directory" && <div className="files-tree-children" data-open={open.includes(entry.path)} aria-hidden={!open.includes(entry.path)} inert={!open.includes(entry.path)}><div><Directory workspaceId={workspaceId} path={entry.path} refreshKey={refreshKey} activePath={activePath} visible={visible && open.includes(entry.path)} onOpen={onOpen} /></div></div>}
		</li>)}
	</ul>;
}

export function FilePane({ workspaceId, activePath, refreshToken, visible, treeVisible, children, onOpen }: FilePaneProps) {
	const mobile = useMobileLayout();
	const [treeOpen, setTreeOpen] = useState(false);
	const [treeWidth, setTreeWidth] = useState(240);
	const [availableWidth, setAvailableWidth] = useState(0);
	const [resizing, setResizing] = useState(false);
	const pane = useRef<HTMLElement>(null);
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
		const element = pane.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setAvailableWidth(element.clientWidth));
		observer.observe(element);
		setAvailableWidth(element.clientWidth);
		return () => observer.disconnect();
	}, []);
	function resizeTree(width: number) { setTreeWidth(Math.max(minTreeWidth, Math.min(maxTreeWidth, width))); }
	const tree = <nav className="files-tree" id={treeId} aria-label="作業フォルダーのファイル" hidden={!treeVisible}><Directory workspaceId={workspaceId} path="" refreshKey={String(refreshToken)} activePath={activePath} visible={visible && treeVisible && (!mobile || treeOpen)} onOpen={(path) => { onOpen(path); setTreeOpen(false); }} /></nav>;
	return <section className="files-pane" ref={pane} aria-label="作業ビューア">
		{mobile && treeVisible && <button type="button" className="files-tree-toggle" aria-haspopup="dialog" aria-expanded={treeOpen} aria-controls={treeId} onClick={() => setTreeOpen(true)}>ファイル一覧を開く</button>}
		<div className="files-layout" style={{ gridTemplateColumns: mobile || !treeVisible ? "minmax(0, 1fr)" : `minmax(0, 1fr) ${splitWidth}px minmax(0, ${displayedTreeWidth}px)` }}>
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
			{mobile ? <MobileSheet open={treeOpen && visible && treeVisible} side="right" title="ファイル一覧" onClose={() => setTreeOpen(false)}>{tree}</MobileSheet> : tree}
		</div>
	</section>;
}
