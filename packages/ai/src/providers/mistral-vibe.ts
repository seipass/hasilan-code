import { createHash } from "node:crypto";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { Credential } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model, SimpleStreamOptions } from "../types.ts";
import { normalizeMistralStream } from "./mistral-vibe-transport.ts";

const ID = "mistral-vibe";
const BASE_URL = "https://api.mistral.ai/v1";
const FALLBACK_MODEL = "mistral-vibe-cli-latest";
const CATALOG_TTL = 60 * 60 * 1000;

function fingerprint(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

function credentialKey(credential?: Credential): string | undefined {
	const envKey = typeof process !== "undefined" ? process.env.MISTRAL_VIBE_API_KEY?.trim() : undefined;
	return (credential?.type === "api_key" ? credential.key.trim() : undefined) || envKey;
}

/** Mistral does not return pricing metadata. Zero here is a placeholder, not free inference. */
export function mistralVibeModel(id: string, row: Record<string, unknown> = {}): Model<"openai-completions"> {
	const capabilities =
		row.capabilities && typeof row.capabilities === "object"
			? (row.capabilities as Record<string, unknown>)
			: {};
	const reported = row.max_context_length;
	const contextWindow =
		typeof reported === "number" && Number.isSafeInteger(reported) && reported > 0 ? reported : 128_000;
	const maxTokens = Math.min(contextWindow, id === "deepseek-v4-1-flash-1017" ? 65_536 : 8192);
	return {
		id,
		name: typeof row.name === "string" && row.name ? row.name : id,
		provider: ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		reasoning: false,
		input: capabilities.vision === true ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	};
}

/** Only expose chat-capable models; the list depends on the current Vibe key. */
export function parseMistralVibeCatalog(payload: unknown): Model<"openai-completions">[] {
	if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid Mistral Vibe model catalog");
	}
	const result = new Map<string, Model<"openai-completions">>();
	for (const entry of payload.data) {
		if (!entry || typeof entry !== "object") continue;
		const row = entry as Record<string, unknown>;
		if (typeof row.id !== "string" || !row.id.trim() || row.id !== row.id.trim()) continue;
		const capabilities = row.capabilities;
		if (
			!capabilities ||
			typeof capabilities !== "object" ||
			(capabilities as Record<string, unknown>).completion_chat !== true
		) continue;
		result.set(row.id, mistralVibeModel(row.id, row));
	}
	return [...result.values()];
}

/**
 * The Vibe subscription key is independent of MISTRAL_API_KEY and the normal
 * Mistral Conversations provider. Only the dedicated key is used here.
 */
export function mistralVibeProvider(fetcher: typeof fetch = fetch): Provider<"openai-completions"> {
	const fallback = mistralVibeModel(FALLBACK_MODEL);
	let catalog: Model<"openai-completions">[] = [fallback];
	let currentScope: string | undefined;
	let refreshedAt = 0;
	const api = openAICompletionsApi();

	const requestOptions = (model: Model<"openai-completions">, options: SimpleStreamOptions = {}): SimpleStreamOptions => {
		const key = options.apiKey?.trim();
		if (!key) throw new Error("Missing Mistral Vibe API key");
		if (model.baseUrl.replace(/\/$/, "") !== BASE_URL) throw new Error("Mistral Vibe endpoint override blocked");
		if (
			model.id !== FALLBACK_MODEL &&
			(currentScope !== fingerprint(key) || !catalog.some((candidate) => candidate.id === model.id))
		) throw new Error("Model not found in the current Mistral Vibe key's catalog");
		const transport = options.fetch ?? fetcher;
		return {
			...options,
			maxRetries: 0,
			fetch: async (input, init) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (url.href !== BASE_URL + "/chat/completions") {
					throw new Error("Mistral Vibe request destination blocked");
				}
				return normalizeMistralStream(await transport(input, { ...init, redirect: "error" }));
			},
			onPayload: async (payload, currentModel) => {
				const replacement = await options.onPayload?.(payload, currentModel);
				const body = { ...((replacement ?? payload) as Record<string, unknown>) };
				if (body.model !== model.id) throw new Error("Mistral Vibe model substitution blocked");
				if (Array.isArray(body.messages)) {
					body.messages = body.messages.map((message: unknown) => {
						if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
							return message;
						}
						const cleaned = { ...(message as Record<string, unknown>) };
						for (const field of ["reasoning_content", "reasoning_text", "reasoning", "reasoning_details"]) {
							delete cleaned[field];
						}
						return cleaned;
					});
				}
				return body;
			},
		};
	};

	const base = createProvider<"openai-completions">({
		id: ID,
		name: "Mistral Vibe (unofficial)",
		baseUrl: BASE_URL,
		auth: {
			apiKey: envApiKeyAuth("Mistral Vibe API key", ["MISTRAL_VIBE_API_KEY"]),
		},
		models: [],
		api: {
			...api,
			stream: (model, context, options) => api.stream(model, context, requestOptions(model as Model<"openai-completions">, options)),
			streamSimple: (model, context, options) =>
				api.streamSimple(model, context, requestOptions(model as Model<"openai-completions">, options)),
		},
	});

	return {
		...base,
		getModels: () => catalog,
		filterModels: (models, credential) => {
			const key = credentialKey(credential);
			return key && currentScope === fingerprint(key)
				? models
				: models.filter((model) => model.id === FALLBACK_MODEL);
		},
		async refreshModels(context) {
			const key = credentialKey(context.credential);
			const nextScope = key ? fingerprint(key) : undefined;
			if (currentScope !== nextScope) {
				const restored =
					nextScope && context.stored?.etag === nextScope
						? context.stored.models.filter(
								(model): model is Model<"openai-completions"> =>
									model.provider === ID && model.api === "openai-completions" &&
									(!model.type || model.type === "chat") && model.baseUrl === BASE_URL,
							)
						: [];
				const result = await context.publish({
					...(context.stored?.etag !== nextScope ? { persist: null } : {}),
					update: () => {
						catalog = restored.length ? restored : [fallback];
						currentScope = nextScope;
						refreshedAt = 0;
					},
				});
				if (!result) return;
			}
			if (!key || !context.allowNetwork || context.signal.aborted) return;
			if (context.baseUrl && context.baseUrl.replace(/\/$/, "") !== BASE_URL) {
				throw new Error("Mistral Vibe catalog endpoint override blocked");
			}
			if (!context.force && refreshedAt && Date.now() - refreshedAt < CATALOG_TTL) return;
			const response = await fetcher(BASE_URL + "/models", {
				headers: { Authorization: "Bearer " + key, Accept: "application/json" },
				signal: AbortSignal.any([context.signal, AbortSignal.timeout(8000)]),
				redirect: "error",
			});
			if (!response.ok) throw new Error("Mistral Vibe model discovery failed (HTTP " + response.status + ")");
			const discovered = parseMistralVibeCatalog(await response.json());
			const refreshed = [fallback, ...discovered.filter((model) => model.id !== FALLBACK_MODEL)];
			await context.publish({
				persist: { models: refreshed, etag: nextScope, checkedAt: Date.now() },
				update: () => {
					catalog = refreshed;
					currentScope = nextScope;
					refreshedAt = Date.now();
				},
			});
		},
	};
}
