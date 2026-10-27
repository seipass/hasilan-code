import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HistoryPosition } from "../shared/session-history.ts";
import { ComputerActivity } from "./ComputerActivity.tsx";
import { conversationRows } from "./computer-activity.ts";
import { Presence } from "./Motion.tsx";
import { Content, record } from "./Content.tsx";
import { observeConversation } from "./conversation-resize.ts";
import { RUN_LABELS } from "./TeamPane.tsx";
import { ToolCard } from "./ToolInspector.tsx";
import type { ChatMessage, ToolCall } from "./types.ts";
import "./Conversation.css";

const ESTIMATED_HEIGHT = 220;
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

interface MessageProps {
	message: ChatMessage;
	tools: (ToolCall | undefined)[];
	onFile: (path: string, line?: number) => void;
	expansions: Map<string, boolean[]>;
}
const Message = memo(function Message({ message, tools, onFile, expansions }: MessageProps) {
	const element = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const row = element.current;
		if (!row) return;
		const saved = expansions.get(message.messageId);
		if (saved) row.querySelectorAll("details").forEach((details, index) => { details.open = saved[index] ?? details.open; });
		const remember = () => expansions.set(message.messageId, [...row.querySelectorAll("details")].map((details) => details.open));
		row.addEventListener("toggle", remember, true);
		return () => row.removeEventListener("toggle", remember, true);
	}, [message.messageId, expansions]);
	const injection = message.contextInjection;
	const parts: unknown[] = Array.isArray(message.content) ? message.content : [];
	const calls = parts.filter((part) => record(part) && part.type === "toolCall");
	const content = calls.length ? parts.filter((part) => !record(part) || part.type !== "toolCall") : message.content;
	return <div ref={element} className="virtual-message" data-message-id={message.messageId}>
		{injection ? <details className="message context-entry">
			<summary><span className="context-entry-label">コンテキスト</span><span className="context-entry-agent">{injection.source.agentName}</span>{injection.source.status && <span className={`badge status-${injection.source.status}`}>{RUN_LABELS[injection.source.status]}</span>}</summary>
			<div className="context-entry-body"><div className="message-content"><Content value={injection.content} onFile={onFile} /></div>
				<dl className="context-entry-source"><dt>通知元</dt><dd>{injection.source.type === "team_message" ? "エージェント間メッセージ" : "サブエージェントの完了通知"}</dd><dt>エージェント ID</dt><dd><code>{injection.source.agentId}</code></dd>{injection.source.runId && <><dt>実行 ID</dt><dd><code>{injection.source.runId}</code></dd></>}<dt>コンテキスト ID</dt><dd><code>{injection.injectionId}</code></dd></dl>
			</div>
		</details> : message.importedContext ? <details className="message context-entry"><summary><span className="context-entry-label">参照履歴</span></summary><div className="context-entry-body"><div className="message-content"><Content value={message.content} onFile={onFile} /></div></div></details> :
			<article className={`message role-${message.role} ${message.partial ? "partial" : ""}`}>
				{message.role !== "assistant" && message.role !== "user" && message.role !== "system" && <div className="message-label">{message.role}</div>}
				<div className="message-content"><Content value={content} onFile={onFile} />{calls.map((part, index) => {
					const tool = tools[index];
					if (tool?.name === "computer") return null;
					return tool ? <ToolCard key={tool.key} tool={tool} onFile={onFile} /> : <p key={index} className="tool-preparing">{record(part) && typeof part.name === "string" ? part.name : "ツール"} を準備中…</p>;
				})}{message.partial && <span className="streaming-dot" aria-label="応答中" />}</div>
			</article>}
	</div>;
}, (previous, next) => previous.message === next.message && previous.onFile === next.onFile && previous.expansions === next.expansions && previous.tools.length === next.tools.length && previous.tools.every((tool, index) => tool === next.tools[index]));

