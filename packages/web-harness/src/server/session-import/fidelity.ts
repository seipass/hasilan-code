import type {
	ImportContent,
	ImportedMessageOrigin,
	ImportedRecord,
	ImportedTranscript,
	SessionImportMessage,
} from "../../shared/session-import.ts";
import { codexUserText, contentText, type JsonRecord, messageOrigins, record, string, timestamp } from "./common.ts";

/** Normalize presentation without discarding the provider-native record stored alongside it. */
export function importContent(value: unknown): ImportContent[] {
	if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
	if (Array.isArray(value)) return value.flatMap(importContent);
	if (value == null) return [];
	const part = record(value);
	const type = String(part.type ?? "");
	if (["text", "input_text", "output_text", "summary_text", "reasoning_text"].includes(type))
		return [{ type: "text", text: String(part.text ?? "") }];
	if (["thinking", "reasoning", "redacted_thinking"].includes(type)) {
		const summary = Array.isArray(part.summary)
			? part.summary.map((item) => string(record(item).text) ?? "").join("\n")
			: "";
		const body = Array.isArray(part.content)
			? part.content.map((item) => string(record(item).text) ?? "").join("\n")
			: contentText(part.content, []);
		return [
			{
				type: "thinking",
				thinking: string(part.thinking) ?? string(part.reasoning) ?? string(part.text) ?? body,
				...(summary ? { summary } : {}),
				...((string(part.thinkingSignature) ??
				string(part.signature) ??
				string(part.encrypted_content) ??
				string(part.data))
					? {
							thinkingSignature:
								string(part.thinkingSignature) ??
								string(part.signature) ??
								string(part.encrypted_content) ??
								string(part.data),
						}
					: {}),
				...(type === "redacted_thinking" || part.encrypted_content ? { redacted: true } : {}),
			},
		];
	}
	if (
		["tool_use", "toolCall", "tool-call", "function_call", "custom_tool_call", "local_shell_call", "tool"].includes(
			type,
		)
	) {
		const state = record(part.state);
		let input = part.input ?? part.arguments ?? part.action ?? state.input ?? {};
		if (typeof input === "string") {
			try {
				input = JSON.parse(input);
			} catch {
				/* Preserve non-JSON custom tool input verbatim. */
			}
		}
		const id = string(part.call_id) ?? string(part.callID) ?? string(part.id) ?? "";
		const name = string(part.name) ?? string(part.tool) ?? type;
		const blocks: ImportContent[] = [
			{
				type: "toolCall",
				id,
				name,
				arguments: input,
				...(string(state.status ?? part.status) ? { status: String(state.status ?? part.status) } : {}),
			},
		];
		if (
			state.content !== undefined ||
			state.output !== undefined ||
			state.error !== undefined ||
			["completed", "error", "failed", "cancelled"].includes(String(state.status))
		)
			blocks.push({
				type: "toolResult",
				id,
				name,
				content: importContent(state.content ?? state.output ?? state.error),
				isError: state.status === "error" || state.status === "failed" || state.error !== undefined,
				status: string(state.status),
			});
		return blocks;
	}
	if (
		[
			"tool_result",
			"toolResult",
			"function_call_output",
			"custom_tool_call_output",
			"local_shell_call_output",
		].includes(type)
	)
		return [
			{
				type: "toolResult",
				id:
					string(part.tool_use_id) ??
					string(part.toolCallId) ??
					string(part.tool_call_id) ??
					string(part.call_id) ??
					string(part.id) ??
					"",
				name: string(part.toolName) ?? string(part.name),
				content: importContent(part.content ?? part.output),
				isError: part.is_error === true || part.isError === true || part.status === "error",
				status: string(part.status),
			},
		];
	if (
		[
			"image",
			"image_url",
			"input_image",
			"input_file",
			"file",
			"document",
			"audio",
			"input_audio",
			"video",
			"resource",
			"resource_link",
		].includes(type)
	) {
		const source = record(part.source);
		const attachment = record(part.attachment);
		const resource = record(part.resource);
		const audio = record(part.input_audio);
		const image = record(part.image_url);
		const url =
			string(source.url) ??
			string(source.uri) ??
			string(part.url) ??
			string(part.image_url) ??
			string(image.url) ??
			string(part.file_url) ??
			string(resource.uri) ??
			string(part.uri);
		const mimeType =
			string(part.mimeType) ??
			string(part.mime_type) ??
			string(part.media_type) ??
			string(part.mediaType) ??
			string(part.mime) ??
			string(source.media_type) ??
			string(attachment.mediaType) ??
			string(resource.mimeType) ??
			(type.includes("image")
				? "image/png"
				: type.includes("audio")
					? `audio/${string(audio.format) ?? "mpeg"}`
					: "application/octet-stream");
		return [
			{
				type: "attachment",
				kind: type,
				name:
					string(part.filename) ??
					string(part.name) ??
					string(part.title) ??
					string(attachment.name) ??
					"添付ファイル",
				mimeType,
				...(string(attachment.attachmentId) ? { referenceId: String(attachment.attachmentId) } : {}),
				...((string(part.data) ??
				string(source.data) ??
				string(audio.data) ??
				string(resource.blob) ??
				string(part.file_data))
					? {
							data:
								string(part.data) ??
								string(source.data) ??
								string(audio.data) ??
								string(resource.blob) ??
								string(part.file_data),
						}
					: {}),
				...((string(source.text) ?? string(resource.text))
					? { text: string(source.text) ?? string(resource.text) }
					: {}),
				...((string(part.path) ?? string(part.file_path) ?? string(source.path))
					? { path: string(part.path) ?? string(part.file_path) ?? string(source.path) }
					: {}),
				...(url ? { url } : {}),
			},
		];
	}
	if (!type && typeof part.text === "string") return [{ type: "text", text: part.text }];
	return [{ type: "sourceBlock", label: type || "元のデータ", value }];
}

