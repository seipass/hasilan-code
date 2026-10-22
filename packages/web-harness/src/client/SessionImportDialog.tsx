import type { ThinkingLevel } from "@hasilan-code/pi-agent-core";
import { useEffect, useId, useRef, useState } from "react";
import { SESSION_IMPORT_SOURCES, type SessionDiscovery, type SessionImportPreview, type SessionImportSource } from "../shared/session-import.ts";
import { api, command, errorMessage } from "./api.ts";
import type { Model, SessionSummary, Workspace } from "./types.ts";
import "./SessionImportDialog.css";

export function SessionImportDialog({ workspaces, workspaceId, model, thinkingLevel, onClose, onImported, beforeImport }: {
	workspaces: Workspace[];
	workspaceId?: string;
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	onClose: () => void;
	onImported: (session: SessionSummary, workspace: Workspace) => void;
	beforeImport: (workspaceId?: string) => boolean;
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
	const [destination, setDestination] = useState(workspaceId ?? "source");
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
		void api<SessionDiscovery>("/api/session-imports/discover", { method: "POST", body: JSON.stringify({ source, ...(requestPath ? { path: requestPath } : {}) }), signal: controller.signal })
			.then((result) => { if (!controller.signal.aborted) setDiscovery(result); })
			.catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
			.finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, [source, requestPath, attempt]);
	useEffect(() => {
		setPreview(undefined); setPreviewError(undefined);
		if (!candidateId) { setPreviewLoading(false); return; }
		const controller = new AbortController();
		setPreviewLoading(true);
		void api<SessionImportPreview>("/api/session-imports/preview", { method: "POST", body: JSON.stringify({ candidateId }), signal: controller.signal })
			.then((result) => { if (!controller.signal.aborted) setPreview(result); })
			.catch((reason: unknown) => { if (!controller.signal.aborted) setPreviewError(errorMessage(reason)); })
			.finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
		return () => controller.abort();
	}, [candidateId, previewAttempt]);
	const candidates = discovery?.candidates.filter((entry) => `${entry.title} ${entry.cwd ?? ""} ${entry.sourceSessionId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
	async function importSession() {
		if (!preview || busy || !beforeImport(destination === "source" ? undefined : destination)) return;
		setBusy(true); setPreviewError(undefined);
		try {
			const result = await command<{ session: SessionSummary; workspace: Workspace }>("/api/session-imports", {
				candidateId: preview.candidateId, revision: preview.revision,
				...(destination === "source" ? {} : { workspaceId: destination }),
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
		<header className="session-import-heading"><div><h2 id={titleId}>セッションを引き継ぐ</h2><p>履歴を新しい会話にコピーします。元のデータは変更しません。</p></div><button type="button" disabled={busy} onClick={onClose} aria-label="セッション引き継ぎを閉じる">閉じる</button></header>
		<form className="session-import-source" onSubmit={(event) => { event.preventDefault(); setRequestPath(path.trim()); setAttempt((value) => value + 1); }}>
			<label>ハーネス<select value={source} disabled={busy} onChange={(event) => { setSource(event.target.value as SessionImportSource); setPath(""); setRequestPath(""); setQuery(""); }}>{SESSION_IMPORT_SOURCES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
			<label>保存先<input value={path} disabled={busy} onChange={(event) => setPath(event.target.value)} placeholder="自動検出 · フォルダーまたは履歴ファイルの絶対パス" /></label>
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
					{!loading && !error && candidates.length === 0 && <p>{query ? "一致するセッションはありません。" : "セッションが見つかりません。保存先を指定して再検索できます。"}</p>}
				</div>
			</section>
			<section className="session-import-preview" aria-label="引き継ぐ履歴のプレビュー" aria-busy={previewLoading}>
				{previewLoading && <p role="status">履歴を読み込んでいます…</p>}
				{!previewLoading && !candidateId && <p className="session-import-empty">引き継ぐセッションを選択してください。</p>}
				{preview && <><h3>{preview.title}</h3><p className="fine-print">全{preview.messageCount}件を引き継ぎます。プレビューは直近12件、各4000文字まで表示します。</p>{preview.warnings.map((warning) => <p className="session-import-warning" key={warning}>{warning}</p>)}{preview.messages.map((message, index) => <article className="session-import-message" key={`${preview.candidateId}-${index}`}><span>{message.role === "user" ? "ユーザー" : message.role === "assistant" ? "AI" : "参照履歴"}</span><pre>{message.text}</pre></article>)}</>}
				{previewError && <div className="session-import-error" role="alert"><p>{previewError}</p>{candidateId && <button type="button" disabled={busy} onClick={() => setPreviewAttempt((value) => value + 1)}>プレビューを再読み込み</button>}</div>}
			</section>
		</div>
		<footer className="session-import-actions"><label>引き継ぎ先<select value={destination} disabled={busy} onChange={(event) => setDestination(event.target.value)}><option value="source" disabled={!preview?.cwd}>元の作業フォルダー{preview?.cwd ? ` · ${preview.cwd}` : "（未記録）"}</option>{workspaces.map((entry) => <option key={entry.workspaceId} value={entry.workspaceId}>{entry.path}</option>)}</select></label><button type="button" disabled={busy || !preview || previewLoading || (destination === "source" && !preview.cwd)} onClick={() => { void importSession(); }}>{busy ? "引き継ぎ中…" : "このセッションを引き継ぐ"}</button></footer>
		<p className="session-import-note">ツールの実行記録は参照用の履歴として引き継ぎます。続きの実行には現在選択中のモデルを使います。</p>
	</dialog>;
}
