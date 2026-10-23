import type { ImportedTranscript, SessionImportMessage } from "../../shared/session-import.ts";
import { addMessage, contentText, type JsonRecord, messageOrigins, record, string, transcript } from "./common.ts";
import { preserveTranscript } from "./fidelity.ts";

function openCodeText(message: JsonRecord, warnings: string[]): string {
	if (typeof message.text === "string" || message.type === "user") {
		return string(message.text) ?? (Array.isArray(message.files) && message.files.length ? "[添付ファイル]" : "");
	}
	if (message.type === "shell")
		return `[端末実行]\n${string(message.command) ?? ""}\n${typeof message.output === "string" ? message.output : JSON.stringify(message.output ?? "")}`;
	const parts = message.parts ?? message.content;
	if (!Array.isArray(parts)) return contentText(parts, warnings);
	return parts
		.map((raw) => {
			const part = record(raw);
			if (part.type !== "tool") return contentText([part], warnings);
			const state = record(part.state);
			return `[ツール記録: ${string(part.name) ?? string(part.tool) ?? "tool"}]\n${JSON.stringify(state.input ?? {})}\n${contentText(state.content, warnings) || string(state.output) || string(state.error) || String(state.status ?? "")}`;
		})
		.filter(Boolean)
		.join("\n");
}

export function parseOpenCode(value: unknown, fallbackId: string, warnings: string[]): ImportedTranscript {
	const data = record(value);
	const info = record(data.info);
	if (!string(info.id) || !Array.isArray(data.messages))
		throw new Error("OpenCode のセッション書き出し形式ではありません。");
	let rows = data.messages.map(record);
	const revert = record(info.revert);
	if (string(revert.messageID)) {
		const boundary = rows.findIndex((row) => (row.id ?? record(row.info).id) === revert.messageID);
		if (boundary < 0) throw new Error("OpenCode の巻き戻し位置が見つかりません。");
		rows = rows.slice(0, boundary);
	}
	const messages: SessionImportMessage[] = [];
	const compactIndex = rows.findLastIndex(
		(row) =>
			row.type === "compaction" && (row.status === "completed" || (row.status === undefined && string(row.summary))),
	);
	if (compactIndex >= 0) {
		const compact = rows[compactIndex];
		const metadata = record(compact.metadata);
		const native = record(compact.native).messages ?? record(compact.providerContext).messages;
		if (Array.isArray(native)) {
			for (const raw of native) {
				const message = record(raw);
				addMessage(
					messages,
					message.role === "user" || message.role === "assistant" ? message.role : "context",
					contentText(message.content, warnings),
					undefined,
					compact,
					message.content,
				);
			}
		} else {
			addMessage(
				messages,
				"context",
				`[会話の要約]\n${string(compact.summary) ?? ""}`,
				record(compact.time).created,
				compact,
			);
			const keep = rows.findIndex((row) => row.id === metadata.keepID);
			if (string(metadata.keepID) && keep < 0)
				throw new Error("OpenCode の要約後に残すメッセージが見つかりません。");
			if (keep >= 0 && keep < compactIndex) {
				for (const row of rows.slice(keep, compactIndex))
					addMessage(messages, "context", openCodeText(row, warnings), record(row.time).created, row);
			} else addMessage(messages, "context", string(metadata.recent) ?? string(compact.recent) ?? "");
		}
		rows = rows.slice(compactIndex + 1);
	}
	for (const row of rows) {
		const legacy = record(row.info);
		const role = row.type ?? legacy.role;
		if (role !== "user" && role !== "assistant" && !["synthetic", "system", "skill", "shell"].includes(String(role)))
			continue;
		if (legacy.summary === true) messages.length = 0;
		const time = record(row.time ?? legacy.time).created;
		addMessage(
			messages,
			role === "user" || role === "assistant" ? role : "context",
			openCodeText(row.type ? row : { ...legacy, parts: row.parts }, warnings),
			time,
			row,
		);
	}
	return preserveTranscript(
		transcript(
			"opencode",
			string(info.id) ?? fallbackId,
			record(info.location).directory ?? info.directory,
			info.title,
			messages,
			warnings,
		),
		[info, ...data.messages.map(record)],
	);
}

