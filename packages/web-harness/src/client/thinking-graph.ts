import { record } from "./Content.tsx";
import type { TurnActivity } from "./turn-activity.ts";
import type { ToolCall } from "./types.ts";

export interface ThinkingCitation {
	kind: "file" | "web";
	label: string;
	ext?: string;
	path?: string;
	url?: string;
}

export interface ThinkingGraphNode {
	id: string;
	lane: "main" | "branch";
	kind: "search" | "step" | "dead_end" | "merge" | "finish";
	status: "active" | "done" | "abandoned";
	label: string;
	meta?: string;
	citations?: ThinkingCitation[];
	forkFromId?: string;
	mergeFromId?: string;
	prevMainId?: string;
	prevBranchId?: string;
	thinkingText?: string;
}

export interface ThinkingGraph {
	nodes: ThinkingGraphNode[];
	startedAtMs?: number;
	endedAtMs?: number;
	active: boolean;
}

function shortFileName(path: string): string {
	return path.split(/[\\/]/).at(-1) ?? path;
}

function fileExt(path: string): string {
	const name = shortFileName(path);
	const dot = name.lastIndexOf(".");
	if (dot < 0) return "FILE";
	const raw = name.slice(dot + 1).toUpperCase();
	if (raw === "TSX" || raw === "TS") return "TS";
	if (raw === "JSX" || raw === "JS" || raw === "MJS" || raw === "CJS") return "JS";
	return raw.slice(0, 4);
}

function isSearchTool(name: string): boolean {
	return name === "grep" || name === "glob" || name === "find" || name === "web_search";
}

function isDeadEndText(text: string): boolean {
	return /\b(dead end|won't work|doesn't work|cannot read|can't read|can't handle|approach failed|backtrack)\b|うまくいかない|使えない|読み取れない|方針を変え/i.test(
		text,
	);
}

