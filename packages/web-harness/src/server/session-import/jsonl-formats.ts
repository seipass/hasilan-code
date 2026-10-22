import type { ImportedTranscript, SessionImportMessage } from "../../shared/session-import.ts";
import { activeBranch, addMessage, contentText, type JsonRecord, record, string, transcript } from "./common.ts";

function responseMessage(item: JsonRecord, messages: SessionImportMessage[], warnings: string[], time?: unknown): void {
	if (item.type === "message") {
		const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : "context";
		const text = contentText(item.content, warnings);
		addMessage(messages, role, role === "context" ? `[元の ${String(item.role)} メッセージ]\n${text}` : text, time);
	} else if (["function_call", "custom_tool_call", "local_shell_call"].includes(String(item.type))) {
		addMessage(
			messages,
			"context",
			`[ツール呼び出し: ${string(item.name) ?? String(item.type)}]\n${typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.input ?? item.action ?? item.arguments ?? {})}`,
			time,
		);
	} else if (
		["function_call_output", "custom_tool_call_output", "local_shell_call_output"].includes(String(item.type))
	) {
		addMessage(
			messages,
			"context",
			`[ツール結果: ${string(item.call_id) ?? "tool"}]\n${contentText(item.output, warnings) || JSON.stringify(item.output ?? "")}`,
			time,
		);
	} else if (item.type === "reasoning" && Array.isArray(item.summary)) {
		const summary = item.summary
			.map((part) => string(record(part).text) ?? "")
			.filter(Boolean)
			.join("\n");
		addMessage(messages, "context", summary ? `[推論の要約]\n${summary}` : "", time);
	}
}

export function parseCodex(entries: JsonRecord[], fallbackId: string, warnings: string[]): ImportedTranscript {
	const meta = record(entries.find((entry) => entry.type === "session_meta")?.payload);
	if (!string(meta.id)) throw new Error("Codex の session_meta が見つかりません。");
	const messages: SessionImportMessage[] = [];
	const fallback: SessionImportMessage[] = [];
	// Remove abandoned turns before applying compaction: a rollback can discard a compaction itself.
	const active: JsonRecord[] = [];
	const starts: number[] = [];
	const explicitTurns = entries.some(
		(entry) =>
			entry.type === "event_msg" && ["task_started", "turn_started"].includes(String(record(entry.payload).type)),
	);
	const responseUsers = entries.some(
		(entry) => entry.type === "response_item" && record(entry.payload).role === "user",
	);
	for (const entry of entries) {
		const payload = record(entry.payload);
		if (entry.type === "event_msg" && payload.type === "thread_rolled_back") {
			const count = Number(payload.num_turns);
			if (!Number.isSafeInteger(count) || count < 0) throw new Error("Codex の巻き戻し記録が不正です。");
			if (count > 0 && starts.length) {
				const turn = Math.max(0, starts.length - count);
				active.splice(starts[turn]);
				starts.splice(turn);
			}
			continue;
		}
		const boundary = explicitTurns
			? entry.type === "event_msg" && ["task_started", "turn_started"].includes(String(payload.type))
			: responseUsers
				? entry.type === "response_item" && payload.role === "user"
				: entry.type === "event_msg" && payload.type === "user_message";
		if (boundary) starts.push(active.length);
		active.push(entry);
	}
	for (const entry of active) {
		const item = record(entry.payload);
		if (entry.type === "response_item") responseMessage(item, messages, warnings, entry.timestamp);
		else if (entry.type === "compacted") {
			if (Array.isArray(item.replacement_history)) {
				messages.length = 0;
				for (const replacement of item.replacement_history)
					responseMessage(record(replacement), messages, warnings, entry.timestamp);
			} else {
				const users = messages.filter((message) => message.role === "user");
				messages.splice(0, messages.length, ...users);
				addMessage(messages, "context", `[会話の要約]\n${string(item.message) ?? ""}`, entry.timestamp);
			}
		} else if (entry.type === "event_msg") {
			if (item.type === "user_message") addMessage(fallback, "user", string(item.message) ?? "", entry.timestamp);
			else if (item.type === "agent_message")
				addMessage(fallback, "assistant", string(item.message) ?? "", entry.timestamp);
		}
	}
	if (!messages.length && fallback.length) {
		messages.push(...fallback);
		warnings.push("イベントの表示履歴から復元しました。ツールの詳細が含まれない場合があります。");
	}
	return transcript("codex", string(meta.id) ?? fallbackId, meta.cwd, meta.title, messages, warnings);
}