function grokConversation(
	items: JsonRecord[],
	messages: SessionImportMessage[],
	warnings: string[],
	origin?: JsonRecord,
): void {
	for (const item of items) {
		const role = item.type ?? item.role;
		if (role === "system") continue;
		if (role === "user" || role === "assistant") {
			addMessage(messages, role, contentText(item.content, warnings), undefined, origin ?? item, item.content);
			if (Array.isArray(item.tool_calls))
				for (const raw of item.tool_calls) {
					const tool = record(raw);
					const fn = record(tool.function);
					addMessage(
						messages,
						"context",
						`[ツール呼び出し: ${string(tool.name) ?? string(fn.name) ?? "tool"}]\n${String(tool.arguments ?? fn.arguments ?? "")}`,
						undefined,
						origin ?? item,
						{ ...fn, ...tool, type: "toolCall" },
					);
				}
		} else if (role === "tool_result" || role === "tool")
			addMessage(
				messages,
				"context",
				`[ツール結果: ${string(item.tool_call_id) ?? "tool"}]\n${contentText(item.content, warnings)}`,
				undefined,
				origin ?? item,
				{ ...item, type: "toolResult" },
			);
	}
}

function grokPromptStarts(entries: JsonRecord[]): Map<number, number> {
	const starts = new Map<number, number>();
	let lastRole: unknown;
	let lastNumber: unknown;
	let numbered = false;
	let legacyCount = 0;
	for (const [index, entry] of entries.entries()) {
		const update = record(record(entry.params).update ?? entry.update);
		const meta = record(update._meta);
		if (meta.hostTurn === true) {
			lastRole = undefined;
			continue;
		}
		if (update.sessionUpdate === "user_message_chunk") {
			if (Number.isSafeInteger(meta.promptIndex)) {
				numbered = true;
				if (meta.promptIndex !== lastNumber) starts.set(Number(meta.promptIndex), index);
				lastNumber = meta.promptIndex;
			} else if (!numbered && lastRole !== "user_message_chunk" && meta.interjection !== true)
				starts.set(legacyCount++, index);
		}
		if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "user_message_chunk")
			lastRole = update.sessionUpdate;
	}
	return starts;
}

export function activeGrokUpdates(updates: JsonRecord[]): JsonRecord[] {
	const filtered: JsonRecord[] = [];
	for (const entry of updates) {
		const update = record(record(entry.params).update ?? entry.update);
		if (update.sessionUpdate === "rewind_marker") {
			const target = update.target_prompt_index;
			if (!Number.isSafeInteger(target) || Number(target) < 0)
				throw new Error("Grok Build の巻き戻し記録が不正です。");
			const start = grokPromptStarts(filtered).get(Number(target));
			if (start === undefined)
				throw new Error("Grok Build の巻き戻し先が見つかりません。完全な updates.jsonl を指定してください。");
			filtered.splice(start);
		} else filtered.push(entry);
	}
	const checkpoint = filtered.findLastIndex(
		(entry) => record(record(entry.params).update ?? entry.update).sessionUpdate === "compaction_checkpoint",
	);
	return filtered.slice(Math.max(0, checkpoint));
}

