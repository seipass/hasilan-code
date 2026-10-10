import { useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../api.ts";
import "./FilePane.css";

interface FileEntry { name: string; path: string; kind: "file" | "directory" | "symlink"; size: number }
interface FileView {
	path: string; revision: string; kind: "text" | "image" | "binary";
	lines?: { number: number; text: string; truncated?: boolean }[]; nextOffset?: number; size: number;
}
export interface FileTarget { path: string; line?: number; requestId: string }
interface OpenFile { path: string; line?: number; offset: number }
interface FilePaneProps {
	workspaceId: string; target?: FileTarget; refreshToken: number; visible?: boolean;
	onOpen: (path: string, line?: number) => void; onClear?: () => void;
}
const MIN_PREVIEW_WIDTH = 300;
const MIN_TREE_WIDTH = 180;
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
			}}><span className="files-tree-marker" aria-hidden="true">{entry.kind === "directory" ? (open.includes(entry.path) ? "▾" : "▸") : entry.kind === "symlink" ? "↗" : "·"}</span><span>{entry.name}</span></button>
			{entry.kind === "directory" && open.includes(entry.path) && <Directory workspaceId={workspaceId} path={entry.path} refreshKey={refreshKey} activePath={activePath} visible={visible} onOpen={onOpen} />}
		</li>)}
	</ul>;
}

export function FilePane(props: FilePaneProps) {
	return <WorkspaceFilePane key={props.workspaceId} {...props} />;
}

