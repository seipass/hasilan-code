import {
	normalizeResults,
	type SearchFetch,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
	searchJson,
} from "./types.ts";

export class ExaSearchProvider implements SearchProvider {
	private readonly getKey: () => string | undefined;
	private readonly fetcher: SearchFetch;

	constructor(getKey: () => string | undefined, fetcher: SearchFetch = fetch) {
		this.getKey = getKey;
		this.fetcher = fetcher;
	}

	async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
		const key = this.getKey();
		if (!key) throw new Error("Exa API key is not configured; add it in Settings");
		const days = { day: 1, week: 7, month: 30, year: 365 } as const;
		const data = await searchJson(
			"exa",
			this.fetcher,
			"https://api.exa.ai/search",
			{
				method: "POST",
				headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					query: request.query,
					numResults: request.limit,
					type: "auto",
					contents: { highlights: true },
					...(request.timeRange
						? { startPublishedDate: new Date(Date.now() - days[request.timeRange] * 86400000).toISOString() }
						: {}),
				}),
			},
			signal,
		);
		if (!data || typeof data !== "object") throw new Error("Exa search returned an invalid response");
		return {
			provider: "exa",
			query: request.query,
			results: normalizeResults((data as Record<string, unknown>).results, "highlights", request.limit),
		};
	}
}
