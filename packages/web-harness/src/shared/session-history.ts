import type { ContextInjection } from "./context-injection.ts";
import type { ImportedMessageOrigin } from "./session-import.ts";

export const HISTORY_PAGE_SIZE = 50;

export interface HistoryMessage {
	messageId: string;
	role: string;
	content: unknown;
	partial: boolean;
	runId?: string;
	contextInjection?: ContextInjection;
	importedContext?: boolean;
	importedOrigin?: ImportedMessageOrigin;
}
export interface HistoryTool {
	key: string;
	sessionId: string;
	runId?: string;
	callId: string;
	name: string;
	input: unknown;
	result?: unknown;
	status: "running" | "success" | "error" | "cancelled" | "incomplete";
	sourceStatus?: string;
	importedOrigin?: ImportedMessageOrigin;
}
export interface HistoryPosition {
	start: number;
	total: number;
	before?: string;
}
export interface HistorySource {
	sessionId: string;
	messages: HistoryMessage[];
	toolCalls: HistoryTool[];
	history?: HistoryPosition;
}
export interface HistoryPatch<T extends HistorySource = HistorySource> {
	metadata: Partial<Omit<T, "messages" | "toolCalls" | "history">>;
	removedMetadata: string[];
	messages: { index: number; message: HistoryMessage }[];
	toolCalls: HistoryTool[];
	removedTools: string[];
	total: number;
}
export interface HistoryBaseline {
	messages: HistoryMessage[];
	tools: Map<string, HistoryTool>;
	metadata: Map<string, string | undefined>;
}

export function isHistorySource(value: unknown): value is HistorySource {
	return (
		typeof value === "object" &&
		value !== null &&
		"sessionId" in value &&
		typeof value.sessionId === "string" &&
		"messages" in value &&
		Array.isArray(value.messages) &&
		"toolCalls" in value &&
		Array.isArray(value.toolCalls)
	);
}

export function displayMessages(source: HistorySource): HistoryMessage[] {
	return source.messages.filter((message) => message.contextInjection || message.role !== "toolResult");
}

export class HistoryCursorError extends Error {}

export function historyPage<T extends HistorySource>(source: T, before?: string): T & { history: HistoryPosition } {
	const all = displayMessages(source);
	const end = before === undefined ? all.length : all.findIndex((message) => message.messageId === before);
	if (end < 0) throw new HistoryCursorError("履歴が更新されました。会話を読み込み直してください。");
	const start = Math.max(0, end - HISTORY_PAGE_SIZE);
	const messages = all.slice(start, end);
	const calls = new Set<string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content as unknown[]) {
			if (
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "toolCall" &&
				"id" in part &&
				typeof part.id === "string"
			)
				calls.add(`${message.runId ?? ""}/${part.id}`);
		}
	}
	return {
		...source,
		messages,
		toolCalls: source.toolCalls.filter(
			(tool) =>
				calls.has(`${tool.runId ?? ""}/${tool.callId}`) || (before === undefined && tool.status === "running"),
		),
		history: { start, total: all.length, before: start > 0 ? messages[0]?.messageId : undefined },
	};
}

/** Retain immutable item references, never serialized copies of the entire transcript. */
export function historyBaseline(source: HistorySource): HistoryBaseline {
	const { messages: _messages, toolCalls: _tools, history: _history, ...metadata } = source;
	return {
		messages: displayMessages(source),
		tools: new Map(source.toolCalls.map((tool) => [tool.key, tool])),
		metadata: new Map(Object.entries(metadata).map(([key, value]) => [key, JSON.stringify(value)])),
	};
}

export function historyPatch<T extends HistorySource>(
	baseline: HistoryBaseline,
	source: T,
	next = historyBaseline(source),
): HistoryPatch<T> | undefined {
	const messages = next.messages;
	if (
		messages.length < baseline.messages.length ||
		baseline.messages.some((message, index) => message.messageId !== messages[index]?.messageId)
	)
		return undefined;
	const { messages: _messages, toolCalls: _tools, history: _history, ...metadata } = source;
	return {
		metadata: Object.fromEntries(
			Object.entries(metadata).filter(
				([key, value]) => value !== undefined && next.metadata.get(key) !== baseline.metadata.get(key),
			),
		) as HistoryPatch<T>["metadata"],
		removedMetadata: [...baseline.metadata.keys()].filter(
			(key) => baseline.metadata.get(key) !== undefined && next.metadata.get(key) === undefined,
		),
		messages: messages.flatMap((message, index) =>
			baseline.messages[index] === message ? [] : [{ index, message }],
		),
		toolCalls: source.toolCalls.filter((tool) => baseline.tools.get(tool.key) !== tool),
		removedTools: [...baseline.tools.keys()].filter((key) => !next.tools.has(key)),
		total: messages.length,
	};
}

export function applyHistoryPatch<T extends HistorySource>(current: T, patch: HistoryPatch<T>): T {
	const metadata = { ...current, ...patch.metadata };
	for (const key of patch.removedMetadata) Reflect.deleteProperty(metadata, key);
	const start = current.history?.start ?? 0;
	let messages = current.messages;
	for (const change of patch.messages) {
		if (change.index < start) continue;
		if (messages === current.messages) messages = messages.slice();
		messages[change.index - start] = change.message;
	}
	let toolCalls = current.toolCalls;
	if (patch.toolCalls.length || patch.removedTools.length) {
		const tools = new Map(toolCalls.map((tool) => [tool.key, tool]));
		for (const key of patch.removedTools) tools.delete(key);
		for (const tool of patch.toolCalls) tools.set(tool.key, tool);
		toolCalls = [...tools.values()];
	}
	return {
		...metadata,
		messages,
		toolCalls,
		history: { ...current.history, start, total: patch.total },
	} as T;
}

/** A page can race with streaming; already loaded rows always win over its older snapshot. */
export function prependHistory<T extends HistorySource>(current: T, page: HistorySource): T {
	if (
		!current.history ||
		!page.history ||
		current.sessionId !== page.sessionId ||
		current.history.before !== current.messages[0]?.messageId ||
		page.history.start + page.messages.length !== current.history.start
	)
		return current;
	const tools = new Map(page.toolCalls.map((tool) => [tool.key, tool]));
	for (const tool of current.toolCalls) tools.set(tool.key, tool);
	return {
		...current,
		messages: [...page.messages, ...current.messages],
		toolCalls: [...tools.values()],
		history: { ...page.history, total: current.history.total },
	};
}

/** Retain older loaded pages across a reconnect only when the new tail proves continuity. */
export function reconcileHistory<T extends HistorySource>(previous: T, snapshot: T): T {
	if (
		!previous.history ||
		!snapshot.history ||
		previous.sessionId !== snapshot.sessionId ||
		snapshot.history.total < previous.history.total
	)
		return snapshot;
	const prefix = snapshot.history.start - previous.history.start;
	if (prefix < 0 || prefix >= previous.messages.length) return snapshot;
	const overlap = Math.min(previous.messages.length - prefix, snapshot.messages.length);
	if (
		!overlap ||
		snapshot.messages
			.slice(0, overlap)
			.some((message, index) => message.messageId !== previous.messages[prefix + index]?.messageId)
	)
		return snapshot;
	const tools = new Map(previous.toolCalls.map((tool) => [tool.key, tool]));
	for (const tool of snapshot.toolCalls) tools.set(tool.key, tool);
	return {
		...snapshot,
		messages: [...previous.messages.slice(0, prefix), ...snapshot.messages],
		toolCalls: [...tools.values()],
		history: { ...snapshot.history, start: previous.history.start, before: previous.history.before },
	};
}
