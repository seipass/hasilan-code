import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HistoryPosition } from "../shared/session-history.ts";
import type { SessionSurface, SurfaceAction } from "../shared/surfaces.ts";
import { ActionPlanCard } from "./ActionPlanCard.tsx";
import { ComputerActivity } from "./ComputerActivity.tsx";
import { ConversationFindBar } from "./ConversationFindBar.tsx";
import {
	applyConversationHighlights,
	clearConversationHighlights,
	collectConversationMatches,
	extractActivitySearchText,
	extractMessageSearchText,
} from "./conversation-find.ts";
import { PrLifecycleCard } from "./PrLifecycleCard.tsx";
import { SplitNoticeCard, SplitProposalCard } from "./SplitProposalCard.tsx";
import { conversationRows } from "./computer-activity.ts";
import { Presence } from "./Motion.tsx";
import { Content, record } from "./Content.tsx";
import { observeConversation } from "./conversation-resize.ts";
import { RUN_LABELS } from "./TeamPane.tsx";
import { MessageActions, userText } from "./MessageActions.tsx";
import { ToolCard } from "./ToolInspector.tsx";
import { ThinkingTimeline, useThinkingDuration } from "./ThinkingTimeline.tsx";
import { type TurnActivity, turnActivityLabel, turnActivityRows } from "./turn-activity.ts";
import { preferences, usePreferenceState } from "./preferences.ts";
import type { ChatMessage, ToolCall } from "./types.ts";
import { Icon } from "./Icon.tsx";
import { UserMessageContent } from "./UserMessageContent.tsx";
import { FileChanges } from "./FileChanges.tsx";
import { fileChanges, type FileChangeSummary } from "./file-changes.ts";
import "./Conversation.css";

const ESTIMATED_HEIGHT = 220;

