import {
	normalizeResults,
	type SearchFetch,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
	searchJson,
} from "./types.ts";

export class TavilySearchProvider implements SearchProvider {
	private readonly getKey: () => string | undefined;
	private readonly fetcher: SearchFetch;

	constructor(getKey: () => string | undefined, fetcher: SearchFetch = fetch) {
		this.getKey = getKey;
		this.fetcher = fetcher;
	}

	async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
		const key = this.getKey();
		if (!key) throw new Error("Tavily API key is not configured; add it in Settings");
		const data = await searchJson(
			"tavily",
			this.fetcher,
			"https://api.tavily.com/search",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					query: request.query,
					max_results: request.limit,
					search_depth: "basic",
					topic: "general",
					auto_parameters: false,
					include_answer: false,
					include_raw_content: false,
					...(request.timeRange ? { time_range: request.timeRange } : {}),
				}),
			},
			signal,
		);
		if (!data || typeof data !== "object") throw new Error("Tavily search returned an invalid response");
		return {
			provider: "tavily",
			query: request.query,
			results: normalizeResults((data as Record<string, unknown>).results, "content", request.limit),
		};
	}
}
