import type { SessionManager } from "@hasilan-code/pi-coding-agent";
import type { HistoryMessage, HistoryTool } from "../../shared/session-history.ts";
import {
	type ImportContent,
	SESSION_IMPORT_BOUNDARY_TYPE,
	SESSION_IMPORT_RECORD_TYPE,
} from "../../shared/session-import.ts";
import { record } from "./common.ts";
import { importedRecord } from "./persistence.ts";

export interface ImportAsset {
	name: string;
	mimeType: string;
}

export function projectImport(
	manager: SessionManager,
	sessionId: string,
): {
	messages: HistoryMessage[];
	toolCalls: HistoryTool[];
	assets: Map<string, ImportAsset>;
	boundary?: string;
} {
	const messages: HistoryMessage[] = [];
	const toolCalls: HistoryTool[] = [];
	const assets = new Map<string, ImportAsset>();
	const calls = new Map<string, HistoryTool[]>();
	const nodes = new Map<string, { parent?: string | null; tools: Map<string, HistoryTool> }>();
	let boundary: string | undefined;
	const content = (blocks: ImportContent[]): ImportContent[] =>
		blocks.map((block) => {
			if (block.type === "attachment") {
				if (block.assetId) assets.set(block.assetId, { name: block.name, mimeType: block.mimeType });
				return {
					type: "attachment",
					kind: block.kind,
					name: block.name,
					mimeType: block.mimeType,
					...(block.assetId
						? {
								assetId: block.assetId,
								url: `/api/session-imports/${encodeURIComponent(sessionId)}/assets/${block.assetId}`,
							}
						: {
								unavailable: block.unavailable ?? "元の添付本体を取得できません",
								...(/^https?:\/\//i.test(block.url ?? "") ? { url: block.url } : {}),
							}),
				};
			}
			if (block.type === "toolResult") return { ...block, content: content(block.content) };
			if (block.type === "thinking")
				return {
					type: "thinking",
					thinking: block.thinking,
					...(block.summary ? { summary: block.summary } : {}),
					...(block.redacted ? { redacted: true } : {}),
				};
			if (block.type === "sourceBlock") return { type: "sourceBlock", label: block.label, value: undefined };
			return { ...block };
		});
	for (const entry of manager.getEntries()) {
		if (entry.type !== "custom") continue;
		if (entry.customType === SESSION_IMPORT_BOUNDARY_TYPE) boundary = entry.id;
		if (entry.customType !== SESSION_IMPORT_RECORD_TYPE || !importedRecord(entry.data)) continue;
		const rawId =
			typeof entry.data.raw.uuid === "string"
				? entry.data.raw.uuid
				: typeof entry.data.raw.id === "string"
					? entry.data.raw.id
					: undefined;
		const rawParent = entry.data.raw.parentUuid ?? entry.data.raw.parentId;
		if (rawId && !nodes.has(rawId))
			nodes.set(rawId, { parent: typeof rawParent === "string" ? rawParent : null, tools: new Map() });
		const update = record(record(entry.data.raw.params).update ?? entry.data.raw.update);
		if (update.sessionUpdate === "tool_call_update" && typeof update.toolCallId === "string") {
			const tool = calls.get(update.toolCallId)?.at(-1);
			if (tool && update.rawInput !== undefined) {
				tool.input = update.rawInput;
				if (typeof update.rawInput === "string") {
					try {
						tool.input = JSON.parse(update.rawInput);
					} catch {
						/* Preserve raw custom tool input. */
					}
				}
			}
			if (tool && typeof update.title === "string") tool.name = update.title;
		}
		for (const [index, source] of entry.data.messages.entries()) {
			const messageId = `import/${entry.data.id}/${index}`;
			const origin = source.origin && {
				...source.origin,
				url: `/api/session-imports/${encodeURIComponent(sessionId)}/records/${encodeURIComponent(entry.id)}`,
			};
			const blocks = content(source.content ?? [{ type: "text", text: source.text }]);
			const ownCalls = new Map<string, HistoryTool>();
			if (origin?.id) nodes.set(origin.id, { parent: origin.parentId, tools: ownCalls });
			for (const block of blocks)
				if (block.type === "toolCall") {
					const callId = block.id || `${messageId}/unknown-call`;
					block.id = callId;
					const tool: HistoryTool = {
						key: `${sessionId}/${messageId}/${callId}`,
						sessionId,
						runId: messageId,
						callId,
						name: block.name,
						input: block.arguments,
						status:
							block.status === "cancelled"
								? "cancelled"
								: ["failed", "error"].includes(block.status ?? "")
									? "error"
									: "incomplete",
						sourceStatus: block.status,
						importedOrigin: origin,
					};
					toolCalls.push(tool);
					ownCalls.set(callId, tool);
					const previous = calls.get(callId) ?? [];
					previous.push(tool);
					calls.set(callId, previous);
				}
			const visible: ImportContent[] = [];
			for (const block of blocks) {
				if (block.type !== "toolResult") {
					visible.push(block);
					continue;
				}
				let tool = ownCalls.get(block.id);
				let parent = origin?.parentId;
				const seen = new Set<string>();
				while (!tool && parent && !seen.has(parent)) {
					seen.add(parent);
					const node = nodes.get(parent);
					tool = node?.tools.get(block.id);
					parent = node?.parent;
				}
				tool ??= calls.get(block.id)?.at(-1);
				if (tool) {
					tool.result = { content: block.content, isError: block.isError, sourceRecord: origin?.url };
					tool.sourceStatus = block.status ?? tool.sourceStatus;
					tool.status = block.isError
						? "error"
						: block.status && !["success", "completed", "complete"].includes(block.status)
							? "incomplete"
							: "success";
				} else visible.push(block);
			}
			if (!visible.length) continue;
			const hasCalls = visible.some((block) => block.type === "toolCall");
			messages.push({
				messageId,
				role: hasCalls || visible.some((block) => block.type === "thinking") ? "assistant" : source.role,
				content: visible,
				partial: false,
				runId: messageId,
				...(source.role === "context" && !hasCalls && !visible.some((block) => block.type === "thinking")
					? { importedContext: true }
					: {}),
				importedOrigin: origin,
			});
		}
	}
	return { messages, toolCalls, assets, boundary };
}
