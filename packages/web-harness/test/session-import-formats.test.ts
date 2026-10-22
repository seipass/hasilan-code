import { describe, expect, it } from "vitest";
import { type JsonRecord, jsonLines } from "../src/server/session-import/common.ts";
import { parseClaude, parseCodex, parseDeepSeek, parseOhMyPi } from "../src/server/session-import/jsonl-formats.ts";
import { parseGrok, parseOpenCode } from "../src/server/session-import/other-formats.ts";

describe("independent session import parsers", () => {
	it("imports Codex response items once, preserves tools as text and applies rollback", () => {
		const result = parseCodex(
			[
				{ type: "session_meta", payload: { id: "codex-example", cwd: "/project" } },
				{
					type: "response_item",
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect code" }] },
				},
				{ type: "event_msg", payload: { type: "user_message", message: "Inspect code" } },
				{
					type: "response_item",
					payload: { type: "function_call", name: "read", call_id: "c1", arguments: '{"path":"main.ts"}' },
				},
				{ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "source" } },
				{
					type: "response_item",
					payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Found it" }] },
				},
				{
					type: "response_item",
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Discard me" }] },
				},
				{
					type: "response_item",
					payload: {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "Discarded answer" }],
					},
				},
				{ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
			],
			"fallback",
			[],
		);
		expect(result.messages.map((message) => message.role)).toEqual(["user", "context", "context", "assistant"]);
		expect(result.messages.map((message) => message.text).join("\n")).toContain("source");
		expect(result.messages.at(-1)?.text).toBe("Found it");
	});
	it("uses Codex compaction replacement instead of duplicating old context", () => {
		const result = parseCodex(
			[
				{ type: "session_meta", payload: { id: "c" } },
				{ type: "response_item", payload: { type: "message", role: "user", content: "old prompt" } },
				{
					type: "compacted",
					payload: { replacement_history: [{ type: "message", role: "user", content: "summary" }] },
				},
				{ type: "response_item", payload: { type: "message", role: "assistant", content: "continued" } },
			],
			"c",
			[],
		);
		expect(result.messages.map((message) => message.text)).toEqual(["summary", "continued"]);
	});
	it("restores Codex context when rollback discards a turn that compacted earlier messages", () => {
		const result = parseCodex(
			[
				{ type: "session_meta", payload: { id: "c" } },
				{ type: "event_msg", payload: { type: "task_started", turn_id: "first" } },
				{ type: "response_item", payload: { type: "message", role: "user", content: "first prompt" } },
				{ type: "response_item", payload: { type: "message", role: "assistant", content: "first answer" } },
				{ type: "event_msg", payload: { type: "task_started", turn_id: "discarded" } },
				{ type: "response_item", payload: { type: "message", role: "user", content: "discarded prompt" } },
				{
					type: "compacted",
					payload: { replacement_history: [{ type: "message", role: "user", content: "discarded summary" }] },
				},
				{ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
			],
			"c",
			[],
		);
		expect(result.messages.map((message) => message.text)).toEqual(["first prompt", "first answer"]);
	});
	it("selects Claude's latest main branch and ignores a late progress record on an older branch", () => {
		const result = parseClaude(
			[
				{
					type: "user",
					uuid: "u",
					parentUuid: null,
					sessionId: "claude-example",
					cwd: "/project",
					message: { content: "question" },
				},
				{ type: "assistant", uuid: "old", parentUuid: "u", message: { content: "old answer" } },
				{
					type: "assistant",
					uuid: "a",
					parentUuid: "u",
					message: { content: [{ type: "text", text: "new answer" }] },
				},
				{ type: "user", uuid: "side", parentUuid: null, isSidechain: true, message: { content: "subagent" } },
				{ type: "progress", uuid: "p", parentUuid: "old" },
				{ type: "custom-title", customTitle: "Reviewed parser" },
			],
			"c",
			[],
		);
		expect(result.messages.map((message) => message.text)).toEqual(["question", "new answer"]);
		expect(result.title).toBe("Reviewed parser");
	});
	it("recovers Claude parallel tool records only from the selected assistant response", () => {
		const result = parseClaude(
			[
				{ type: "user", uuid: "u", parentUuid: null, message: { content: "read both" } },
				{
					type: "assistant",
					uuid: "c1",
					parentUuid: "u",
					message: {
						id: "response",
						content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "one" } }],
					},
				},
				{
					type: "assistant",
					uuid: "c2",
					parentUuid: "c1",
					message: {
						id: "response",
						content: [{ type: "tool_use", id: "t2", name: "read", input: { path: "two" } }],
					},
				},
				{
					type: "user",
					uuid: "r1",
					parentUuid: "c1",
					message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "first result" }] },
				},
				{
					type: "user",
					uuid: "r2",
					parentUuid: "c2",
					message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "second result" }] },
				},
				{ type: "assistant", uuid: "a", parentUuid: "r1", message: { content: "done" } },
			],
			"c",
			[],
		);
		const text = result.messages.map((message) => message.text).join("\n");
		expect(text).toContain("first result");
		expect(text).toContain("second result");
		expect(text).toContain('"path":"two"');
	});
	it("does not follow Claude logical parents back across compaction", () => {
		const result = parseClaude(
			[
				{ type: "user", uuid: "old", parentUuid: null, message: { content: "obsolete" } },
				{
					type: "system",
					uuid: "boundary",
					parentUuid: null,
					logicalParentUuid: "old",
					subtype: "compact_boundary",
				},
				{
					type: "user",
					uuid: "summary",
					parentUuid: "boundary",
					isCompactSummary: true,
					message: { content: "summary" },
				},
			],
			"c",
			[],
		);
		expect(result.messages.map((message) => message.text)).toEqual(["summary"]);
	});
	it("uses oh my pi title slots, active leaf overrides and branch parents", () => {
		const result = parseOhMyPi(
			[
				{ type: "title", title: "Title slot", v: 1 },
				{ type: "session", id: "omp-example", version: 3, cwd: "/project" },
				{ type: "message", id: "u", parentId: null, message: { role: "user", content: "question" } },
				{
					type: "message",
					id: "a",
					parentId: "u",
					message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
				},
				{
					type: "message",
					id: "discarded",
					parentId: "u",
					message: { role: "assistant", content: [{ type: "text", text: "old branch" }] },
				},
				{ type: "model_usage", id: "late", parentId: "discarded", activeLeafId: "a" },
			],
			"o",
			[],
		);
		expect(result.title).toBe("Title slot");
		expect(result.messages.map((message) => message.text)).toEqual(["question", "answer"]);
	});
	it("applies oh my pi reset and compaction without reviving cleared turns", () => {
		const result = parseOhMyPi(
			[
				{ type: "session", id: "o", version: 3 },
				{ type: "message", id: "old", parentId: null, message: { role: "user", content: "cleared" } },
				{ type: "reset_boundary", id: "reset", parentId: "old" },
				{ type: "message", id: "u", parentId: "reset", message: { role: "user", content: "kept prompt" } },
				{ type: "compaction", id: "compact", parentId: "u", summary: "summary", firstKeptEntryId: "u" },
				{
					type: "message",
					id: "a",
					parentId: "compact",
					message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
				},
			],
			"o",
			[],
		);
		expect(result.messages.map((message) => message.text)).toEqual([
			"[会話の要約]\nsummary",
			"kept prompt",
			"answer",
		]);
	});
	it("applies DeepSeek's inclusive surface replacement and preserves current user and assistant roles", () => {
		const result = parseDeepSeek(
			[
				{ type: "session", version: 4, id: "deepseek-example", cwd: "/project" },
				{
					type: "user/message",
					seq: 0,
					surfaceOp: "append",
					data: { role: "user", content: [{ type: "text", text: "old" }] },
				},
				{
					type: "assistant/message",
					seq: 1,
					surfaceOp: "append",
					data: { message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } },
				},
				{
					type: "user/message",
					seq: 2,
					surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
					sourceEventSeqs: [0, 1],
					data: { role: "user", content: [{ type: "text", text: "summary" }] },
				},
				{
					type: "assistant/message",
					seq: 3,
					surfaceOp: "append",
					data: { message: { role: "assistant", content: [{ type: "text", text: "continued" }] } },
				},
			],
			"d",
			[],
		);
		expect(result.messages.map((message) => message.text)).toEqual(["summary", "continued"]);
		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});
	it("refuses unknown required DeepSeek events, future formats, sequence gaps and cyclic branches", () => {
		const header = { type: "session", version: 4, id: "d" };
		expect(() => parseDeepSeek([header, { type: "plugin:unknown", seq: 0, data: {} }], "d", [])).toThrow(
			"plugin:unknown",
		);
		expect(() => parseDeepSeek([{ ...header, version: 99 }], "d", [])).toThrow("99");
		expect(() =>
			parseDeepSeek([header, { type: "user/message", seq: 3, surfaceOp: "append", data: {} }], "d", []),
		).toThrow("連番");
		expect(() =>
			parseOhMyPi(
				[
					{ type: "session", id: "o" },
					{ type: "message", id: "u", parentId: "u", message: {} },
				],
				"o",
				[],
			),
		).toThrow("循環");
	});
	it("reads legacy OpenCode exports and keeps tool state as inert text", () => {
		const result = parseOpenCode(
			{
				info: { id: "oc", directory: "/project", title: "Legacy" },
				messages: [
					{ info: { id: "u", role: "user" }, parts: [{ type: "text", text: "question" }] },
					{
						info: { id: "a", role: "assistant" },
						parts: [
							{
								type: "tool",
								tool: "read",
								state: { input: { path: "main" }, output: "source", status: "completed" },
							},
							{ type: "text", text: "answer" },
						],
					},
				],
			},
			"o",
			[],
		);
		expect(result.messages[0].text).toBe("question");
		expect(result.messages[1].text).toContain("source");
		expect(result.cwd).toBe("/project");
	});
	it("reads modern OpenCode compaction, kept text and staged revert boundaries", () => {
		const result = parseOpenCode(
			{
				info: { id: "oc", location: { directory: "/project" }, revert: { messageID: "gone" } },
				messages: [
					{ id: "old", type: "user", text: "obsolete" },
					{ id: "keep", type: "user", text: "kept prompt" },
					{
						id: "compact",
						type: "compaction",
						status: "completed",
						summary: "summary",
						metadata: { keepID: "keep" },
					},
					{ id: "a", type: "assistant", content: [{ type: "text", text: "answer" }] },
					{ id: "gone", type: "user", text: "discarded" },
				],
			},
			"o",
			[],
		);
		expect(result.messages.map((message) => message.text)).toEqual([
			"[会話の要約]\nsummary",
			"kept prompt",
			"answer",
		]);
	});
	it("replays Grok chunks and rewind markers without importing the stale cache", () => {
		const update = (kind: string, text: string, promptIndex?: number): JsonRecord => ({
			timestamp: 1790812800,
			method: "session/update",
			params: {
				sessionId: "g",
				update: {
					sessionUpdate: kind,
					content: { type: "text", text },
					...(promptIndex === undefined ? {} : { _meta: { promptIndex } }),
				},
			},
		});
		const result = parseGrok(
			[
				update("user_message_chunk", "Inspect ", 0),
				update("user_message_chunk", "parser", 0),
				update("agent_message_chunk", "found"),
				update("user_message_chunk", "discard", 1),
				update("agent_message_chunk", "discarded answer"),
				{
					method: "_x.ai/session/update",
					params: { update: { sessionUpdate: "rewind_marker", target_prompt_index: 1 } },
				},
				update("user_message_chunk", "new prompt", 1),
			],
			{ info: { id: "g", cwd: "/project" } },
			[{ type: "user", content: "stale cache" }],
			new Map(),
			"g",
			[],
		);
		expect(result.messages.map((message) => message.text)).toEqual(["Inspect parser", "found", "new prompt"]);
	});
	it("loads Grok checkpoints and refuses missing required checkpoint data", () => {
		const checkpoint: JsonRecord = {
			method: "_x.ai/session/update",
			params: {
				update: {
					sessionUpdate: "compaction_checkpoint",
					schema_version: 1,
					checkpoint_file: "compaction_checkpoints/c.json",
				},
			},
		};
		const checkpoints = new Map([
			[
				"compaction_checkpoints/c.json",
				{ schema_version: 1, compacted_history: [{ type: "user", content: [{ type: "text", text: "summary" }] }] },
			],
		]);
		expect(parseGrok([checkpoint], {}, [], checkpoints, "g", []).messages[0].text).toBe("summary");
		expect(() => parseGrok([checkpoint], {}, [{ type: "user", content: "stale" }], new Map(), "g", [])).toThrow(
			"チェックポイント",
		);
	});
	it("ignores an obsolete missing Grok checkpoint superseded by a later valid checkpoint", () => {
		const checkpoint = (path: string): JsonRecord => ({
			method: "_x.ai/session/update",
			params: { update: { sessionUpdate: "compaction_checkpoint", schema_version: 1, checkpoint_file: path } },
		});
		const result = parseGrok(
			[checkpoint("compaction_checkpoints/missing.json"), checkpoint("compaction_checkpoints/current.json")],
			{},
			[],
			new Map([
				[
					"compaction_checkpoints/current.json",
					{ schema_version: 1, compacted_history: [{ type: "user", content: "current summary" }] },
				],
			]),
			"g",
			[],
		);
		expect(result.messages[0].text).toBe("current summary");
	});
	it("warns for omitted media, rejects corrupt middle rows and tolerates only a torn final row", () => {
		const warnings: string[] = [];
		expect(jsonLines('{"type":"ok"}\n{"type":', warnings)).toHaveLength(1);
		expect(warnings).toHaveLength(1);
		expect(() => jsonLines('{"type":"ok"}\nINVALID\n{"type":"ok"}\n', [])).toThrow("2 行目");
		const result = parseCodex(
			[
				{ type: "session_meta", payload: { id: "c" } },
				{
					type: "response_item",
					payload: { type: "message", role: "user", content: [{ type: "image", data: "synthetic" }] },
				},
			],
			"c",
			[],
		);
		expect(result.warnings.join("\n")).toContain("添付ファイル");
		expect(result.messages[0].text).not.toContain("synthetic");
	});
});
