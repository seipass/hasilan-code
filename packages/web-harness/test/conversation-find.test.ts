import { describe, expect, it } from "vitest";
import { collectConversationMatches, extractMessageSearchText } from "../src/client/conversation-find.ts";
import type { ChatMessage, ToolCall } from "../src/client/types.ts";

describe("conversation find", () => {
	it("collects case-insensitive matches across multiple virtualized rows", () => {
		const matches = collectConversationMatches(
			[
				{ key: "m1", text: "Hello world, hello again" },
				{ key: "m2", text: "No match here" },
				{ key: "m3", text: "Say HELLO once more" },
			],
			"hello",
		);
		expect(matches).toEqual([
			{ rowKey: "m1", rowIndex: 0, occurrenceInRow: 0 },
			{ rowKey: "m1", rowIndex: 0, occurrenceInRow: 1 },
			{ rowKey: "m3", rowIndex: 2, occurrenceInRow: 0 },
		]);
		expect(collectConversationMatches([{ key: "m1", text: "Hello" }], "   ")).toEqual([]);
	});

	it("extracts searchable text from message content, thinking, attachments and tool inputs", () => {
		const message: ChatMessage = {
			messageId: "m1",
			role: "assistant",
			partial: false,
			content: [
				{ type: "thinking", thinking: "Check SessionOverview styling" },
				{ type: "text", text: "Updated layout cleanly" },
				{ type: "fileAttachment", name: "spec.md", path: ".hasilan-code/attachments/spec.md" },
			],
		};
		const tool: ToolCall = {
			key: "t1",
			sessionId: "s1",
			runId: "r1",
			callId: "c1",
			name: "edit",
			input: { path: "packages/web-harness/src/client/App.tsx" },
			status: "success",
		};
		const text = extractMessageSearchText(message, [tool]);
		expect(text).toContain("Updated layout cleanly");
		expect(text).toContain("Check SessionOverview styling");
		expect(text).toContain("spec.md");
		expect(text).toContain("packages/web-harness/src/client/App.tsx");
	});
});
