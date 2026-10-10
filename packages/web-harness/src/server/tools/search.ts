import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { BraveSearchProvider } from "../search-providers/brave.ts";
import { TavilySearchProvider } from "../search-providers/tavily.ts";
import type { SearchFetch, SearchProvider, SearchResult } from "../search-providers/types.ts";
import { type SearchProviderId, type SettingsService, searchProviderSchema } from "../settings.ts";

export const webSearchSchema = Type.Object(
	{
		query: Type.String({ minLength: 1 }),
		provider: Type.Optional(searchProviderSchema),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		timeRange: Type.Optional(
			Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")]),
		),
	},
	{ additionalProperties: false },
);
export type WebSearchInput = Static<typeof webSearchSchema>;

export class SearchService {
	private readonly settings: Pick<SettingsService, "get" | "getSearchKey">;
	private readonly providers: Record<SearchProviderId, SearchProvider>;

	constructor(settings: Pick<SettingsService, "get" | "getSearchKey">, fetcher: SearchFetch = fetch) {
		this.settings = settings;
		this.providers = {
			brave: new BraveSearchProvider(() => settings.getSearchKey("brave"), fetcher),
			tavily: new TavilySearchProvider(() => settings.getSearchKey("tavily"), fetcher),
		};
	}

	async search(input: unknown, signal?: AbortSignal): Promise<SearchResult> {
		if (!Check(webSearchSchema, input))
			throw new Error("Invalid search request; choose Brave or Tavily in Settings and a limit of 1..20");
		const query = input.query.trim();
		if (!query) throw new Error("Search query must not be empty");
		const provider = input.provider ?? this.settings.get().search.defaultProvider;
		return this.providers[provider].search(
			{ query, limit: input.limit ?? 5, ...(input.timeRange ? { timeRange: input.timeRange } : {}) },
			signal,
		);
	}

	createTool(): ToolDefinition<typeof webSearchSchema, SearchResult> {
		return {
			name: "web_search",
			label: "Web search",
			description:
				"Search the web using the configured Brave or Tavily provider. Results contain source title, URL, and snippet. Configure API keys in Settings; no provider fallback or automatic retry is performed.",
			promptSnippet: "Search the web with Brave or Tavily and return source links",
			parameters: webSearchSchema,
			execute: async (_toolCallId, params, signal) => {
				const result = await this.search(params, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		};
	}
}
