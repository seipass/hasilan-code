import type { SearchProviderId } from "../settings.ts";

export type SearchTimeRange = "day" | "week" | "month" | "year";
export interface SearchRequest {
	query: string;
	limit: number;
	timeRange?: SearchTimeRange;
}
export interface SearchResult {
	provider: SearchProviderId;
	query: string;
	results: { title: string; url: string; snippet: string }[];
}
export interface SearchProvider {
	search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>;
}
export type SearchFetch = typeof fetch;

/** Keeps headers, provider response bodies, and network error causes out of errors. */
export async function searchJson(
	provider: SearchProviderId,
	fetcher: SearchFetch,
	url: string | URL,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(30_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let publicError: Error | undefined;
	try {
		combined.throwIfAborted();
		const response = await fetcher(url, { ...init, redirect: "error", signal: combined });
		if (!response.ok) {
			publicError = new Error(
				`${provider} search failed (HTTP ${response.status}); check credentials and quota in Settings`,
			);
			await response.body?.cancel();
			throw publicError;
		}
		try {
			return await response.json();
		} catch {
			if (combined.aborted) throw new Error("Search request interrupted");
			publicError = new Error(`${provider} search returned invalid JSON`);
			throw publicError;
		}
	} catch {
		if (signal?.aborted) throw new Error(`${provider} search cancelled`);
		if (timeout.aborted) throw new Error(`${provider} search timed out after 30 seconds`);
		if (publicError) throw publicError;
		throw new Error(`${provider} search could not connect; check network and provider configuration in Settings`);
	}
}

export function normalizeResults(
	value: unknown,
	snippetField: "description" | "content",
	limit: number,
): SearchResult["results"] {
	if (!Array.isArray(value)) throw new Error("Search provider returned an invalid results list");
	const results: SearchResult["results"] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const result = entry as Record<string, unknown>;
		if (typeof result.url !== "string" || typeof result.title !== "string") continue;
		let url: URL;
		try {
			url = new URL(result.url);
		} catch {
			continue;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") continue;
		results.push({
			title: result.title,
			url: url.href,
			snippet: typeof result[snippetField] === "string" ? result[snippetField] : "",
		});
		if (results.length >= limit) break;
	}
	return results;
}
