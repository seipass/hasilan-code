import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ATTACHMENT_LIMITS, type AttachmentUpload } from "../shared/attachments.ts";
import type { ComposerDestination, ComposerSendResult, ConversationCandidate } from "../shared/workspace-routing.ts";
import { errorMessage } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { matchesAppKeybinding } from "./app-keybindings.ts";
import type { BrowserAnnotation, BrowserAnnotationDelivery } from "./BrowserPane.tsx";
import { CHAT_MAX_WIDTH, CHAT_MIN_WIDTH, clampChatWidth } from "./chat-width.ts";
import { CommandPicker } from "./CommandPicker.tsx";
import { ComposerAttachments, useComposerAttachments } from "./ComposerAttachments.tsx";
import { Conversation } from "./Conversation.tsx";
import { MotionItems, Presence, useLayoutMotion } from "./Motion.tsx";
import { MotionSize } from "./MotionSwap.tsx";
import { usePreferenceState, usePreferenceText } from "./preferences.ts";
import { COMPOSER_COMMANDS } from "./slash-command.ts";
import type { PendingInputAction, SessionDetail } from "./types.ts";
import { UsagePanel } from "./UsagePanel.tsx";
import { useComposerSize } from "./use-composer-size.ts";
import "./ChatWidth.css";

function destinationKey(candidate: ConversationCandidate): string {
	return candidate.kind === "session" ? `session:${candidate.sessionId}` : `new:${candidate.workspaceId}`;
}

const annotationDrafts = new Map<string, BrowserAnnotation[]>();