export function parseClaude(entries: JsonRecord[], fallbackId: string, warnings: string[]): ImportedTranscript {
	const linked = entries.filter(
		(entry) =>
			["user", "assistant", "progress", "system", "attachment"].includes(String(entry.type)) && string(entry.uuid),
	);
	const main = linked.filter((entry) => !entry.isSidechain && !entry.teamName);
	const leaf = main.findLastIndex((entry) => (entry.type === "user" || entry.type === "assistant") && !entry.isMeta);
	if (leaf < 0) throw new Error("Claude Code の会話メッセージが見つかりません。");
	// Late progress records must not switch the selected conversation back to an older branch.
	const branch = activeBranch(main.slice(0, leaf + 1), "uuid", "parentUuid");
	const selectedIds = new Set(branch.map((entry) => entry.uuid));
	// Parallel tools can be siblings. Recover their records only when their parent call belongs to this branch.
	const responseIds = new Set(
		branch
			.filter((entry) => entry.type === "assistant")
			.map((entry) => string(record(entry.message).id))
			.filter(Boolean),
	);
	for (const entry of main.slice(0, leaf + 1)) {
		if (selectedIds.has(entry.uuid)) continue;
		if (entry.type === "assistant" && responseIds.has(string(record(entry.message).id))) selectedIds.add(entry.uuid);
		if (entry.type === "user" && selectedIds.has(entry.parentUuid)) {
			const content = record(entry.message).content;
			if (Array.isArray(content) && content.some((part) => record(part).type === "tool_result"))
				selectedIds.add(entry.uuid);
		}
	}
	const messages: SessionImportMessage[] = [];
	for (const entry of main.filter((item) => selectedIds.has(item.uuid))) {
		const message = record(entry.message);
		if (entry.type !== "user" && entry.type !== "assistant") continue;
		const content = message.content;
		const toolResult = Array.isArray(content) && content.every((part) => record(part).type === "tool_result");
		addMessage(
			messages,
			toolResult || entry.isMeta ? "context" : entry.type,
			contentText(content, warnings),
			entry.timestamp,
		);
	}
	const meta = main[leaf];
	const title =
		entries.findLast((entry) => entry.type === "custom-title")?.customTitle ??
		entries.findLast((entry) => entry.type === "summary")?.summary;
	return transcript(
		"claude-code",
		string(meta.sessionId) ?? fallbackId,
		meta.cwd ?? main.find((entry) => string(entry.cwd))?.cwd,
		title,
		messages,
		warnings,
	);
}

export function parseOhMyPi(entries: JsonRecord[], fallbackId: string, warnings: string[]): ImportedTranscript {
	const header = entries.find((entry) => entry.type === "session");
	if (!header || !string(header.id)) throw new Error("oh my pi のセッションヘッダーが見つかりません。");
	const version = header.version ?? 1;
	if (typeof version !== "number" || version < 1 || version > 3)
		throw new Error(`oh my pi の形式バージョン ${String(version)} には対応していません。`);
	const nodes = entries.filter((entry) => entry.type !== "session" && entry.type !== "title");
	const last = nodes.findLast((entry) => string(entry.id));
	let branch: JsonRecord[];
	if (last && Object.hasOwn(last, "activeLeafId")) {
		const leaf = last.activeLeafId;
		if (leaf === null) branch = [];
		else {
			const index = nodes.findIndex((entry) => entry.id === leaf);
			if (index < 0) throw new Error("oh my pi の有効な分岐が見つかりません。");
			branch = activeBranch([...nodes.filter((entry) => entry.id !== leaf), nodes[index]], "id", "parentId");
		}
	} else branch = activeBranch(nodes, "id", "parentId");
	const reset = branch.findLastIndex((entry) => entry.type === "reset_boundary");
	if (reset >= 0) branch = branch.slice(reset + 1);
	const compaction = branch.findLastIndex((entry) => entry.type === "compaction");
	let summary: JsonRecord | undefined;
	if (compaction >= 0) {
		summary = branch[compaction];
		const firstKept = branch.findIndex((entry) => entry.id === summary?.firstKeptEntryId);
		if (firstKept < 0) throw new Error("oh my pi の要約後に残すメッセージが見つかりません。");
		branch = branch.slice(firstKept).filter((entry) => entry !== summary);
	}
	const messages: SessionImportMessage[] = [];
	if (summary) addMessage(messages, "context", `[会話の要約]\n${string(summary.summary) ?? ""}`, summary.timestamp);
	for (const entry of branch) {
		if (entry.type === "message") {
			const message = record(entry.message);
			const role = message.role === "user" || message.role === "assistant" ? message.role : "context";
			let text = contentText(message.content, warnings);
			if (message.role === "toolResult") text = `[ツール結果: ${string(message.toolName) ?? "tool"}]\n${text}`;
			else if (message.role === "bashExecution")
				text = `[端末実行]\n${string(message.command) ?? ""}\n${string(message.output) ?? ""}`;
			else if (message.role === "system") continue;
			addMessage(messages, role, text, message.timestamp ?? entry.timestamp);
		} else if (entry.type === "custom_message")
			addMessage(messages, "context", contentText(entry.content, warnings), entry.timestamp);
		else if (entry.type === "branch_summary")
			addMessage(messages, "context", `[分岐の要約]\n${string(entry.summary) ?? ""}`, entry.timestamp);
	}
	const title =
		entries.findLast((entry) => entry.type === "title")?.title ??
		entries.findLast((entry) => entry.type === "title_change")?.title ??
		header.title;
	return transcript("oh-my-pi", string(header.id) ?? fallbackId, header.cwd, title, messages, warnings);
}