function summarizeThinkingLine(text: string): string {
	const line = text
		.split(/\r?\n/)
		.map((entry) => entry.replace(/^[#>*\-\s]+/, "").trim())
		.find((entry) => entry.length > 0);
	if (!line) return "状況を整理中";
	return line.length > 88 ? `${line.slice(0, 87)}…` : line;
}

function extractCitationsFromTool(tool: ToolCall): ThinkingCitation[] {
	const citations: ThinkingCitation[] = [];
	const input = record(tool.input) ? tool.input : undefined;
	const result = record(tool.result) ? tool.result : undefined;
	const details = result && record(result.details) ? result.details : result;

	if (typeof input?.path === "string" && input.path.trim()) {
		citations.push({
			kind: "file",
			label: shortFileName(input.path),
			ext: fileExt(input.path),
			path: input.path,
		});
	}
	if (tool.name === "web_search" && Array.isArray(details?.results)) {
		for (const item of details.results.slice(0, 6)) {
			if (!record(item)) continue;
			const url = typeof item.url === "string" ? item.url : undefined;
			const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : url;
			if (title) citations.push({ kind: "web", label: title.slice(0, 44), url });
		}
	}
	if ((tool.name === "grep" || tool.name === "glob" || tool.name === "find") && details) {
		const files = Array.isArray(details.files) ? details.files : undefined;
		if (files) {
			for (const entry of files.slice(0, 8)) {
				const path =
					typeof entry === "string"
						? entry
						: record(entry) && typeof entry.path === "string"
							? entry.path
							: undefined;
				if (path) {
					citations.push({ kind: "file", label: shortFileName(path), ext: fileExt(path), path });
				}
			}
		}
	}
	return citations;
}

function dedupeCitations(list: readonly ThinkingCitation[]): ThinkingCitation[] {
	const seen = new Set<string>();
	const result: ThinkingCitation[] = [];
	for (const citation of list) {
		const key =
			citation.kind === "file" ? `f:${citation.path ?? citation.label}` : `w:${citation.url ?? citation.label}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(citation);
	}
	return result;
}

function describeTool(tool: ToolCall, active: boolean): string {
	const input = record(tool.input) ? tool.input : undefined;
	const path = typeof input?.path === "string" ? shortFileName(input.path) : undefined;
	if (tool.name === "edit") return active ? `編集中: ${path ?? "ファイル"}` : `編集完了: ${path ?? "ファイル"}`;
	if (tool.name === "write") return active ? `作成中: ${path ?? "ファイル"}` : `作成完了: ${path ?? "ファイル"}`;
	if (tool.name === "bash" || tool.name === "shell_process") {
		const cmd =
			typeof input?.command === "string" ? input.command.trim().split(/\r?\n/, 1)[0].slice(0, 56) : undefined;
		if (tool.status === "error") return `失敗: ${cmd ?? "コマンド実行"}`;
		return active ? `実行中: ${cmd ?? "コマンド"}` : `実行完了: ${cmd ?? "コマンド"}`;
	}
	if (tool.name === "team") {
		const action = typeof input?.action === "string" ? input.action : "連携";
		return active ? `並列チーム実行中 (${action})` : `並列チーム完了 (${action})`;
	}
	if (tool.name === "browser") return active ? "ブラウザーを操作中" : "ブラウザー操作を完了";
	if (tool.name === "read") return active ? `確認中: ${path ?? "ファイル"}` : `確認完了: ${path ?? "ファイル"}`;
	return active ? `${tool.name} を実行中` : `${tool.name} を完了`;
}

export function buildThinkingGraph(block: TurnActivity): ThinkingGraph {
	const nodes: ThinkingGraphNode[] = [];
	let lastMainId: string | undefined;
	let startedAtMs: number | undefined;
	let endedAtMs: number | undefined;
	let filesRead = 0;
	let filesEdited = 0;
	let commandsRun = 0;

	const pushMain = (partial: Omit<ThinkingGraphNode, "lane" | "prevMainId">) => {
		const node: ThinkingGraphNode = {
			...partial,
			lane: "main",
			prevMainId: lastMainId,
		};
		nodes.push(node);
		lastMainId = node.id;
		return node;
	};

	const recordTimestamp = (ts?: string) => {
		if (!ts) return;
		const ms = Date.parse(ts);
		if (!Number.isFinite(ms)) return;
		if (startedAtMs === undefined || ms < startedAtMs) startedAtMs = ms;
		if (endedAtMs === undefined || ms > endedAtMs) endedAtMs = ms;
	};

	// Flatten ordered units: thinking blocks and tool call batches (preserving parallel call groups per message).
	type Unit =
		| { kind: "thinking"; id: string; text: string; active: boolean }
		| { kind: "tools"; id: string; tools: ToolCall[] };
	const units: Unit[] = [];

	for (const row of block.items) {
		if (row.kind === "computer") continue;
		recordTimestamp(row.message.timestamp);
		const parts = Array.isArray(row.message.content) ? row.message.content : [];
		let toolCursor = 0;
		const batchTools: ToolCall[] = [];
		const flushBatch = (suffix: number) => {
			if (!batchTools.length) return;
			units.push({ kind: "tools", id: `${row.key}:t:${suffix}`, tools: [...batchTools] });
			batchTools.length = 0;
		};
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index];
			if (!record(part)) continue;
			if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
				flushBatch(index);
				const isLastPart = index === parts.length - 1;
				units.push({
					kind: "thinking",
					id: `${row.key}:th:${index}`,
					text: part.thinking,
					active: block.active && row.message.partial && isLastPart,
				});
			} else if (part.type === "toolCall") {
				const tool = row.tools[toolCursor++];
				if (tool) batchTools.push(tool);
			}
		}
		flushBatch(parts.length);
	}

	let unitIndex = 0;
	while (unitIndex < units.length) {
		const unit = units[unitIndex];
		if (unit.kind === "thinking") {
			const summary = summarizeThinkingLine(unit.text);
			if (isDeadEndText(unit.text) && lastMainId) {
				nodes.push({
					id: unit.id,
					lane: "branch",
					kind: "dead_end",
					status: unit.active ? "active" : "abandoned",
					label: summary,
					forkFromId: lastMainId,
					thinkingText: unit.text,
				});
			} else {
				pushMain({
					id: unit.id,
					kind: "step",
					status: unit.active ? "active" : "done",
					label: summary,
					thinkingText: unit.text,
				});
			}
			unitIndex++;
			continue;
		}

		// Merge consecutive search tool batches into one search node.
		if (unit.tools.every((tool) => isSearchTool(tool.name))) {
			const collected: ToolCall[] = [...unit.tools];
			while (
				unitIndex + 1 < units.length &&
				units[unitIndex + 1].kind === "tools" &&
				(units[unitIndex + 1] as Extract<Unit, { kind: "tools" }>).tools.every((tool) => isSearchTool(tool.name))
			) {
				unitIndex++;
				collected.push(...(units[unitIndex] as Extract<Unit, { kind: "tools" }>).tools);
			}
			const active = collected.some((tool) => tool.status === "running");
			const citations = dedupeCitations(collected.flatMap(extractCitationsFromTool));
			const hasWeb = collected.some((tool) => tool.name === "web_search");
			pushMain({
				id: unit.id,
				kind: "search",
				status: active ? "active" : "done",
				label: active
					? hasWeb
						? "コードベースと Web を検索中"
						: "コードベースを検索中"
					: hasWeb
						? "コードベースと Web を検索完了"
						: "コードベースを検索完了",
				...(citations.length ? { citations } : {}),
			});
			unitIndex++;
			continue;
		}

		// Merge consecutive read tool batches into one counted read node.
		if (unit.tools.every((tool) => tool.name === "read")) {
			const collected: ToolCall[] = [...unit.tools];
			while (
				unitIndex + 1 < units.length &&
				units[unitIndex + 1].kind === "tools" &&
				(units[unitIndex + 1] as Extract<Unit, { kind: "tools" }>).tools.every((tool) => tool.name === "read")
			) {
				unitIndex++;
				collected.push(...(units[unitIndex] as Extract<Unit, { kind: "tools" }>).tools);
			}
			const completedCount = collected.filter((tool) => tool.status !== "running").length;
			const active = collected.some((tool) => tool.status === "running");
			filesRead += collected.length;
			const citations = dedupeCitations(collected.flatMap(extractCitationsFromTool));
			pushMain({
				id: unit.id,
				kind: "step",
				status: active ? "active" : "done",
				label: active
					? `${collected.length} 件中 ${Math.min(collected.length, completedCount + 1)} 件目のファイルを確認中`
					: `${collected.length} 件のファイルを確認`,
				...(citations.length ? { citations } : {}),
			});
			unitIndex++;
			continue;
		}

		// Parallel sub-branch when multiple tools run together in one turn OR team delegation occurs.
		const isParallel = unit.tools.length > 1 || unit.tools.some((tool) => tool.name === "team");
		if (isParallel && lastMainId) {
			const forkParent = lastMainId;
			let prevBranchId: string | undefined;
			const allDone = unit.tools.every((tool) => tool.status !== "running");
			for (const tool of unit.tools) {
				if (tool.name === "edit" || tool.name === "write") filesEdited++;
				if (tool.name === "bash" || tool.name === "shell_process") commandsRun++;
				if (tool.name === "read") filesRead++;
				const active = tool.status === "running";
				const isError = tool.status === "error";
				const nodeId = `${unit.id}:${tool.callId}`;
				const citations = dedupeCitations(extractCitationsFromTool(tool));
				nodes.push({
					id: nodeId,
					lane: "branch",
					kind: isError ? "dead_end" : "step",
					status: active ? "active" : isError ? "abandoned" : "done",
					label: describeTool(tool, active),
					...(citations.length ? { citations } : {}),
					...(prevBranchId ? { prevBranchId } : { forkFromId: forkParent }),
				});
				prevBranchId = nodeId;
			}
			if (prevBranchId) {
				const anySuccess = unit.tools.some((tool) => tool.status !== "error");
				if (anySuccess) {
					pushMain({
						id: `${unit.id}:merge`,
						kind: "merge",
						status: allDone ? "done" : "active",
						label: allDone ? `${unit.tools.length} 件の並列結果を統合` : "並列実行の結果を統合中",
						mergeFromId: prevBranchId,
					});
				}
			}
			unitIndex++;
			continue;
		}

		// Single tool on main trunk (or dead-end side branch on error).
		for (const tool of unit.tools) {
			if (tool.name === "edit" || tool.name === "write") filesEdited++;
			if (tool.name === "bash" || tool.name === "shell_process") commandsRun++;
			const active = tool.status === "running";
			const citations = dedupeCitations(extractCitationsFromTool(tool));
			if (tool.status === "error" && lastMainId) {
				nodes.push({
					id: `${unit.id}:${tool.callId}`,
					lane: "branch",
					kind: "dead_end",
					status: "abandoned",
					label: describeTool(tool, false),
					forkFromId: lastMainId,
				});
			} else {
				pushMain({
					id: `${unit.id}:${tool.callId}`,
					kind: "step",
					status: active ? "active" : "done",
					label: describeTool(tool, active),
					...(citations.length ? { citations } : {}),
				});
			}
		}
		unitIndex++;
	}

	if (!block.active && nodes.length > 0) {
		const stats: string[] = [];
		if (filesRead > 0) stats.push(`${filesRead} ファイル確認`);
		if (filesEdited > 0) stats.push(`${filesEdited} 件編集`);
		if (commandsRun > 0) stats.push(`${commandsRun} コマンド実行`);
		pushMain({
			id: `${block.key}:finish`,
			kind: "finish",
			status: "done",
			label: "思考を完了",
			...(stats.length ? { meta: stats.join(" · ") } : {}),
		});
	}

	return {
		nodes,
		startedAtMs,
		endedAtMs,
		active: block.active,
	};
}
