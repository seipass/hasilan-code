import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, ImageContent, JsonObject, TextContent } from "@hasilan-code/pi-ai";
import type { SessionManager } from "@hasilan-code/pi-coding-agent";
import {
	type ImportContent,
	type ImportedRecord,
	type ImportedTranscript,
	SESSION_IMPORT_BOUNDARY_TYPE,
	SESSION_IMPORT_CONTEXT_TYPE,
	SESSION_IMPORT_MESSAGE_API,
	SESSION_IMPORT_RECORD_TYPE,
} from "../../shared/session-import.ts";
import { record } from "./common.ts";

export async function storeImport(
	manager: SessionManager,
	source: ImportedTranscript,
	assetDirectory: string,
): Promise<void> {
	const materialized = new WeakMap<ImportContent, ImportContent>();
	const prepare = async (blocks: ImportContent[]): Promise<ImportContent[]> => {
		const result: ImportContent[] = [];
		for (const block of blocks) {
			const cached = materialized.get(block);
			if (cached) {
				result.push(cached);
				continue;
			}
			let value: ImportContent = block;
			if (block.type === "toolResult") value = { ...block, content: await prepare(block.content) };
			if (block.type === "attachment") {
				value = { ...block };
				try {
					let bytes: Buffer | undefined;
					let path = block.path;
					const reference = /^sha256:([a-f0-9]{64})$/.exec(block.referenceId ?? "");
					if (reference && source.source === "deepseek-harness" && source.attachmentRoot)
						path = join(
							source.attachmentRoot,
							block.kind === "file" ? "file-objects" : "objects",
							reference[1].slice(0, 2),
							reference[1],
						);
					const dataUrl = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(block.url ?? block.data ?? "");
					if (dataUrl) {
						value.mimeType = dataUrl[1] || block.mimeType;
						bytes = dataUrl[2] ? Buffer.from(dataUrl[3], "base64") : Buffer.from(decodeURIComponent(dataUrl[3]));
					} else if (block.data !== undefined) bytes = Buffer.from(block.data, "base64");
					else if (block.text !== undefined) bytes = Buffer.from(block.text);
					else if (block.url?.startsWith("file:")) path = fileURLToPath(block.url);
					else if (block.url && !/^[a-z][a-z0-9+.-]*:/i.test(block.url)) path = block.url;
					if (path) path = await realpath(isAbsolute(path) ? path : resolve(source.cwd ?? ".", path));
					const hash = createHash("sha256");
					if (!bytes && !path)
						throw new Error(
							block.url
								? "外部URLの添付は参照を保存しました。本体は元のサービスへの接続が必要です。"
								: "元の履歴に添付本体または読み取り可能な保存先がありません。",
						);
					await mkdir(assetDirectory, { recursive: true, mode: 0o700 });
					if (bytes) {
						hash.update(bytes);
						value.assetId = hash.digest("hex");
						if (reference && value.assetId !== reference[1])
							throw new Error("添付ファイルのハッシュが元の記録と一致しません。");
						await writeFile(join(assetDirectory, value.assetId), bytes, { mode: 0o600 });
					} else if (path) {
						const temporary = join(assetDirectory, `${randomUUID()}.tmp`);
						try {
							await pipeline(
								createReadStream(path),
								new Transform({
									transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
										hash.update(chunk);
										callback(null, chunk);
									},
								}),
								createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
							);
							value.assetId = hash.digest("hex");
							if (reference && value.assetId !== reference[1])
								throw new Error("添付ファイルのハッシュが元の記録と一致しません。");
							await rename(temporary, join(assetDirectory, value.assetId));
						} finally {
							await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
								if (error.code !== "ENOENT") throw error;
							});
						}
						value.name = block.name === "添付ファイル" && !reference ? basename(path) : block.name;
					}
					delete value.data;
					delete value.text;
					delete value.path;
				} catch (error) {
					delete value.assetId;
					value.unavailable = error instanceof Error ? error.message : String(error);
					source.warnings.push(`${block.name}: ${value.unavailable}`);
				}
			}
			materialized.set(block, value);
			result.push(value);
		}
		return result;
	};
	for (const entry of source.records ?? []) {
		const stored: ImportedRecord = { ...entry, messages: [] };
		for (const message of entry.messages)
			stored.messages.push({
				...message,
				content: await prepare(message.content ?? [{ type: "text", text: message.text }]),
			});
		manager.appendCustomEntry(SESSION_IMPORT_RECORD_TYPE, stored);
	}
	const calls = new Map<string, string>();
	const pending = new Set<string>();
	let buffered: AssistantMessage | undefined;
	const flushAssistant = () => {
		if (!buffered) return;
		manager.appendMessage(buffered);
		buffered = undefined;
	};
	const finishTools = () => {
		flushAssistant();
		for (const id of pending)
			manager.appendMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: calls.get(id) ?? "tool",
				content: [{ type: "text", text: "引き継ぎ元に完了結果がありません。引き継ぎで実行は再開していません。" }],
				isError: true,
				timestamp: Date.now(),
			});
		pending.clear();
	};
	const plain = async (blocks: ImportContent[]): Promise<(TextContent | ImageContent)[]> => {
		const result: (TextContent | ImageContent)[] = [];
		for (const block of await prepare(blocks)) {
			if (block.type === "text") result.push(block);
			else if (block.type === "attachment" && block.assetId) {
				if (/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType))
					result.push({
						type: "image",
						data: (await readFile(join(assetDirectory, block.assetId))).toString("base64"),
						mimeType: block.mimeType,
					});
				else
					result.push({
						type: "text",
						text: `[添付: ${block.name}; ${block.mimeType}; 保存先: ${join(assetDirectory, block.assetId)}]${block.text ? `\n${block.text}` : ""}`,
					});
			} else if (block.type === "attachment")
				result.push({
					type: "text",
					text: `[添付: ${block.name}] ${block.unavailable ?? block.url ?? "本体を取得できません"}`,
				});
			else if (block.type === "thinking")
				result.push({
					type: "text",
					text:
						block.thinking ||
						(block.summary ? `[元の推論の要約]\n${block.summary}` : "[元の推論は暗号化されています]"),
				});
			else if (block.type === "sourceBlock")
				result.push({ type: "text", text: JSON.stringify(block.value) ?? `[${block.label}]` });
		}
		return result;
	};
	let callNumber = 0;
	for (const message of source.messages) {
		const timestamp = message.timestamp ?? Date.now();
		const blocks = message.content ?? [{ type: "text", text: message.text }];
		const assistant: AssistantMessage["content"] = [];
		for (const block of blocks) {
			if (block.type === "toolCall") {
				const id = block.id || `imported-call-${callNumber++}`;
				const input = block.arguments;
				assistant.push({
					type: "toolCall",
					id,
					name: block.name,
					arguments: (input !== null && typeof input === "object" && !Array.isArray(input)
						? input
						: { input }) as JsonObject,
				});
			} else if (block.type === "thinking") {
				if (block.thinking) assistant.push({ type: "thinking", thinking: block.thinking });
				else if (block.summary) assistant.push({ type: "text", text: `[元の推論の要約]\n${block.summary}` });
			} else if (block.type === "text") assistant.push(block);
			else if (block.type === "attachment" && message.role === "assistant") {
				const saved = (await prepare([block]))[0];
				if (saved.type === "attachment")
					assistant.push({
						type: "text",
						text: `[添付: ${saved.name}; 保存先: ${saved.assetId ? join(assetDirectory, saved.assetId) : (saved.unavailable ?? saved.url ?? "取得できません")}]`,
					});
			}
		}
		if (
			message.role === "assistant" ||
			assistant.some((block) => block.type === "toolCall" || block.type === "thinking")
		) {
			if (assistant.length) {
				if (!buffered && pending.size) finishTools();
				if (buffered) {
					buffered.content.push(...assistant);
					if (assistant.some((block) => block.type === "toolCall")) buffered.stopReason = "toolUse";
				} else
					buffered = {
						role: "assistant",
						content: assistant,
						api: SESSION_IMPORT_MESSAGE_API,
						provider: `imported-${source.source}`,
						model: "imported",
						stopReason: assistant.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
						timestamp,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
				for (const block of assistant)
					if (block.type === "toolCall") {
						calls.set(block.id, block.name);
						pending.add(block.id);
					}
			}
		} else if (message.role === "user") {
			const content = await plain(blocks);
			if (content.length) {
				finishTools();
				manager.appendMessage({ role: "user", content, timestamp });
			}
		} else if (blocks.some((block) => block.type !== "toolResult")) {
			const content = await plain(blocks);
			if (content.length) {
				finishTools();
				manager.appendCustomMessageEntry(SESSION_IMPORT_CONTEXT_TYPE, content, true);
			}
		}
		for (const block of blocks)
			if (block.type === "toolResult") {
				flushAssistant();
				if (pending.has(block.id)) {
					manager.appendMessage({
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name ?? calls.get(block.id) ?? "tool",
						content: await plain(block.content),
						isError: block.isError,
						timestamp,
					});
					pending.delete(block.id);
				} else
					manager.appendCustomMessageEntry(
						SESSION_IMPORT_CONTEXT_TYPE,
						[
							{ type: "text", text: `[対応する呼び出しが現在の文脈にないツール結果: ${block.id}]` },
							...(await plain(block.content)),
						],
						true,
					);
			}
	}
	finishTools();
	manager.appendCustomEntry(SESSION_IMPORT_BOUNDARY_TYPE, { version: 1, warnings: [...new Set(source.warnings)] });
}

export function importedRecord(value: unknown): value is ImportedRecord {
	const entry = record(value);
	return (
		typeof entry.id === "string" &&
		typeof entry.raw === "object" &&
		entry.raw !== null &&
		Array.isArray(entry.messages)
	);
}
