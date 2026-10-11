import {
	normalizeResults,
	type SearchFetch,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
	searchJson,
} from "./types.ts";

export class FirecrawlSearchProvider implements SearchProvider {
	private readonly getKey: () => string | undefined;
	private readonly fetcher: SearchFetch;

	constructor(getKey: () => string | undefined, fetcher: SearchFetch = fetch) {
		this.getKey = getKey;
		this.fetcher = fetcher;
	}

	async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
		const key = this.getKey();
		if (!key) throw new Error("Firecrawl API key is not configured; add it in Settings");
		const data = await searchJson(
			"firecrawl",
			this.fetcher,
			"https://api.firecrawl.dev/v2/search",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					query: request.query,
					limit: request.limit,
					sources: [
						{
							type: "web",
							...(request.timeRange
								? { tbs: `qdr:${{ day: "d", week: "w", month: "m", year: "y" }[request.timeRange]}` }
								: {}),
						},
					],
				}),
			},
			signal,
		);
		if (!data || typeof data !== "object" || (data as Record<string, unknown>).success !== true)
			throw new Error("Firecrawl search returned an invalid response");
		const result = (data as Record<string, unknown>).data;
		if (!result || typeof result !== "object") throw new Error("Firecrawl search returned an invalid web response");
		return {
			provider: "firecrawl",
			query: request.query,
			results: normalizeResults((result as Record<string, unknown>).web, "description", request.limit),
		};
	}
}
