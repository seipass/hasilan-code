import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "./api.ts";
import { CommandPicker } from "./CommandPicker.tsx";
import { Conversation } from "./Conversation.tsx";
import { COMPOSER_COMMANDS } from "./slash-command.ts";
import type { PendingInputAction, SessionDetail } from "./types.ts";
import { UsagePanel } from "./UsagePanel.tsx";

export function ChatPane({ session, workspacePath, contextWindow, connected, modelSetup, draftKey, modelControl, goalControl, surface, draftInsertion, onDraftInserted, onSend, onPendingInputAction, onFile, onStop, onParent, onModelSelect, onProviderSettings, onLoadOlder, historyLoading, historyError }: {
	session?: SessionDetail;
	workspacePath?: string;
	contextWindow?: number;
	connected: boolean;
	modelSetup?: "selection" | "authentication";
	draftKey: string;
	modelControl: ReactNode;
	goalControl: ReactNode;
	surface?: boolean;
	draftInsertion?: { id: string; text: string };
	onDraftInserted: () => void;
	onSend: (text: string, mode: "prompt" | "steer" | "followUp") => Promise<{ disposition?: "queued" | "started"; notice?: string }>;
	onPendingInputAction: (inputId: string, action: PendingInputAction) => Promise<void>;
	onFile: (path: string, line?: number) => void;
	onStop: () => void;
	onParent: (sessionId: string) => void;
	onModelSelect: () => void;
	onProviderSettings: () => void;
	onLoadOlder?: () => Promise<void>;
	historyLoading?: boolean;
	historyError?: string;
}) {
	const [text, setText] = useState(() => { try { return localStorage.getItem(`pi-web-draft:${draftKey}`) ?? ""; } catch { return ""; } });
	const [mode, setMode] = useState<"steer" | "followUp">("followUp");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [commandIndex, setCommandIndex] = useState(0);
	const [pickerDismissed, setPickerDismissed] = useState(false);
	const pickerId = useId();
	const [editingInput, setEditingInput] = useState<{ inputId: string; text: string }>();
	const [mutatingInputId, setMutatingInputId] = useState<string>();
	const [followRequest, setFollowRequest] = useState(0);
	const input = useRef<HTMLTextAreaElement>(null);
	const inputMotion = useRef<Animation | undefined>(undefined);
	const submitting = useRef(false);
	const insertedDraft = useRef<string | undefined>(undefined);
	const slashInput = text.trimStart().startsWith("/");
	const commandPrefix = text.trimStart().split(/\s/, 1)[0];
	const suggestions = COMPOSER_COMMANDS.filter((entry) => entry.command.startsWith(commandPrefix));
	const pickerOpen = slashInput && !/\s/.test(text.trimStart()) && !pickerDismissed;
	const activeCommand = Math.min(commandIndex, Math.max(0, suggestions.length - 1));
	function chooseCommand(command: string) {
		setText(`${command}${command === "/hyakki" || command === "/goal" ? " " : ""}`);
		setPickerDismissed(true);
		input.current?.focus();
	}
	useEffect(() => {
		if (!draftInsertion || insertedDraft.current === draftInsertion.id) return;
		insertedDraft.current = draftInsertion.id;
		setText((current) => {
			if (!current.trim()) return draftInsertion.text;
			// Keep a leading command first when attaching a design to an existing draft.
			if (draftInsertion.text.startsWith("/hyakki ")) {
				return `/hyakki ${current.replace(/^\/hyakki\s+/, "")}\n\n${draftInsertion.text.slice("/hyakki ".length)}`;
			}
			return `${current}\n\n${draftInsertion.text}`;
		});
		onDraftInserted();
		input.current?.focus();
	}, [draftInsertion, onDraftInserted]);
	const busy = session?.currentRun !== undefined;
	const latestRunFallback = session?.messages.length === 0 && session.latestRun?.inputKind !== "context" ? session.latestRun : undefined;
	const empty = !session || (session.messages.length === 0 && !latestRunFallback);
	useEffect(() => {
		try { if (text) localStorage.setItem(`pi-web-draft:${draftKey}`, text); else localStorage.removeItem(`pi-web-draft:${draftKey}`); } catch { /* Drafting remains available without browser storage. */ }
	}, [draftKey, text]);
	useLayoutEffect(() => {
		const element = input.current;
		if (!element) return;
		const previousHeight = element.getBoundingClientRect().height;
		inputMotion.current?.cancel();
		element.style.overflowY = "hidden";
		element.style.height = "auto";
		const overflow = element.scrollHeight > 220 ? "auto" : "hidden";
		const height = Math.max(70, Math.min(element.scrollHeight, 220));
		element.style.height = `${height}px`;
		if (previousHeight !== height && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			const animation = element.animate([{ height: `${previousHeight}px` }, { height: `${height}px` }], { duration: 180, easing: "cubic-bezier(.2, .75, .25, 1)" });
			inputMotion.current = animation;
			animation.onfinish = () => { element.style.overflowY = overflow; inputMotion.current = undefined; };
		} else element.style.overflowY = overflow;
	}, [text]);
	useEffect(() => () => inputMotion.current?.cancel(), []);
	async function submit() {
		if (!text.trim() || submitting.current) return;
		submitting.current = true;
		setSending(true); setError(undefined); setNotice(undefined);
		const submitted = text;
		try {
			const result = await onSend(submitted, busy ? mode : "prompt");
			setText((current) => current === submitted ? "" : current);
			if (result.notice) setNotice(result.notice);
			else if (busy && result.disposition) setNotice(result.disposition === "queued" ? "追加の指示を予約しました。" : "追加の指示を送信しました。");
			setFollowRequest((value) => value + 1);
		} catch (reason) { setError(errorMessage(reason)); }
		finally { submitting.current = false; setSending(false); }
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
	return <section className={`chat-pane ${surface ? "has-surface" : empty ? "is-empty" : "has-messages"}`} aria-label="会話">
		{session?.parentSessionId && <div className="child-banner">この会話はチームエージェントの作業です。<button className="text-link" onClick={() => { if (session.parentSessionId) onParent(session.parentSessionId); }}>親の会話に戻る</button></div>}
		{session?.availability === "missing" && <div className="error" role="alert">保存された会話ファイルが見つかりません。新しい会話を開始してください。</div>}
		{!surface && !empty && session && <Conversation messages={session.messages} tools={session.toolCalls} history={session.history} loading={historyLoading} error={historyError} onLoadOlder={onLoadOlder} onFile={onFile} followRequest={followRequest} fallback={latestRunFallback?.task} latestError={latestError} />}
		<div className="composer-area">
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
			{!surface && empty && <div className="composer-heading"><span className="composer-identity"><img src="/icon.svg" alt="" />Hasilan Code</span>{workspacePath && <code className="composer-workspace" title={workspacePath}>{workspacePath}</code>}</div>}
			{notice && <div className="composer-notice" role="status"><span>{notice}</span><button type="button" aria-label="通知を閉じる" title="通知を閉じる" onClick={() => setNotice(undefined)}>×</button></div>}
			{goalControl}
			<form className="composer command-picker-anchor" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
				{pickerOpen && <CommandPicker id={pickerId} commands={suggestions} activeIndex={activeCommand} onActive={setCommandIndex} onChoose={chooseCommand} />}
				<label className="sr-only" htmlFor="message">メッセージ</label>
				<div className="composer-input-row">
					<textarea ref={input} id="message" role="combobox" aria-label="メッセージ" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={pickerOpen} aria-controls={pickerOpen ? pickerId : undefined} aria-activedescendant={pickerOpen && suggestions.length ? `${pickerId}-${activeCommand}` : undefined} value={text} onChange={(event) => { setText(event.target.value); setCommandIndex(0); setPickerDismissed(false); }} placeholder="メッセージ、または / でコマンドを入力…" rows={3} disabled={sending} onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (pickerOpen && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPickerDismissed(true); return; }
						if (pickerOpen && suggestions.length && !event.ctrlKey && !event.metaKey && !event.altKey) {
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								setCommandIndex((activeCommand + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
								return;
							}
							if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); chooseCommand(suggestions[activeCommand].command); return; }
						}
						if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); }
					}} />
				</div>
				<div className="composer-toolbar">
					<div className="composer-context">{modelControl}</div>
					<div className="composer-delivery">
						{busy && <label><span className="sr-only">追加指示の送信方法</span><select aria-label="追加指示の送信方法" value={mode} onChange={(event) => setMode(event.target.value as "steer" | "followUp")}><option value="followUp">完了後に続ける</option><option value="steer">実行中に指示</option></select></label>}
						{hasContextLimit && <UsagePanel title="この会話の使用量" groups={session ? [{ id: session.sessionId, label: session.parentSessionId ? "子AI" : "親AI", usage: session.usage }] : []} trigger={<span className="context-usage">コンテキスト {contextTokens == null ? "—" : compactTokens(contextTokens)} / {compactTokens(contextLimit)}{usage?.percent != null ? ` (${Math.round(usage.percent)}%)` : ""}</span>} />}
						{busy && !text.trim() ? <button className="stop-button" type="button" aria-label="実行を停止" onClick={onStop}><span aria-hidden="true">■</span></button> : <button className="send-button" type="submit" aria-label={sending ? "送信中" : "送信"} title="Ctrl / Cmd + Enter で送信" disabled={sending || !text.trim() || !slashInput && (!connected || session?.availability === "missing")}>{sending ? "…" : "↑"}</button>}
					</div>
				</div>
			</form>
			{modelSetup && <div className="composer-caption"><button className="text-link" onClick={modelSetup === "authentication" ? onProviderSettings : onModelSelect}>{modelSetup === "authentication" ? "プロバイダーの認証を設定してください" : "モデルを選択してください"}</button></div>}
			{error && <p className="composer-error" role="alert">{error}</p>}
		</div>
	</section>;
}