const DEEPSEEK_LOG_EVENTS = new Set([
	"agent-preset/selected",
	"agent/inbox/spliced",
	"approval/asked",
	"approval/decided",
	"approval/policy",
	"assistant/attempt",
	"command/done",
	"command/run",
	"compaction/end",
	"compaction/prune",
	"compaction/start",
	"compaction/summary",
	"deliverables/presented",
	"feedback/message-delete",
	"feedback/message-put",
	"feedback/record",
	"goal/change",
	"hook/invoked",
	"hook/result",
	"job/registered",
	"job/settled",
	"llm/retry",
	"llm/retry-started",
	"model/selection",
	"permission/preset",
	"plan/mode",
	"request/context",
	"request/header",
	"sandbox/mode",
	"schedule/change",
	"session-log-deepseek/delivery-accepted",
	"session/end-seed",
	"session/title",
	"session/title-llm-request",
	"step/end",
	"step/start",
	"subagent/catalog",
	"subagent/descriptor",
	"subagent/model-selection-policy",
	"team/member",
	"team/message/delivered",
	"team/message/queued",
	"team/task",
	"todo/write",
	"tool-workflow/agent-end",
	"tool-workflow/agent-start",
	"tool-workflow/run-end",
	"tool-workflow/run-start",
	"tool/call",
	"tool/ptc-dispatch",
	"tool/ptc-dispatch-start",
	"turn/end",
	"turn/start",
	"web/deepseek-search-llm-request",
	"working-directory/change",
	"workspace/changes",
]);
export function parseDeepSeek(entries: JsonRecord[], fallbackId: string, warnings: string[]): ImportedTranscript {
	const header = entries[0];
	if (header?.type !== "session" || !string(header.id))
		throw new Error("deepseek harness のセッションヘッダーが見つかりません。");
	if (![3, 4].includes(Number(header.version)))
		throw new Error(`deepseek harness の形式バージョン ${String(header.version)} には対応していません。`);
	const surface: JsonRecord[] = [];
	let seq = 0;
	let title: unknown;
	let cwd = header.cwd;
	for (const entry of entries.slice(1)) {
		if (entry.seq !== seq++) throw new Error("deepseek harness の履歴の連番が欠けています。");
		const data = record(entry.data);
		if (entry.type === "session/title") title = data.title;
		if (entry.type === "working-directory/change") cwd = data.cwd ?? data.path ?? cwd;
		if (
			["user/message", "assistant/message", "system/message", "developer/message", "tool/result"].includes(
				String(entry.type),
			)
		) {
			if (entry.surfaceOp === "append") surface.push(entry);
			else {
				const op = record(entry.surfaceOp);
				const start = surface.findIndex((node) => node.seq === op.startSeq);
				const end = surface.findIndex((node) => node.seq === op.endSeq);
				if (op.op !== "replace" || start < 0 || end < start)
					throw new Error("deepseek harness の履歴置換範囲が不正です。");
				surface.splice(start, end - start + 1, entry);
			}
		} else if (!DEEPSEEK_LOG_EVENTS.has(String(entry.type)) && entry.ignorable !== true) {
			throw new Error(
				`deepseek harness のイベント ${String(entry.type)} は解釈できません。元のハーネスでテキスト履歴に書き出してください。`,
			);
		}
	}
	const messages: SessionImportMessage[] = [];
	for (const entry of surface) {
		const data = record(entry.data);
		const message = entry.type === "user/message" ? data : record(data.message);
		if (entry.type === "system/message" || entry.type === "developer/message") continue;
		const role =
			entry.type === "user/message" ? "user" : entry.type === "assistant/message" ? "assistant" : "context";
		const text = contentText(message.content, warnings);
		addMessage(
			messages,
			role,
			role === "context"
				? `[ツール結果: ${string(message.name) ?? string(message.toolName) ?? "tool"}]\n${text}`
				: text,
			entry.time,
		);
	}
	return transcript("deepseek-harness", string(header.id) ?? fallbackId, cwd, title, messages, warnings);
}
