import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComputerActivity } from "../src/client/ComputerActivity.tsx";
import { computerAction, computerFrames, computerPointer, conversationRows } from "../src/client/computer-activity.ts";
import { Conversation } from "../src/client/Conversation.tsx";
import type { ChatMessage, ToolCall } from "../src/client/types.ts";

function tool(index: number, action = "screenshot", overrides: Partial<ToolCall> = {}): ToolCall {
	return {
		key: `run/call-${index}`, sessionId: "session", runId: "run", callId: `call-${index}`, name: "computer",
		input: { action }, status: "success",
		result: { details: { frameId: `frame-${index}`, width: 1000, height: 500, monitor: 1, artifact: { id: `image-${index}` } } },
		...overrides,
	};
}

function message(index: number, tools: ToolCall[], content: unknown[] = []): ChatMessage {
	return {
		messageId: `message-${index}`, role: "assistant", runId: tools[0]?.runId, partial: false,
		content: [...content, ...tools.map((call) => ({ type: "toolCall", id: call.callId, name: call.name, arguments: call.input }))],
	};
}

describe("Computer use activity", () => {
	it("shows the Jev tool's live screen and its recorded operations in the same interactive viewer", () => {
		const jev = tool(1, "task", { name: "jev_computer", status: "running", input: { objective: "Open settings" }, result: { details: { mode: "jev", frames: [
			{ action: "screenshot", frameId: "first", width: 100, height: 50, artifact: { id: "first-image" } },
			{ action: "click", frameId: "second", width: 100, height: 50, artifact: { id: "second-image" }, input: { action: "click", frameId: "first", x: 10, y: 20 } },
		] } } });
		const [row] = conversationRows([message(1, [jev])], [jev], "run");
		if (row.kind !== "computer") throw new Error("Expected computer activity");
		const frames = computerFrames(row.group.tools);
		expect(frames.map((entry) => entry.url)).toEqual(["/api/artifacts/first-image", "/api/artifacts/second-image"]);
		expect(computerPointer(frames[1].tool, frames)).toEqual({ x: 10, y: 40 });
		const markup = renderToStaticMarkup(<ComputerActivity group={row.group} onFile={() => {}} />);
		expect(markup).toContain("判断モデル Computer use");
		expect(markup).toContain('src="/api/artifacts/second-image"');
		expect(markup).toContain("操作の履歴");
	});
	it("keeps one stable viewer as operations move across assistant messages", () => {
		const screenshot = tool(1);
		const click = tool(2, "click");
		const first = conversationRows([message(1, [screenshot])], [screenshot], "run");
		const next = conversationRows([message(1, [screenshot]), message(2, [click])], [screenshot, click], "run");
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({ key: first[0].key, kind: "computer", group: { live: true, tools: [screenshot, click] } });
		expect(conversationRows([message(1, [screenshot])], [screenshot])[0]).toMatchObject({ group: { live: false } });
	});

	it("separates successful release cycles and different runs but retains a failed release", () => {
		const calls = [tool(1), tool(2, "release", { status: "error", result: { error: "busy" } }), tool(3),
			tool(4, "release", { result: { details: { released: true } } }), tool(5), tool(6, "screenshot", { runId: "other" })];
		const rows = conversationRows(calls.map((call, index) => message(index, [call])), calls, "other");
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({ group: { tools: calls.slice(0, 4), released: true, live: false } });
		expect(rows[1]).toMatchObject({ group: { tools: [calls[4]], released: false, live: false } });
		expect(rows[2]).toMatchObject({ group: { tools: [calls[5]], live: true } });
	});

	it("preserves prose, thinking, and ordinary tools around the viewer", () => {
		const calls = [tool(1), tool(2, "read", { name: "read", input: { path: "file.txt" } })];
		const mixed = message(1, calls, [{ type: "text", text: "画面を確認します。" }, { type: "thinking", thinking: "Review the window" }]);
		const rows = conversationRows([mixed], calls, "run");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ kind: "message", message: mixed, tools: calls });
		const html = renderToStaticMarkup(<Conversation messages={[mixed]} tools={calls} activeRunId="run" onFile={() => {}} followRequest={0} />);
		expect(html).toContain("画面を確認します。");
		expect(html).toContain("Review the window");
		expect(html).toContain("Read file");
		expect(html.match(/class="computer-activity"/g)).toHaveLength(1);
		expect(html).not.toContain('tool-heading"><strong>Computer');
	});

	it("does not turn imported or injected context into live activity", () => {
		const call = tool(1);
		const imported = { ...message(1, [call]), importedContext: true };
		const injected: ChatMessage = { ...message(2, [call]), role: "toolResult", contextInjection: {
			injectionId: "injection", content: "Agent result", source: { type: "team_message", agentId: "agent", agentName: "Worker" },
		} };
		const result: ChatMessage = { messageId: "result", role: "toolResult", content: [], partial: false };
		expect(conversationRows([imported, injected, result], [call], "run").map((row) => row.kind)).toEqual(["message", "message"]);
	});

	it("keeps unknown calls visible and stops the live state on cancellation", () => {
		const call = tool(1, "screenshot", { status: "cancelled", result: undefined });
		expect(conversationRows([message(1, [call])], [], "run")[0].kind).toBe("message");
		expect(conversationRows([message(1, [call])], [call], "run")[0]).toMatchObject({ group: { live: false } });
	});

	it("retains the last screenshot after release and lazily renders the original calls", () => {
		const calls = [tool(1), tool(2, "release", { result: { details: { released: true } } })];
		const [row] = conversationRows(calls.map((call, index) => message(index, [call])), calls, "run");
		if (row.kind !== "computer") throw new Error("Expected Computer use activity");
		const html = renderToStaticMarkup(<ComputerActivity group={row.group} onFile={() => {}} />);
		expect(html).toContain("操作終了");
		expect(html).toContain('src="/api/artifacts/image-1"');
		expect(html).toContain("呼び出し履歴 · 2");
		expect(html).not.toContain("tool-card");
	});

	it("does not create hundreds of empty virtual rows or eager tool cards", () => {
		const calls = Array.from({ length: 200 }, (_, index) => tool(index));
		const html = renderToStaticMarkup(<Conversation messages={calls.map((call, index) => message(index, [call]))} tools={calls} activeRunId="run" onFile={() => {}} followRequest={0} />);
		expect(html.match(/class="virtual-message"/g)).toHaveLength(1);
		expect(html).toContain('src="/api/artifacts/image-199"');
		expect(html).toContain("操作の履歴");
		expect(html).not.toContain("tool-card");
	});

	it("uses only same-origin artifact identifiers and valid image dimensions", () => {
		const calls = [tool(1, "screenshot", { result: { details: { width: 100, height: 50, artifact: { id: "id/with spaces", url: "https://remote.invalid/image" } } } }),
			tool(2, "screenshot", { status: "error" }), tool(3, "release", { result: {} }),
			...[0, -1, NaN, Infinity, 1.5, 32769].map((width, index) => tool(index + 4, "screenshot", { result: { details: { width, height: 50, artifact: { id: "bad" } } } }))];
		expect(computerFrames(calls).map((frame) => frame.url)).toEqual(["/api/artifacts/id%2Fwith%20spaces"]);
	});

	it("maps click and drag overlays using the screenshot the AI acted on", () => {
		const before = tool(1);
		const drag = tool(2, "drag", { input: { action: "drag", frameId: "frame-1", x: 250, y: 100, toX: 750, toY: 400 },
			result: { details: { frameId: "frame-2", width: 2000, height: 1000, artifact: { id: "after" } } } });
		const frames = computerFrames([before, drag]);
		expect(computerPointer(drag, frames)).toEqual({ x: 25, y: 20, toX: 75, toY: 80 });
		expect(computerPointer({ ...drag, status: "running" }, frames)).toEqual({ x: 25, y: 20, toX: 75, toY: 80 });
		expect(computerPointer({ ...drag, status: "error" }, frames)).toBeUndefined();
		for (const input of [{ frameId: "missing", x: 1, y: 1 }, { frameId: "frame-1", x: -1, y: 0 }, { frameId: "frame-1", x: 1000, y: 0 }, { frameId: "frame-1", x: NaN, y: 0 }]) {
			expect(computerPointer({ ...drag, input }, frames)).toBeUndefined();
		}
	});

	it("summarizes text without copying it into the activity label and tolerates malformed keys", () => {
		expect(computerAction(tool(1, "type", { input: { action: "type", text: "秘密𠮷" } }))).toBe("文字を入力 · 3文字");
		expect(computerAction(tool(2, "press", { input: { action: "press", key: "a", modifiers: ["", "ctrl", null] } }))).toBe("Ctrl + A");
		expect(computerAction(tool(3, "click", { input: { action: "click", count: 2 } }))).toBe("ダブルクリック");
	});
});
