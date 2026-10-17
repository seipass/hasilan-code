import { useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../api.ts";
import { transitionItems } from "../item-transition.ts";
import { type PaneIndex, SplitActions, type SplitEdge, SplitLayout, type SplitMode } from "../SplitLayout.tsx";
import { FilePreview, type FileTab } from "./FilePreview.tsx";
import "./FilePane.css";

interface FileEntry { name: string; path: string; kind: "file" | "directory" | "symlink"; size: number }
export interface FileTarget { path: string; line?: number; requestId: string }
interface OpenFile extends FileTab { pane: PaneIndex; requestId?: string }
interface FilePaneProps {
	workspaceId: string; target?: FileTarget; refreshToken: number; visible?: boolean;
	onOpen: (path: string, line?: number) => void; onClear?: () => void;
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

export function FilePane(props: FilePaneProps) {
	return <WorkspaceFilePane key={props.workspaceId} {...props} />;
}

function WorkspaceFilePane({ workspaceId, target, refreshToken, visible = true, onOpen, onClear }: FilePaneProps) {
	const [files, setFiles] = useState<OpenFile[]>(() => target ? [{ path: target.path, line: target.line, offset: Math.max(1, (target.line ?? 1) - 20), pane: 0, requestId: target.requestId }] : []);
	const [selected, setSelected] = useState<[string | undefined, string | undefined]>([target?.path, undefined]);
	const [focusedPane, setFocusedPane] = useState<PaneIndex>(0);
	const [mode, setMode] = useState<SplitMode>("single");
	const [treeWidth, setTreeWidth] = useState(240);
	const [availableWidth, setAvailableWidth] = useState(0);
	const [resizing, setResizing] = useState(false);
	const [draggingPath, setDraggingPath] = useState<string>();
	const [dropTarget, setDropTarget] = useState<{ path: string; edge: "before" | "after" }>();
	const pane = useRef<HTMLElement>(null);
	const tabStrips = useRef<[HTMLDivElement | null, HTMLDivElement | null]>([null, null]);
	const drag = useRef<{ pointerId: number; startX: number; width: number } | undefined>(undefined);
	const draggedTab = useRef<string | undefined>(undefined);
	const lastRequest = useRef(target?.requestId);
	const id = useId();
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

	useEffect(() => {
		if (!target || target.requestId === lastRequest.current) return;
		lastRequest.current = target.requestId;
		const existing = files.find((file) => file.path === target.path);
		const destination = existing?.pane ?? focusedPane;
		setFiles((previous) => {
			const file: OpenFile = { path: target.path, line: target.line, offset: target.line === undefined ? existing?.offset ?? 1 : Math.max(1, target.line - 20), mode: target.line === undefined ? existing?.mode : "source", pane: destination, requestId: target.requestId };
			return existing ? previous.map((entry) => entry.path === target.path ? file : entry) : [...previous, file];
		});
		setSelected((previous) => destination === 0 ? [target.path, previous[1]] : [previous[0], target.path]);
		setFocusedPane(destination);
	}, [target]);
	useEffect(() => {
		for (const strip of tabStrips.current) strip?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [selected]);
	useEffect(() => {
		const element = pane.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setAvailableWidth(element.clientWidth));
		observer.observe(element);
		setAvailableWidth(element.clientWidth);
		return () => observer.disconnect();
	}, []);
	function mergeFiles(items: OpenFile[], activePath?: string) {
		setFiles(items.map((file) => ({ ...file, pane: 0 })));
		setSelected([items.some((file) => file.path === activePath) ? activePath : items[0]?.path, undefined]);
		setFocusedPane(0);
		setMode("single");
	}

	function closeFile(path: string) {
		const file = files.find((entry) => entry.path === path);
		if (!file) return;
		transitionItems(() => {
			const remaining = files.filter((entry) => entry.path !== path);
			const groupFiles = files.filter((entry) => entry.pane === file.pane);
			const groupRemaining = remaining.filter((entry) => entry.pane === file.pane);
			const replacement = groupRemaining[Math.min(groupFiles.findIndex((entry) => entry.path === path), groupRemaining.length - 1)]?.path;
			const merge = mode !== "single" && !groupRemaining.length;
			if (merge || !remaining.length) mergeFiles(remaining, selected[file.pane === 0 ? 1 : 0]);
			else {
				setFiles(remaining);
				setSelected((previous) => {
					const next: [string | undefined, string | undefined] = [...previous];
					if (next[file.pane] === path) next[file.pane] = replacement;
					return next;
				});
			}
			requestAnimationFrame(() => { (tabStrips.current[merge ? 0 : file.pane]?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? document.getElementById(`${id}-tree`)?.querySelector<HTMLButtonElement>("button"))?.focus(); });
			if (!remaining.length) onClear?.();
		});
	}
	function moveFile(path: string, destination: PaneIndex) {
		const file = files.find((entry) => entry.path === path);
		if (!file) return;
		if (mode !== "single" && file.pane !== destination && !files.some((entry) => entry.pane === file.pane && entry.path !== path)) {
			mergeFiles(files, path);
			requestAnimationFrame(() => { tabStrips.current[0]?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(); });
			return;
		}
		if (destination === 1 && mode === "single") setMode("columns");
		setFiles((previous) => previous.map((entry) => entry.path === path ? { ...entry, pane: destination } : entry));
		setSelected((previous) => {
			const next: [string | undefined, string | undefined] = [...previous];
			if (file.pane !== destination && next[file.pane] === path) next[file.pane] = files.find((entry) => entry.pane === file.pane && entry.path !== path)?.path;
			next[destination] = path;
			return next;
		});
		setFocusedPane(destination);
		requestAnimationFrame(() => { tabStrips.current[destination]?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(); });
	}
	function changeSplit(next: SplitMode) {
		if (next === "single") {
			mergeFiles(files, selected[focusedPane] ?? selected[0] ?? selected[1]);
		} else if (mode === "single" && files.length > 1 && selected[0]) moveFile(selected[0], 1);
		setMode(next);
	}
	function splitFileAt(edge: SplitEdge) {
		const source = draggedTab.current;
		if (!source || files.length < 2 || !files.some((file) => file.path === source)) return;
		const destination: PaneIndex = edge === "left" || edge === "top" ? 0 : 1;
		const other = selected[destination === 0 ? 1 : 0];
		const remaining = files.some((file) => file.path === other && file.path !== source) ? other : files.find((file) => file.path !== source)?.path;
		setFiles((previous) => previous.map((file) => ({ ...file, pane: file.path === source ? destination : destination === 0 ? 1 : 0 })));
		setSelected(destination === 0 ? [source, remaining] : [remaining, source]);
		setFocusedPane(destination);
		setMode(edge === "left" || edge === "right" ? "columns" : "rows");
		endTabDrag();
		requestAnimationFrame(() => { tabStrips.current[destination]?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(); });
	}
	function changeFile(path: string, patch: Partial<FileTab>) {
		setFiles((previous) => previous.map((file) => file.path === path ? { ...file, ...patch } : file));
	}
	function endTabDrag() {
		draggedTab.current = undefined; setDraggingPath(undefined); setDropTarget(undefined);
	}
	function resizeTree(width: number) {
		setTreeWidth(Math.max(minTreeWidth, Math.min(maxTreeWidth, width)));
	}

	return <section className="files-pane" ref={pane} hidden={!visible} aria-label="ファイル閲覧">
		<div className="files-layout" style={{ gridTemplateColumns: `minmax(0, 1fr) ${splitWidth}px minmax(0, ${displayedTreeWidth}px)` }}>
			<div className="files-preview">
				<SplitLayout mode={mode} label="ファイル" dragging={!!draggingPath && files.length > 1} onEdgeDrop={splitFileAt}>
					{([0, 1] as const).map((group) => {
						const tabs = files.filter((file) => file.pane === group);
						const active = tabs.find((file) => file.path === selected[group]);
						return <div key={group} className="split-pane" data-pane={group} data-focused={focusedPane === group} hidden={group === 1 && mode === "single"} onPointerDownCapture={() => setFocusedPane(group)} onFocusCapture={() => setFocusedPane(group)} onDragOver={(event) => { if (draggedTab.current) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { if (!draggedTab.current) return; event.preventDefault(); moveFile(draggedTab.current, group); endTabDrag(); }}>
							<div className="files-tab-header" hidden={!tabs.length && mode === "single"}>
							<div className="files-tabs" role="tablist" aria-label={`ファイル ペイン ${group + 1}`} ref={(element) => { tabStrips.current[group] = element; }}>
								{tabs.map((file, index) => <div className="files-tab" key={file.path} data-path={file.path} data-active={file.path === active?.path} data-dragging={file.path === draggingPath} data-drop={dropTarget?.path === file.path ? dropTarget.edge : undefined} draggable onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeFile(file.path); } }} onDragStart={(event) => { draggedTab.current = file.path; setDraggingPath(file.path); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-hasilan-file-tab", file.path); }} onDragOver={(event) => {
									if (!draggedTab.current) return;
									event.preventDefault(); event.stopPropagation();
									const bounds = event.currentTarget.getBoundingClientRect();
									setDropTarget({ path: file.path, edge: event.clientX < bounds.left + bounds.width / 2 ? "before" : "after" });
								}} onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(undefined); }} onDrop={(event) => {
									const source = draggedTab.current;
									if (!source) return;
									event.preventDefault(); event.stopPropagation();
									const bounds = event.currentTarget.getBoundingClientRect();
									const after = event.clientX >= bounds.left + bounds.width / 2;
									if (source !== file.path) {
										if (files.find((entry) => entry.path === source)?.pane !== group) moveFile(source, group);
										setFiles((previous) => {
											const moved = previous.find((entry) => entry.path === source);
											if (!moved) return previous;
											const remaining = previous.filter((entry) => entry.path !== source);
											const position = remaining.findIndex((entry) => entry.path === file.path);
											remaining.splice(position + (after ? 1 : 0), 0, moved);
											return remaining;
										});
									}
									endTabDrag();
								}} onDragEnd={endTabDrag}>
									<button draggable role="tab" id={`${id}-tab-${group}-${index}`} aria-controls={`${id}-preview-${group}`} aria-selected={file.path === active?.path} tabIndex={file.path === active?.path ? 0 : -1} title={file.path} onClick={() => onOpen(file.path, file.line)} onKeyDown={(event) => {
										let nextIndex: number | undefined;
										if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
										if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
										if (event.key === "Home") nextIndex = 0;
										if (event.key === "End") nextIndex = tabs.length - 1;
										if (event.key === "Delete") { event.preventDefault(); closeFile(file.path); }
										if (nextIndex === undefined) return;
										event.preventDefault(); onOpen(tabs[nextIndex].path, tabs[nextIndex].line);
										document.getElementById(`${id}-tab-${group}-${nextIndex}`)?.focus();
									}}>{file.path.split(/[\\/]/).at(-1) || file.path}</button>
									<button className="split-tab-move" aria-label={`${file.path} を別のペインへ移動`} title="別のペインへ移動" onClick={() => moveFile(file.path, group === 0 ? 1 : 0)}>⇄</button>
									<button className="files-tab-close" aria-label={`${file.path} を閉じる`} draggable={false} onClick={() => closeFile(file.path)}>×</button>
								</div>)}
							</div>
								<SplitActions label={`ファイル ペイン ${group + 1}`} mode={mode} onChange={changeSplit} />
							</div>
							<FilePreview workspaceId={workspaceId} file={active} visible={visible && (group === 0 || mode !== "single")} refreshKey={`${refreshToken}:${active?.requestId ?? ""}`} id={`${id}-preview-${group}`} labelledBy={active ? `${id}-tab-${group}-${tabs.indexOf(active)}` : undefined} onOpen={onOpen} onChange={changeFile} />
						</div>;
					})}
				</SplitLayout>
			</div>
			<div className="files-splitter" role="separator" tabIndex={0} aria-label="ファイルツリーの幅" aria-orientation="vertical" aria-controls={`${id}-tree`} aria-valuemin={minTreeWidth} aria-valuemax={maxTreeWidth} aria-valuenow={displayedTreeWidth} aria-valuetext={`${displayedTreeWidth} ピクセル`} data-resizing={resizing} onPointerDown={(event) => {
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
			}} />
			<nav className="files-tree" id={`${id}-tree`} aria-label="作業フォルダーのファイル"><Directory workspaceId={workspaceId} path="" refreshKey={`${refreshToken}:${target?.requestId ?? ""}`} activePath={selected[focusedPane]} visible={visible} onOpen={onOpen} /></nav>
		</div>
	</section>;
}
