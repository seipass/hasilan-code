import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ClassifierModel } from "../types.ts";

/** Liquid's decision endpoint uses System One questions and data URL images. */
export function liquidProvider(): Provider {
	const models: ClassifierModel<"typesafe-system-one">[] = ["d1", "d1-ultra"].map((id) => ({
		type: "classifier",
		id,
		name: `Liquid ${id}`,
		api: "typesafe-system-one",
		provider: "liquid",
		baseUrl: "https://api.liquid.ai/decisions/v1",
		input: ["text", "image"],
		cost: { input: id === "d1" ? 0.02 : 0.042, output: 0, cacheRead: id === "d1" ? 0.02 : 0.042, cacheWrite: 0 },
		contextWindow: 32000,
		compat: { imageInput: "images", sendImageOptInHeader: false },
	}));
	return createProvider({
		id: "liquid",
		name: "Liquid AI",
		auth: { apiKey: envApiKeyAuth("Liquid AI API key", ["LIQUID_API_KEY"]) },
		models,
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}
