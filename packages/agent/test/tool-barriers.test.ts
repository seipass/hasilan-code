import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@hasilan-code/pi-ai";
import { obj, str } from "@hasilan-code/pi-schema";
import { expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentMessage, AgentTool } from "../src/types.ts";

it("runs parallel groups concurrently without crossing a sequential tool", async () => {
	const schema = obj({ value: str() });
	const order: string[] = [];
	let releaseFirst: () => void = () => {};
	let releaseLast: () => void = () => {};
	const first = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const last = new Promise<void>((resolve) => {
		releaseLast = resolve;
	});
	const parallel: AgentTool<typeof schema> = {
		name: "parallel",
		label: "parallel",
		description: "parallel",
		parameters: schema,
		async execute(_id, { value }) {
			order.push(`start:${value}`);
			if (value === "a") await first;
			if (value === "b") releaseFirst();
			if (value === "c") await last;
			if (value === "d") releaseLast();
			order.push(`end:${value}`);
			return { content: [{ type: "text", text: value }], details: undefined };
		},
	};
	const barrier: AgentTool<typeof schema> = {
		name: "barrier",
		label: "barrier",
		description: "barrier",
		parameters: schema,
		executionMode: "sequential",
		async execute() {
			order.push("barrier");
			return { content: [{ type: "text", text: "barrier" }], details: undefined };
		},
	};
	const model: Model<"openai-responses"> = {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
	const calls: AssistantMessage["content"] = [
		...(["a", "b"] as const).map((value) => ({
			type: "toolCall" as const,
			id: value,
			name: "parallel",
			arguments: { value },
		})),
		{ type: "toolCall", id: "barrier", name: "barrier", arguments: { value: "barrier" } },
		...(["c", "d"] as const).map((value) => ({
			type: "toolCall" as const,
			id: value,
			name: "parallel",
			arguments: { value },
		})),
	];
	let turn = 0;
	const context: AgentContext = { messages: [], tools: [parallel, barrier] };
	const stream = agentLoop(
		[{ role: "user", content: "run", timestamp: 0 }],
		context,
		{ model, convertToLlm: (messages: AgentMessage[]) => messages as Message[] },
		undefined,
		() => {
			const response = createAssistantMessageEventStream();
			const content: AssistantMessage["content"] = turn++ === 0 ? calls : [{ type: "text", text: "done" }];
			const message: AssistantMessage = {
				role: "assistant",
				content,
				api: "openai-responses",
				provider: "openai",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: content === calls ? "toolUse" : "stop",
				timestamp: 0,
			};
			queueMicrotask(() =>
				response.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }),
			);
			return response;
		},
	);
	const result = await stream.result();
	expect(order).toEqual(["start:a", "start:b", "end:b", "end:a", "barrier", "start:c", "start:d", "end:d", "end:c"]);
	expect(result.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)).toEqual([
		"a",
		"b",
		"barrier",
		"c",
		"d",
	]);
});
