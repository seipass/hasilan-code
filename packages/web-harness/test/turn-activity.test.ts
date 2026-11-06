import { describe, expect, it } from "vitest";
import { conversationRows } from "../src/client/computer-activity.ts";
import { turnActivityLabel, turnActivityRows } from "../src/client/turn-activity.ts";
import type { ChatMessage, ToolCall } from "../src/client/types.ts";

function assistant(messageId: string, content: unknown, partial = false): ChatMessage {
	return { role: "assistant", messageId, runId: "r1", content, partial };
}

const read: ToolCall = {
	key: "r1/read-1",
	sessionId: "s1",
	runId: "r1",
	callId: "read-1",
	name: "read",
	input: { path: "src/config.ts" },
	status: "success",
};
const investigation = assistant("investigation", [
	{ type: "thinking", thinking: "Locate the configuration." },
	{ type: "toolCall", id: read.callId, name: read.name },
]);

describe("beta chat activity", () => {
	it("keeps the same block after a tool completes and switches its live label", () => {
		const running = { ...read, status: "running" as const };
		const [before] = turnActivityRows(conversationRows([investigation], [running]), "r1");
		const [after] = turnActivityRows(conversationRows([investigation], [read]), "r1");
		if (before.kind !== "activity" || after.kind !== "activity") throw new Error("Expected an activity block");
		expect(before.key).toBe(after.key);
		expect(turnActivityLabel(before)).toBe("ファイルを確認中 · config.ts");
		expect(after.active).toBe(true);
		expect(turnActivityLabel(after)).toBe("思考中…");
	});

	it("settles the previous block at commentary and final answer, even within one assistant message", () => {
		const commentary = {
			type: "text",
			text: "修正に進みます。",
			textSignature: JSON.stringify({ phase: "commentary" }),
		};
		const final = { type: "text", text: "修正しました。" };
		const reply = assistant("reply", [commentary, { type: "thinking", thinking: "Apply the fix." }, final], true);
		const [first, report, second, answer] = turnActivityRows(conversationRows([investigation, reply], [read]), "r1");
		expect(first).toMatchObject({ kind: "activity", active: false });
		expect(report).toMatchObject({ kind: "message", message: { content: [commentary] } });
		expect(second).toMatchObject({ kind: "activity", active: false });
		expect(answer).toMatchObject({ kind: "message", message: { content: [final] } });
	});

	it("settles on turn end and keeps interactive computer rows outside the accordion", () => {
		const computer = { ...read, name: "computer", callId: "screen", key: "r1/screen" };
		const screenshot = assistant("screen", [{ type: "toolCall", id: computer.callId, name: computer.name }]);
		const rows = conversationRows([investigation, screenshot], [read, computer], "r1");
		const [block, viewer] = turnActivityRows(rows, "r1");
		expect(block).toMatchObject({ kind: "activity", active: false });
		expect(viewer).toMatchObject({ kind: "computer", group: { live: true } });
		const [finished] = turnActivityRows(conversationRows([investigation], [read]));
		if (finished.kind !== "activity") throw new Error("Expected an activity block");
		expect(finished.active).toBe(false);
		expect(turnActivityLabel(finished)).toBe("ファイル確認 1件");
	});
});
