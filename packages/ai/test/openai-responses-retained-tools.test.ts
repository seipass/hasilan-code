import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import type { Context, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "cache-test",
	name: "Cache test",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
};
const read: Tool = { name: "read", description: "Read files", parameters: Type.Object({ path: Type.String() }) };
const bash: Tool = { name: "bash", description: "Run commands", parameters: Type.Object({ command: Type.String() }) };
const browser: Tool = { name: "browser", description: "Browse", parameters: Type.Object({ url: Type.String() }) };
const initial: Context = {
	messages: [
		{ role: "system", content: "Stable instructions", toolsAdded: [read, bash], timestamp: 0 },
		{ role: "user", content: "First task", timestamp: 1 },
	],
};
const restricted: Context = {
	messages: [
		...initial.messages,
		{
			role: "system",
			content: "Read-only task",
			toolsRemoved: [{ name: "bash" }],
			toolsAdded: [browser],
			timestamp: 2,
		},
		{ role: "user", content: "Next task", timestamp: 3 },
	],
};

async function capture(context: Context, selected = model, apiKey = "sk-test"): Promise<ResponseCreateParamsStreaming> {
	let payload: ResponseCreateParamsStreaming | undefined;
	await stream(selected, normalizeContext(context), {
		apiKey,
		onPayload(value) {
			payload = value as ResponseCreateParamsStreaming;
			throw new Error("Captured before HTTP dispatch");
		},
	}).result();
	if (!payload) throw new Error("Provider did not construct a request");
	return payload;
}

test("retains the old prefix while restricting removed tools, then restores with an inline declaration", async () => {
	const before = await capture(initial);
	const after = await capture(restricted);
	expect(after.tools).toEqual(before.tools);
	if (!Array.isArray(before.input) || !Array.isArray(after.input)) throw new Error("Expected response input items");
	expect(after.input.slice(0, before.input.length)).toEqual(before.input);
	expect(after.tool_choice).toEqual({
		type: "allowed_tools",
		mode: "auto",
		tools: [
			{ type: "function", name: "read" },
			{ type: "function", name: "browser" },
		],
	});
	const restored = await capture({
		messages: [
			...restricted.messages,
			{ role: "system", content: "Commands enabled again", toolsAdded: [bash], timestamp: 4 },
		],
	});
	expect(restored.tools).toEqual(before.tools);
	if (!Array.isArray(restored.input)) throw new Error("Expected response input items");
	expect(restored.input.slice(0, after.input.length)).toEqual(after.input);
	expect(restored.input.filter((item) => item.type === "additional_tools")).toHaveLength(3);
	expect(restored.input.at(-2)).toMatchObject({ type: "additional_tools", tools: [{ name: "bash" }] });
	expect(restored.tool_choice).toBeUndefined();
});

test("disables all calls without discarding cached declarations", async () => {
	const payload = await capture({
		messages: [
			...initial.messages,
			{ role: "system", content: "No tools", toolsRemoved: [{ name: "read" }, { name: "bash" }], timestamp: 2 },
		],
	});
	expect(payload.tools).toEqual((await capture(initial)).tools);
	expect(payload.tool_choice).toBe("none");
});

test("updates a retained tool schema inline without discarding the cached prefix", async () => {
	const before = await capture(restricted);
	const payload = await capture({
		messages: [
			...restricted.messages,
			{
				role: "system",
				content: "New interface",
				toolsRemoved: [{ name: "read" }],
				toolsAdded: [{ ...read, parameters: Type.Object({ paths: Type.Array(Type.String()) }) }],
				timestamp: 4,
			},
		],
	});
	expect(payload.tools).toBeUndefined();
	if (!Array.isArray(before.input) || !Array.isArray(payload.input)) throw new Error("Expected response input items");
	expect(payload.input.slice(0, before.input.length)).toEqual(before.input);
	expect(payload.input.at(-2)).toMatchObject({
		type: "additional_tools",
		tools: [{ name: "read", parameters: { properties: { paths: { type: "array" } } } }],
	});
	expect(payload.tool_choice).toMatchObject({
		type: "allowed_tools",
		tools: [{ name: "browser" }, { name: "read" }],
	});
});

test.each([
	{ name: "compatible endpoint", selected: { ...model, baseUrl: "http://127.0.0.1:9" }, key: "sk-test" },
	{ name: "ChatGPT sign-in", selected: model, key: "oauth-access-token" },
	{ name: "incapable model", selected: { ...model, compat: {} }, key: "sk-test" },
])("does not enable retained-tool restrictions for $name", async ({ selected, key }) => {
	const payload = await capture(restricted, selected, key);
	expect(payload.tools?.some((tool) => tool.type === "function" && tool.name === "bash") ?? false).toBe(false);
	expect(payload.tool_choice).toBeUndefined();
});
