import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ATTACHMENT_LIMITS, type AttachmentUpload } from "../shared/attachments.ts";
import { GIT_REVIEW_ID, WORKSPACE_ROUTER_ID } from "../shared/plugin-profile.ts";
import type { PrLifecycleSurface, WorkspaceGitSummary } from "../shared/pr-lifecycle.ts";
import type { SurfaceAction } from "../shared/surfaces.ts";
import type { ComposerDestination, ComposerSendResult, ConversationCandidate } from "../shared/workspace-routing.ts";
import { api, errorMessage } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { matchesAppKeybinding } from "./app-keybindings.ts";
import type { BrowserAnnotation, BrowserAnnotationDelivery } from "./BrowserPane.tsx";
import { CHAT_MAX_WIDTH, CHAT_MIN_WIDTH, clampChatWidth } from "./chat-width.ts";
import { CommandPicker } from "./CommandPicker.tsx";
import { ComposerAttachments, useComposerAttachments } from "./ComposerAttachments.tsx";
import { ComposerDock } from "./ComposerDock.tsx";
import { ContextWindowPopover } from "./ContextWindowPopover.tsx";
import { Conversation } from "./Conversation.tsx";
import { GitReview } from "./GitReview.tsx";
import { fileChanges } from "./file-changes.ts";
import { MotionItems, Presence, useLayoutMotion } from "./Motion.tsx";
import { PrDockTray } from "./PrDockTray.tsx";
import { usePluginProfile } from "./plugins/profile.tsx";
import { usePreferenceState, usePreferenceText } from "./preferences.ts";
import { SessionOverview } from "./SessionOverview.tsx";
import { COMPOSER_COMMANDS } from "./slash-command.ts";
import { Tooltip } from "./Tooltip.tsx";
import type { PendingInputAction, SessionDetail, TeamSnapshot } from "./types.ts";
import { useComposerSize } from "./use-composer-size.ts";
import { workspaceLabel } from "./workspace-label.ts";
import "./ChatWidth.css";
import "./ComposerLayout.css";

function destinationKey(candidate: ConversationCandidate): string {
	return candidate.kind === "session" ? `session:${candidate.sessionId}` : `new:${candidate.workspaceId}`;
}

const annotationDrafts = new Map<string, BrowserAnnotation[]>();

