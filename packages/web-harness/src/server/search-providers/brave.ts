import {
	normalizeResults,
	type SearchFetch,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
	searchJson,
} from "./types.ts";

export class BraveSearchProvider implements SearchProvider {
	private readonly getKey: () => string | undefined;
	private readonly fetcher: SearchFetch;

	constructor(getKey: () => string | undefined, fetcher: SearchFetch = fetch) {
		this.getKey = getKey;
		this.fetcher = fetcher;
	}

	async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
		if (Array.from(request.query).length > 600 || request.query.trim().split(/\s+/u).length > 75)
			throw new Error("Brave query exceeds 600 characters or 75 words; shorten the query");
		const key = this.getKey();
		if (!key) throw new Error("Brave API key is not configured; add it in Settings");
		const url = new URL("https://api.search.brave.com/res/v1/web/search");
		url.searchParams.set("q", request.query);
		url.searchParams.set("count", String(request.limit));
		url.searchParams.set("result_filter", "web");
		url.searchParams.set("text_decorations", "false");
		if (request.timeRange)
			url.searchParams.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[request.timeRange]);
		const data = await searchJson(
			"brave",
			this.fetcher,
			url,
			{ method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": key } },
			signal,
		);
		if (!data || typeof data !== "object") throw new Error("Brave search returned an invalid response");
		const web = (data as Record<string, unknown>).web;
		if (web === undefined || web === null) return { provider: "brave", query: request.query, results: [] };
		if (typeof web !== "object") throw new Error("Brave search returned an invalid web response");
		return {
			provider: "brave",
			query: request.query,
			results: normalizeResults((web as Record<string, unknown>).results ?? [], "description", request.limit),
		};
	}
}
