import { record } from "./Content.tsx";
import type { ChatMessage, ToolCall } from "./types.ts";

export interface ComputerActivityGroup {
	key: string;
	runId?: string;
	tools: ToolCall[];
	live: boolean;
	released: boolean;
}
export type ConversationRow =
	| { kind: "message"; key: string; message: ChatMessage; tools: (ToolCall | undefined)[] }
	| { kind: "computer"; key: string; group: ComputerActivityGroup };

export function computerDetails(tool: ToolCall): Record<string, unknown> | undefined {
	return record(tool.result) ? (record(tool.result.details) ? tool.result.details : tool.result) : undefined;
}

/** One movable row per release-delimited sequence, keyed independently of the latest assistant message. */
export function conversationRows(messages: ChatMessage[], tools: ToolCall[], activeRunId?: string): ConversationRow[] {
	const toolMap = new Map(tools.map((tool) => [`${tool.runId ?? ""}/${tool.callId}`, tool]));
	const prepared: { row: Extract<ConversationRow, { kind: "message" }>; visible: boolean }[] = [];
	const groups: { group: ComputerActivityGroup; anchor: string }[] = [];
	let current: (typeof groups)[number] | undefined;
	for (const message of messages) {
		if (!message.contextInjection && message.role === "toolResult") continue;
		const parts: unknown[] = Array.isArray(message.content) ? message.content : [];
		const calls = parts.filter((part) => record(part) && part.type === "toolCall");
		const messageTools = calls.map((part) =>
			record(part) ? toolMap.get(`${message.runId ?? ""}/${String(part.id)}`) : undefined,
		);
		const computerTools =
			message.contextInjection || message.importedContext
				? []
				: messageTools.filter(
						(tool): tool is ToolCall => tool?.name === "computer" || tool?.name === "jev_computer",
					);
		for (const tool of computerTools) {
			if (!current || current.group.released || current.group.runId !== tool.runId) {
				current = {
					group: { key: `computer:${tool.key}`, runId: tool.runId, tools: [], live: false, released: false },
					anchor: message.messageId,
				};
				groups.push(current);
			}
			current.group.tools.push(tool);
			current.anchor = message.messageId;
			const input = record(tool.input) ? tool.input : undefined;
			if (
				(input?.action === "release" || tool.name === "jev_computer") &&
				tool.status === "success" &&
				computerDetails(tool)?.released === true
			)
				current.group.released = true;
		}
		const hasBody = parts.some((part) => {
			if (!record(part)) return typeof part !== "string" || !!part.trim();
			if (part.type === "toolCall") return false;
			if (part.type === "text") return typeof part.text === "string" && !!part.text.trim();
			if (part.type === "thinking") return !!part.thinking || !!part.summary || part.redacted === true;
			return true;
		});
		prepared.push({
			row: { kind: "message", key: message.messageId, message, tools: messageTools },
			visible: !computerTools.length || computerTools.length !== calls.length || hasBody,
		});
	}
	const anchored = new Map<string, ComputerActivityGroup[]>();
	for (const { group, anchor } of groups) {
		const last = group.tools.at(-1);
		group.live =
			!group.released &&
			last?.status !== "cancelled" &&
			(group.runId !== undefined ? group.runId === activeRunId : last?.status === "running");
		const entries = anchored.get(anchor) ?? [];
		entries.push(group);
		anchored.set(anchor, entries);
	}
	return prepared.flatMap(({ row, visible }) => [
		...(visible ? [row] : []),
		...(anchored.get(row.key) ?? []).map((group): ConversationRow => ({ kind: "computer", key: group.key, group })),
	]);
}