export function ChatPane({ session, parentSessionTitle, team, loading = false, workspacePath, contextWindow, connected, modelSetup, draftKey, modelControl, goalControl, composerDock, homeDashboard, surface, suppressFloatingActions = false, gitRefreshToken = 0, commands = COMPOSER_COMMANDS, draftInsertion, onDraftInserted, onSend, onPendingInputAction, onSurfaceAction, onCreatePr, onFile, onStop, onParent, onModelSelect, onProviderSettings, onLoadOlder, historyLoading, historyError, onRetry }: {
	session?: SessionDetail;
	parentSessionTitle?: string;
	team?: TeamSnapshot;
	loading?: boolean;
	workspacePath?: string;
	contextWindow?: number;
	connected: boolean;
	modelSetup?: "selection" | "authentication";
	draftKey: string;
	modelControl: ReactNode;
	goalControl: ReactNode;
	composerDock?: ReactNode;
	homeDashboard?: ReactNode;
	surface?: boolean;
	suppressFloatingActions?: boolean;
	gitRefreshToken?: number;
	commands?: readonly (typeof COMPOSER_COMMANDS)[number][];
	draftInsertion?: { id: string; text: string };
	onDraftInserted: () => void;
	onSend: (text: string, mode: "prompt" | "steer" | "followUp", attachments: AttachmentUpload[], destination?: ComposerDestination) => Promise<ComposerSendResult>;
	onPendingInputAction: (inputId: string, action: PendingInputAction) => Promise<void>;
	onSurfaceAction?: (surfaceId: string, action: SurfaceAction) => Promise<void>;
	onCreatePr?: (title?: string) => Promise<void>;
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
	const profile = usePluginProfile();
	const gitReviewEnabled = profile?.activeIds.includes(GIT_REVIEW_ID) ?? true;
	const workspaceRouterEnabled = profile?.activeIds.includes(WORKSPACE_ROUTER_ID) ?? true;
	const [reviewOpen, setReviewOpen] = useState(false);
	const [findOpen, setFindOpen] = useState(false);
	const [findFocusToken, setFindFocusToken] = useState(0);
	const [gitSummary, setGitSummary] = useState<WorkspaceGitSummary>();
	const [creatingPr, setCreatingPr] = useState(false);
	const [error, setError] = useState<string>();
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
	const suggestions = commands.filter((entry) => entry.command.startsWith(commandPrefix));
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
		setText(`${command}${command === "/hyakki" || command === "/goal" || command === "/plan" || command === "/split" || command === "/pr" ? " " : ""}`);
		setPickerDismissed(true);
		input.current?.focus();
	}
	const activePrSurface = session?.surfaces?.findLast(
		(entry): entry is PrLifecycleSurface => entry.kind === "pr_lifecycle",
	);
	const sessionIdForGit = session?.sessionId;
	const sessionAvailability = session?.availability;
	const latestSettledAt = session?.latestRun?.settledAt;
	const currentRunId = session?.currentRun?.runId;
	useEffect(() => {
		if (!sessionIdForGit || sessionAvailability !== "ready" || surface) {
			setGitSummary(undefined);
			return;
		}
		const controller = new AbortController();
		void api<WorkspaceGitSummary>(
			`/api/sessions/${encodeURIComponent(sessionIdForGit)}/git-status`,
			{ signal: controller.signal },
		)
			.then((summary) => {
				if (!controller.signal.aborted) setGitSummary(summary);
			})
			.catch(() => {
				if (!controller.signal.aborted) setGitSummary(undefined);
			});
		return () => controller.abort();
	}, [sessionIdForGit, sessionAvailability, latestSettledAt, currentRunId, gitRefreshToken, surface]);
	async function handleCreatePr() {
		if (!onCreatePr || creatingPr) return;
		setCreatingPr(true);
		setError(undefined);
		try {
			await onCreatePr();
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setCreatingPr(false);
		}
	}
	useEffect(() => {
		if (!draftInsertion || insertedDraft.current === draftInsertion.id) return;
		insertedDraft.current = draftInsertion.id;
		setWorkspaceCandidates(undefined);
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
	const dashboardVisible = !!homeDashboard && !session && !loading && !surface;
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
	const overviewWidth = Math.floor((paneWidth - shownWidth) / 2) - 32;
	const canFind = !surface && !empty && session?.availability === "ready";
	useEffect(() => {
		if (!canFind) setFindOpen(false);
	}, [canFind, session?.sessionId]);
	useEffect(() => {
		if (!canFind) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
			const target = event.target instanceof Element ? event.target : document.activeElement;
			if (target?.closest(".right-panel, dialog[open], .cm-editor, .xterm")) return;
			event.preventDefault();
			setFindOpen(true);
			setFindFocusToken((value) => value + 1);
		};
		const onOpenFind = () => {
			setFindOpen(true);
			setFindFocusToken((value) => value + 1);
		};
		const onOpenReview = () => {
			if (gitReviewEnabled) setReviewOpen(true);
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("hasilan:conversation-find", onOpenFind);
		window.addEventListener("hasilan:git-review", onOpenReview);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("hasilan:conversation-find", onOpenFind);
			window.removeEventListener("hasilan:git-review", onOpenReview);
		};
	}, [canFind, gitReviewEnabled]);
	// A fresh conversation should be ready to type in; the sidebar button keeps focus otherwise.
	// Skip auto-focus on touch devices while the home dashboard is visible so the keyboard does not cover it.
	useEffect(() => {
		if (loading || surface || !empty) return;
		if (dashboardVisible && window.matchMedia("(pointer: coarse)").matches) return;
		const frame = requestAnimationFrame(() => {
			const active = document.activeElement;
			if (active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
			input.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [dashboardVisible, draftKey, empty, loading, surface]);
	useComposerSize(input, text, canRouteWorkspace);
	async function submit(destination?: ComposerDestination, mode: "steer" | "followUp" = "steer") {
		if ((!text.trim() && !attachments.length && !browserAnnotations.length) || reading || submitting.current || attachmentError || !slashInput && (!connected || session?.availability === "missing")) return;
		const annotationSizes = browserAnnotations.map(({ image }) => Math.floor((image.length - image.indexOf(",") - 1) * 3 / 4));
		if (attachments.length + annotationSizes.length > ATTACHMENT_LIMITS.files || annotationSizes.reduce((sum, size) => sum + size, 0) + attachments.reduce((sum, file) => sum + file.size, 0) > ATTACHMENT_LIMITS.totalBytes) {
			setError("添付は10件、合計20 MBまでです。不要な添付や注釈を削除してください。"); return;
		}
		submitting.current = true;
		setSending(true); setError(undefined);
		const submitted = text;
		const submittedAttachments = attachments;
		const submittedAnnotations = browserAnnotations;
		const annotationText = submittedAnnotations.map(({ selection, note }, index) => `ブラウザ注釈 ${index + 1}（画像: browser-comment-${index + 1}.png）\n${JSON.stringify(selection)}\nコメント: ${note}`).join("\n\n");
		const annotationImages = submittedAnnotations.map(({ image }, index) => ({ name: `browser-comment-${index + 1}.png`, mimeType: "image/png", data: image.slice(image.indexOf(",") + 1) }));
		try {
			const result = await onSend([submitted, annotationText].filter(Boolean).join("\n\n"), busy ? mode : "prompt", [...submittedAttachments.map(({ name, mimeType, data }) => ({ name, mimeType, data })), ...annotationImages], destination);
			if (result.destinationCandidates) {
				setWorkspaceCandidates(result.destinationCandidates); setWorkspaceIndex(0);
				return;
			}
			setWorkspaceCandidates(undefined);
			setText((current) => current === submitted ? "" : current);
			remove(submittedAttachments.map((attachment) => attachment.id));
			annotationDrafts.delete(draftKey);
			setBrowserAnnotations([]);
			setFollowRequest((value) => value + 1);
		} catch (reason) { setError(errorMessage(reason)); }
		finally { submitting.current = false; setSending(false); }
	}
	async function attach(files: File[]) {
		if (submitting.current) return;
		setWorkspaceCandidates(undefined);
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
	const hasContextLimit = contextLimit !== undefined && contextLimit > 0;
	const currentAgent = session ? team?.agents.find((agent) => agent.sessionId === session.sessionId) : undefined;
	const siblingAgents = currentAgent ? team?.agents.filter((agent) => agent.teamId === currentAgent.teamId && agent.parentAgentId) ?? [] : [];
	const parentCrumbLabel = (parentSessionTitle?.replace(/\s+/g, " ").trim() || "親の会話").slice(0, 40);
	const pendingInputs = session?.pendingInput.filter((input) => !input.fromAgentId && !input.completionRunId) ?? [];
	useLayoutMotion(pendingList, pendingInputs, true, true);
	return <section ref={pane} className={`chat-pane ${surface ? "has-surface" : empty ? "is-empty" : "has-messages"}${dashboardVisible ? " has-home-dashboard" : ""}`} aria-label="会話" style={{ "--chat-content-width": `${shownWidth}px` } as CSSProperties}>
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
		<Presence show={!!session?.parentSessionId} collapse><nav className="subagent-breadcrumb" aria-label="エージェント階層">
			<div className="subagent-breadcrumb-trail">
				<button type="button" className="subagent-breadcrumb-parent" title="親の会話に戻る" aria-label="親の会話に戻る" onClick={() => { if (session?.parentSessionId) onParent(session.parentSessionId); }}>
					<Icon name="chevronLeft" size="inline" />
					<span>{parentCrumbLabel}</span>
				</button>
				<Icon name="chevronRight" size="inline" className="subagent-breadcrumb-sep" />
				<span className="subagent-breadcrumb-current">
					<span className={`subagent-breadcrumb-dot is-${session?.currentRun ? "running" : session?.latestRun?.status === "completed" ? "completed" : session?.latestRun?.status === "failed" ? "failed" : "idle"}`} aria-hidden="true" />
					<strong>{currentAgent?.name ?? session?.title ?? "サブエージェント"}</strong>
				</span>
			</div>
			{siblingAgents.length > 1 && <div className="subagent-breadcrumb-siblings" role="group" aria-label="チームのエージェント">
				{siblingAgents.map((agent) => {
					const active = agent.sessionId === session?.sessionId;
					const tone = agent.currentRun ? "running" : agent.latestRun?.status === "completed" ? "completed" : agent.latestRun?.status === "failed" ? "failed" : "idle";
					return <button key={agent.agentId} type="button" className="subagent-breadcrumb-chip" aria-current={active ? "page" : undefined} title={agent.name} onClick={() => onParent(agent.sessionId)}>
						<span className={`subagent-breadcrumb-dot is-${tone}`} aria-hidden="true" />
						<span>{agent.name}</span>
					</button>;
				})}
			</div>}
		</nav></Presence>
		<Presence show={!!session?.splitFromSessionId} collapse><div className="split-child-bar">
			<button type="button" className="split-back-button" onClick={() => { if (session?.splitFromSessionId) onParent(session.splitFromSessionId); }}><Icon name="chevronLeft" size="inline" />メインチャット</button>
			<span className="split-child-title">{session?.title ?? "分割セッション"}</span>
			{session?.splitBranch && <code className="split-child-branch">{session.splitBranch}</code>}
			<span className="split-child-status">
				<span className={`mst-row-glyph is-${session?.currentRun ? "working" : session?.latestRun?.status === "failed" ? "failed" : "done"}`} aria-hidden="true">
					{!session?.currentRun && <Icon name={session?.latestRun?.status === "failed" ? "close" : "check"} size="inline" />}
				</span>
				<span>{session?.currentRun ? "実行中" : session?.latestRun?.status === "failed" ? "失敗" : "完了"}</span>
			</span>
		</div></Presence>
		<Presence show={session?.availability === "missing"} collapse><div className="error" role="alert">保存された会話ファイルが見つかりません。新しい会話を開始してください。</div></Presence>
		{!surface && !empty && session && <Conversation messages={session.messages} tools={session.toolCalls} surfaces={session.surfaces} onSurfaceAction={onSurfaceAction} onSelectSession={onParent} activeRunId={session.currentRun?.runId} history={session.history} loading={historyLoading} error={historyError} onLoadOlder={onLoadOlder} onFile={onFile} followRequest={followRequest} fallback={latestRunFallback?.task} latestError={latestError} onRetry={onRetry ? () => onRetry() : undefined} onEdit={(_, value) => { setText(value); input.current?.focus(); }} findOpen={findOpen} findFocusToken={findFocusToken} onCloseFind={() => setFindOpen(false)} />}
		<div className="composer-area">
			<ComposerDock>
				{composerDock}
				{!surface && session?.availability === "ready" && (
					<PrDockTray
						gitSummary={gitSummary}
						surface={activePrSurface}
						creating={creatingPr}
						onCreatePr={onCreatePr ? handleCreatePr : undefined}
						onOpenReview={gitReviewEnabled ? () => setReviewOpen(true) : undefined}
						onSurfaceAction={onSurfaceAction}
						onFile={onFile}
					/>
				)}
			</ComposerDock>
			<Presence show={pendingInputs.length > 0} collapse><div ref={pendingList} className="pending-input-list" role="list" aria-label="予約中の追加指示">
				<MotionItems items={pendingInputs} itemKey={(pendingInput) => pendingInput.inputId}>{(pendingInput) => {
					const editing = editingInput?.inputId === pendingInput.inputId;
					const disabled =
						!connected ||
						session?.availability === "missing" ||
						!pendingInput.manageable ||
						mutatingInputId !== undefined;
					return <div className={`pending-input-row${pendingInput.manageable ? "" : " unavailable"}`} data-editing={editing || undefined} role="listitem" key={pendingInput.inputId}>
						<div className="pending-input-content">
							<span className="pending-input-mode">{pendingInput.mode === "followUp" ? "完了後に指示" : "実行中に指示"}</span>
							{editing
								? <textarea className="pending-input-edit motion-label" aria-label="追加指示を編集" value={editingInput?.text ?? ""} rows={2} onChange={(event) => setEditingInput((current) => current?.inputId === pendingInput.inputId ? { ...current, text: event.target.value } : current)} onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) return;
									if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditingInput(undefined); return; }
									if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !disabled && editingInput?.text.trim()) {
										event.preventDefault();
										void mutatePendingInput(pendingInput.inputId, { type: "edit", text: editingInput.text });
									}
								}} />
								: <p className="pending-input-text motion-label">{pendingInput.text}</p>}
							{!!pendingInput.attachments?.length && <div className="pending-input-attachments">{pendingInput.attachments.map((attachment, index) => <button type="button" className="text-link" key={`${attachment.path}:${index}`} onClick={() => onFile(attachment.path)}>{attachment.name}</button>)}</div>}
						</div>
						<div className="pending-input-actions">
							{editing
								? <>
									<button type="button" aria-label="変更を保存" title="変更を保存" disabled={disabled || !(editingInput?.text.trim())} onClick={() => { const text = editingInput?.text ?? ""; void mutatePendingInput(pendingInput.inputId, { type: "edit", text }); }}><Icon name="check" size="inline" /></button>
									<button type="button" aria-label="編集をキャンセル" title="編集をキャンセル" disabled={mutatingInputId !== undefined} onClick={() => setEditingInput(undefined)}><Icon name="close" size="inline" /></button>
								</>
								: <>
									{pendingInput.mode === "followUp" && <button type="button" aria-label="すぐに送信" title="すぐに送信" disabled={disabled} onClick={() => { void mutatePendingInput(pendingInput.inputId, { type: "sendNow" }); }}><Icon name="send" size="inline" /></button>}
									<button type="button" aria-label="追加指示を編集" title="追加指示を編集" disabled={disabled} onClick={() => { setError(undefined); setEditingInput({ inputId: pendingInput.inputId, text: pendingInput.text }); }}><Icon name="pencil" size="inline" /></button>
									<button type="button" aria-label="追加指示を削除" title="追加指示を削除" disabled={disabled} onClick={() => { void mutatePendingInput(pendingInput.inputId, { type: "delete" }); }}><Icon name="close" size="inline" /></button>
								</>}
						</div>
					</div>;
				}}</MotionItems>
			</div></Presence>
			<Presence show={!surface && empty} collapse><div className="composer-heading"><span className="composer-identity"><img src="/icon.svg" alt="" />Hasilan Code</span>{workspacePath && <code className="composer-workspace" title={workspacePath} aria-label={workspacePath}>{workspaceLabel(workspacePath, [])}</code>}</div></Presence>
			<Presence show={!!goalControl}><div className="motion-contents">{goalControl}</div></Presence>
			<form className={`composer command-picker-anchor${canRouteWorkspace ? " composer-home" : ""}${shownWidth <= 440 ? " is-compact" : ""}${dragging ? " is-dragging" : ""}`} aria-busy={sending || reading} onSubmit={(event) => { event.preventDefault(); void submit(); }} onDragOver={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault(); event.dataTransfer.dropEffect = sending || reading ? "none" : "copy"; setDragging(!sending && !reading);
			}} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault(); setDragging(false); void attach(Array.from(event.dataTransfer.files));
			}}>
				<Presence show={pickerOpen}><div className="motion-contents"><CommandPicker id={pickerId} commands={suggestions} activeIndex={activeCommand} onActive={setCommandIndex} onChoose={chooseCommand} below={dashboardVisible} /></div></Presence>
				<Presence show={workspacePickerOpen}><div className="motion-contents"><CommandPicker id={workspacePickerId} label="送信先の会話" below commands={(workspaceCandidates ?? []).map((candidate) => ({ command: destinationKey(candidate), label: candidate.kind === "session" ? candidate.title : "＋ 新しい会話で開始", description: candidate.kind === "session" ? `${candidate.name}${candidate.updatedAt ? ` · ${new Date(candidate.updatedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""} · ${candidate.path}` : `${candidate.name} · ${candidate.path}` }))} activeIndex={activeWorkspace} onActive={setWorkspaceIndex} disabled={sending || reading} onChoose={(key) => { const candidate = workspaceCandidates?.find((entry) => destinationKey(entry) === key); if (workspacePickerOpen && candidate) void submit(candidate); }} /></div></Presence>
				<Presence show={attachments.length > 0} collapse><ComposerAttachments attachments={attachments} disabled={sending} onRemove={(id) => { setWorkspaceCandidates(undefined); remove([id]); }} /></Presence>
				{browserAnnotations.length > 0 && <ul className="browser-annotation-list" aria-label="ブラウザ注釈">{browserAnnotations.map((annotation, index) => <li key={`${annotation.selection.url}:${index}`}><img src={annotation.image} alt="選択箇所のスクリーンショット" /><span><strong>{annotation.selection.title || annotation.selection.url}</strong><small>{annotation.note}</small></span><button type="button" aria-label={`注釈 ${index + 1} を削除`} disabled={sending} onClick={() => setBrowserAnnotations((current) => { const next = current.filter((_, itemIndex) => itemIndex !== index); if (next.length) annotationDrafts.set(draftKey, next); else annotationDrafts.delete(draftKey); return next; })}><Icon name="close" size="inline" /></button></li>)}</ul>}
				<input ref={fileInput} type="file" multiple hidden aria-label="添付ファイルを選択" disabled={sending || reading} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void attach(files); }} />
				<label className="sr-only" htmlFor="message">メッセージ</label>
				<div className={`composer-input-row${canRouteWorkspace ? " is-home" : ""}`}>
					<textarea ref={input} id="message" role="combobox" aria-label="メッセージ" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={pickerOpen || workspacePickerOpen} aria-controls={workspacePickerOpen ? workspacePickerId : pickerOpen ? pickerId : undefined} aria-activedescendant={workspacePickerOpen ? `${workspacePickerId}-${activeWorkspace}` : pickerOpen && suggestions.length ? `${pickerId}-${activeCommand}` : undefined} value={text} onChange={(event) => { setText(event.target.value); setWorkspaceCandidates(undefined); setCommandIndex(0); setPickerDismissed(false); }} placeholder="メッセージ、または / でコマンドを入力…" rows={1} disabled={sending} onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (matchesAppKeybinding(event, "composer.routeWorkspace")) { event.preventDefault(); if (canRouteWorkspace && workspaceRouterEnabled && !event.repeat) void submit({ kind: "auto" }); return; }
						if (matchesAppKeybinding(event, "composer.followUp")) { event.preventDefault(); if (busy && !event.repeat) void submit(undefined, "followUp"); return; }
						if (workspacePickerOpen && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setWorkspaceCandidates(undefined); return; }
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
				<div className="composer-footer">
					<div className="composer-footer-left">
						{modelControl}
					</div>
					<div className="composer-footer-right">
						<Tooltip label="ファイルを添付" placement="top"><button type="button" className="composer-attach-button" aria-label={reading ? "添付を読み込み中" : "ファイルを添付"} disabled={sending || reading} onClick={() => fileInput.current?.click()}><Icon name="plus" size="control" /></button></Tooltip>
						{!canRouteWorkspace && <Presence show={hasContextLimit} collapse axis="width"><div className="composer-usage-slot"><ContextWindowPopover session={session} contextWindow={contextLimit} /></div></Presence>}
						<div className="composer-delivery">
							{busy && <Tooltip label="実行を停止" placement="top"><button className="stop-button" type="button" aria-label="実行を停止" onClick={onStop}><Icon name="stop" size="control" /></button></Tooltip>}
							<Tooltip label={busy ? "実行中に指示" : "送信"} shortcut="enter" placement="top"><button className="send-button" type="submit" aria-label={sending ? "送信中" : "送信"} disabled={sending || reading || (!text.trim() && !attachments.length && !browserAnnotations.length) || !slashInput && (!connected || session?.availability === "missing")}>{sending ? <span className="motion-label" aria-hidden="true">…</span> : <Icon name="send" size="control" />}</button></Tooltip>
						</div>
					</div>
				</div>
			</form>
			<Presence show={!!modelSetup} collapse><div className="composer-caption"><button className="text-link" onClick={modelSetup === "authentication" ? onProviderSettings : onModelSelect}>{modelSetup === "authentication" ? "プロバイダーの認証を設定してください" : "モデルを選択してください"}</button></div></Presence>
			<Presence show={!!(error || attachmentError)} collapse><p className="composer-error" role="alert">{error ?? attachmentError}</p></Presence>
		</div>
		{dashboardVisible && homeDashboard}
		{!suppressFloatingActions && !surface && !empty && !(paneWidth >= 1100 && overviewWidth >= 160) && session?.availability === "ready" && !findOpen && (canFind || gitReviewEnabled) && <div className="chat-floating-actions">
			{canFind && <button type="button" className="chat-find-trigger" onClick={() => { setFindOpen(true); setFindFocusToken((value) => value + 1); }} title="会話内を検索" aria-label="会話内を検索"><Icon name="search" size="inline" /></button>}
			{gitReviewEnabled && <button type="button" className={`chat-review-trigger${gitSummary && gitSummary.filesChanged > 0 ? " has-changes" : ""}`} onClick={() => setReviewOpen(true)} title={gitSummary?.filesChanged ? `変更をレビュー（${gitSummary.filesChanged}件）` : "変更をレビュー"} aria-label="変更をレビュー"><Icon name="pencil" size="inline" />{gitSummary && gitSummary.filesChanged > 0 && <span className="chat-review-trigger-count">{gitSummary.filesChanged}</span>}</button>}
		</div>}
		{!surface && !empty && paneWidth >= 1100 && overviewWidth >= 160 && session?.availability === "ready" && <SessionOverview width={overviewWidth} session={session} team={team} gitSummary={gitSummary} onFile={onFile} onSession={onParent} onAttach={() => fileInput.current?.click()} attachDisabled={sending || reading} onReview={gitReviewEnabled ? () => setReviewOpen(true) : undefined} onFind={() => { setFindOpen(true); setFindFocusToken((value) => value + 1); }} />}
		{gitReviewEnabled && reviewOpen && session && <GitReview sessionId={session.sessionId} turn={session.latestRun ? fileChanges(session.toolCalls, session.latestRun.runId) : []} onClose={() => setReviewOpen(false)} onDraft={(value) => { setText((current) => [current.trimEnd(), value].filter(Boolean).join("\n\n")); setReviewOpen(false); requestAnimationFrame(() => input.current?.focus()); }} />}
	</section>;
}