export function ChatPane({ session, loading = false, workspacePath, contextWindow, connected, modelSetup, draftKey, modelControl, goalControl, surface, draftInsertion, onDraftInserted, onSend, onPendingInputAction, onFile, onStop, onParent, onModelSelect, onProviderSettings, onLoadOlder, historyLoading, historyError, onRetry }: {
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
	onSend: (text: string, mode: "prompt" | "steer" | "followUp", attachments: AttachmentUpload[], destination?: ComposerDestination) => Promise<ComposerSendResult>;
	onPendingInputAction: (inputId: string, action: PendingInputAction) => Promise<void>;
	onFile: (path: string, line?: number) => void;
	onStop: () => void;
	onParent: (sessionId: string) => void;
	onModelSelect: () => void;
	onProviderSettings: () => void;
	onLoadOlder?: () => Promise<void>;
	historyLoading?: boolean;
	historyError?: string;
	onRetry?: () => void;
}) {
	const [text, setText] = usePreferenceText(`pi-web-draft:${draftKey}`);
	const [chatWidth, setChatWidth] = usePreferenceState("pi-web-chat-width", 744);
	const widthDrag = useRef<{ id: number; x: number; width: number } | undefined>(undefined);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const { attachments, reading, error: attachmentError, addFiles, remove } = useComposerAttachments(draftKey);
	const [browserAnnotations, setBrowserAnnotations] = useState<BrowserAnnotation[]>(() => annotationDrafts.get(draftKey) ?? []);
	const [dragging, setDragging] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const [commandIndex, setCommandIndex] = useState(0);
	const [pickerDismissed, setPickerDismissed] = useState(false);
	const pickerId = useId();
	const workspacePickerId = useId();
	const [workspaceCandidates, setWorkspaceCandidates] = useState<ConversationCandidate[]>();
	const [workspaceIndex, setWorkspaceIndex] = useState(0);
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
	const canRouteWorkspace = !session && !loading && !surface;
	const workspacePickerOpen = canRouteWorkspace && !!workspaceCandidates?.length;
	const activeWorkspace = Math.min(workspaceIndex, Math.max(0, (workspaceCandidates?.length ?? 0) - 1));
	useEffect(() => { if (workspacePickerOpen && !sending) input.current?.focus(); }, [workspacePickerOpen, sending]);
	useEffect(() => {
		const receive = (event: Event) => {
			if (!input.current?.getClientRects().length || input.current.closest("[inert]")) return;
			const delivery = (event as CustomEvent<BrowserAnnotationDelivery>).detail;
			const annotation = delivery.annotation;
			const images = [...browserAnnotations.map((item) => item.image), annotation.image];
			const sizes = images.map((image) => Math.floor((image.length - image.indexOf(",") - 1) * 3 / 4));
			if (sending || reading || attachments.length + images.length > ATTACHMENT_LIMITS.files || sizes.some((size) => size > ATTACHMENT_LIMITS.fileBytes) || sizes.reduce((a, b) => a + b, 0) + attachments.reduce((sum, file) => sum + file.size, 0) > ATTACHMENT_LIMITS.totalBytes) {
				setError("注釈を追加できません。添付は10件、合計20 MBまでです。"); return;
			}
			delivery.accepted = true;
			setBrowserAnnotations((current) => { const next = [...current, annotation]; annotationDrafts.set(draftKey, next); return next; }); setError(undefined); setWorkspaceCandidates(undefined);
		};
		window.addEventListener("hasilan:browser-annotation", receive);
		return () => window.removeEventListener("hasilan:browser-annotation", receive);
	}, [attachments, browserAnnotations, draftKey, reading, sending]);
	function chooseCommand(command: string) {
		setWorkspaceCandidates(undefined);
		setText(`${command}${command === "/hyakki" || command === "/goal" ? " " : ""}`);
		setPickerDismissed(true);
		input.current?.focus();
	}
	useEffect(() => {
		if (!draftInsertion || insertedDraft.current === draftInsertion.id) return;
		insertedDraft.current = draftInsertion.id;
		setWorkspaceCandidates(undefined);
		setNotice(undefined);
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
	const pane = useRef<HTMLElement>(null);
	const [paneWidth, setPaneWidth] = useState(0);
	useEffect(() => {
		const element = pane.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setPaneWidth(element.clientWidth));
		observer.observe(element);
		setPaneWidth(element.clientWidth);
		return () => observer.disconnect();
	}, []);
	const clampWidth = (value: number) => clampChatWidth(value, paneWidth);
	const shownWidth = clampWidth(chatWidth);
	// A fresh conversation should be ready to type in; the sidebar button keeps focus otherwise.
	useEffect(() => {
		if (loading || surface || !empty) return;
		const frame = requestAnimationFrame(() => {
			const active = document.activeElement;
			if (active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
			input.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [draftKey, empty, loading, surface]);
	useComposerSize(input, text);
	async function submit(destination?: ComposerDestination, mode: "steer" | "followUp" = "steer") {
		if ((!text.trim() && !attachments.length && !browserAnnotations.length) || reading || submitting.current || attachmentError || !slashInput && (!connected || session?.availability === "missing")) return;
		const annotationSizes = browserAnnotations.map(({ image }) => Math.floor((image.length - image.indexOf(",") - 1) * 3 / 4));
		if (attachments.length + annotationSizes.length > ATTACHMENT_LIMITS.files || annotationSizes.reduce((sum, size) => sum + size, 0) + attachments.reduce((sum, file) => sum + file.size, 0) > ATTACHMENT_LIMITS.totalBytes) {
			setError("添付は10件、合計20 MBまでです。不要な添付や注釈を削除してください。"); return;
		}
		submitting.current = true;
		setSending(true); setError(undefined); setNotice(undefined);
		if (destination?.kind === "auto") setNotice("判断モデルがワークスペースと会話を選択しています…");
		const submitted = text;
		const submittedAttachments = attachments;
		const submittedAnnotations = browserAnnotations;
		const annotationText = submittedAnnotations.map(({ selection, note }, index) => `ブラウザ注釈 ${index + 1}（画像: browser-comment-${index + 1}.png）\n${JSON.stringify(selection)}\nコメント: ${note}`).join("\n\n");
		const annotationImages = submittedAnnotations.map(({ image }, index) => ({ name: `browser-comment-${index + 1}.png`, mimeType: "image/png", data: image.slice(image.indexOf(",") + 1) }));
		try {
			const result = await onSend([submitted, annotationText].filter(Boolean).join("\n\n"), busy ? mode : "prompt", [...submittedAttachments.map(({ name, mimeType, data }) => ({ name, mimeType, data })), ...annotationImages], destination);
			if (result.destinationCandidates) {
				setWorkspaceCandidates(result.destinationCandidates); setWorkspaceIndex(0);
				setNotice("続ける会話、または新しい会話の開始先を選んでください。");
				return;
			}
			setWorkspaceCandidates(undefined); setNotice(undefined);
			setText((current) => current === submitted ? "" : current);
			remove(submittedAttachments.map((attachment) => attachment.id));
			annotationDrafts.delete(draftKey);
			setBrowserAnnotations([]);
			if (result.notice) setNotice(result.notice);
			else if (busy && result.disposition) setNotice(result.disposition === "queued" ? "追加の指示を予約しました。" : "追加の指示を送信しました。");
			setFollowRequest((value) => value + 1);
		} catch (reason) { setNotice(undefined); setError(errorMessage(reason)); }
		finally { submitting.current = false; setSending(false); }
	}
	async function attach(files: File[]) {
		if (submitting.current) return;
		setWorkspaceCandidates(undefined);
		setNotice(undefined);
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
	return <section ref={pane} className={`chat-pane ${surface ? "has-surface" : empty ? "is-empty" : "has-messages"}`} aria-label="会話" style={{ "--chat-content-width": `${shownWidth}px` } as CSSProperties}>
{!surface && !empty && <div className="chat-width-handle" role="separator" tabIndex={0} aria-label="チャットの幅" aria-orientation="vertical" aria-valuemin={CHAT_MIN_WIDTH} aria-valuemax={clampWidth(CHAT_MAX_WIDTH)} aria-valuenow={shownWidth} title="ドラッグしてチャットの幅を変更" onPointerDown={(event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.currentTarget.setPointerCapture(event.pointerId);
			// The handle sits at the pane edge once the content is capped, so store the shown width, not the saved one.
			widthDrag.current = { id: event.pointerId, x: event.clientX, width: shownWidth };
		}} onPointerMove={(event) => {
			const drag = widthDrag.current;
			if (drag?.id !== event.pointerId) return;
			// The column is centred, so both edges move: the handle tracks the pointer at 2x the width delta.
			setChatWidth(clampWidth(drag.width + 2 * (drag.x - event.clientX)));
		}} onPointerUp={(event) => { if (widthDrag.current?.id === event.pointerId) { widthDrag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); } }} onLostPointerCapture={() => { widthDrag.current = undefined; }} onDoubleClick={() => setChatWidth(744)} onKeyDown={(event) => {
			const step = event.shiftKey ? 96 : 32;
			if (event.key === "Home") { event.preventDefault(); setChatWidth(clampWidth(CHAT_MIN_WIDTH)); return; }
			if (event.key === "End") { event.preventDefault(); setChatWidth(clampWidth(Number.POSITIVE_INFINITY)); return; }
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			event.preventDefault();
			setChatWidth((width) => clampWidth(width + (event.key === "ArrowLeft" ? step : -step)));
		}} />}
		{loading && <div className="conversation conversation-loading" role="status">会話を読み込んでいます…</div>}
		<Presence show={!!session?.parentSessionId} collapse><div className="child-banner">この会話はチームエージェントの作業です。<button className="text-link" onClick={() => { if (session?.parentSessionId) onParent(session.parentSessionId); }}>親の会話に戻る</button></div></Presence>
		<Presence show={session?.availability === "missing"} collapse><div className="error" role="alert">保存された会話ファイルが見つかりません。新しい会話を開始してください。</div></Presence>
		{!surface && !empty && session && <Conversation messages={session.messages} tools={session.toolCalls} activeRunId={session.currentRun?.runId} history={session.history} loading={historyLoading} error={historyError} onLoadOlder={onLoadOlder} onFile={onFile} followRequest={followRequest} fallback={latestRunFallback?.task} latestError={latestError} onRetry={onRetry ? () => onRetry() : undefined} onEdit={(_, value) => { setText(value); setNotice("前の依頼を入力欄に戻しました。編集して送信すると新しい依頼になります。"); input.current?.focus(); }} />}
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
							<span className="pending-input-mode">{pendingInput.mode === "followUp" ? "完了後に指示" : "実行中に指示"}</span>
							{editing
								? <textarea className="pending-input-edit motion-label" aria-label="追加指示を編集" value={editingInput?.text ?? ""} rows={2} onChange={(event) => setEditingInput((current) => current?.inputId === pendingInput.inputId ? { ...current, text: event.target.value } : current)} />
								: <p className="pending-input-text motion-label">{pendingInput.text}</p>}
							{!!pendingInput.attachments?.length && <div className="pending-input-attachments">{pendingInput.attachments.map((attachment, index) => <button type="button" className="text-link" key={`${attachment.path}:${index}`} onClick={() => onFile(attachment.path)}>{attachment.name}</button>)}</div>}
						</div>
						<div className="pending-input-actions">
							{editing
								? <>
									<button type="button" aria-label="変更を保存" title="変更を保存" disabled={disabled || !(editingInput?.text.trim())} onClick={() => { const text = editingInput?.text ?? ""; void mutatePendingInput(pendingInput.inputId, { type: "edit", text }); }}><Icon name="check" size={14} /></button>
									<button type="button" aria-label="編集をキャンセル" title="編集をキャンセル" disabled={mutatingInputId !== undefined} onClick={() => setEditingInput(undefined)}><Icon name="close" size={14} /></button>
								</>
								: <>
									{pendingInput.mode === "followUp" && <button type="button" aria-label="すぐに送信" title="すぐに送信" disabled={disabled} onClick={() => { void mutatePendingInput(pendingInput.inputId, { type: "sendNow" }); }}><Icon name="send" size={14} /></button>}
									<button type="button" aria-label="追加指示を編集" title="追加指示を編集" disabled={disabled} onClick={() => { setError(undefined); setEditingInput({ inputId: pendingInput.inputId, text: pendingInput.text }); }}><Icon name="pencil" size={14} /></button>
									<button type="button" aria-label="追加指示を削除" title="追加指示を削除" disabled={disabled} onClick={() => { void mutatePendingInput(pendingInput.inputId, { type: "delete" }); }}><Icon name="close" size={14} /></button>
								</>}
						</div>
					</div>;
				}}</MotionItems>
			</div></Presence>
			<Presence show={!surface && empty} collapse><div className="composer-heading"><span className="composer-identity"><img src="/icon.svg" alt="" />Hasilan Code</span>{workspacePath && <code className="composer-workspace" title={workspacePath}>{workspacePath}</code>}</div></Presence>
			<Presence show={!!notice} collapse><div className="composer-notice" role="status"><span>{notice}</span><button type="button" aria-label="通知を閉じる" title="通知を閉じる" onClick={() => setNotice(undefined)}><Icon name="close" size={13} /></button></div></Presence>
			<Presence show={!!goalControl}><div className="motion-contents">{goalControl}</div></Presence>
			<form className={`composer command-picker-anchor${dragging ? " is-dragging" : ""}`} aria-busy={sending || reading} onSubmit={(event) => { event.preventDefault(); void submit(); }} onDragOver={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault(); event.dataTransfer.dropEffect = sending || reading ? "none" : "copy"; setDragging(!sending && !reading);
			}} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault(); setDragging(false); void attach(Array.from(event.dataTransfer.files));
			}}>
				<Presence show={pickerOpen}><div className="motion-contents"><CommandPicker id={pickerId} commands={suggestions} activeIndex={activeCommand} onActive={setCommandIndex} onChoose={chooseCommand} /></div></Presence>
				<Presence show={workspacePickerOpen}><div className="motion-contents"><CommandPicker id={workspacePickerId} label="送信先の会話" below commands={(workspaceCandidates ?? []).map((candidate) => ({ command: destinationKey(candidate), label: candidate.kind === "session" ? candidate.title : "＋ 新しい会話で開始", description: candidate.kind === "session" ? `${candidate.name}${candidate.updatedAt ? ` · ${new Date(candidate.updatedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""} · ${candidate.path}` : `${candidate.name} · ${candidate.path}` }))} activeIndex={activeWorkspace} onActive={setWorkspaceIndex} disabled={sending || reading} onChoose={(key) => { const candidate = workspaceCandidates?.find((entry) => destinationKey(entry) === key); if (workspacePickerOpen && candidate) void submit(candidate); }} /></div></Presence>
				<Presence show={attachments.length > 0} collapse><ComposerAttachments attachments={attachments} disabled={sending} onRemove={(id) => { setWorkspaceCandidates(undefined); setNotice(undefined); remove([id]); }} /></Presence>
				{browserAnnotations.length > 0 && <ul className="browser-annotation-list" aria-label="ブラウザ注釈">{browserAnnotations.map((annotation, index) => <li key={`${annotation.selection.url}:${index}`}><img src={annotation.image} alt="選択箇所のスクリーンショット" /><span><strong>{annotation.selection.title || annotation.selection.url}</strong><small>{annotation.note}</small></span><button type="button" aria-label={`注釈 ${index + 1} を削除`} disabled={sending} onClick={() => setBrowserAnnotations((current) => { const next = current.filter((_, itemIndex) => itemIndex !== index); if (next.length) annotationDrafts.set(draftKey, next); else annotationDrafts.delete(draftKey); return next; })}><Icon name="close" size={13} /></button></li>)}</ul>}
				<input ref={fileInput} type="file" multiple hidden aria-label="添付ファイルを選択" disabled={sending || reading} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void attach(files); }} />
				<label className="sr-only" htmlFor="message">メッセージ</label>
				<div className="composer-input-row">
					<textarea ref={input} id="message" role="combobox" aria-label="メッセージ" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={pickerOpen || workspacePickerOpen} aria-controls={workspacePickerOpen ? workspacePickerId : pickerOpen ? pickerId : undefined} aria-activedescendant={workspacePickerOpen ? `${workspacePickerId}-${activeWorkspace}` : pickerOpen && suggestions.length ? `${pickerId}-${activeCommand}` : undefined} value={text} onChange={(event) => { setText(event.target.value); setWorkspaceCandidates(undefined); setNotice(undefined); setCommandIndex(0); setPickerDismissed(false); }} placeholder="メッセージ、または / でコマンドを入力…" rows={2} disabled={sending} onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (matchesAppKeybinding(event, "composer.routeWorkspace")) { event.preventDefault(); if (canRouteWorkspace && !event.repeat) void submit({ kind: "auto" }); return; }
						if (matchesAppKeybinding(event, "composer.followUp")) { event.preventDefault(); if (busy && !event.repeat) void submit(undefined, "followUp"); return; }
						if (workspacePickerOpen && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setWorkspaceCandidates(undefined); setNotice(undefined); return; }
						if (workspacePickerOpen && workspaceCandidates && !event.ctrlKey && !event.metaKey && !event.altKey) {
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								setWorkspaceIndex((activeWorkspace + (event.key === "ArrowDown" ? 1 : -1) + workspaceCandidates.length) % workspaceCandidates.length);
								return;
							}
							if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!event.repeat) void submit(workspaceCandidates[activeWorkspace]); return; }
						}
						if (pickerOpen && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPickerDismissed(true); return; }
						if (pickerOpen && suggestions.length && !event.ctrlKey && !event.metaKey && !event.altKey) {
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								setCommandIndex((activeCommand + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
								return;
							}
							if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); chooseCommand(suggestions[activeCommand].command); return; }
						}
						if (matchesAppKeybinding(event, "composer.send")) { event.preventDefault(); if (!event.repeat) void submit(); return; }
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
						<Presence show={hasContextLimit} collapse axis="width"><div className="composer-usage-slot"><UsagePanel title="この会話の使用量" groups={session ? [{ id: session.sessionId, label: session.parentSessionId ? "子AI" : "親AI", usage: session.usage }] : []} trigger={<span className="context-usage"><Icon name="gauge" size={13} />{contextTokens == null ? "—" : compactTokens(contextTokens)} / {compactTokens(contextLimit ?? 0)}{usage?.percent != null ? ` (${Math.round(usage.percent)}%)` : ""}</span>} /></div></Presence>
						{busy && <button className="stop-button" type="button" aria-label="実行を停止" title="実行を停止" onClick={onStop}><Icon name="stop" size={14} /></button>}
						<button className="send-button" type="submit" aria-label={sending ? "送信中" : "送信"} title={canRouteWorkspace ? "Enter で送信 · Shift + Enter で改行 · Ctrl / Cmd + Shift + Enter で送信先を選択" : busy ? "Enter で実行中に指示 · Ctrl / Cmd + Enter で完了後に指示 · Shift + Enter で改行" : "Enter で送信 · Shift + Enter で改行"} disabled={sending || reading || (!text.trim() && !attachments.length && !browserAnnotations.length) || !slashInput && (!connected || session?.availability === "missing")}>{sending ? <span className="motion-label" aria-hidden="true">…</span> : <Icon name="send" size={17} />}</button>
					</div>
				</div></MotionSize>
			</form>
			<Presence show={!!modelSetup} collapse><div className="composer-caption"><button className="text-link" onClick={modelSetup === "authentication" ? onProviderSettings : onModelSelect}>{modelSetup === "authentication" ? "プロバイダーの認証を設定してください" : "モデルを選択してください"}</button></div></Presence>
			<Presence show={!!(error || attachmentError)} collapse><p className="composer-error" role="alert">{error ?? attachmentError}</p></Presence>
		</div>
	</section>;
}
