import { record } from "./Content.tsx";
import type { ConversationRow } from "./computer-activity.ts";
import type { ToolCall } from "./types.ts";

type MessageRow = Extract<ConversationRow, { kind: "message" }>;

export interface TurnActivity {
	kind: "activity";
	key: string;
	runId?: string;
	items: ConversationRow[];
	active: boolean;
}

const labels: Record<string, { running: string; summary: string }> = {
	read: { running: "ファイルを確認中", summary: "ファイル確認" },
	edit: { running: "ファイルを編集中", summary: "編集" },
	write: { running: "ファイルを書き込み中", summary: "書き込み" },
	bash: { running: "コマンドを実行中", summary: "コマンド実行" },
	terminal: { running: "端末で実行中", summary: "端末操作" },
	web_search: { running: "ウェブを検索中", summary: "ウェブ検索" },
	browser: { running: "ブラウザーを操作中", summary: "ブラウザー操作" },
	team: { running: "チームと連携中", summary: "チーム連携" },
};

function activityLabel(name: string, input?: unknown): string {
	const args = record(input) ? input : undefined;
	const label = Object.hasOwn(labels, name) ? labels[name].running : `${name} を実行中`;
	const path = typeof args?.path === "string" ? args.path.split(/[\\/]/).at(-1) : undefined;
	const target = path ?? (name === "web_search" && typeof args?.query === "string" ? args.query : undefined);
	return target ? `${label} · ${target.trim().replace(/\s+/g, " ").slice(0, 80)}` : label;
}