function formatTokens(value: number): string {
	return new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
const OVERSCAN = 600;

function rowAt(offsets: number[], offset: number): number {
	let low = 0;
	let high = offsets.length - 1;
	while (low < high) {
		const middle = Math.floor((low + high + 1) / 2);
		if (offsets[middle] <= offset) low = middle;
		else high = middle - 1;
	}
	return Math.min(low, offsets.length - 2);
}

function hasAssistantText(message: ChatMessage): boolean {
	if (message.role !== "assistant" || message.partial) return false;
	const { content } = message;
	return typeof content === "string" ? Boolean(content.trim()) : Array.isArray(content)
		&& content.some((part) => record(part) && part.type === "text" && typeof part.text === "string" && part.text.trim());
}

function hasUserActions(message: ChatMessage): boolean {
	return message.role === "user" && !message.contextInjection && !message.importedContext && Boolean(userText(message));
}

interface MessageProps {
	rowKey: string;
	grouped?: boolean;
	message: ChatMessage;
	tools: (ToolCall | undefined)[];
	surfacesByCallId?: Map<string, SessionSurface>;
	onSurfaceAction?: (surfaceId: string, action: SurfaceAction) => Promise<void>;
	onFile: (path: string, line?: number) => void;
	onRetry?: (messageId: string) => void;
	onEdit?: (messageId: string, text: string) => void;
	expansions: Map<string, boolean[]>;
	changes?: FileChangeSummary[];
}
const Message = memo(function Message({ rowKey, grouped, message, tools, surfacesByCallId, onSurfaceAction, onFile, onRetry, onEdit, expansions, changes }: MessageProps) {
	const element = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const row = element.current;
		if (!row) return;
		const saved = expansions.get(rowKey);
		if (saved) row.querySelectorAll("details").forEach((details, index) => { details.open = saved[index] ?? details.open; });
		const remember = () => expansions.set(rowKey, [...row.querySelectorAll("details")].map((details) => details.open));
		row.addEventListener("toggle", remember, true);
		return () => row.removeEventListener("toggle", remember, true);
	}, [rowKey, expansions]);
	const injection = message.contextInjection;
	const parts: unknown[] = Array.isArray(message.content) ? message.content : [];
	const lastPart = Array.isArray(message.content) ? parts.at(-1) : message.content;
	const activeThinking = message.role === "assistant" && message.partial && record(lastPart) && lastPart.type === "thinking";
	const calls = parts.filter((part) => record(part) && part.type === "toolCall");
	const content = calls.length ? parts.filter((part) => !record(part) || part.type !== "toolCall") : message.content;
	return <div ref={element} className={grouped ? undefined : "virtual-message"} data-message-id={grouped ? undefined : rowKey}>
		{injection ? <details className="message context-entry">
			<summary><span className="context-entry-label">コンテキスト</span><span className="context-entry-agent">{injection.source.agentName}</span>{injection.source.status && <span className={`badge status-${injection.source.status}`}>{RUN_LABELS[injection.source.status]}</span>}</summary>
			<div className="context-entry-body"><div className="message-content"><Content value={injection.content} onFile={onFile} /></div>
				<dl className="context-entry-source"><dt>通知元</dt><dd>{injection.source.type === "team_message" ? "エージェント間メッセージ" : "サブエージェントの完了通知"}</dd><dt>エージェント ID</dt><dd><code>{injection.source.agentId}</code></dd>{injection.source.runId && <><dt>実行 ID</dt><dd><code>{injection.source.runId}</code></dd></>}<dt>コンテキスト ID</dt><dd><code>{injection.injectionId}</code></dd></dl>
			</div>
		</details> : message.importedContext ? <details className="message context-entry"><summary><span className="context-entry-label">参照履歴</span></summary><div className="context-entry-body"><div className="message-content"><Content value={message.content} onFile={onFile} /></div></div></details> :
			<article className={`message role-${message.role} ${message.partial ? "partial" : ""}`}>
				{message.role !== "assistant" && message.role !== "user" && message.role !== "system" && <div className="message-label">{message.role}</div>}
				<div className="message-content">{message.role === "user" ? <UserMessageContent value={content} onFile={onFile} /> : <Content value={content} onFile={onFile} activeThinking={activeThinking} colorPreview={message.role === "assistant"} />}{calls.map((part, index) => {
					const tool = tools[index];
					if (tool?.name === "computer") return null;
					const callId = tool?.callId ?? (record(part) && typeof part.id === "string" ? part.id : undefined);
					const surface = callId ? surfacesByCallId?.get(callId) : undefined;
					if (surface?.kind === "action_plan" && onSurfaceAction) {
						return <ActionPlanCard key={surface.surfaceId} surface={surface} onAction={onSurfaceAction} onFile={onFile} />;
					}
					if (tool?.name === "action_plan" || (record(part) && part.name === "action_plan")) return null;
					return tool ? <ToolCard key={tool.key} tool={tool} onFile={onFile} /> : <p key={index} className="tool-preparing">{record(part) && typeof part.name === "string" ? part.name : "ツール"} を準備中…</p>;
				})}{message.partial && <span className="streaming-dot" aria-label="応答中" />}</div>
				{(hasAssistantText(message) || hasUserActions(message)) && <div className="message-meta">
					{message.timestamp && Number.isFinite(Date.parse(message.timestamp)) && <time dateTime={message.timestamp}>{new Date(message.timestamp).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>}
					{message.role === "assistant" && message.usage && <span className="message-usage" title="この応答の概算">{`${formatTokens(message.usage.input + message.usage.cacheRead + message.usage.cacheWrite + message.usage.output)} tok · $${message.usage.cost.toFixed(3)}`}</span>}
					<MessageActions message={message} content={content} onRetry={onRetry ? () => onRetry(message.messageId) : undefined} onEdit={onEdit ? (text) => onEdit(message.messageId, text) : undefined} />
				</div>}
			</article>}
		{!!changes?.length && <FileChanges files={changes} onFile={onFile} />}
	</div>;
}, (previous, next) =>
	previous.rowKey === next.rowKey &&
	previous.grouped === next.grouped &&
	previous.message === next.message &&
	previous.message.timestamp === next.message.timestamp &&
	previous.message.usage === next.message.usage &&
	previous.onFile === next.onFile &&
	previous.onRetry === next.onRetry &&
	previous.onEdit === next.onEdit &&
	previous.expansions === next.expansions &&
	previous.changes === next.changes &&
	previous.surfacesByCallId === next.surfacesByCallId &&
	previous.onSurfaceAction === next.onSurfaceAction &&
	previous.tools.length === next.tools.length &&
	previous.tools.every((tool, index) => tool === next.tools[index]));