function WorkspaceFilePane({ workspaceId, target, refreshToken, visible = true, onOpen, onClear }: FilePaneProps) {
	const [files, setFiles] = useState<OpenFile[]>(() => target ? [{ path: target.path, line: target.line, offset: Math.max(1, (target.line ?? 1) - 20) }] : []);
	const [activePath, setActivePath] = useState(target?.path);
	const [result, setResult] = useState<{ key: string; view?: FileView; error?: string }>();
	const [treeWidth, setTreeWidth] = useState(240);
	const [availableWidth, setAvailableWidth] = useState(0);
	const [resizing, setResizing] = useState(false);
	const pane = useRef<HTMLElement>(null);
	const viewer = useRef<HTMLDivElement>(null);
	const tabStrip = useRef<HTMLDivElement>(null);
	const drag = useRef<{ pointerId: number; startX: number; width: number } | undefined>(undefined);
	const lastRequest = useRef(target?.requestId);
	const id = useId();
	const active = files.find((file) => file.path === activePath);
	const maxTreeWidth = Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, availableWidth - MIN_PREVIEW_WIDTH - SPLIT_WIDTH));
	const requestKey = active && (!target || target.requestId === lastRequest.current) ? JSON.stringify([workspaceId, active.path, active.offset, refreshToken, target?.requestId]) : undefined;
	const loaded = result?.key === requestKey ? result : undefined;

	useEffect(() => {
		if (!target || target.requestId === lastRequest.current) return;
		lastRequest.current = target.requestId;
		setFiles((previous) => {
			const existing = previous.find((file) => file.path === target.path);
			const file = { path: target.path, line: target.line, offset: target.line === undefined ? existing?.offset ?? 1 : Math.max(1, target.line - 20) };
			return existing ? previous.map((entry) => entry.path === target.path ? file : entry) : [...previous, file];
		});
		setActivePath(target.path);
	}, [target]);
	useEffect(() => {
		if (!visible || !active || !requestKey) return;
		const controller = new AbortController();
		setResult(undefined);
		api<FileView>(`/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(active.path)}&offset=${active.offset}&limit=200`, { signal: controller.signal })
			.then((view) => { if (!controller.signal.aborted) setResult({ key: requestKey, view }); })
			.catch((reason: unknown) => { if (!controller.signal.aborted) setResult({ key: requestKey, error: errorMessage(reason) }); });
		return () => controller.abort();
	}, [workspaceId, active?.path, active?.offset, requestKey, visible]);
	useEffect(() => {
		if (visible && loaded?.view && active?.line) viewer.current?.querySelector(`[data-line="${active.line}"]`)?.scrollIntoView({ block: "center", inline: "nearest" });
	}, [loaded?.view, active?.line, visible]);
	useEffect(() => {
		tabStrip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [activePath]);
	useEffect(() => {
		const element = pane.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setAvailableWidth(element.clientWidth));
		observer.observe(element);
		setAvailableWidth(element.clientWidth);
		return () => observer.disconnect();
	}, []);

	function closeFile(path: string) {
		const remaining = files.filter((file) => file.path !== path);
		setFiles(remaining);
		requestAnimationFrame(() => {
			const selectedTab = tabStrip.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
			if (selectedTab) selectedTab.focus();
			else document.getElementById(`${id}-tree`)?.querySelector<HTMLButtonElement>("button")?.focus();
		});
		if (path !== activePath) return;
		const next = remaining[Math.min(files.findIndex((file) => file.path === path), remaining.length - 1)];
		setActivePath(next?.path);
		if (next) onOpen(next.path, next.line);
		else onClear?.();
	}
	function changeOffset(offset: number) {
		setFiles((previous) => previous.map((file) => file.path === activePath ? { ...file, offset } : file));
		viewer.current?.scrollTo({ top: 0 });
	}
	function resizeTree(width: number) {
		setTreeWidth(Math.max(MIN_TREE_WIDTH, Math.min(maxTreeWidth, width)));
	}

	return <section className="files-pane" ref={pane} hidden={!visible} aria-label="ファイル閲覧">
		<div className="files-layout" style={{ gridTemplateColumns: `minmax(${MIN_PREVIEW_WIDTH}px, 1fr) ${SPLIT_WIDTH}px ${treeWidth}px`, minWidth: MIN_PREVIEW_WIDTH + SPLIT_WIDTH + treeWidth }}>
			<div className="files-preview">
				{files.length > 0 && <div className="files-tabs" role="tablist" aria-label="開いているファイル" ref={tabStrip}>
					{files.map((file, index) => <div className="files-tab" key={file.path} data-active={file.path === activePath}>
						<button role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-preview`} aria-selected={file.path === activePath} tabIndex={file.path === activePath ? 0 : -1} title={file.path} onClick={() => onOpen(file.path, file.line)} onKeyDown={(event) => {
							let nextIndex: number | undefined;
							if (event.key === "ArrowLeft") nextIndex = (index - 1 + files.length) % files.length;
							if (event.key === "ArrowRight") nextIndex = (index + 1) % files.length;
							if (event.key === "Home") nextIndex = 0;
							if (event.key === "End") nextIndex = files.length - 1;
							if (event.key === "Delete") { event.preventDefault(); closeFile(file.path); }
							if (nextIndex === undefined) return;
							event.preventDefault();
							const next = files[nextIndex];
							onOpen(next.path, next.line);
							document.getElementById(`${id}-tab-${nextIndex}`)?.focus();
						}}>{file.path.split(/[\\/]/).at(-1) || file.path}</button>
						<button className="files-tab-close" aria-label={`${file.path} を閉じる`} onClick={() => closeFile(file.path)}>×</button>
					</div>)}
				</div>}
				<div className="files-viewer" id={`${id}-preview`} role={active ? "tabpanel" : undefined} aria-labelledby={active ? `${id}-tab-${files.findIndex((file) => file.path === activePath)}` : undefined} ref={viewer} tabIndex={0} aria-busy={!!active && !loaded}>
					{!active && <p className="files-message muted">ファイルを選択してください。</p>}
					{active && !loaded && <p className="files-message" role="status">読み込み中…</p>}
					{loaded?.error && <p role="alert" className="files-message error">{loaded.error}</p>}
					{active && loaded?.view && loaded.view.path === active.path && <>
						{loaded.view.kind === "text" && <>
							{active.offset > 1 && <div className="files-page"><button onClick={() => changeOffset(Math.max(1, active.offset - 200))}>前の行</button></div>}
							{loaded.view.lines?.length === 0 && <p className="files-message muted">空のファイル</p>}
							<div className="files-source-lines">{loaded.view.lines?.map((line) => <div key={line.number} data-line={line.number} className={line.number === active.line ? "files-selected-line" : undefined}><span className="files-line-number">{line.number}</span><code>{line.text || " "}</code></div>)}</div>
							{loaded.view.lines?.some((line) => line.truncated) && <p className="files-message warning">64 KiB の表示上限を超える行は先頭のみ表示しています。省略された行: {loaded.view.lines.filter((line) => line.truncated).map((line) => line.number).join(", ")}</p>}
							{loaded.view.nextOffset && <div className="files-page"><button onClick={() => changeOffset(loaded.view?.nextOffset ?? 1)}>次の行 ({loaded.view.nextOffset}〜)</button></div>}
						</>}
						{loaded.view.kind === "image" && <img className="files-image" alt={loaded.view.path} src={`/api/workspaces/${encodeURIComponent(workspaceId)}/file-content?path=${encodeURIComponent(loaded.view.path)}&revision=${encodeURIComponent(loaded.view.revision)}`} />}
						{loaded.view.kind === "binary" && <p className="files-message">バイナリファイルです。内容は表示しません。</p>}
					</>}
				</div>
			</div>
			<div className="files-splitter" role="separator" tabIndex={0} aria-label="ファイルツリーの幅" aria-orientation="vertical" aria-controls={`${id}-tree`} aria-valuemin={MIN_TREE_WIDTH} aria-valuemax={Math.max(maxTreeWidth, treeWidth)} aria-valuenow={treeWidth} aria-valuetext={`${treeWidth} ピクセル`} data-resizing={resizing} onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.focus();
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { pointerId: event.pointerId, startX: event.clientX, width: treeWidth };
				setResizing(true);
			}} onPointerMove={(event) => {
				if (drag.current?.pointerId === event.pointerId) resizeTree(drag.current.width + drag.current.startX - event.clientX);
			}} onPointerUp={(event) => {
				if (drag.current?.pointerId !== event.pointerId) return;
				event.currentTarget.releasePointerCapture(event.pointerId);
				drag.current = undefined;
				setResizing(false);
			}} onLostPointerCapture={() => { drag.current = undefined; setResizing(false); }} onKeyDown={(event) => {
				if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				const step = event.shiftKey ? 48 : 16;
				resizeTree(event.key === "Home" ? MIN_TREE_WIDTH : event.key === "End" ? maxTreeWidth : treeWidth + (event.key === "ArrowLeft" ? step : -step));
			}} />
			<nav className="files-tree" id={`${id}-tree`} aria-label="作業フォルダーのファイル">
				<Directory workspaceId={workspaceId} path="" refreshKey={`${refreshToken}:${target?.requestId ?? ""}`} activePath={activePath} visible={visible} onOpen={onOpen} />
			</nav>
		</div>
	</section>;
}
