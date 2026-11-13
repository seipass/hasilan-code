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
		const bytes = new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n");
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
});
