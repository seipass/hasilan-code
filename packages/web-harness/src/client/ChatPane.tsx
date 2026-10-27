import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AttachmentUpload } from "../shared/attachments.ts";
import { errorMessage } from "./api.ts";
import { CommandPicker } from "./CommandPicker.tsx";
import { ComposerAttachments, useComposerAttachments } from "./ComposerAttachments.tsx";
import { Conversation } from "./Conversation.tsx";
import { MotionItems, Presence, useLayoutMotion } from "./Motion.tsx";
import { MotionSize } from "./MotionSwap.tsx";
import { COMPOSER_COMMANDS } from "./slash-command.ts";
import type { PendingInputAction, SessionDetail } from "./types.ts";
import { UsagePanel } from "./UsagePanel.tsx";
import { useComposerSize } from "./use-composer-size.ts";

export function ChatPane({ session, loading = false, workspacePath, contextWindow, connected, modelSetup, draftKey, modelControl, goalControl, surface, draftInsertion, onDraftInserted, onSend, onPendingInputAction, onFile, onStop, onParent, onModelSelect, onProviderSettings, onLoadOlder, historyLoading, historyError }: {
	session?: SessionDetail;
	loading?: boolean;
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
	onSend: (text: string, mode: "prompt" | "steer" | "followUp", attachments: AttachmentUpload[]) => Promise<{ disposition?: "queued" | "started"; notice?: string }>;
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
	const { attachments, reading, addFiles, remove } = useComposerAttachments(draftKey);
	const [dragging, setDragging] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const [commandIndex, setCommandIndex] = useState(0);
	const [pickerDismissed, setPickerDismissed] = useState(false);
	const pickerId = useId();
	const [editingInput, setEditingInput] = useState<{ inputId: string; text: string }>();
	const [mutatingInputId, setMutatingInputId] = useState<string>();
	const [followRequest, setFollowRequest] = useState(0);
	const input = useRef<HTMLTextAreaElement>(null);
	const pendingList = useRef<HTMLDivElement>(null);
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
	const empty = !loading && (!session || (session.messages.length === 0 && !latestRunFallback));
	useComposerSize(input, text);
	useEffect(() => {
		try { if (text) localStorage.setItem(`pi-web-draft:${draftKey}`, text); else localStorage.removeItem(`pi-web-draft:${draftKey}`); } catch { /* Drafting remains available without browser storage. */ }
	}, [draftKey, text]);
	async function submit() {
		if ((!text.trim() && !attachments.length) || reading || submitting.current) return;
		submitting.current = true;
		setSending(true); setError(undefined); setNotice(undefined);
		const submitted = text;
		const submittedAttachments = attachments;
		try {
			const result = await onSend(submitted, busy ? mode : "prompt", submittedAttachments.map(({ name, mimeType, data }) => ({ name, mimeType, data })));
			setText((current) => current === submitted ? "" : current);
			remove(submittedAttachments.map((attachment) => attachment.id));
			if (result.notice) setNotice(result.notice);
			else if (busy && result.disposition) setNotice(result.disposition === "queued" ? "追加の指示を予約しました。" : "追加の指示を送信しました。");
			setFollowRequest((value) => value + 1);
		} catch (reason) { setError(errorMessage(reason)); }
		finally { submitting.current = false; setSending(false); }
	}
	async function attach(files: File[]) {
		if (submitting.current) return;
		setError(undefined);
		try { await addFiles(files); input.current?.focus(); }
		catch (reason) { setError(errorMessage(reason)); }
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
	useLayoutMotion(pendingList, pendingInputs, true, true);
	return <section className={`chat-pane ${surface ? "has-surface" : empty ? "is-empty" : "has-messages"}`} aria-label="会話">
		{loading && <div className="conversation conversation-loading" role="status">会話を読み込んでいます…</div>}
		<Presence show={!!session?.parentSessionId} collapse><div className="child-banner">この会話はチームエージェントの作業です。<button className="text-link" onClick={() => { if (session?.parentSessionId) onParent(session.parentSessionId); }}>親の会話に戻る</button></div></Presence>
		<Presence show={session?.availability === "missing"} collapse><div className="error" role="alert">保存された会話ファイルが見つかりません。新しい会話を開始してください。</div></Presence>
		{!surface && !empty && session && <Conversation messages={session.messages} tools={session.toolCalls} activeRunId={session.currentRun?.runId} history={session.history} loading={historyLoading} error={historyError} onLoadOlder={onLoadOlder} onFile={onFile} followRequest={followRequest} fallback={latestRunFallback?.task} latestError={latestError} />}
		<div className="composer-area">
			<Presence show={pendingInputs.length > 0} collapse><div ref={pendingList} className="pending-input-list" role="list" aria-label="予約中の追加指示">
				<MotionItems items={pendingInputs} itemKey={(pendingInput) => pendingInput.inputId}>{(pendingInput) => {
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
								? <textarea className="pending-input-edit motion-label" aria-label="追加指示を編集" value={editingInput?.text ?? ""} rows={2} onChange={(event) => setEditingInput((current) => current?.inputId === pendingInput.inputId ? { ...current, text: event.target.value } : current)} />
								: <p className="pending-input-text motion-label">{pendingInput.text}</p>}
							{!!pendingInput.attachments?.length && <div className="pending-input-attachments">{pendingInput.attachments.map((attachment, index) => <button type="button" className="text-link" key={`${attachment.path}:${index}`} onClick={() => onFile(attachment.path)}>{attachment.name}</button>)}</div>}
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
				}}</MotionItems>
			</div></Presence>
			<Presence show={!surface && empty} collapse><div className="composer-heading"><span className="composer-identity"><img src="/icon.svg" alt="" />Hasilan Code</span>{workspacePath && <code className="composer-workspace" title={workspacePath}>{workspacePath}</code>}</div></Presence>
			<Presence show={!!notice} collapse><div className="composer-notice" role="status"><span>{notice}</span><button type="button" aria-label="通知を閉じる" title="通知を閉じる" onClick={() => setNotice(undefined)}>×</button></div></Presence>
			<Presence show={!!goalControl}><div className="motion-contents">{goalControl}</div></Presence>
			<form className={`composer command-picker-anchor${dragging ? " is-dragging" : ""}`} aria-busy={sending || reading} onSubmit={(event) => { event.preventDefault(); void submit(); }} onDragOver={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault(); event.dataTransfer.dropEffect = sending || reading ? "none" : "copy"; setDragging(!sending && !reading);
			}} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault(); setDragging(false); void attach(Array.from(event.dataTransfer.files));
			}}>
				<Presence show={pickerOpen}><div className="motion-contents"><CommandPicker id={pickerId} commands={suggestions} activeIndex={activeCommand} onActive={setCommandIndex} onChoose={chooseCommand} /></div></Presence>
				<Presence show={attachments.length > 0} collapse><ComposerAttachments attachments={attachments} disabled={sending} onRemove={(id) => remove([id])} /></Presence>
				<input ref={fileInput} type="file" multiple hidden aria-label="添付ファイルを選択" disabled={sending || reading} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void attach(files); }} />
				<label className="sr-only" htmlFor="message">メッセージ</label>
				<div className="composer-input-row">
					<textarea ref={input} id="message" role="combobox" aria-label="メッセージ" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={pickerOpen} aria-controls={pickerOpen ? pickerId : undefined} aria-activedescendant={pickerOpen && suggestions.length ? `${pickerId}-${activeCommand}` : undefined} value={text} onChange={(event) => { setText(event.target.value); setCommandIndex(0); setPickerDismissed(false); }} placeholder="メッセージ、または / でコマンドを入力…" rows={2} disabled={sending} onKeyDown={(event) => {
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
					}} onPaste={(event) => {
						const files = Array.from(event.clipboardData.files);
						if (!files.length) return;
						event.preventDefault();
						const pasted = event.clipboardData.getData("text/plain");
						if (pasted) { const { selectionStart, selectionEnd } = event.currentTarget; setText((current) => current.slice(0, selectionStart) + pasted + current.slice(selectionEnd)); }
						void attach(files);
					}} />
				</div>
				<MotionSize><div className="composer-toolbar">
					<div className="composer-context"><button type="button" className="composer-attach-button" aria-label={reading ? "添付を読み込み中" : "ファイルを添付"} title="ファイルを添付（1ファイル10 MB、合計20 MBまで）" disabled={sending || reading} onClick={() => fileInput.current?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 11-8.4 8.4a5 5 0 0 1-7.1-7.1L13 3.8a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.4a1.6 1.6 0 0 1-2.3-2.3L15 6.2" /></svg></button>{modelControl}</div>
					<div className="composer-delivery">
						<Presence show={busy} collapse axis="width"><label><span className="sr-only">追加指示の送信方法</span><select aria-label="追加指示の送信方法" value={mode} onChange={(event) => setMode(event.target.value as "steer" | "followUp")}><option value="followUp">完了後に続ける</option><option value="steer">実行中に指示</option></select></label></Presence>
						<Presence show={hasContextLimit} collapse axis="width"><div className="composer-usage-slot"><UsagePanel title="この会話の使用量" groups={session ? [{ id: session.sessionId, label: session.parentSessionId ? "子AI" : "親AI", usage: session.usage }] : []} trigger={<span className="context-usage">{contextTokens == null ? "—" : compactTokens(contextTokens)} / {compactTokens(contextLimit ?? 0)}{usage?.percent != null ? ` (${Math.round(usage.percent)}%)` : ""}</span>} /></div></Presence>
						{busy && !text.trim() && !attachments.length ? <button className="stop-button" type="button" aria-label="実行を停止" onClick={onStop}><span key="stop" className="motion-label" aria-hidden="true">■</span></button> : <button className="send-button" type="submit" aria-label={sending ? "送信中" : "送信"} title="Ctrl / Cmd + Enter で送信" disabled={sending || reading || (!text.trim() && !attachments.length) || !slashInput && (!connected || session?.availability === "missing")}><span key={sending ? "sending" : "send"} className="motion-label" aria-hidden="true">{sending ? "…" : "↑"}</span></button>}
					</div>
				</div></MotionSize>
			</form>
			<Presence show={!!modelSetup} collapse><div className="composer-caption"><button className="text-link" onClick={modelSetup === "authentication" ? onProviderSettings : onModelSelect}>{modelSetup === "authentication" ? "プロバイダーの認証を設定してください" : "モデルを選択してください"}</button></div></Presence>
			<Presence show={!!error} collapse><p className="composer-error" role="alert">{error}</p></Presence>
		</div>
	</section>;
}
