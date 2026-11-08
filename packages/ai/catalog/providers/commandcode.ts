import type { ClassifierModel } from "../../src/types.ts";
import { defineProvider, modelsDevModels } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";

export default defineProvider({
	id: "commandcode",
	models: (ctx) => {
		const listed = new Map((ctx.sources.commandCode ?? []).map((model) => [model.id, model]));
		return modelsDevModels(ctx, "commandcode", {
			api: "openai-completions",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			skipDeprecated: true,
			include: (source) => listed.has(source.id),
			map: (model, source) => {
				const entry = listed.get(source.id);
				const endpoints = entry?.supported_endpoints ?? [];
				const api = endpoints.includes("/messages")
					? "anthropic-messages"
					: model.id.startsWith("gpt-") && endpoints.includes("/responses")
						? "openai-responses"
						: endpoints.includes("/chat/completions")
							? "openai-completions"
							: undefined;
				if (!api) return undefined;
				const thinkingLevelMap = getEffortThinkingLevelMap(source.reasoningOptions ?? []);
				return {
					...model,
					api,
					baseUrl: api === "anthropic-messages" ? "https://api.commandcode.ai/provider" : model.baseUrl,
					contextWindow: Math.min(entry?.context_length ?? Infinity, model.contextWindow),
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					...(api === "openai-completions"
						? {
								compat: {
									supportsStore: false,
									supportsLongCacheRetention: false,
									supportsDeveloperRole: false,
									maxTokensField: "max_tokens" as const,
									supportsReasoningEffort: !!thinkingLevelMap,
									...(!thinkingLevelMap && model.reasoning ? { thinkingFormat: "deepseek" as const } : {}),
								},
							}
						: {}),
				};
			},
		});
	},
	// Documented decision models are omitted from Command Code's public model listing.
	classifiers: (): ClassifierModel<"typesafe-system-one">[] =>
		["typesafe/jev", "typesafe/jev-1.14.0"].map((id) => ({
			type: "classifier",
			id,
			name: id.endsWith("1.14.0") ? "Jev 1.14" : "Jev",
			api: "typesafe-system-one",
			provider: "commandcode",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			input: ["text"],
			contextWindow: 32000,
			cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
});
