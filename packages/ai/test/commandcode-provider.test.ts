import { describe, expect, it } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import { builtinModels, getBuiltinClassifierModels, getBuiltinModels } from "../src/providers/all.ts";

describe("Command Code provider", () => {
	it("keeps decision models separate and maps chat models to supported endpoints", () => {
		const chat = getBuiltinModels("commandcode");
		expect(chat.length).toBeGreaterThan(20);
		expect(chat.some((model) => model.id.includes("jev"))).toBe(false);
		expect(chat.find((model) => model.id === "claude-opus-4-7")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.commandcode.ai/provider",
		});
		expect(chat.find((model) => model.id === "gpt-6.1-sol")).toMatchObject({
			api: "openai-responses",
			baseUrl: "https://api.commandcode.ai/provider/v1",
		});
		expect(chat.find((model) => model.id === "deepseek/deepseek-v4-pro")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.commandcode.ai/provider/v1",
		});
		expect(getBuiltinClassifierModels("commandcode").map((model) => model.id)).toEqual([
			"typesafe/jev",
			"typesafe/jev-1.14.0",
		]);
		expect(getEnvApiKey("commandcode", { CMD_API_KEY: "test-command-key" })).toBe("test-command-key");
	});

	it.each(["typesafe/jev", "typesafe/jev-1.14.0"])("calls %s through System One with the provider key", async (id) => {
		const models = builtinModels();
		const model = models.getModelOfType("classifier", "commandcode", id);
		if (!model) throw new Error("Missing Jev model");
		expect(models.getModel("commandcode", id)).toBeUndefined();
		const result = await models.classify(
			model,
			{
				state: { task: "Fix music" },
				questions: {
					folder: {
						type: "choice",
						instructions: "Which folder?",
						criteria: { music: "Music player", web: "Website" },
					},
				},
			},
			{
				apiKey: "test-command-key",
				maxRetries: 0,
				fetch: async (url, init) => {
					expect(String(url)).toBe("https://api.commandcode.ai/provider/v1/systemone");
					expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-command-key");
					expect(JSON.parse(String(init?.body))).toMatchObject({
						model: id,
						questions: { folder: { type: "choice" } },
					});
					return Response.json({
						model: id,
						answers: {
							folder: {
								type: "choice",
								choice: "music",
								confidence: 0.9,
								probabilities: { music: 0.95, web: 0.05 },
							},
						},
					});
				},
			},
		);
		expect(result.stopReason).toBe("stop");
		expect(result.answers.folder).toMatchObject({ choice: "music" });
	});

	it.each([
		["claude-opus-4-7", "https://api.commandcode.ai/provider/v1/messages"],
		["gpt-6.1-sol", "https://api.commandcode.ai/provider/v1/responses"],
		["deepseek/deepseek-v4-pro", "https://api.commandcode.ai/provider/v1/chat/completions"],
	])("sends %s to its native chat endpoint with credentials", async (id, endpoint) => {
		const models = builtinModels();
		const model = models.getModel("commandcode", id);
		if (!model) throw new Error("Missing chat model");
		const requests: string[] = [];
		await models.completeSimple(
			model,
			{ messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
			{
				apiKey: "test-command-key",
				maxRetries: 0,
				fetch: async (url, init) => {
					const target = new URL(String(url));
					requests.push(`${target.origin}${target.pathname}`);
					const headers = new Headers(init?.headers);
					expect(
						headers.get("authorization") === "Bearer test-command-key" ||
							headers.get("x-api-key") === "test-command-key",
					).toBe(true);
					expect(JSON.parse(String(init?.body)).model).toBe(id);
					// End without tokens: this test exercises request routing, not SDK stream parsing.
					return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
				},
			},
		);
		expect(requests).toEqual([endpoint]);
	});
});