export interface ComputerFrame {
	tool: ToolCall;
	url: string;
	width: number;
	height: number;
	monitor?: number;
}
export function computerFrames(tools: ToolCall[]): ComputerFrame[] {
	return tools.flatMap((tool): ComputerFrame[] => {
		const details = computerDetails(tool);
		if (details?.mode === "jev" && Array.isArray(details.frames)) {
			return details.frames.flatMap((entry): ComputerFrame[] => {
				if (!record(entry) || typeof entry.frameId !== "string") return [];
				return computerFrames([
					{
						...tool,
						key: `${tool.key}:${entry.frameId}`,
						input: record(entry.input) ? entry.input : {},
						result: { details: entry },
						status: "success",
					},
				]);
			});
		}
		const artifact = details && record(details.artifact) ? details.artifact : undefined;
		if (
			tool.status !== "success" ||
			typeof artifact?.id !== "string" ||
			!artifact.id ||
			typeof details?.width !== "number" ||
			!Number.isInteger(details.width) ||
			details.width <= 0 ||
			details.width > 32768 ||
			typeof details.height !== "number" ||
			!Number.isInteger(details.height) ||
			details.height <= 0 ||
			details.height > 32768
		)
			return [];
		return [
			{
				tool,
				url: `/api/artifacts/${encodeURIComponent(artifact.id)}`,
				width: details.width,
				height: details.height,
				monitor: typeof details.monitor === "number" ? details.monitor : undefined,
			},
		];
	});
}

const ACTIONS: Record<string, string> = {
	screens: "画面を確認",
	screenshot: "画面を取得",
	move: "ポインターを移動",
	click: "クリック",
	drag: "ドラッグ",
	scroll: "スクロール",
	type: "文字を入力",
	press: "キーを入力",
	release: "操作を終了",
};
export function computerAction(tool: ToolCall): string {
	const input = record(tool.input) ? tool.input : {};
	const action = typeof input.action === "string" ? input.action : "";
	if (action === "type" && typeof input.text === "string") return `文字を入力 · ${[...input.text].length}文字`;
	if (action === "press" && typeof input.key === "string") {
		const modifiers = Array.isArray(input.modifiers)
			? input.modifiers
					.filter((value): value is string => typeof value === "string" && value.length > 0)
					.map((value) => (value === "cmd" ? "⌘" : value[0].toUpperCase() + value.slice(1)))
			: [];
		return [...modifiers, input.key.length === 1 ? input.key.toUpperCase() : input.key].join(" + ");
	}
	if (action === "click")
		return input.button === "right"
			? "右クリック"
			: input.button === "middle"
				? "中クリック"
				: input.count === 2
					? "ダブルクリック"
					: "クリック";
	if (action === "scroll")
		return `${({ up: "上", down: "下", left: "左", right: "右" } as Record<string, string>)[String(input.direction)] ?? ""}にスクロール`;
	return ACTIONS[action] ?? "デスクトップ操作";
}

export function computerPointer(
	tool: ToolCall,
	frames: ComputerFrame[],
): { x: number; y: number; toX?: number; toY?: number } | undefined {
	if (tool.status !== "success" && tool.status !== "running") return undefined;
	const input = record(tool.input) ? tool.input : undefined;
	const before = frames.find((frame) => computerDetails(frame.tool)?.frameId === input?.frameId);
	if (
		!before ||
		typeof input?.x !== "number" ||
		typeof input.y !== "number" ||
		!Number.isFinite(input.x) ||
		!Number.isFinite(input.y) ||
		input.x < 0 ||
		input.x >= before.width ||
		input.y < 0 ||
		input.y >= before.height
	)
		return undefined;
	const pointer = { x: (input.x / before.width) * 100, y: (input.y / before.height) * 100 };
	return input.action === "drag" &&
		typeof input.toX === "number" &&
		typeof input.toY === "number" &&
		Number.isFinite(input.toX) &&
		Number.isFinite(input.toY) &&
		input.toX >= 0 &&
		input.toX < before.width &&
		input.toY >= 0 &&
		input.toY < before.height
		? { ...pointer, toX: (input.toX / before.width) * 100, toY: (input.toY / before.height) * 100 }
		: pointer;
}