function sourceMessage(entry: JsonRecord, message: JsonRecord, role: unknown, content: unknown): SessionImportMessage {
	const blocks = importContent(content);
	if (Array.isArray(message.tool_calls))
		blocks.push(
			...message.tool_calls.flatMap((tool) => {
				const item = record(tool);
				return importContent({ ...record(item.function), ...item, type: "toolCall" });
			}),
		);
	if (typeof message.reasoning_content === "string")
		blocks.unshift({ type: "thinking", thinking: message.reasoning_content });
	return {
		role: role === "user" || role === "assistant" ? role : "context",
		text: contentText(content, []) || (blocks.length ? `[${blocks[0].type}]` : ""),
		content: blocks,
		timestamp: timestamp(message.timestamp ?? entry.timestamp ?? entry.time ?? record(message.time).created),
	};
}

function extract(source: ImportedTranscript["source"], entry: JsonRecord, canonical: boolean): SessionImportMessage[] {
	if (source === "codex") {
		const item = record(entry.payload);
		if (entry.type === "response_item") {
			if (item.type === "message") {
				const text = contentText(item.content, []);
				const request = item.role === "user" ? codexUserText(text) : undefined;
				return [
					sourceMessage(
						entry,
						item,
						item.role === "user" && !request ? "context" : item.role,
						item.role === "user" && request && request !== text ? request : item.content,
					),
				];
			}
			return [
				sourceMessage(
					entry,
					item,
					["reasoning", "function_call", "custom_tool_call", "local_shell_call"].includes(String(item.type))
						? "assistant"
						: "context",
					item,
				),
			];
		}
		if (entry.type === "compacted")
			return Array.isArray(item.replacement_history)
				? item.replacement_history.map((raw) => {
						const replacement = record(raw);
						return sourceMessage(
							entry,
							replacement,
							replacement.role,
							replacement.type === "message" ? replacement.content : replacement,
						);
					})
				: [sourceMessage(entry, item, "context", `[会話の要約]\n${String(item.message ?? "")}`)];
		if (!canonical && entry.type === "event_msg" && ["user_message", "agent_message"].includes(String(item.type)))
			return [sourceMessage(entry, item, item.type === "user_message" ? "user" : "assistant", item.message)];
		return [];
	}
	if (source === "claude-code") {
		if (entry.type === "user" || entry.type === "assistant") {
			const message = record(entry.message);
			return [sourceMessage(entry, message, entry.isMeta ? "context" : entry.type, message.content)];
		}
		if (entry.type === "attachment")
			return [sourceMessage(entry, entry, "context", entry.attachment ?? entry.content)];
		return [];
	}
	if (source === "oh-my-pi") {
		if (entry.type === "message") {
			const message = record(entry.message);
			return [
				sourceMessage(
					entry,
					message,
					message.role,
					message.role === "toolResult"
						? { ...message, type: "toolResult" }
						: message.role === "bashExecution"
							? `[端末実行]\n${String(message.command ?? "")}\n${String(message.output ?? "")}`
							: message.content,
				),
			];
		}
		if (["compaction", "branch_summary"].includes(String(entry.type)))
			return [sourceMessage(entry, entry, "context", `[会話の要約]\n${String(entry.summary ?? "")}`)];
		if (entry.type === "custom_message") return [sourceMessage(entry, entry, "context", entry.content)];
		return [];
	}
	if (source === "deepseek-harness") {
		const data = record(entry.data);
		const message = entry.type === "user/message" ? data : record(data.message);
		if (String(entry.type).endsWith("/message"))
			return [sourceMessage(entry, message, message.role, message.content)];
		if (entry.type === "tool/result")
			return [sourceMessage(entry, message, "context", { ...message, type: "toolResult" })];
		return [];
	}
	if (source === "opencode") {
		const message = entry.type ? entry : { ...record(entry.info), parts: entry.parts };
		if (message.type === "compaction") {
			const native = record(message.native).messages ?? record(message.providerContext).messages;
			return Array.isArray(native)
				? native.map((raw) => {
						const item = record(raw);
						return sourceMessage(entry, item, item.role, item.content);
					})
				: [sourceMessage(entry, message, "context", `[会話の要約]\n${String(message.summary ?? "")}`)];
		}
		const role = message.type ?? message.role;
		if (["synthetic", "system", "skill"].includes(String(role)))
			return [sourceMessage(entry, message, "context", message.text)];
		if (role === "shell")
			return [
				sourceMessage(
					entry,
					message,
					"context",
					`[端末実行]\n${String(message.command ?? "")}\n${typeof message.output === "string" ? message.output : JSON.stringify(message.output ?? "")}`,
				),
			];
		if (role !== "user" && role !== "assistant") return [];
		const content = message.parts ?? message.content ?? message.text;
		const result = sourceMessage(entry, message, role, content);
		if (Array.isArray(message.files))
			result.content?.push(...message.files.flatMap((file) => importContent({ type: "file", ...record(file) })));
		return [result];
	}
	if (Array.isArray(entry.compacted_history))
		return entry.compacted_history.map((raw) => {
			const item = record(raw);
			return sourceMessage(entry, item, item.type ?? item.role, item.content);
		});
	const update = record(record(entry.params).update ?? entry.update);
	if (
		update.sessionUpdate === "user_message_chunk" ||
		update.sessionUpdate === "agent_message_chunk" ||
		update.sessionUpdate === "agent_thought_chunk"
	)
		return [
			sourceMessage(
				entry,
				update,
				update.sessionUpdate === "user_message_chunk" ? "user" : "assistant",
				update.sessionUpdate === "agent_thought_chunk"
					? { type: "thinking", thinking: contentText([update.content], []) }
					: update.content,
			),
		];
	if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
		const blocks: ImportContent[] = [];
		if (update.sessionUpdate === "tool_call")
			blocks.push({
				type: "toolCall",
				id: String(update.toolCallId ?? ""),
				name: String(update.title ?? update.toolCallId ?? "tool"),
				arguments: update.rawInput ?? {},
				status: string(update.status),
			});
		if (update.rawOutput !== undefined || update.content !== undefined || update.status !== undefined)
			blocks.push({
				type: "toolResult",
				id: String(update.toolCallId ?? ""),
				content: importContent(
					update.rawOutput ??
						(Array.isArray(update.content)
							? update.content.map((raw) => record(raw).content ?? raw)
							: update.content),
				),
				isError: update.status === "failed",
				status: string(update.status),
			});
		return [{ role: "assistant", text: "[ツール記録]", content: blocks, timestamp: timestamp(entry.timestamp) }];
	}
	if (entry.type || entry.role)
		return [
			sourceMessage(
				entry,
				entry,
				entry.type ?? entry.role,
				entry.type === "tool_result" || entry.role === "tool" ? { ...entry, type: "toolResult" } : entry.content,
			),
		];
	return [];
}

