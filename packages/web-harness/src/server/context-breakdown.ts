import { estimateTokens, type SessionManager } from "@hasilan-code/pi-coding-agent";
import type { ContextBreakdown, McpContextEntry } from "../shared/context-window.ts";

const MAX_MESSAGE_SEGMENTS = 36;

export interface ActiveToolSchemaInfo {
	name: string;
	description?: string;
	parameters?: unknown;
}

export interface ContextBreakdownInput {
	manager: SessionManager;
	contextWindow: number;
	reportedTotalTokens?: number | null;
	reserveTokens: number;
	maxContextTokens?: number;
	activeTools?: readonly ActiveToolSchemaInfo[];
}

function estimateCharsTokens(chars: number): number {
	return Math.max(0, Math.ceil(chars / 4));
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
			if (typeof part.text === "string") text += part.text;
		}
	}
	return text;
}

function downsampleSegments(weights: readonly number[], maxBuckets = MAX_MESSAGE_SEGMENTS): number[] {
	const positive = weights.filter((value) => value > 0);
	if (positive.length <= maxBuckets) return positive;
	const result: number[] = [];
	const step = positive.length / maxBuckets;
	for (let index = 0; index < maxBuckets; index++) {
		const start = Math.floor(index * step);
		const end = Math.max(start + 1, Math.floor((index + 1) * step));
		let sum = 0;
		for (let cursor = start; cursor < end && cursor < positive.length; cursor++) sum += positive[cursor];
		if (sum > 0) result.push(sum);
	}
	return result;
}

function extractMcpServerName(toolName: string): string | undefined {
	if (toolName.startsWith("mcp__")) {
		const second = toolName.indexOf("__", 5);
		return second > 5 ? toolName.slice(5, second) : toolName.slice(5);
	}
	if (toolName.startsWith("mcp:")) {
		const rest = toolName.slice(4);
		const sep = rest.search(/[:/._]/);
		return sep > 0 ? rest.slice(0, sep) : rest || "mcp";
	}
	return undefined;
}

export function computeContextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
	const contextWindow = Math.max(1, Math.round(input.contextWindow));
	const projection = input.manager.buildSessionProjection();

	let rawSystemTokens = 0;
	let skillsTokens = 0;
	let skillsCount = 0;
	let mcpInstructionsTokens = 0;

	const messageWeights: number[] = [];
	let rawMessagesTokens = 0;

	for (const message of projection.messages) {
		if (message.role === "system") {
			const messageTokens = estimateTokens(message);
			rawSystemTokens += messageTokens;
			const parts: string[] = [extractTextFromContent(message.content)];
			if ("sections" in message && message.sections && typeof message.sections === "object") {
				for (const sectionValue of Object.values(message.sections as Record<string, unknown>)) {
					if (typeof sectionValue === "string") parts.push(sectionValue);
				}
			}
			const combined = parts.join("\n");
			const skillsMatch = /<available_skills>[\s\S]*?<\/available_skills>/i.exec(combined);
			if (skillsMatch) {
				skillsTokens += estimateCharsTokens(skillsMatch[0].length);
				skillsCount += (skillsMatch[0].match(/<skill[\s>]/gi) ?? []).length;
			}
			const mcpMatch = /<mcp_instructions>[\s\S]*?<\/mcp_instructions>/i.exec(combined);
			if (mcpMatch) {
				mcpInstructionsTokens += estimateCharsTokens(mcpMatch[0].length);
			}
			continue;
		}
		const weight = Math.max(1, estimateTokens(message));
		messageWeights.push(weight);
		rawMessagesTokens += weight;
	}

	const mcpByServer = new Map<string, number>();
	let mcpToolsTokens = 0;
	let builtinToolsTokens = 0;
	for (const tool of input.activeTools ?? []) {
		const serialized = JSON.stringify({
			name: tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters ?? {},
		});
		const tokens = estimateCharsTokens(serialized.length);
		const server = extractMcpServerName(tool.name);
		if (server) {
			mcpByServer.set(server, (mcpByServer.get(server) ?? 0) + tokens);
			mcpToolsTokens += tokens;
		} else {
			builtinToolsTokens += tokens;
		}
	}

	const systemTokens = Math.max(0, rawSystemTokens - skillsTokens - mcpInstructionsTokens) + builtinToolsTokens;
	const mcpTokens = mcpToolsTokens + mcpInstructionsTokens;
	const mcpServers: McpContextEntry[] = [...mcpByServer.entries()]
		.map(([name, tokens]) => ({ name, tokens }))
		.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

	const fixedTokens = systemTokens + mcpTokens + skillsTokens;
	const estimatedTotal = fixedTokens + rawMessagesTokens;
	const reported =
		typeof input.reportedTotalTokens === "number" &&
		Number.isFinite(input.reportedTotalTokens) &&
		input.reportedTotalTokens > 0
			? Math.round(input.reportedTotalTokens)
			: undefined;

	let messagesTokens = rawMessagesTokens;
	let totalTokens = estimatedTotal;
	if (reported !== undefined) {
		totalTokens = reported;
		if (reported >= fixedTokens) {
			messagesTokens = reported - fixedTokens;
		} else if (estimatedTotal > 0) {
			const scale = reported / estimatedTotal;
			messagesTokens = Math.max(0, Math.round(rawMessagesTokens * scale));
		}
	}

	const reservedTokens = Math.min(contextWindow, Math.max(0, Math.round(input.reserveTokens)));
	const autoCompactThreshold = Math.min(
		Math.max(0, contextWindow - reservedTokens),
		input.maxContextTokens !== undefined && Number.isFinite(input.maxContextTokens)
			? Math.max(0, Math.round(input.maxContextTokens))
			: Number.POSITIVE_INFINITY,
	);
	const freeTokens = Math.max(0, contextWindow - totalTokens - reservedTokens);
	const untilAutoCompact = Math.max(0, autoCompactThreshold - totalTokens);
	const percent = Math.min(100, Math.max(0, (totalTokens / contextWindow) * 100));

	return {
		contextWindow,
		autoCompactThreshold,
		totalTokens,
		percent,
		systemTokens,
		mcpTokens,
		mcpServers,
		mcpInstructionsTokens,
		skillsTokens,
		skillsCount,
		messagesTokens,
		messageCount: messageWeights.length,
		messageSegments: downsampleSegments(messageWeights),
		reservedTokens,
		freeTokens,
		untilAutoCompact,
	};
}