function ActivityBlock({ block, onFile, expansions, opened }: {
	block: TurnActivity;
	onFile: MessageProps["onFile"];
	expansions: MessageProps["expansions"];
	opened: Map<string, { active: boolean; open: boolean }>;
}) {
	const [, setVersion] = useState(0);
	const duration = useThinkingDuration(block);
	let state = opened.get(block.key);
	if (!state || state.active !== block.active) {
		state = { active: block.active, open: block.active };
		opened.set(block.key, state);
	}
	const open = state.open;
	const label = turnActivityLabel(block);
	return <div className="virtual-message" data-message-id={block.key}>
		{block.items.length === 0 ? <p className="turn-activity-waiting" role="status"><span className="turn-activity-label">{label}</span></p> :
			<details className="turn-activity" data-active={block.active} open={open} onToggle={(event) => {
				if (event.target !== event.currentTarget) return;
				const next = event.currentTarget.open;
				const current = opened.get(block.key);
				if (current && current.open !== next) {
					current.open = next;
					setVersion((version) => version + 1);
				}
			}}>
				<summary><span className="turn-activity-label" role={block.active ? "status" : undefined}>{label}</span>{duration !== undefined && <span className="turn-activity-duration">{duration}s</span>}</summary>
				{open && <ThinkingTimeline block={block} onFile={onFile} rawChildren={block.items.map((row) => row.kind === "computer"
					? <ComputerActivity key={row.key} group={row.group} onFile={onFile} />
					: <Message key={row.key} rowKey={row.key} grouped message={row.message} tools={row.tools} onFile={onFile} expansions={expansions} />,
				)} />}
			</details>}
	</div>;
}

