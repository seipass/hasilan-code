import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "./api.ts";
import { Content, record } from "./Content.tsx";
import { RUN_LABELS } from "./TeamPane.tsx";
import { ToolCard } from "./ToolInspector.tsx";
import type { SessionDetail } from "./types.ts";

export function ChatPane({ session, connected, modelReady, draftKey, modelControl, folderControl, onSend, onFile, onStop, onParent, onSettings }: {
	session?: SessionDetail;
	connected: boolean;
	modelReady: boolean;
	draftKey: string;
	modelControl: ReactNode;
	folderControl: ReactNode;
	onSend: (text: string, mode: "prompt" | "steer" | "followUp") => Promise<{ runId: string; disposition: "queued" | "started" }>;
	onFile: (path: string, line?: number) => void;
	onStop: () => void;
	onParent: (sessionId: string) => void;
	onSettings: () => void;
}) {
	const [text, setText] = useState(() => { try { return localStorage.getItem(`pi-web-draft:${draftKey}`) ?? ""; } catch { return ""; } });
	const [mode, setMode] = useState<"steer" | "followUp">("followUp");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [nearBottom, setNearBottom] = useState(true);
	const scroller = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const atBottom = useRef(true);
	const busy = session?.currentRun !== undefined;
	const empty = !session || (session.messages.length === 0 && !session.latestRun);
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
	const latestError = session?.latestRun?.status === "failed" ? session.latestRun.error : undefined;
	return <section className={`chat-pane ${empty ? "is-empty" : "has-messages"}`} aria-label="会話">
		{session?.parentSessionId && <div className="child-banner">この会話はチームエージェントの作業です。<button className="text-link" onClick={() => { if (session.parentSessionId) onParent(session.parentSessionId); }}>親の会話に戻る</button></div>}
		{session?.availability === "missing" && <div className="error" role="alert">保存された会話ファイルが見つかりません。新しい会話を開始してください。</div>}
		{empty ? <div className="welcome-zone"><img className="welcome-brand" src="/icon.svg" alt="" /><span className="welcome-name">Hasilan Code</span><h1>何を進めましょうか？</h1><p>調べたいことや、実装したいことを入力してください。</p></div> : <div className="conversation" ref={scroller} onScroll={() => { const element = scroller.current; if (element) { const following = element.scrollHeight - element.scrollTop - element.clientHeight < 80; atBottom.current = following; setNearBottom(following); } }}>
			<div className="conversation-content">{session && session.messages.length === 0 && session.latestRun && <article className="message role-user"><div className="message-content"><Content value={session.latestRun.task} onFile={onFile} /></div></article>}{session?.messages.filter((message) => message.role !== "toolResult").map((message) => {
				const parts = Array.isArray(message.content) ? message.content : [];
				const calls = parts.filter((part: unknown) => record(part) && part.type === "toolCall");
				const content = calls.length ? parts.filter((part: unknown) => !record(part) || part.type !== "toolCall") : message.content;
				return <article key={message.messageId} className={`message role-${message.role} ${message.partial ? "partial" : ""}`}><div className="message-label">{message.role === "user" ? "あなた" : message.role === "assistant" ? "Hasilan Code" : message.role}</div><div className="message-content"><Content value={content} onFile={onFile} />{calls.map((part: unknown, index) => { const tool = record(part) ? session.toolCalls.find((entry) => entry.callId === part.id) : undefined; return tool ? <ToolCard key={tool.key} tool={tool} onFile={onFile} /> : <p key={index} className="tool-preparing">{record(part) && typeof part.name === "string" ? part.name : "ツール"} を準備中…</p>; })}{message.partial && <span className="streaming-dot" aria-label="応答中" />}</div></article>;
			})}{latestError && <div className="run-error" role="alert"><strong>応答を取得できませんでした</strong><p>接続設定を確認して、もう一度送信してください。</p><button className="text-link" onClick={onSettings}>モデルと接続設定を確認</button><details><summary>エラーの詳細</summary><pre>{latestError}</pre></details></div>}</div>
		</div>}
		{!empty && !nearBottom && <button className="back-to-bottom" onClick={() => { if (scroller.current) scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); atBottom.current = true; setNearBottom(true); }}>最新のメッセージへ ↓</button>}
		<div className="composer-area">{session?.currentRun && <div className="run-progress" role="status"><span className="activity-dot" /><span>{RUN_LABELS[session.currentRun.status]}</span>{session.pendingInput.length > 0 && <span className="muted">追加指示 {session.pendingInput.length} 件</span>}</div>}
			<form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
				<label className="sr-only" htmlFor="message">メッセージ</label><textarea ref={input} id="message" aria-label="メッセージ" value={text} onChange={(event) => setText(event.target.value)} placeholder="メッセージを入力…" rows={3} disabled={sending || session?.availability === "missing"} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
				<div className="composer-toolbar"><div className="composer-context">{modelControl}{folderControl}</div><div className="composer-delivery">{busy && <label><span className="sr-only">追加指示の送信方法</span><select aria-label="追加指示の送信方法" value={mode} onChange={(event) => setMode(event.target.value as "steer" | "followUp")}><option value="followUp">完了後に続ける</option><option value="steer">実行中に指示</option></select></label>}{busy && !text.trim() ? <button className="stop-button" type="button" aria-label="実行を停止" onClick={onStop}><span aria-hidden="true">■</span></button> : <button className="send-button" type="submit" aria-label={sending ? "送信中" : "送信"} title="Ctrl / Cmd + Enter で送信" disabled={!connected || sending || !text.trim() || session?.availability === "missing"}>{sending ? "…" : "↑"}</button>}</div></div>
			</form>
			<div className="composer-caption">{!modelReady ? <button className="text-link" onClick={onSettings}>モデルを接続すると会話を始められます</button> : <span>Ctrl / Cmd + Enter で送信</span>}</div>
			{error && <p className="composer-error" role="alert">{error}</p>}{notice && <p className="muted" role="status">{notice}</p>}
		</div>
	</section>;
}