export const Conversation = memo(function Conversation({ messages: allMessages, tools, activeRunId, history, loading, error, onLoadOlder, onFile, followRequest, fallback, latestError }: {
	messages: ChatMessage[];
	tools: ToolCall[];
	activeRunId?: string;
	history?: HistoryPosition;
	loading?: boolean;
	error?: string;
	onLoadOlder?: () => Promise<void>;
	onFile: (path: string, line?: number) => void;
	followRequest: number;
	fallback?: string;
	latestError?: string;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const heights = useRef(new Map<string, number>());
	const expansions = useRef(new Map<string, boolean[]>());
	const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
	const following = useRef(true);
	const programmaticTop = useRef(-1);
	const origin = useRef(24);
	const observer = useRef<ResizeObserver | undefined>(undefined);
	const fileCallback = useRef(onFile);
	fileCallback.current = onFile;
	const openFile = useCallback((path: string, line?: number) => fileCallback.current(path, line), []);
	const [measureVersion, setMeasureVersion] = useState(0);
	const [viewport, setViewport] = useState({ top: 0, height: 600 });
	const [nearBottom, setNearBottom] = useState(true);
	const rows = useMemo(() => conversationRows(allMessages, tools, activeRunId), [allMessages, tools, activeRunId]);
	const offsets = useMemo(() => {
		const result = [0];
		for (const row of rows) result.push(result[result.length - 1] + (heights.current.get(row.key) ?? (row.kind === "computer" ? 430 : ESTIMATED_HEIGHT)));
		return result;
	}, [rows, measureVersion]);
	const total = offsets[offsets.length - 1];
	const topInset = history?.before || loading || error ? 40 : 0;
	const top = following.current ? Math.max(0, total - viewport.height) : Math.max(0, viewport.top - origin.current - topInset);
	const start = Math.max(0, rowAt(offsets, Math.max(0, top - OVERSCAN)));
	const end = Math.min(rows.length, rowAt(offsets, top + viewport.height + OVERSCAN) + 1);
	const geometry = useRef({ rows, offsets, topInset });
	geometry.current = { rows, offsets, topInset };
	const updateViewport = useCallback(() => {
		const element = scroller.current;
		if (!element) return;
		setViewport((previous) => previous.top === element.scrollTop && previous.height === element.clientHeight ? previous : { top: element.scrollTop, height: element.clientHeight });
	}, []);
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		if (content.current) origin.current = content.current.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
		if (following.current) element.scrollTop = element.scrollHeight;
		else if (anchor.current) {
			const index = rows.findIndex((row) => row.key === anchor.current?.id);
			if (index >= 0) element.scrollTop = origin.current + topInset + offsets[index] + anchor.current.offset;
			else { following.current = true; element.scrollTop = element.scrollHeight; setNearBottom(true); }
		}
		programmaticTop.current = element.scrollTop;
		updateViewport();
	}, [rows, offsets, topInset, viewport.height, updateViewport]);
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const resize = observeConversation(element, heights.current, () => setMeasureVersion((version) => version + 1), updateViewport);
		observer.current = resize;
		return () => { resize.disconnect(); observer.current = undefined; };
	}, [updateViewport]);
	useLayoutEffect(() => {
		const resize = observer.current;
		const elements = scroller.current?.querySelectorAll(".virtual-message");
		elements?.forEach((row) => resize?.observe(row));
		return () => elements?.forEach((row) => resize?.unobserve(row));
	}, [start, end, rows]);
	useEffect(() => {
		following.current = true;
		setNearBottom(true);
		if (scroller.current) { scroller.current.scrollTop = scroller.current.scrollHeight; programmaticTop.current = scroller.current.scrollTop; }
		updateViewport();
	}, [followRequest, updateViewport]);
	return <>
		<div className="conversation virtual-conversation" ref={scroller} onScroll={() => {
			const element = scroller.current;
			if (!element) return;
			if (Math.abs(element.scrollTop - programmaticTop.current) > 1) {
				following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
				setNearBottom(following.current);
			}
			const current = geometry.current;
			const y = element.scrollTop - origin.current - current.topInset;
			const index = Math.max(0, rowAt(current.offsets, Math.max(0, y)));
			const row = current.rows[index];
			if (row) anchor.current = { id: row.key, offset: y - current.offsets[index] };
			updateViewport();
			if (element.scrollTop < 160 && history?.before && !loading && !error) void onLoadOlder?.();
		}}>
			<div className="conversation-content" ref={content}>
				{topInset > 0 && <div className="history-control" aria-live="polite">{error ? <><span>{error}</span><button type="button" onClick={() => { void onLoadOlder?.(); }}>再試行</button></> : loading ? "過去のメッセージを読み込んでいます…" : <button type="button" onClick={() => { void onLoadOlder?.(); }}>過去のメッセージを読み込む</button>}</div>}
				{fallback && <article className="message role-user"><div className="message-content"><Content value={fallback} onFile={openFile} /></div></article>}
				<div className="history-spacer" aria-hidden="true" style={{ height: offsets[start] }} />
				{rows.slice(start, end).map((row) => row.kind === "computer"
					? <div key={row.key} className="virtual-message" data-message-id={row.key}><ComputerActivity group={row.group} onFile={openFile} /></div>
					: <Message key={row.key} message={row.message} tools={row.tools} onFile={openFile} expansions={expansions.current} />)}
				<div className="history-spacer" aria-hidden="true" style={{ height: total - offsets[end] }} />
				<Presence show={!!latestError} collapse><div className="run-error" role="alert"><strong>応答を取得できませんでした</strong><details><summary>エラーの詳細</summary><pre>{latestError}</pre></details></div></Presence>
			</div>
		</div>
		<Presence show={!nearBottom}><button className="back-to-bottom" onClick={() => { following.current = true; setNearBottom(true); if (scroller.current) { scroller.current.scrollTop = scroller.current.scrollHeight; programmaticTop.current = scroller.current.scrollTop; } updateViewport(); }}>最新のメッセージへ ↓</button></Presence>
	</>;
});
