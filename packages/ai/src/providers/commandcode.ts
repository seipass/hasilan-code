import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { COMMANDCODE_CLASSIFIER_MODELS, COMMANDCODE_MODELS } from "./commandcode.models.ts";

/** Command Code's public listing is authoritative: new models appear without a rebuild. */
async function fetchCommandCodeModels(context: { allowNetwork: boolean; signal: AbortSignal }) {
	if (!context.allowNetwork) return [];
	let response: Response;
	try {
		response = await fetch("https://api.commandcode.ai/provider/v1/models", {
			signal: AbortSignal.any([context.signal, AbortSignal.timeout(8_000)]),
		});
	} catch (error) {
		console.warn("[commandcode] model discovery failed:", error instanceof Error ? error.message : error);
		throw error;
	}
	// Throw instead of returning []: the runtime keeps the previous overlay and the generated
	// baseline, whereas an empty result would be persisted and hide every model.
	if (!response.ok) {
		console.warn(`[commandcode] model discovery returned ${response.status}`);
		throw new Error(`Command Code model list returned ${response.status}`);
	}
	const listing = (await response.json()) as {
		data?: { id?: string; name?: string; context_length?: number; supported_endpoints?: string[] }[];
	};
	type Chat = Model<"anthropic-messages" | "openai-completions" | "openai-responses">;
	const known = new Map<string, Chat>();
	for (const model of Object.values(COMMANDCODE_MODELS) as Chat[]) known.set(model.id, model);
	const models: Chat[] = [];
	for (const entry of listing.data ?? []) {
		if (!entry.id) continue;
		const existing = known.get(entry.id);
		if (existing) {
			models.push(existing);
			continue;
		}
		const endpoints = entry.supported_endpoints ?? [];
		const api = endpoints.includes("/messages")
			? "anthropic-messages"
			: entry.id.startsWith("gpt-") && endpoints.includes("/responses")
				? "openai-responses"
				: endpoints.includes("/chat/completions")
					? "openai-completions"
					: undefined;
		if (!api) continue;
		models.push({
			id: entry.id,
			name: entry.name ?? entry.id,
			provider: "commandcode",
			api,
			baseUrl: api === "anthropic-messages" ? "https://api.commandcode.ai/provider" : "https://api.commandcode.ai/provider/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: entry.context_length ?? 128000,
			maxTokens: 8192,
		});
	}
	return models;
}

export function commandcodeProvider(): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	return createProvider<"anthropic-messages" | "openai-completions" | "openai-responses">({
		id: "commandcode",
		name: "Command Code",
		auth: { apiKey: envApiKeyAuth("Command Code API key", ["CMD_API_KEY"]) },
		models: [...Object.values(COMMANDCODE_MODELS), ...Object.values(COMMANDCODE_CLASSIFIER_MODELS)],
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
		fetchModels: fetchCommandCodeModels,
	});
}
