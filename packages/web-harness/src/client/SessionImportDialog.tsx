import type { ThinkingLevel } from "@hasilan-code/pi-agent-core";
import { useEffect, useId, useRef, useState } from "react";
import { SESSION_IMPORT_SOURCES, type SessionDiscovery, type SessionImportPreview, type SessionImportSource } from "../shared/session-import.ts";
import { api, command, errorMessage } from "./api.ts";
import { Content } from "./Content.tsx";
import type { Model, SessionSummary, Workspace } from "./types.ts";
import "./SessionImportDialog.css";

export function SessionImportDialog({ workspace, model, thinkingLevel, onClose, onImported, onFile }: {
	workspace: Workspace;
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	onClose: () => void;
	onImported: (session: SessionSummary, workspace: Workspace) => void;
	onFile: (path: string, line?: number) => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const [source, setSource] = useState<SessionImportSource>("codex");
	const [path, setPath] = useState("");
	const [requestPath, setRequestPath] = useState("");
	const [attempt, setAttempt] = useState(0);
	const [discovery, setDiscovery] = useState<SessionDiscovery>();
	const [candidateId, setCandidateId] = useState<string>();
	const [preview, setPreview] = useState<SessionImportPreview>();
	const [previewAttempt, setPreviewAttempt] = useState(0);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [previewError, setPreviewError] = useState<string>();
	useEffect(() => {
		const element = dialog.current;
		const previous = document.activeElement;
		element?.showModal();
		return () => { element?.close(); if (previous instanceof HTMLElement) previous.focus(); };
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true); setDiscovery(undefined); setCandidateId(undefined); setError(undefined);
		void api<SessionDiscovery>("/api/session-imports/discover", { method: "POST", body: JSON.stringify({ source, workspaceId: workspace.workspaceId, ...(requestPath ? { path: requestPath } : {}) }), signal: controller.signal })
			.then((result) => { if (!controller.signal.aborted) setDiscovery(result); })
			.catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
			.finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, [source, requestPath, attempt, workspace.workspaceId]);
	useEffect(() => {
		setPreview(undefined); setPreviewError(undefined);
		if (!candidateId) { setPreviewLoading(false); return; }
		const controller = new AbortController();
		setPreviewLoading(true);
		void api<SessionImportPreview>("/api/session-imports/preview", { method: "POST", body: JSON.stringify({ candidateId, workspaceId: workspace.workspaceId }), signal: controller.signal })
			.then((result) => { if (!controller.signal.aborted) setPreview(result); })
			.catch((reason: unknown) => { if (!controller.signal.aborted) setPreviewError(errorMessage(reason)); })
			.finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
		return () => controller.abort();
	}, [candidateId, previewAttempt, workspace.workspaceId]);
	const candidates = discovery?.candidates.filter((entry) => `${entry.title} ${entry.cwd ?? ""} ${entry.sourceSessionId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
	async function importSession() {
		if (!preview || busy) return;
		setBusy(true); setPreviewError(undefined);
		try {
			const result = await command<{ session: SessionSummary; workspace: Workspace }>("/api/session-imports", {
				candidateId: preview.candidateId, revision: preview.revision, workspaceId: workspace.workspaceId,
				...(model ? { model: { provider: model.provider, id: model.id } } : {}),
				...(thinkingLevel ? { thinkingLevel } : {}),
			});
			onImported(result.session, result.workspace);
		} catch (reason) { setPreviewError(errorMessage(reason)); }
		finally { setBusy(false); }
	}
	return <dialog ref={dialog} className="session-import-dialog" aria-labelledby={titleId} aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }} onClick={(event) => {
		if (event.target !== event.currentTarget || busy) return;
		const bounds = event.currentTarget.getBoundingClientRect();
		if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
	}}>
		<header className="session-import-heading"><div><h2 id={titleId}>セッションを引き継ぐ</h2><p>このワークスペースの履歴</p><code>{workspace.path}</code></div><button type="button" disabled={busy} onClick={onClose} aria-label="セッション引き継ぎを閉じる">閉じる</button></header>
		<form className="session-import-source" onSubmit={(event) => { event.preventDefault(); setRequestPath(path.trim()); setAttempt((value) => value + 1); }}>
			<label>ハーネス<select value={source} disabled={busy} onChange={(event) => { setSource(event.target.value as SessionImportSource); setPath(""); setRequestPath(""); setQuery(""); }}>{SESSION_IMPORT_SOURCES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
			<label>履歴ファイル<input value={path} disabled={busy} onChange={(event) => setPath(event.target.value)} placeholder="自動検出 · フォルダーまたは履歴ファイルの絶対パス" /></label>
			<button type="submit" disabled={busy || loading}>{loading ? "検索中…" : "再読み込み"}</button>
		</form>
		{discovery && <p className="session-import-paths">{discovery.paths.length ? discovery.paths.join(" · ") : "保存先を指定してください。"}</p>}
		{error && <p className="session-import-error" role="alert">{error}</p>}
		{discovery?.warnings.length ? <details className="session-import-warnings"><summary>読み込みについて（{discovery.warnings.length}件）</summary>{discovery.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details> : null}
		<div className="session-import-body">
			<section className="session-import-list" aria-label="引き継ぐセッション">
				<label><span className="sr-only">引き継ぐセッションを検索</span><input type="search" value={query} disabled={busy} placeholder="タイトル・フォルダー・IDで検索" onChange={(event) => setQuery(event.target.value)} /></label>
				<div className="session-import-candidates" role="listbox" aria-label="保存済みセッション" aria-busy={loading}>
					{candidates.map((entry) => <button key={entry.candidateId} type="button" role="option" aria-selected={entry.candidateId === candidateId} disabled={busy} onClick={() => setCandidateId(entry.candidateId)}><strong>{entry.title}</strong><span>{entry.cwd ?? entry.sourceSessionId}</span><time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleString()}</time></button>)}
					{loading && <p role="status">保存された履歴を検索しています…</p>}
					{!loading && !error && candidates.length === 0 && <p>{query ? "一致するセッションはありません。" : "このワークスペースのセッションはありません。履歴ファイルを指定して再検索できます。"}</p>}
				</div>
			</section>
			<section className="session-import-preview" aria-label="引き継ぐ履歴のプレビュー" aria-busy={previewLoading}>
				{previewLoading && <p role="status">履歴を読み込んでいます…</p>}
				{!previewLoading && !candidateId && <p className="session-import-empty">引き継ぐセッションを選択してください。</p>}
				{preview && <><h3>{preview.title}</h3><p className="fine-print">履歴{preview.messageCount}件を引き継ぎます。会話の直近12件を表示しています。</p>{preview.warnings.map((warning) => <p className="session-import-warning" key={warning}>{warning}</p>)}{preview.messages.map((message, index) => <article className="session-import-message" key={`${preview.candidateId}-${index}`}><span>{message.role === "user" ? "ユーザー" : "AI"}</span><div className="message-content"><Content value={message.text} onFile={(path, line) => { onClose(); onFile(path, line); }} /></div></article>)}</>}
				{previewError && <div className="session-import-error" role="alert"><p>{previewError}</p>{candidateId && <button type="button" disabled={busy} onClick={() => setPreviewAttempt((value) => value + 1)}>プレビューを再読み込み</button>}</div>}
			</section>
		</div>
		<footer className="session-import-actions"><button type="button" disabled={busy || !preview || previewLoading} onClick={() => { void importSession(); }}>{busy ? "引き継ぎ中…" : "このセッションを引き継ぐ"}</button></footer>
		<p className="session-import-note">ツールの実行記録は参照用の履歴として引き継ぎます。続きの実行には現在選択中のモデルを使います。</p>
	</dialog>;
}
