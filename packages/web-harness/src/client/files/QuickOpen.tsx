import { useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../api.ts";
import { Presence } from "../Motion.tsx";

interface FileEntry {
	name: string;
	path: string;
	kind: "file" | "directory" | "symlink";
	size: number;
}

/** Filename fuzzy search across the workspace so a file can be opened without scrolling the tree. */
export function QuickOpen({ workspaceId, open, onClose, onOpen }: {
	workspaceId: string;
	open: boolean;
	onClose: () => void;
	onOpen: (path: string, line?: number) => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const listId = useId();
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<FileEntry[]>([]);
	const [cursor, setCursor] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		if (open && !element.open) {
			setQuery("");
			setResults([]);
			setCursor(0);
			setError(undefined);
			element.showModal();
			requestAnimationFrame(() => input.current?.focus());
		} else if (!open && element.open) element.close();
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const trimmed = query.trim();
		if (!trimmed) {
			setResults([]);
			setBusy(false);
			return;
		}
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			setBusy(true);
			void api<FileEntry[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/file-search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
				.then((value: FileEntry[]) => {
					if (controller.signal.aborted) return;
					setResults(value);
					setCursor(0);
					setError(undefined);
				})
				.catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
				.finally(() => { if (!controller.signal.aborted) setBusy(false); });
		}, 160);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [open, query, workspaceId]);

	useEffect(() => {
		list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [cursor, results]);

	const choose = (entry: FileEntry) => {
		onClose();
		onOpen(entry.path);
	};
	const active = Math.min(cursor, Math.max(0, results.length - 1));

	return <dialog ref={dialog} className="quick-open motion-dialog" aria-labelledby={`${listId}-title`} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
		<h2 id={`${listId}-title`} className="sr-only">ファイルを開く</h2>
		<input ref={input} type="search" className="quick-open-input" aria-label="ファイルを検索" aria-controls={listId} aria-autocomplete="list" placeholder="ファイル名で検索（Ctrl / Cmd + P）" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
			if (event.nativeEvent.isComposing) return;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (!results.length) return;
				setCursor((active + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
			} else if (event.key === "Enter") {
				event.preventDefault();
				const entry = results[active];
				if (entry) choose(entry);
			} else if (event.key === "Escape") {
				event.preventDefault();
				onClose();
			}
		}} />
		<div ref={list} id={listId} className="quick-open-results" role="listbox" aria-label="一致するファイル" aria-busy={busy}>
			{results.map((entry, index) => <button key={entry.path} id={`${listId}-${index}`} type="button" role="option" aria-selected={index === active} onPointerMove={() => setCursor(index)} onClick={() => choose(entry)}>
				<span className="quick-open-name">{entry.name}</span>
				<span className="quick-open-path">{entry.path}</span>
			</button>)}
			<Presence show={!busy && !error && !!query.trim() && results.length === 0}><p className="quick-open-empty">一致するファイルはありません。</p></Presence>
			<Presence show={!!error}><p className="quick-open-empty error" role="alert">{error}</p></Presence>
		</div>
	</dialog>;
}
