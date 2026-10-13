import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "./api.ts";
import { Content, record } from "./Content.tsx";
import { RUN_LABELS } from "./TeamPane.tsx";
import { ToolCard } from "./ToolInspector.tsx";
import type { PendingInputAction, SessionDetail } from "./types.ts";

export function ChatPane({ session, workspacePath, contextWindow, connected, modelSetup, draftKey, modelControl, onSend, onPendingInputAction, onFile, onStop, onParent, onModelSelect, onProviderSettings }: {
	session?: SessionDetail;
	workspacePath?: string;
	contextWindow?: number;
	connected: boolean;
	modelSetup?: "selection" | "authentication";
	draftKey: string;
	modelControl: ReactNode;
	onSend: (text: string, mode: "prompt" | "steer" | "followUp") => Promise<{ runId: string; disposition: "queued" | "started" }>;
	onPendingInputAction: (inputId: string, action: PendingInputAction) => Promise<void>;
	onFile: (path: string, line?: number) => void;
	onStop: () => void;
	onParent: (sessionId: string) => void;
	onModelSelect: () => void;
	onProviderSettings: () => void;
}) {
	const [text, setText] = useState(() => { try { return localStorage.getItem(`pi-web-draft:${draftKey}`) ?? ""; } catch { return ""; } });
	const [mode, setMode] = useState<"steer" | "followUp">("followUp");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [editingInput, setEditingInput] = useState<{ inputId: string; text: string }>();
	const [mutatingInputId, setMutatingInputId] = useState<string>();
	const [nearBottom, setNearBottom] = useState(true);
	const scroller = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const atBottom = useRef(true);
	const busy = session?.currentRun !== undefined;
	const latestRunFallback = session?.messages.length === 0 && session.latestRun?.inputKind !== "context" ? session.latestRun : undefined;
	const empty = !session || (session.messages.length === 0 && !latestRunFallback);
	useEffect(() => {
		try { if (text) localStorage.setItem(`pi-web-draft:${draftKey}`, text); else localStorage.removeItem(`pi-web-draft:${draftKey}`); } catch { /* Drafting remains available without browser storage. */ }
	}, [draftKey, text]);
	useEffect(() => {
		if (atBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
	}, [session?.messages, session?.toolCalls]);
	useEffect(() => {
		if (input.current) { input.current.style.height = "auto"; input.current.style.height = `${Math.min(input.current.scrollHeight, 220)}px`; }
	}, [text]);
	async function submit() {
		if (!text.trim() || sending) return;
		setSending(true); setError(undefined); setNotice(undefined);
		const submitted = text;
		try {
			const result = await onSend(submitted, busy ? mode : "prompt");
			setText((current) => current === submitted ? "" : current);
			try { localStorage.removeItem(`pi-web-draft:${draftKey}`); } catch { /* Storage is optional. */ }
			if (busy) setNotice(result.disposition === "queued" ? "追加の指示を予約しました。" : "追加の指示を送信しました。");
			atBottom.current = true; setNearBottom(true);
		} catch (reason) { setError(errorMessage(reason)); }
		finally { setSending(false); }
	}

	async function mutatePendingInput(inputId: string, action: PendingInputAction) {
		if (mutatingInputId) return;
		setError(undefined);
		setMutatingInputId(inputId);
		try {
			await onPendingInputAction(inputId, action);
			setEditingInput(undefined);
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setMutatingInputId(undefined);
		}
	}

	const latestError = session?.latestRun?.status === "failed" ? session.latestRun.error : undefined;
	const usage = session?.contextUsage;
	const contextLimit = usage?.contextWindow ?? contextWindow;
	const contextTokens = usage?.tokens;
	const compactTokens = (value: number) => new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 }).format(value);
	const hasContextLimit = contextLimit !== undefined && contextLimit > 0;
	const pendingInputs = session?.pendingInput.filter((input) => !input.fromAgentId && !input.completionRunId) ?? [];
	return <section className={`chat-pane ${empty ? "is-empty" : "has-messages"}`} aria-label="会話">
		{session?.parentSessionId && <div className="child-banner">この会話はチームエージェントの作業です。<button className="text-link" onClick={() => { if (session.parentSessionId) onParent(session.parentSessionId); }}>親の会話に戻る</button></div>}
		{session?.availability === "missing" && <div className="error" role="alert">保存された会話ファイルが見つかりません。新しい会話を開始してください。</div>}
		{!empty && <div className="conversation" ref={scroller} onScroll={() => { const element = scroller.current; if (element) { const following = element.scrollHeight - element.scrollTop - element.clientHeight < 80; atBottom.current = following; setNearBottom(following); } }}>
			<div className="conversation-content">{latestRunFallback && <article className="message role-user"><div className="message-content"><Content value={latestRunFallback.task} onFile={onFile} /></div></article>}{session?.messages.filter((message) => message.contextInjection || message.role !== "toolResult").map((message) => {
				const injection = message.contextInjection;
				if (injection) return <details key={message.messageId} className="message context-entry">
					<summary><span className="context-entry-label">コンテキスト</span><span className="context-entry-agent">{injection.source.agentName}</span><span className={`badge status-${injection.source.status}`}>{RUN_LABELS[injection.source.status]}</span></summary>
					<div className="context-entry-body">
						<div className="message-content"><Content value={injection.content} onFile={onFile} /></div>
						<dl className="context-entry-source">
							<dt>通知元</dt><dd>サブエージェントの完了通知</dd>
							<dt>エージェント ID</dt><dd><code>{injection.source.agentId}</code></dd>
							<dt>実行 ID</dt><dd><code>{injection.source.runId}</code></dd>
							<dt>コンテキスト ID</dt><dd><code>{injection.injectionId}</code></dd>
						</dl>
					</div>
				</details>;
				const parts = Array.isArray(message.content) ? message.content : [];
				const calls = parts.filter((part: unknown) => record(part) && part.type === "toolCall");
				const content = calls.length ? parts.filter((part: unknown) => !record(part) || part.type !== "toolCall") : message.content;
				return <article key={message.messageId} className={`message role-${message.role} ${message.partial ? "partial" : ""}`}>{message.role !== "assistant" && message.role !== "user" && <div className="message-label">{message.role}</div>}<div className="message-content"><Content value={content} onFile={onFile} />{calls.map((part: unknown, index) => { const tool = record(part) ? session.toolCalls.find((entry) => entry.callId === part.id) : undefined; return tool ? <ToolCard key={tool.key} tool={tool} onFile={onFile} /> : <p key={index} className="tool-preparing">{record(part) && typeof part.name === "string" ? part.name : "ツール"} を準備中…</p>; })}{message.partial && <span className="streaming-dot" aria-label="応答中" />}</div></article>;
			})}{latestError && <div className="run-error" role="alert"><strong>応答を取得できませんでした</strong><details><summary>エラーの詳細</summary><pre>{latestError}</pre></details></div>}</div>
		</div>}
		{!empty && !nearBottom && <button className="back-to-bottom" onClick={() => { if (scroller.current) scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); atBottom.current = true; setNearBottom(true); }}>最新のメッセージへ ↓</button>}
		<div className="composer-area">{session?.currentRun && <div className="run-progress" role="status"><span className="activity-dot" /><span>{RUN_LABELS[session.currentRun.status]}</span></div>}
			{pendingInputs.length > 0 && <div className="pending-input-list" role="list" aria-label="予約中の追加指示">
				{pendingInputs.map((pendingInput) => {
					const editing = editingInput?.inputId === pendingInput.inputId;
					const disabled =
						!connected ||
						session?.availability === "missing" ||
						!pendingInput.manageable ||
						mutatingInputId !== undefined;
					return <div className={`pending-input-row${pendingInput.manageable ? "" : " unavailable"}`} role="listitem" key={pendingInput.inputId}>
						<div className="pending-input-content">
							<span className="pending-input-mode">{pendingInput.mode === "followUp" ? "完了後に続ける" : "実行中に指示"}</span>
							{editing
								? <textarea className="pending-input-edit" aria-label="追加指示を編集" value={editingInput?.text ?? ""} rows={2} onChange={(event) => setEditingInput((current) => current?.inputId === pendingInput.inputId ? { ...current, text: event.target.value } : current)} />
								: <p className="pending-input-text">{pendingInput.text}</p>}
						</div>
						<div className="pending-input-actions">
							{editing
								? <>
									<button type="button" aria-label="変更を保存" title="変更を保存" disabled={disabled || !(editingInput?.text.trim())} onClick={() => { const text = editingInput?.text ?? ""; void mutatePendingInput(pendingInput.inputId, { type: "edit", text }); }}><span aria-hidden="true">✓</span></button>
									<button type="button" aria-label="編集をキャンセル" title="編集をキャンセル" disabled={mutatingInputId !== undefined} onClick={() => setEditingInput(undefined)}><span aria-hidden="true">×</span></button>
								</>
								: <>
									{pendingInput.mode === "followUp" && <button type="button" aria-label="すぐに送信" title="すぐに送信" disabled={disabled} onClick={() => { void mutatePendingInput(pendingInput.inputId, { type: "sendNow" }); }}><span aria-hidden="true">↑</span></button>}
									<button type="button" aria-label="追加指示を編集" title="追加指示を編集" disabled={disabled} onClick={() => { setError(undefined); setEditingInput({ inputId: pendingInput.inputId, text: pendingInput.text }); }}><span aria-hidden="true">✎</span></button>
									<button type="button" aria-label="追加指示を削除" title="追加指示を削除" disabled={disabled} onClick={() => { void mutatePendingInput(pendingInput.inputId, { type: "delete" }); }}><span aria-hidden="true">×</span></button>
								</>}
						</div>
					</div>;
				})}
			</div>}
			{empty && <div className="composer-heading"><span className="composer-identity"><img src="/icon.svg" alt="" />Hasilan Code</span>{workspacePath && <code className="composer-workspace" title={workspacePath}>{workspacePath}</code>}</div>}
			{notice && <div className="composer-notice" role="status">{notice}</div>}
			<form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
				<label className="sr-only" htmlFor="message">メッセージ</label>
				<div className="composer-input-row">
					<textarea ref={input} id="message" aria-label="メッセージ" value={text} onChange={(event) => setText(event.target.value)} placeholder="メッセージを入力…" rows={3} disabled={sending || session?.availability === "missing"} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
				</div>
				<div className="composer-toolbar">
					<div className="composer-context">{modelControl}</div>
					<div className="composer-delivery">
						{busy && <label><span className="sr-only">追加指示の送信方法</span><select aria-label="追加指示の送信方法" value={mode} onChange={(event) => setMode(event.target.value as "steer" | "followUp")}><option value="followUp">完了後に続ける</option><option value="steer">実行中に指示</option></select></label>}
						{hasContextLimit && <div className="composer-usage"><span className="context-usage" aria-label={`コンテキスト使用量 ${contextTokens == null ? "未計測" : `${contextTokens.toLocaleString("ja-JP")} トークン`} / ${contextLimit.toLocaleString("ja-JP")} トークン`}>コンテキスト {contextTokens == null ? "—" : compactTokens(contextTokens)} / {compactTokens(contextLimit)}{usage?.percent != null ? ` (${Math.round(usage.percent)}%)` : ""}</span></div>}
						{busy && !text.trim() ? <button className="stop-button" type="button" aria-label="実行を停止" onClick={onStop}><span aria-hidden="true">■</span></button> : <button className="send-button" type="submit" aria-label={sending ? "送信中" : "送信"} title="Ctrl / Cmd + Enter で送信" disabled={!connected || sending || !text.trim() || session?.availability === "missing"}>{sending ? "…" : "↑"}</button>}
					</div>
				</div>
			</form>
			{modelSetup && <div className="composer-caption"><button className="text-link" onClick={modelSetup === "authentication" ? onProviderSettings : onModelSelect}>{modelSetup === "authentication" ? "プロバイダーの認証を設定してください" : "モデルを選択してください"}</button></div>}
			{error && <p className="composer-error" role="alert">{error}</p>}
		</div>
	</section>;
}