export function turnActivityLabel(block: TurnActivity): string {
	const tools = block.items
		.flatMap((row) => (row.kind === "message" ? row.tools : row.group.tools))
		.filter((tool): tool is ToolCall => tool !== undefined);
	if (block.active) {
		const running = tools.findLast((tool) => tool.status === "running");
		if (running) return activityLabel(running.name, running.input);
		const last = block.items.at(-1);
		if (last?.kind === "message" && last.message.partial && Array.isArray(last.message.content)) {
			const part: unknown = last.message.content.at(-1);
			if (
				record(part) &&
				part.type === "toolCall" &&
				typeof part.name === "string" &&
				last.tools.at(-1) === undefined
			)
				return `${part.name} を準備中…`;
		}
		return "思考中…";
	}
	const counts = new Map<string, number>();
	for (const tool of tools) {
		const label = Object.hasOwn(labels, tool.name) ? labels[tool.name].summary : "ツール実行";
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const failed = tools.filter((tool) => tool.status === "error").length;
	const cancelled = tools.filter((tool) => tool.status === "cancelled" || tool.status === "incomplete").length;
	const summary = [...counts].map(([label, count]) => `${label} ${count}件`);
	if (failed) summary.push(`失敗 ${failed}件`);
	if (cancelled) summary.push(`未完了 ${cancelled}件`);
	return summary.join(" · ") || "思考";
}

function isCommentary(part: unknown): boolean {
	if (!record(part) || part.type !== "text" || typeof part.textSignature !== "string") return false;
	try {
		const signature: unknown = JSON.parse(part.textSignature);
		return record(signature) && signature.phase === "commentary";
	} catch {
		return false;
	}
}

function isInteractivePlanCall(part: unknown, tool: ToolCall | undefined): boolean {
	const name = tool?.name ?? (record(part) && typeof part.name === "string" ? part.name : undefined);
	if (name !== "action_plan") return false;
	const input =
		tool && record(tool.input) ? tool.input : record(part) && record(part.arguments) ? part.arguments : undefined;
	return input?.action === "propose";
}

function isActivityPart(part: unknown, tool: ToolCall | undefined): boolean {
	if (!record(part)) return false;
	if (part.type === "thinking") return true;
	if (part.type === "toolCall") return !isInteractivePlanCall(part, tool);
	return false;
}

/** Group adjacent thinking and tool calls. Prose, context, interactive plan cards, and the computer viewer stay in the timeline. */
export function turnActivityRows(rows: ConversationRow[], activeRunId?: string): (ConversationRow | TurnActivity)[] {
	const output: (ConversationRow | TurnActivity)[] = [];
	let current: TurnActivity | undefined;
	let tailRunId: string | undefined;
	let tail: "activity" | "commentary" | "text" | "computer" | "other" = "other";
	for (const row of rows) {
		if (row.kind === "computer") {
			output.push(row);
			current = undefined;
			tail = row.group.live ? "computer" : "other";
			tailRunId = row.group.runId;
			continue;
		}
		const { message } = row;
		tailRunId = message.runId;
		const parts: unknown = message.content;
		if (
			message.role !== "assistant" ||
			message.contextInjection ||
			message.importedContext ||
			!Array.isArray(parts)
		) {
			output.push(row);
			current = undefined;
			tail = message.role === "assistant" ? "text" : "other";
			continue;
		}
		let index = 0;
		let callIndex = 0;
		for (; index < parts.length; ) {
			const first: unknown = parts[index];
			if (record(first) && first.type === "text" && typeof first.text === "string" && !first.text.trim()) {
				index++;
				continue;
			}
			const peekTool = record(first) && first.type === "toolCall" ? row.tools[callIndex] : undefined;
			const work = isActivityPart(first, peekTool);
			const from = index;
			const tools: MessageRow["tools"] = [];
			const content: unknown[] = [];
			for (; index < parts.length; index++) {
				const part: unknown = parts[index];
				if (record(part) && part.type === "text" && typeof part.text === "string" && !part.text.trim()) continue;
				const nextTool = record(part) && part.type === "toolCall" ? row.tools[callIndex] : undefined;
				const activityPart = isActivityPart(part, nextTool);
				if (activityPart !== work) break;
				if (record(part) && part.type === "toolCall") {
					const tool = row.tools[callIndex++];
					if (tool?.name === "computer" || tool?.name === "jev_computer") continue;
					tools.push(tool);
				}
				content.push(part);
			}
			if (!content.length) continue;
			const key = `${row.key}:${from}`;
			const segment: MessageRow = { ...row, key, tools, message: { ...message, content } };
			if (work) {
				if (!current || current.runId !== message.runId) {
					current = { kind: "activity", key: `activity:${key}`, runId: message.runId, items: [], active: false };
					output.push(current);
				}
				current.items.push(segment);
				tail = "activity";
			} else {
				output.push(segment);
				current = undefined;
				tail = content.every(isCommentary) ? "commentary" : "text";
			}
		}
	}
	if (activeRunId && current?.runId === activeRunId) current.active = true;
	else if (activeRunId && (tailRunId !== activeRunId || (tail !== "text" && tail !== "computer"))) {
		output.push({
			kind: "activity",
			key: `activity:waiting:${activeRunId}`,
			runId: activeRunId,
			items: [],
			active: true,
		});
	}
	// Once a reply is complete, consolidate the preceding activity and progress messages
	// from the same run without crossing user messages or imported context.
	const settled: (ConversationRow | TurnActivity)[] = [];
	let start = 0;
	while (start < output.length) {
		const first = output[start];
		const runId =
			first.kind === "computer"
				? first.group.runId
				: first.kind === "activity"
					? first.runId
					: first.message.role === "assistant" && !first.message.contextInjection && !first.message.importedContext
						? first.message.runId
						: undefined;
		if (!runId || runId === activeRunId) {
			settled.push(first);
			start++;
			continue;
		}
		let end = start;
		while (end < output.length) {
			const row = output[end];
			const id =
				row.kind === "computer"
					? row.group.runId
					: row.kind === "activity"
						? row.runId
						: row.message.role === "assistant" && !row.message.contextInjection && !row.message.importedContext
							? row.message.runId
							: undefined;
			if (id !== runId) break;
			end++;
		}
		const group = output.slice(start, end);
		const last = group.at(-1);
		const final =
			last?.kind === "message" &&
			!last.message.partial &&
			((typeof last.message.content === "string" && !!last.message.content.trim()) ||
				(Array.isArray(last.message.content) &&
					last.message.content.some(
						(part) =>
							record(part) &&
							part.type === "text" &&
							typeof part.text === "string" &&
							part.text.trim() &&
							!isCommentary(part),
					)));
		const previous = group.slice(0, -1);
		if (final && previous.length) {
			const items = previous.flatMap((row): ConversationRow[] => (row.kind === "activity" ? row.items : [row]));
			if (items.length)
				settled.push({ kind: "activity", key: `activity:${items[0].key}`, runId, items, active: false });
			settled.push(last);
		} else settled.push(...group);
		start = end;
	}
	return settled;
}