/** The source archive is independent of the producer's compacted/selected execution context. */
export function preserveTranscript(data: ImportedTranscript, entries: JsonRecord[]): ImportedTranscript {
	const ids = new Map(entries.map((entry, index) => [entry, `record-${index}`]));
	const canonical = data.source === "codex" && entries.some((entry) => entry.type === "response_item");
	const active = new Set<JsonRecord>();
	for (const message of data.messages) {
		const origin = messageOrigins.get(message);
		if (origin) {
			active.add(origin.entry);
			for (const related of origin.related ?? []) active.add(related);
		}
	}
	const records: ImportedRecord[] = entries.map((entry) => {
		const native = record(entry.message ?? entry.payload ?? record(entry.data).message ?? entry.data ?? entry.info);
		const id = ids.get(entry)!;
		const origin: ImportedMessageOrigin = {
			recordId: id,
			id:
				string(entry.uuid) ??
				string(entry.id) ??
				string(native.id) ??
				(typeof entry.seq === "number" ? String(entry.seq) : undefined),
			parentId:
				string(entry.parentUuid) ??
				string(entry.parentId) ??
				string(native.parentID) ??
				(entry.parentUuid === null || entry.parentId === null ? null : undefined),
			channel: string(native.channel) ?? string(native.phase),
			model:
				string(native.model) ??
				string(record(native.model).id) ??
				string(record(native.model).modelID) ??
				string(record(native.source).model),
			stopReason:
				string(native.stopReason) ??
				string(native.stop_reason) ??
				string(native.finish) ??
				string(record(record(entry.data).reason).kind),
			usage: native.usage ?? native.tokens ?? record(entry.data).usage,
			active: active.has(entry),
		};
		return {
			id,
			raw: entry,
			messages: extract(data.source, entry, canonical).map((message) => ({ ...message, origin: { ...origin } })),
		};
	});
	const byId = new Map(records.map((entry) => [entry.id, entry]));
	if (data.source === "grok-build") {
		let previous: { kind: string; prompt: unknown; message: SessionImportMessage } | undefined;
		for (const entry of records) {
			const update = record(record(entry.raw.params).update ?? entry.raw.update);
			const kind = String(update.sessionUpdate);
			const meta = record(update._meta);
			const message = entry.messages[0];
			if (
				!message ||
				!["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].includes(kind) ||
				meta.hostTurn ||
				meta.interjection
			) {
				previous = undefined;
				continue;
			}
			if (
				previous?.kind === kind &&
				previous.prompt === meta.promptIndex &&
				previous.message.origin?.active === message.origin?.active
			) {
				previous.message.text += message.text;
				for (const block of message.content ?? []) {
					const last = previous.message.content?.at(-1);
					if (block.type === "text" && last?.type === "text") last.text += block.text;
					else if (block.type === "thinking" && last?.type === "thinking") last.thinking += block.thinking;
					else previous.message.content?.push(block);
				}
				entry.messages = [];
			} else previous = { kind, prompt: meta.promptIndex, message };
		}
	}
	for (const message of data.messages) {
		const origin = messageOrigins.get(message);
		const id = origin && ids.get(origin.entry);
		const stored = id && byId.get(id);
		if (!stored) continue;
		const matching = stored.messages.find((item) => item.text === message.text) ?? stored.messages[0];
		message.origin = { ...(matching?.origin ?? { recordId: stored.id }), active: true };
		message.content = origin?.content === undefined ? matching?.content : importContent(origin.content);
		// Retain sanitized user/setup text while keeping media and all raw source attributes.
		if (message.content?.length && message.content.every((part) => part.type === "text"))
			message.content = [{ type: "text", text: message.text }];
	}
	data.records = records;
	return data;
}
