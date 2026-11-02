import { DEFAULT_RUSTXNG_URL } from "../settings.ts";
import {
	normalizeResults,
	type SearchFetch,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
	searchJson,
} from "./types.ts";

export class RustxngSearchProvider implements SearchProvider {
	private readonly getUrl: () => string | undefined;
	private readonly fetcher: SearchFetch;

	constructor(getUrl: () => string | undefined, fetcher: SearchFetch = fetch) {
		this.getUrl = getUrl;
		this.fetcher = fetcher;
	}

	async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
		const base = `${(this.getUrl() ?? DEFAULT_RUSTXNG_URL).replace(/\/$/, "")}/`;
		const url = new URL("search", base);
		url.searchParams.set("q", request.query);
		url.searchParams.set("format", "json");
		url.searchParams.set("max_results", String(request.limit));
		if (request.timeRange) url.searchParams.set("time_range", request.timeRange);
		const data = await searchJson(
			"rustxng",
			this.fetcher,
			url,
			{ method: "GET", headers: { Accept: "application/json" } },
			signal,
		);
		if (!data || typeof data !== "object") throw new Error("RustXNG search returned an invalid response");
		return {
			provider: "rustxng",
			query: request.query,
			results: normalizeResults((data as Record<string, unknown>).results ?? [], "content", request.limit),
		};
	}
}