export function parseGrok(
	updates: JsonRecord[],
	summary: JsonRecord,
	cached: JsonRecord[],
	checkpoints: ReadonlyMap<string, JsonRecord>,
	fallbackId: string,
	warnings: string[],
): ImportedTranscript {
	const info = record(summary.info);
	const filtered = activeGrokUpdates(updates);
	const messages: SessionImportMessage[] = [];
	const toolMessages = new Map<string, SessionImportMessage>();
	const toolStates = new Map<string, JsonRecord>();
	let lastChunk = "";
	let lastPrompt: unknown;
	for (const entry of filtered) {
		const update = record(record(entry.params).update ?? entry.update);
		const meta = record(update._meta);
		if (meta.hostTurn === true) {
			lastChunk = "";
			continue;
		}
		const kind = String(update.sessionUpdate);
		if (kind === "compaction_checkpoint") {
			const path = string(update.checkpoint_file);
			const checkpoint = path && checkpoints.get(path);
			if (
				update.schema_version !== 1 ||
				!checkpoint ||
				checkpoint.schema_version !== 1 ||
				!Array.isArray(checkpoint.compacted_history)
			)
				throw new Error(
					"Grok Build の要約チェックポイントを読み込めません。元のセッション一式を指定してください。",
				);
			messages.length = 0;
			toolMessages.clear();
			toolStates.clear();
			lastChunk = "";
			grokConversation(checkpoint.compacted_history.map(record), messages, warnings, checkpoint);
			addMessage(messages, "context", string(record(update.auto_continue).prompt_text) ?? "", undefined, entry);
		} else if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
			const text = contentText([update.content], warnings);
			const role = kind === "user_message_chunk" ? "user" : "assistant";
			const newPrompt = role === "user" && meta.promptIndex !== undefined && meta.promptIndex !== lastPrompt;
			const last = messages.at(-1);
			if (last && lastChunk === kind && !newPrompt && meta.interjection !== true) {
				last.text += text;
				const origin = messageOrigins.get(last);
				if (origin) {
					origin.related ??= [];
					origin.related.push(entry);
				}
			} else addMessage(messages, role, text, entry.timestamp, entry);
			lastChunk = kind;
			if (role === "user" && meta.promptIndex !== undefined) lastPrompt = meta.promptIndex;
		} else if (kind === "tool_call" || kind === "tool_call_update") {
			const toolId = string(update.toolCallId);
			if (!toolId) continue;
			let message = toolMessages.get(toolId);
			if (!message) {
				message = { role: "context", text: `[ツール記録: ${string(update.title) ?? toolId}]` };
				toolMessages.set(toolId, message);
				messages.push(message);
				const state: JsonRecord = {};
				toolStates.set(toolId, state);
				messageOrigins.set(message, {
					entry,
					content: { type: "tool", id: toolId, name: string(update.title) ?? toolId, state },
				});
			}
			const state = toolStates.get(toolId)!;
			if (update.rawInput !== undefined) state.input = update.rawInput;
			if (update.status !== undefined) state.status = update.status;
			if (update.rawOutput !== undefined) state.output = update.rawOutput;
			if (Array.isArray(update.content)) state.content = update.content.map((raw) => record(raw).content ?? raw);
			if (update.rawInput !== undefined) message.text += `\n入力: ${JSON.stringify(update.rawInput)}`;
			if (Array.isArray(update.content))
				for (const raw of update.content) {
					const part = record(raw);
					message.text += `\n${contentText([part.content ?? part], warnings)}`;
				}
			if (update.rawOutput !== undefined)
				message.text += `\n結果: ${typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput)}`;
			lastChunk = "";
		}
	}
	if (!messages.length && cached.length) {
		grokConversation(cached, messages, warnings);
		warnings.push("Grok Build の表示キャッシュから復元しました。最新の実行記録が含まれない場合があります。");
	}
	const records = [summary];
	const archivedCheckpoints = new Set<JsonRecord>();
	for (const entry of updates) {
		records.push(entry);
		const update = record(record(entry.params).update ?? entry.update);
		const checkpoint = checkpoints.get(String(update.checkpoint_file));
		if (update.sessionUpdate === "compaction_checkpoint" && checkpoint && !archivedCheckpoints.has(checkpoint)) {
			records.push(checkpoint);
			archivedCheckpoints.add(checkpoint);
		}
	}
	if (!updates.length) records.push(...cached);
	return preserveTranscript(
		transcript(
			"grok-build",
			string(info.id) ?? fallbackId,
			info.cwd,
			summary.generated_title ?? summary.session_summary,
			messages,
			warnings,
		),
		records,
	);
}
