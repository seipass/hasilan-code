import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ImportedTranscript, SessionImportMessage, SessionImportSource } from "../../shared/session-import.ts";

export type JsonRecord = Record<string, unknown>;
export function record(value: unknown): JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}
export function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
export async function sameWorkspace(cwd: string | undefined, workspacePath: string): Promise<boolean> {
	if (!cwd || !isAbsolute(cwd)) return false;
	try {
		const paths = await Promise.all([realpath(cwd), realpath(workspacePath)]);
		const normalized = paths.map((path) =>
			process.platform === "win32"
				? path
						.replace(/^\\\\\?\\UNC\\/i, "\\\\")
						.replace(/^\\\\\?\\/, "")
						.toLowerCase()
				: path,
		);
		return normalized[0] === normalized[1];
	} catch {
		return false;
	}
}
export function timestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value < 100000000000 ? value * 1000 : value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
/** Codex writes harness setup in user-role records separately from the user's request. */
export function codexUserText(text: string): string | undefined {
	let request = text.trim();
	if (request.startsWith("# AGENTS.md instructions for ")) {
		const end = request.indexOf("</INSTRUCTIONS>");
		if (end >= 0) request = request.slice(end + "</INSTRUCTIONS>".length).trim();
	}
	for (;;) {
		const setup =
			/^<(environment_context|recommended_plugins|turn_aborted|subagent_notification|in-app-browser-context)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/.exec(
				request,
			);
		if (!setup) break;
		request = request.slice(setup[0].length).trim();
	}
	return string(request.replace(/^## My request:\s*/, ""));
}
export function jsonLines(text: string, warnings: string[], partial = false): JsonRecord[] {
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	const result: JsonRecord[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line.trim()) continue;
		try {
			const value = record(JSON.parse(line));
			if (!Object.keys(value).length) throw new Error("Expected a record");
			result.push(value);
		} catch {
			if (index === lines.length - 1 && (partial || !text.endsWith("\n"))) {
				if (!partial)
					warnings.push("書き込み途中の最終行を除外しました。元のハーネスで保存を終えてから再読み込みできます。");
				break;
			}
			throw new Error(`履歴の ${index + 1} 行目が不正な JSON です。`);
		}
	}
	return result;
}

/** Foreign tool records remain plain text: their IDs, signatures and execution state are not portable. */
export function contentText(value: unknown, warnings: string[]): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) {
		const item = record(value);
		return typeof item.text === "string" ? item.text : "";
	}
	return value
		.map((raw): string => {
			const part = record(raw);
			if (["text", "input_text", "output_text"].includes(String(part.type))) return string(part.text) ?? "";
			if (["thinking", "reasoning"].includes(String(part.type)))
				return string(part.thinking) ?? string(part.text) ?? string(part.reasoning) ?? "";
			if (["tool_use", "toolCall", "tool-call", "function_call"].includes(String(part.type)))
				return `[ツール呼び出し: ${string(part.name) ?? "tool"}]\n${typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.input ?? part.arguments ?? {})}`;
			if (["tool_result", "toolResult", "function_call_output"].includes(String(part.type)))
				return `[ツール結果: ${string(part.tool_use_id) ?? string(part.toolCallId) ?? string(part.call_id) ?? "tool"}]\n${contentText(part.content ?? part.output, warnings)}`;
			if (["image", "image_url", "input_image", "file", "document", "audio", "video"].includes(String(part.type))) {
				warnings.push(
					"画像・音声・添付ファイルの本体は取り込まれません。必要なファイルは引き継ぎ後に追加してください。",
				);
				return `[添付: ${string(part.filename) ?? string(part.name) ?? String(part.type)}]`;
			}
			if (string(part.type)) warnings.push(`内容形式 ${String(part.type)} のブロックは取り込めませんでした。`);
			return "";
		})
		.filter(Boolean)
		.join("\n");
}
export function addMessage(
	messages: SessionImportMessage[],
	role: SessionImportMessage["role"],
	text: string,
	time?: unknown,
): void {
	if (text.trim())
		messages.push({ role, text, ...(timestamp(time) === undefined ? {} : { timestamp: timestamp(time) }) });
}
export function transcript(
	source: SessionImportSource,
	id: string,
	cwd: unknown,
	title: unknown,
	messages: SessionImportMessage[],
	warnings: string[],
): ImportedTranscript {
	return {
		source,
		sourceSessionId: id,
		title: (string(title) ?? messages.find((message) => message.role === "user")?.text ?? id)
			.replace(/\s+/g, " ")
			.slice(0, 200),
		...(string(cwd) ? { cwd: string(cwd) } : {}),
		messages,
		warnings: [...new Set(warnings)],
	};
}

/** The latest physical entry is the current leaf in append-only Pi/Claude logs. */
export function activeBranch(entries: JsonRecord[], idKey: string, parentKey: string): JsonRecord[] {
	const nodes = entries.filter((entry) => string(entry[idKey]));
	if (!nodes.length) return entries;
	const byId = new Map(nodes.map((entry) => [entry[idKey], entry]));
	const branch: JsonRecord[] = [];
	const seen = new Set<unknown>();
	let node: JsonRecord | undefined = nodes.at(-1);
	while (node) {
		const id = node[idKey];
		if (seen.has(id)) throw new Error("履歴の親子関係が循環しています。");
		seen.add(id);
		branch.push(node);
		const parent = node[parentKey];
		if (parent == null) break;
		node = byId.get(parent);
		if (!node) throw new Error("履歴の親メッセージが見つかりません。完全なセッションファイルを指定してください。");
	}
	return branch.reverse();
}
