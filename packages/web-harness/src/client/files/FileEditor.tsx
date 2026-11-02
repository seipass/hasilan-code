import { acceptCompletion, completeAnyWord } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api.ts";
import "./FileEditor.css";

interface Draft { text: string; saved: string; revision: string; newline: "\n" | "\r\n" }
const drafts = new Map<string, Draft>();
const draftListeners = new Map<string, Set<(draft: Draft) => void>>();
function updateDraft(key: string, draft: Draft) {
	drafts.set(key, draft);
	for (const listener of draftListeners.get(key) ?? []) listener(draft);
}
const highlight = syntaxHighlighting(HighlightStyle.define([
	{ tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "#cba6f7" },
	{ tag: [tags.string, tags.special(tags.string)], color: "#a6e3a1" },
	{ tag: [tags.number, tags.bool, tags.null], color: "#fab387" },
	{ tag: [tags.typeName, tags.className, tags.function(tags.variableName)], color: "#89b4fa" },
	{ tag: [tags.propertyName, tags.attributeName, tags.tagName], color: "#94e2d5" },
	{ tag: [tags.comment, tags.meta], color: "#7f849c", fontStyle: "italic" },
]));

window.addEventListener("beforeunload", (event) => {
	if ([...drafts.values()].some((draft) => draft.text !== draft.saved)) event.preventDefault();
});

export function FileEditor({ workspaceId, path, line }: { workspaceId: string; path: string; line?: number }) {
	const key = JSON.stringify([workspaceId, path]);
	const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/file-edit?path=${encodeURIComponent(path)}`;
	const [draft, setDraft] = useState<Draft | undefined>(() => drafts.get(key));
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const host = useRef<HTMLDivElement>(null);
	const editor = useRef<EditorView | undefined>(undefined);
	const savingRef = useRef(false);
	const saveRef = useRef<() => void>(() => {});
	useEffect(() => {
		const listeners = draftListeners.get(key) ?? new Set<(draft: Draft) => void>();
		const receive = (next: Draft) => {
			setDraft(next);
			const view = editor.current;
			if (view && view.state.doc.toString() !== next.text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next.text } });
		};
		listeners.add(receive); draftListeners.set(key, listeners);
		return () => { listeners.delete(receive); if (!listeners.size) draftListeners.delete(key); };
	}, [key]);
	useEffect(() => {
		const controller = new AbortController();
		setError(undefined);
		const existing = drafts.get(key);
		const unsaved = existing && existing.text !== existing.saved ? existing : undefined;
		setDraft(unsaved);
		if (!unsaved) void api<{ text: string; revision: string }>(endpoint, { signal: controller.signal }).then(({ text, revision }) => {
			if (drafts.get(key) !== existing) { setDraft(drafts.get(key)); return; }
			const normalized = text.replace(/\r\n/g, "\n");
			const value: Draft = { text: normalized, saved: normalized, revision, newline: text.includes("\r\n") ? "\r\n" : "\n" };
			updateDraft(key, value);
		}).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, [endpoint, key]);
	async function save() {
		const current = drafts.get(key);
		if (!current || savingRef.current || current.text === current.saved) return;
		savingRef.current = true; setSaving(true); setError(undefined);
		try {
			const { revision } = await api<{ revision: string }>(endpoint, { method: "PUT", body: JSON.stringify({ revision: current.revision, text: current.text.replace(/\n/g, current.newline) }) });
			const latest = drafts.get(key);
			if (latest) updateDraft(key, { ...latest, revision, saved: current.text });
		} catch (reason) { setError(errorMessage(reason)); }
		finally { savingRef.current = false; setSaving(false); }
	}
	saveRef.current = () => { void save(); };
	useEffect(() => {
		const current = drafts.get(key);
		if (!draft || !current || !host.current) return;
		let disposed = false;
		const language = new Compartment();
		const view = new EditorView({
			parent: host.current,
			state: EditorState.create({ doc: current.text, extensions: [
				basicSetup,
				highlight,
				language.of([]),
				EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
				EditorView.contentAttributes.of({ "aria-label": `${path} を編集`, "aria-multiline": "true", spellcheck: "false" }),
				Prec.highest(keymap.of([{ key: "Mod-s", run: () => { saveRef.current(); return true; } }, { key: "Tab", run: acceptCompletion }, indentWithTab])),
				EditorView.updateListener.of((update) => {
					if (!update.docChanged) return;
					const previous = drafts.get(key);
					if (!previous) return;
					const text = update.state.doc.toString();
					if (text !== previous.text) updateDraft(key, { ...previous, text });
				}),
			] }),
		});
		editor.current = view;
		const description = LanguageDescription.matchFilename(languages, path.split(/[\\/]/).at(-1) ?? path);
		if (description) void description.load().then((support) => {
			if (!disposed) view.dispatch({ effects: language.reconfigure(support) });
		}).catch(() => { if (!disposed) setError("言語の読み込みに失敗しました。テキストは編集できます。"); });
		return () => { disposed = true; editor.current = undefined; view.destroy(); };
	}, [key, path, !!draft]);
	useEffect(() => {
		const view = editor.current;
		if (!view || !line) return;
		const position = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines)).from;
		view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
	}, [key, !!draft, line]);
	return <div className="file-editor">
		<div className="file-editor-toolbar"><span role="status">{saving ? "保存中…" : !draft ? "読み込み中…" : draft.text !== draft.saved ? "未保存" : "保存済み"}</span><button type="button" disabled={!draft || saving || draft.text === draft.saved} onClick={() => { void save(); }}>保存</button></div>
		{error && <p className="files-message error" role="alert">{error}</p>}
		{draft && <div className="file-editor-body" ref={host} />}
	</div>;
}
