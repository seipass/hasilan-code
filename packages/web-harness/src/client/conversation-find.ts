import { record } from "./Content.tsx";
import { messageText } from "./MessageActions.tsx";
import { type TurnActivity, turnActivityLabel } from "./turn-activity.ts";
import type { ChatMessage, ToolCall } from "./types.ts";

export interface ConversationMatch {
	rowKey: string;
	rowIndex: number;
	occurrenceInRow: number;
}

export interface SearchableRow {
	key: string;
	text: string;
}

interface HighlightConstructor {
	new (...ranges: AbstractRange[]): unknown;
}

interface HighlightRegistry {
	set(name: string, highlight: unknown): void;
	delete(name: string): void;
}

const ALL_HIGHLIGHT = "conversation-find-all";
const CURRENT_HIGHLIGHT = "conversation-find-current";

function highlightApi(): { HighlightCtor: HighlightConstructor; registry: HighlightRegistry } | undefined {
	if (typeof CSS === "undefined" || typeof globalThis === "undefined") return undefined;
	const cssWithHighlights = CSS as unknown as { highlights?: HighlightRegistry };
	const ctor = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
	if (!cssWithHighlights.highlights || typeof ctor !== "function") return undefined;
	return { HighlightCtor: ctor, registry: cssWithHighlights.highlights };
}

export function clearConversationHighlights(): void {
	const api = highlightApi();
	if (!api) return;
	api.registry.delete(ALL_HIGHLIGHT);
	api.registry.delete(CURRENT_HIGHLIGHT);
}

function extractThinkingText(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (!record(part)) continue;
		if (part.type === "thinking") {
			if (typeof part.thinking === "string" && part.thinking) parts.push(part.thinking);
			if (typeof part.summary === "string" && part.summary) parts.push(part.summary);
		} else if (part.type === "fileAttachment" && typeof part.name === "string") {
			parts.push(part.name);
		}
	}
	return parts;
}

function extractToolText(tools: readonly (ToolCall | undefined)[]): string[] {
	const parts: string[] = [];
	for (const tool of tools) {
		if (!tool) continue;
		parts.push(tool.name);
		if (record(tool.input)) {
			for (const field of ["path", "command", "query", "url", "action"] as const) {
				const value = tool.input[field];
				if (typeof value === "string" && value) parts.push(value);
			}
		}
	}
	return parts;
}

export function extractMessageSearchText(message: ChatMessage, tools: readonly (ToolCall | undefined)[]): string {
	const chunks: string[] = [];
	const plain = messageText(message.content);
	if (plain) chunks.push(plain);
	if (message.contextInjection) {
		chunks.push(message.contextInjection.source.agentName);
		const injected = messageText(message.contextInjection.content);
		if (injected) chunks.push(injected);
	}
	chunks.push(...extractThinkingText(message.content));
	chunks.push(...extractToolText(tools));
	return chunks.join("\n");
}

export function extractActivitySearchText(block: TurnActivity): string {
	const chunks = [turnActivityLabel(block)];
	for (const item of block.items) {
		if (item.kind === "message") {
			const text = extractMessageSearchText(item.message, item.tools);
			if (text) chunks.push(text);
		}
	}
	return chunks.join("\n");
}

export function collectConversationMatches(rows: readonly SearchableRow[], rawQuery: string): ConversationMatch[] {
	const query = rawQuery.trim().toLocaleLowerCase();
	if (!query) return [];
	const matches: ConversationMatch[] = [];
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
		const row = rows[rowIndex];
		const haystack = row.text.toLocaleLowerCase();
		if (!haystack) continue;
		let offset = 0;
		let occurrenceInRow = 0;
		for (;;) {
			const found = haystack.indexOf(query, offset);
			if (found < 0) break;
			matches.push({ rowKey: row.key, rowIndex, occurrenceInRow });
			occurrenceInRow++;
			offset = found + query.length;
		}
	}
	return matches;
}

function collectRowRanges(rowElement: HTMLElement, lowerQuery: string): Range[] {
	const ranges: Range[] = [];
	const doc = rowElement.ownerDocument;
	const walker = doc.createTreeWalker(rowElement, NodeFilter.SHOW_TEXT);
	let current = walker.nextNode();
	while (current) {
		const parent = current.parentElement;
		if (
			parent &&
			!parent.closest(".message-meta, .message-actions, .sr-only, .conversation-find-bar") &&
			current.nodeValue
		) {
			const text = current.nodeValue.toLocaleLowerCase();
			let offset = 0;
			for (;;) {
				const found = text.indexOf(lowerQuery, offset);
				if (found < 0) break;
				const range = doc.createRange();
				range.setStart(current, found);
				range.setEnd(current, found + lowerQuery.length);
				ranges.push(range);
				offset = found + lowerQuery.length;
			}
		}
		current = walker.nextNode();
	}
	return ranges;
}

/** Highlights rendered matches using CSS Custom Highlight API without mutating React DOM. */
export function applyConversationHighlights(
	container: HTMLElement | null,
	rawQuery: string,
	activeMatch: ConversationMatch | undefined,
): Range | undefined {
	clearConversationHighlights();
	const query = rawQuery.trim().toLocaleLowerCase();
	if (!container || !query) return undefined;
	const api = highlightApi();
	const allRanges: Range[] = [];
	let currentRange: Range | undefined;
	const rows = container.querySelectorAll<HTMLElement>(".virtual-message[data-message-id]");
	for (const row of rows) {
		const rowKey = row.dataset.messageId;
		const rowRanges = collectRowRanges(row, query);
		allRanges.push(...rowRanges);
		if (activeMatch && rowKey === activeMatch.rowKey && rowRanges.length > 0) {
			currentRange = rowRanges[Math.min(activeMatch.occurrenceInRow, rowRanges.length - 1)];
		}
	}
	if (api && allRanges.length > 0) {
		api.registry.set(ALL_HIGHLIGHT, new api.HighlightCtor(...allRanges));
		if (currentRange) api.registry.set(CURRENT_HIGHLIGHT, new api.HighlightCtor(currentRange));
	}
	return currentRange;
}
