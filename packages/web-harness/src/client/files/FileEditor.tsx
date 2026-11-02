import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api.ts";
import "./FileEditor.css";

interface Draft { text: string; saved: string; revision: string; newline: "\n" | "\r\n" }
const drafts = new Map<string, Draft>();

window.addEventListener("beforeunload", (event) => {
	if ([...drafts.values()].some((draft) => draft.text !== draft.saved)) event.preventDefault();
});

export function FileEditor({ workspaceId, path, line }: { workspaceId: string; path: string; line?: number }) {
	const key = JSON.stringify([workspaceId, path]);
	const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/file-edit?path=${encodeURIComponent(path)}`;
	const [draft, setDraft] = useState<Draft | undefined>(() => drafts.get(key));
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const input = useRef<HTMLTextAreaElement>(null);
	const numbers = useRef<HTMLDivElement>(null);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	useEffect(() => {
		const controller = new AbortController();
		setError(undefined);
		const existing = drafts.get(key);
		const unsaved = existing && existing.text !== existing.saved ? existing : undefined;
		setDraft(unsaved);
		if (!unsaved) void api<{ text: string; revision: string }>(endpoint, { signal: controller.signal }).then(({ text, revision }) => {
			const normalized = text.replace(/\r\n/g, "\n");
			const value: Draft = { text: normalized, saved: normalized, revision, newline: text.includes("\r\n") ? "\r\n" : "\n" };
			drafts.set(key, value); setDraft(value);
		}).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, [endpoint, key]);
	useEffect(() => {
		if (!draft || !line || !input.current) return;
		const offset = draft.text.split("\n").slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0);
		input.current.setSelectionRange(offset, offset);
	}, [key, !!draft, line]);
	async function save() {
		const current = draftRef.current;
		if (!current || saving || current.text === current.saved) return;
		setSaving(true); setError(undefined);
		try {
			const { revision } = await api<{ revision: string }>(endpoint, { method: "PUT", body: JSON.stringify({ revision: current.revision, text: current.text.replace(/\n/g, current.newline) }) });
			const latest = drafts.get(key);
			if (latest) { const next = { ...latest, revision, saved: current.text }; drafts.set(key, next); setDraft(next); }
		} catch (reason) { setError(errorMessage(reason)); }
		finally { setSaving(false); }
	}
	return <div className="file-editor">
		<div className="file-editor-toolbar"><span role="status">{saving ? "保存中…" : !draft ? "読み込み中…" : draft.text !== draft.saved ? "未保存" : "保存済み"}</span><button type="button" disabled={!draft || saving || draft.text === draft.saved} onClick={() => { void save(); }}>保存</button></div>
		{error && <p className="files-message error" role="alert">{error}</p>}
		{draft && <div className="file-editor-body"><div className="file-editor-numbers" ref={numbers} aria-hidden="true">{Array.from({ length: draft.text.split("\n").length }, (_, index) => <div key={index}>{index + 1}</div>)}</div><textarea ref={input} aria-label={`${path} を編集`} value={draft.text} spellCheck={false} wrap="off" onChange={(event) => { const next = { ...draft, text: event.target.value }; drafts.set(key, next); setDraft(next); }} onScroll={(event) => { if (numbers.current) numbers.current.scrollTop = event.currentTarget.scrollTop; }} onKeyDown={(event) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
			else if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); const target = event.currentTarget; const start = target.selectionStart; const next = { ...draft, text: `${draft.text.slice(0, start)}\t${draft.text.slice(target.selectionEnd)}` }; drafts.set(key, next); setDraft(next); requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 1; }); }
		}} /></div>}
	</div>;
}