export const Conversation = memo(function Conversation({ messages: allMessages, tools, surfaces, onSurfaceAction, onSelectSession, activeRunId, history, loading, error, onLoadOlder, onFile, followRequest, fallback, latestError, onRetry, onEdit, findOpen = false, findFocusToken = 0, onCloseFind }: {
	messages: ChatMessage[];
	tools: ToolCall[];
	surfaces?: SessionSurface[];
	onSurfaceAction?: (surfaceId: string, action: SurfaceAction) => Promise<void>;
	onSelectSession?: (sessionId: string) => void;
	activeRunId?: string;
	history?: HistoryPosition;
	loading?: boolean;
	error?: string;
	onLoadOlder?: () => Promise<void>;
	onFile: (path: string, line?: number) => void;
	followRequest: number;
	fallback?: string;
	latestError?: string;
	onRetry?: (messageId: string) => void;
	onEdit?: (messageId: string, text: string) => void;
	findOpen?: boolean;
	findFocusToken?: number;
	onCloseFind?: () => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const rowsStart = useRef<HTMLDivElement>(null);
	const heights = useRef(new Map<string, number>());
	const expansions = useRef(new Map<string, boolean[]>());
	const openedActivity = useRef(new Map<string, { active: boolean; open: boolean }>());
	const [activityBeta] = usePreferenceState("pi-web-beta-turn-activity", false);
	const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
	const following = useRef(true);
	const lastScrollTop = useRef(0);
	const lastFollowRequest = useRef(followRequest);
	const origin = useRef(24);
	const observer = useRef<ResizeObserver | undefined>(undefined);
	const observedRows = useRef(new Set<HTMLElement>());
	const fileCallback = useRef(onFile);
	fileCallback.current = onFile;
	const openFile = useCallback((path: string, line?: number) => fileCallback.current(path, line), []);
	const actionCallbacks = useRef({ onRetry, onEdit });
	actionCallbacks.current = { onRetry, onEdit };
	const retryMessage = useCallback((messageId: string) => actionCallbacks.current.onRetry?.(messageId), []);
	const editMessage = useCallback((messageId: string, text: string) => actionCallbacks.current.onEdit?.(messageId, text), []);
	const [measureVersion, setMeasureVersion] = useState(0);
	const [viewport, setViewport] = useState({ top: 0, height: 600 });
	const [nearBottom, setNearBottom] = useState(true);
	const [findQuery, setFindQuery] = useState("");
	const [findIndex, setFindIndex] = useState(0);
	const [findJumpNonce, setFindJumpNonce] = useState(0);
	const pendingRangeScroll = useRef(false);
	const rows = useMemo(() => {
		const items = conversationRows(allMessages, tools, activeRunId);
		const explicitlyDisabled = preferences.getItem("pi-web-beta-turn-activity") === "false";
		const useTimeline = activityBeta || (!explicitlyDisabled && tools.some((tool) => tool.name !== "action_plan"));
		return useTimeline ? turnActivityRows(items, activeRunId) : items;
	}, [allMessages, tools, activeRunId, activityBeta]);
	const surfacesByCallId = useMemo(() => {
		if (!surfaces?.length) return undefined;
		const map = new Map<string, SessionSurface>();
		for (const surface of surfaces) {
			if (surface.kind === "action_plan" && surface.anchorCallId) map.set(surface.anchorCallId, surface);
		}
		return map;
	}, [surfaces]);
	const unanchoredSurfaces = useMemo(() => {
		if (!surfaces?.length) return [];
		const anchoredIds = new Set<string>();
		for (const row of rows) {
			if (row.kind !== "message") continue;
			for (const tool of row.tools) if (tool?.callId) anchoredIds.add(tool.callId);
		}
		return surfaces.filter(
			(surface) =>
				surface.kind !== "action_plan" || !surface.anchorCallId || !anchoredIds.has(surface.anchorCallId),
		);
	}, [surfaces, rows]);
	const changesByRow = useMemo(() => {
		const lastByRun = new Map<string, string>();
		for (const row of rows) {
			if (row.kind === "message" && row.message.runId && row.message.runId !== activeRunId && !row.message.contextInjection && !row.message.importedContext && hasAssistantText(row.message)) lastByRun.set(row.message.runId, row.key);
		}
		const result = new Map<string, FileChangeSummary[]>();
		for (const [runId, key] of lastByRun) {
			const changes = fileChanges(tools, runId);
			if (changes.length) result.set(key, changes);
		}
		return result;
	}, [rows, tools, activeRunId]);
	// Retrying only makes sense on the newest reply; older replies cannot be regenerated in place.
	const lastAssistantKey = useMemo(() => {
		for (let index = rows.length - 1; index >= 0; index--) {
			const row = rows[index];
			if (row.kind === "message" && hasAssistantText(row.message)) return row.key;
		}
		return undefined;
	}, [rows]);
	const offsets = useMemo(() => {
		const result = [0];
		for (const row of rows) result.push(result[result.length - 1] + (heights.current.get(row.key) ?? (row.kind === "computer" ? 430 : row.kind === "activity" ? 42 : ESTIMATED_HEIGHT)));
		return result;
	}, [rows, measureVersion]);
	const rowIndexes = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
	const total = offsets[offsets.length - 1];
	const topInset = history?.before || loading || error ? 40 : 0;
	const savedAnchor = anchor.current;
	const anchorIndex = savedAnchor ? rowIndexes.get(savedAnchor.id) : undefined;
	const top = Math.max(0, following.current ? total - viewport.height : savedAnchor && anchorIndex !== undefined ? offsets[anchorIndex] + savedAnchor.offset : viewport.top - origin.current);
	const start = Math.max(0, rowAt(offsets, Math.max(0, top - OVERSCAN)));
	const end = Math.min(rows.length, rowAt(offsets, top + viewport.height + OVERSCAN) + 1);
	const geometry = useRef({ rows, offsets });
	const updateViewport = useCallback(() => {
		const element = scroller.current;
		if (!element) return;
		const { scrollTop: top, clientHeight: height } = element;
		setViewport((previous) => previous.top === top && previous.height === height ? previous : { top, height });
	}, []);
	const captureScroll = useCallback((element: HTMLDivElement) => {
		const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
		lastScrollTop.current = element.scrollTop;
		following.current = remaining <= 2;
		setNearBottom(remaining < 80);
		const current = geometry.current;
		const y = element.scrollTop - origin.current;
		const index = Math.max(0, rowAt(current.offsets, Math.max(0, y)));
		const row = current.rows[index];
		anchor.current = row ? { id: row.key, offset: y - current.offsets[index] } : undefined;
	}, []);
	const followLatest = useCallback(() => {
		following.current = true;
		anchor.current = undefined;
		setNearBottom(true);
		const element = scroller.current;
		if (element) {
			element.scrollTop = element.scrollHeight;
			lastScrollTop.current = element.scrollTop;
		}
		updateViewport();
	}, [updateViewport]);
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const resize = observeConversation(element, heights.current, () => setMeasureVersion((version) => version + 1), updateViewport);
		observer.current = resize;
		return () => { resize.disconnect(); observer.current = undefined; observedRows.current.clear(); };
	}, [updateViewport]);
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		// A stream update can commit before the browser dispatches the user's scroll event.
		const clampedTop = Math.min(lastScrollTop.current, Math.max(0, element.scrollHeight - element.clientHeight));
		if (Math.abs(element.scrollTop - clampedTop) > 0.5) captureScroll(element);
		const mountedRows = new Set(element.querySelectorAll<HTMLElement>(".virtual-message"));
		for (const row of observedRows.current) if (!mountedRows.has(row)) observer.current?.unobserve(row);
		let measured = false;
		for (const row of mountedRows) {
			if (observedRows.current.has(row)) continue;
			observer.current?.observe(row);
			const id = row.dataset.messageId;
			const height = row.getBoundingClientRect().height;
			if (id && height > 0 && heights.current.get(id) !== height) {
				heights.current.set(id, height);
				measured = true;
			}
		}
		observedRows.current = mountedRows;
		// Replace spacer estimates before the newly mounted rows can move visible content for a frame.
		if (measured) {
			setMeasureVersion((version) => version + 1);
			return;
		}
		if (rowsStart.current) origin.current = rowsStart.current.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
		if (following.current) element.scrollTop = element.scrollHeight;
		else if (anchor.current) {
			const index = rowIndexes.get(anchor.current.id);
			if (index !== undefined) element.scrollTop = origin.current + offsets[index] + anchor.current.offset;
			else {
				const previousKey = anchor.current.id;
				const regrouped = rows.findIndex((row) => row.kind === "activity" && row.items.some((item) => item.key === previousKey || `activity:${item.key}` === previousKey));
				if (regrouped >= 0) {
					anchor.current = { id: rows[regrouped].key, offset: 0 };
					element.scrollTop = origin.current + offsets[regrouped];
				}
			}
		}
		lastScrollTop.current = element.scrollTop;
		geometry.current = { rows, offsets };
		updateViewport();
	}, [rows, offsets, rowIndexes, start, end, topInset, fallback, latestError, viewport.height, captureScroll, updateViewport]);
	const searchableRows = useMemo(() => {
		if (!findOpen) return [];
		return rows.map((row) => ({
			key: row.key,
			text:
				row.kind === "message"
					? extractMessageSearchText(row.message, row.tools)
					: row.kind === "activity"
						? extractActivitySearchText(row)
						: "",
		}));
	}, [findOpen, rows]);
	const findMatches = useMemo(() => (findOpen ? collectConversationMatches(searchableRows, findQuery) : []), [findOpen, searchableRows, findQuery]);
	const clampedFindIndex = findMatches.length > 0 ? Math.min(findIndex, findMatches.length - 1) : 0;
	const activeFindMatch = findMatches[clampedFindIndex];
	useEffect(() => {
		if (!findOpen) {
			clearConversationHighlights();
			return;
		}
		if (!activeFindMatch) return;
		const element = scroller.current;
		if (!element) return;
		const rowTop = origin.current + (geometry.current.offsets[activeFindMatch.rowIndex] ?? 0);
		following.current = false;
		pendingRangeScroll.current = true;
		element.scrollTop = Math.max(0, rowTop - Math.round(element.clientHeight * 0.28));
		captureScroll(element);
		updateViewport();
	}, [findOpen, activeFindMatch?.rowKey, activeFindMatch?.occurrenceInRow, findJumpNonce, captureScroll, updateViewport]);
	useEffect(() => {
		if (!findOpen) {
			clearConversationHighlights();
			return;
		}
		const currentRange = applyConversationHighlights(scroller.current, findQuery, activeFindMatch);
		if (currentRange && pendingRangeScroll.current && scroller.current) {
			pendingRangeScroll.current = false;
			const scrollerRect = scroller.current.getBoundingClientRect();
			const rangeRect = currentRange.getBoundingClientRect();
			if (rangeRect.height > 0 && (rangeRect.top < scrollerRect.top + 56 || rangeRect.bottom > scrollerRect.bottom - 32)) {
				scroller.current.scrollTop += rangeRect.top - scrollerRect.top - Math.round(scrollerRect.height * 0.34);
				captureScroll(scroller.current);
				updateViewport();
			}
		}
		return () => { clearConversationHighlights(); };
	}, [findOpen, findQuery, activeFindMatch, start, end, rows, captureScroll, updateViewport]);
	useLayoutEffect(() => {
		if (lastFollowRequest.current === followRequest) return;
		lastFollowRequest.current = followRequest;
		followLatest();
	}, [followRequest, followLatest]);
	return <>
		{findOpen && <ConversationFindBar
			query={findQuery}
			total={findMatches.length}
			activeIndex={clampedFindIndex}
			focusToken={findFocusToken}
			onQueryChange={(value) => { setFindQuery(value); setFindIndex(0); setFindJumpNonce((n) => n + 1); }}
			onNext={() => { if (!findMatches.length) return; setFindIndex((current) => (current + 1) % findMatches.length); setFindJumpNonce((n) => n + 1); }}
			onPrev={() => { if (!findMatches.length) return; setFindIndex((current) => (current - 1 + findMatches.length) % findMatches.length); setFindJumpNonce((n) => n + 1); }}
			onClose={() => { clearConversationHighlights(); onCloseFind?.(); }}
		/>}
		<div className="conversation virtual-conversation" ref={scroller} onScroll={() => {
			const element = scroller.current;
			if (!element) return;
			if (Math.abs(element.scrollTop - lastScrollTop.current) <= 0.5) return;
			captureScroll(element);
			updateViewport();
			if (element.scrollTop < 160 && history?.before && !loading && !error) void onLoadOlder?.();
		}}>
			<div className="conversation-content">
				{topInset > 0 && <div className="history-control" aria-live="polite">{error ? <><span>{error}</span><button type="button" onClick={() => { void onLoadOlder?.(); }}>再試行</button></> : loading ? "過去のメッセージを読み込んでいます…" : <button type="button" onClick={() => { void onLoadOlder?.(); }}>過去のメッセージを読み込む</button>}</div>}
				{fallback && <article className="message role-user"><div className="message-content"><Content value={fallback} onFile={openFile} /></div></article>}
				<div ref={rowsStart} className="history-spacer" aria-hidden="true" style={{ height: offsets[start] }} />
				{rows.slice(start, end).map((row) => row.kind === "computer"
					? <div key={row.key} className="virtual-message" data-message-id={row.key}><ComputerActivity group={row.group} onFile={openFile} /></div>
					: row.kind === "activity" ? <ActivityBlock key={row.key} block={row} onFile={openFile} expansions={expansions.current} opened={openedActivity.current} />
					: <Message key={row.key} rowKey={row.key} message={row.message} tools={row.tools} surfacesByCallId={surfacesByCallId} onSurfaceAction={onSurfaceAction} onFile={openFile} expansions={expansions.current} changes={changesByRow.get(row.key)}
						onRetry={onRetry && row.key === lastAssistantKey ? retryMessage : undefined}
						onEdit={onEdit ? editMessage : undefined} />)}
				<div className="history-spacer" aria-hidden="true" style={{ height: total - offsets[end] }} />
				{unanchoredSurfaces.map((surface) => {
					if (surface.kind === "action_plan" && onSurfaceAction)
						return <ActionPlanCard key={surface.surfaceId} surface={surface} onAction={onSurfaceAction} onFile={openFile} />;
					if (surface.kind === "split_proposal" && onSurfaceAction)
						return <SplitProposalCard key={surface.surfaceId} surface={surface} onAction={onSurfaceAction} onSelectSession={onSelectSession} />;
					if (surface.kind === "split_notice")
						return <SplitNoticeCard key={surface.surfaceId} surface={surface} onSelectSession={onSelectSession} />;
					if (surface.kind === "pr_lifecycle" && onSurfaceAction)
						return <PrLifecycleCard key={surface.surfaceId} surface={surface} onAction={onSurfaceAction} onFile={openFile} />;
					return null;
				})}
				<Presence show={!!latestError} collapse><div className="run-error" role="alert"><strong>応答を取得できませんでした</strong><details><summary>エラーの詳細</summary><pre>{latestError}</pre></details></div></Presence>
			</div>
		</div>
		<Presence show={!nearBottom}><button className="back-to-bottom" aria-label="最新のメッセージへ" title="最新のメッセージへ" onClick={followLatest}><Icon name="send" style={{ transform: "rotate(180deg)" }} /></button></Presence>
	</>;
});
