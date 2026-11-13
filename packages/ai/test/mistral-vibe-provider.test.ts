import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { mistralVibeProvider, parseMistralVibeCatalog } from "../src/providers/mistral-vibe.ts";
import { normalizeMistralStream } from "../src/providers/mistral-vibe-transport.ts";

afterEach(() => vi.restoreAllMocks());

describe("Mistral Vibe provider", () => {
	it("keeps Vibe keys separate from ordinary Mistral authentication", () => {
		const provider = mistralVibeProvider();
		expect(provider.id).toBe("mistral-vibe");
		expect(provider.getModels().map((model) => model.id)).toEqual(["mistral-vibe-cli-latest"]);
	});

	it("accepts only chat models and preserves reported context and vision", () => {
		const models = parseMistralVibeCatalog({
			data: [
				{ id: "chat", max_context_length: 262144, capabilities: { completion_chat: true, vision: true } },
				{ id: "embedding", capabilities: { completion_chat: false } },
			],
		});
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "chat",
			api: "openai-completions",
			provider: "mistral-vibe",
			input: ["text", "image"],
			contextWindow: 262144,
		});
	});

	it("discovers key-scoped models and removes them when credentials change", async () => {
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const key = new Headers(init?.headers).get("authorization");
			return Response.json({
				data: [{ id: key === "Bearer key-one" ? "model-one" : "model-two", capabilities: { completion_chat: true } }],
			});
		});
		const credentials = new InMemoryCredentialStore();
		const store = new InMemoryModelsStore();
		await credentials.modify("mistral-vibe", async () => ({ type: "api_key", key: "key-one" }));
		const models = createModels({ credentials, modelsStore: store });
		models.setProvider(mistralVibeProvider(fetcher));
		let result = await models.refresh({ providers: ["mistral-vibe"] });
		expect(result.errors.size).toBe(0);
		expect(models.getModel("mistral-vibe", "model-one")).toBeDefined();
		await credentials.modify("mistral-vibe", async () => ({ type: "api_key", key: "key-two" }));
		result = await models.refresh({ providers: ["mistral-vibe"] });
		expect(result.errors.size).toBe(0);
		expect(models.getModel("mistral-vibe", "model-two")).toBeDefined();
		expect(models.getModel("mistral-vibe", "model-one")).toBeUndefined();
	});

	it("converts typed streaming content and preserves UTF-8 boundaries", async () => {
		const event = { choices: [{ delta: { content: [
			{ type: "thinking", thinking: [{ type: "text", text: "思考" }] },
			{ type: "text", text: "回答" },
		] } }] };
		const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
		const response = new Response(new ReadableStream({
			start(controller) {
				for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		}), { headers: { "content-type": "text/event-stream" } });
		const output = await normalizeMistralStream(response).text();
		expect(output).toContain('"content":"回答"');
		expect(output).toContain('"reasoning_content":"思考"');
		expect(output).toContain("data: [DONE]");
	});

	it("uses an injected AuthContext key for discovery, availability, and streaming", async () => {
		const key = "auth-context-vibe-key";
		const calls: { url: string; authorization: string | null; method: string; model?: string }[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			const authorization = new Headers(init?.headers).get("authorization");
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) as { model?: string } : {};
			calls.push({ url, authorization, method, model: body.model });
			if (url.endsWith("/models")) {
				return Response.json({
					data: [{ id: "test-vibe-model", max_context_length: 128000, capabilities: { completion_chat: true } }],
				});
			}
			if (url.endsWith("/chat/completions")) {
				const events = [
					{ id: "vibe-response", model: "test-vibe-model", choices: [{ index: 0, delta: { content: [
						{ type: "text", text: "Vibe works" },
					] }, finish_reason: null }] },
					{ id: "vibe-response", model: "test-vibe-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
				];
				return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			}
			throw new Error(`Unexpected endpoint: ${url}`);
		};
		const models = createModels({
			authContext: {
				env: async (name) => name === "MISTRAL_VIBE_API_KEY" ? key : undefined,
				fileExists: async () => false,
			},
		});
		models.setProvider(mistralVibeProvider(fetcher));
		const refreshed = await models.refresh({ providers: ["mistral-vibe"] });
		expect(refreshed.errors.size).toBe(0);
		const available = await models.getAvailable("mistral-vibe");
		const model = available.find((entry) => entry.id === "test-vibe-model");
		expect(model).toBeDefined();
		const message = await models.completeSimple(model!, {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Vibe works" }]);
		expect(calls.some((call) =>
			call.url === "https://api.mistral.ai/v1/chat/completions" &&
			call.authorization === `Bearer ${key}` &&
			call.model === "test-vibe-model",
		)).toBe(true);
	});

	it("hides the previous catalog after an AuthContext key rotation", async () => {
		let key = "one";
		const models = createModels({
			authContext: {
				env: async (name) => name === "MISTRAL_VIBE_API_KEY" ? key : undefined,
				fileExists: async () => false,
			},
		});
		const fetcher: typeof fetch = async () => Response.json({
			data: [{ id: `model-${key}`, capabilities: { completion_chat: true } }],
		});
		models.setProvider(mistralVibeProvider(fetcher));
		expect((await models.refresh({ providers: ["mistral-vibe"] })).errors.size).toBe(0);
		expect((await models.getAvailable("mistral-vibe")).some((model) => model.id === "model-one")).toBe(true);
		key = "two";
		expect((await models.getAvailable("mistral-vibe")).some((model) => model.id === "model-one")).toBe(false);
		expect((await models.refresh({ providers: ["mistral-vibe"] })).errors.size).toBe(0);
		expect((await models.getAvailable("mistral-vibe")).some((model) => model.id === "model-two")).toBe(true);
	});

});
