import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { COMMANDCODE_CLASSIFIER_MODELS, COMMANDCODE_MODELS } from "./commandcode.models.ts";

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
	});
}
