import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { conversationRows } from "../src/client/computer-activity.ts";
import { buildThinkingGraph } from "../src/client/thinking-graph.ts";
import { ThinkingTimeline } from "../src/client/ThinkingTimeline.tsx";
import { turnActivityRows } from "../src/client/turn-activity.ts";
import type { ChatMessage, ToolCall } from "../src/client/types.ts";

describe("Branching ThinkingTimeline", () => {
	it("builds main trunk, search citations, dead-end side branch, parallel branch + merge, and finish node", () => {
		const tools: ToolCall[] = [
			{
				key: "t1",
				sessionId: "s1",
				runId: "r1",
				callId: "c1",
				name: "grep",
				input: { pattern: "session" },
				result: { details: { files: ["src/router.ts", "src/auth.ts"] } },
				status: "success",
			},
			{
				key: "t2",
				sessionId: "s1",
				runId: "r1",
				callId: "c2",
				name: "read",
				input: { path: "src/router.ts" },
				status: "success",
			},
			{
				key: "t3",
				sessionId: "s1",
				runId: "r1",
				callId: "c3",
				name: "read",
				input: { path: "src/auth.ts" },
				status: "success",
			},
			{
				key: "t4",
				sessionId: "s1",
				runId: "r1",
				callId: "c4",
				name: "bash",
				input: { command: "pnpm test auth" },
				status: "success",
			},
			{
				key: "t5",
				sessionId: "s1",
				runId: "r1",
				callId: "c5",
				name: "bash",
				input: { command: "pnpm test checkout" },
				status: "success",
			},
		];
		const messages: ChatMessage[] = [
			{
				messageId: "m1",
				role: "assistant",
				runId: "r1",
				partial: false,
				timestamp: "2026-10-01T00:00:00Z",
				content: [{ type: "toolCall", id: "c1", name: "grep" }],
			},
			{
				messageId: "m2",
				role: "assistant",
				runId: "r1",
				partial: false,
				timestamp: "2026-10-01T00:00:03Z",
				content: [
					{ type: "toolCall", id: "c2", name: "read" },
					{ type: "toolCall", id: "c3", name: "read" },
				],
			},
			{
				messageId: "m3",
				role: "assistant",
				runId: "r1",
				partial: false,
				timestamp: "2026-10-01T00:00:06Z",
				content: [{ type: "thinking", thinking: "Dead end: middleware can't read the request body" }],
			},
			{
				messageId: "m4",
				role: "assistant",
				runId: "r1",
				partial: false,
				timestamp: "2026-10-01T00:00:10Z",
				content: [
					{ type: "toolCall", id: "c4", name: "bash" },
					{ type: "toolCall", id: "c5", name: "bash" },
				],
			},
		];

		const [activity] = turnActivityRows(conversationRows(messages, tools));
		if (activity.kind !== "activity") throw new Error("Expected activity row");
		const graph = buildThinkingGraph(activity);

		const searchNode = graph.nodes.find((node) => node.kind === "search");
		expect(searchNode?.citations?.map((c) => c.label)).toEqual(["router.ts", "auth.ts"]);

		const deadEndNode = graph.nodes.find((node) => node.kind === "dead_end");
		expect(deadEndNode).toMatchObject({ lane: "branch", status: "abandoned" });
		expect(deadEndNode?.forkFromId).toBeTruthy();

		const mergeNode = graph.nodes.find((node) => node.kind === "merge");
		expect(mergeNode).toMatchObject({ lane: "main", status: "done" });
		expect(mergeNode?.mergeFromId).toBeTruthy();

		const finishNode = graph.nodes.at(-1);
		expect(finishNode).toMatchObject({ kind: "finish", lane: "main", label: "思考を完了" });
		expect(finishNode?.meta).toContain("2 ファイル確認");

		const html = renderToStaticMarkup(<ThinkingTimeline block={activity} onFile={() => {}} />);
		expect(html).toContain("router.ts");
		expect(html).toContain("is-dead_end");
		expect(html).toContain("is-merge");
		expect(html).toContain("is-finish");
	});
});
