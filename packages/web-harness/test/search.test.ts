import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BraveSearchProvider } from "../src/server/search-providers/brave.ts";
import { ExaSearchProvider } from "../src/server/search-providers/exa.ts";
import { FirecrawlSearchProvider } from "../src/server/search-providers/firecrawl.ts";
import { TavilySearchProvider } from "../src/server/search-providers/tavily.ts";
import type { SearchFetch } from "../src/server/search-providers/types.ts";
import type { SettingsService, SettingsSnapshot } from "../src/server/settings.ts";
import { SearchService } from "../src/server/tools/search.ts";

describe("Search provider consumer boundaries", () => {
	let server: Server;
	let requests: { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown>; url: URL }[];
	let fetcher: SearchFetch;
	beforeEach(async () => {
		requests = [];
		server = createServer((request, response) => {
			void (async () => {
				const url = new URL(request.url ?? "/", "http://fixture");
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				const body = chunks.length
					? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
					: {};
				requests.push({ headers: request.headers, body, url });
				const query = url.searchParams.get("q") ?? body.query;
				if (query === "wait") return;
				response.setHeader("Content-Type", "application/json");
				if (query === "401" || query === "429") {
					response.writeHead(Number(query));
					response.end(
						JSON.stringify({ error: `Server reflected private-secret ${JSON.stringify(request.headers)}` }),
					);
					return;
				}
				if (query === "empty") {
					response.end(
						JSON.stringify(
							url.pathname === "/v2/search"
								? { success: true, data: { web: [] } }
								: url.searchParams.has("q")
									? {}
									: { results: [] },
						),
					);
					return;
				}
				if (query === "invalid") {
					response.end("not-json-private-secret");
					return;
				}
				const rows = [
					{
						title: "Source",
						url: "https://example.org/source",
						description: "Brave snippet",
						content: "Tavily snippet",
						highlights: ["Exa", "snippet"],
					},
					{ title: "Unsafe", url: "javascript:alert(1)", description: "bad" },
				];
				response.end(
					JSON.stringify(
						url.pathname === "/v2/search"
							? { success: true, data: { web: rows } }
							: url.searchParams.has("q")
								? { web: { results: rows } }
								: { results: rows },
					),
				);
			})().catch(() => {
				response.writeHead(500);
				response.end();
			});
		});
		const listening = once(server, "listening");
		server.listen(0, "127.0.0.1");
		await listening;
		const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		fetcher = (input, init) => {
			const original = new URL(input instanceof Request ? input.url : String(input));
			return fetch(`${local}${original.pathname}${original.search}`, init);
		};
	});
	afterEach(async () => {
		server.closeAllConnections();
		const closed = Promise.withResolvers<void>();
		server.close((error) => (error ? closed.reject(error) : closed.resolve()));
		await closed.promise;
	});

	it("normalizes real HTTP responses and expresses the requested provider filters", async () => {
		const brave = new BraveSearchProvider(() => "private-secret", fetcher);
		const tavily = new TavilySearchProvider(() => "private-secret", fetcher);
		expect(await brave.search({ query: "query", limit: 5, timeRange: "month" })).toEqual({
			provider: "brave",
			query: "query",
			results: [{ title: "Source", url: "https://example.org/source", snippet: "Brave snippet" }],
		});
		expect(await tavily.search({ query: "query", limit: 2, timeRange: "week" })).toEqual({
			provider: "tavily",
			query: "query",
			results: [{ title: "Source", url: "https://example.org/source", snippet: "Tavily snippet" }],
		});
		const exa = new ExaSearchProvider(() => "private-secret", fetcher);
		const firecrawl = new FirecrawlSearchProvider(() => "private-secret", fetcher);
		expect(await exa.search({ query: "query", limit: 3, timeRange: "day" })).toEqual({
			provider: "exa",
			query: "query",
			results: [{ title: "Source", url: "https://example.org/source", snippet: "Exa snippet" }],
		});
		expect(await firecrawl.search({ query: "query", limit: 4, timeRange: "year" })).toEqual({
			provider: "firecrawl",
			query: "query",
			results: [{ title: "Source", url: "https://example.org/source", snippet: "Brave snippet" }],
		});
		expect(requests[0].headers["x-subscription-token"]).toBe("private-secret");
		expect(requests[0].url.searchParams.get("freshness")).toBe("pm");
		expect(requests[1].headers.authorization).toBe("Bearer private-secret");
		expect(requests[1].body).toMatchObject({
			max_results: 2,
			search_depth: "basic",
			topic: "general",
			auto_parameters: false,
			include_answer: false,
			include_raw_content: false,
			time_range: "week",
		});
		expect(requests[2].headers["x-api-key"]).toBe("private-secret");
		expect(requests[2].body).toMatchObject({ numResults: 3, contents: { highlights: true } });
		expect(new Date(String(requests[2].body.startPublishedDate)).getTime()).toBeGreaterThan(
			Date.now() - 2 * 86400000,
		);
		expect(requests[3].headers.authorization).toBe("Bearer private-secret");
		expect(requests[3].body).toMatchObject({ limit: 4, sources: [{ type: "web", tbs: "qdr:y" }] });
		expect((await brave.search({ query: "empty", limit: 5 })).results).toEqual([]);
		expect((await tavily.search({ query: "empty", limit: 5 })).results).toEqual([]);
		expect((await exa.search({ query: "empty", limit: 5 })).results).toEqual([]);
		expect((await firecrawl.search({ query: "empty", limit: 5 })).results).toEqual([]);
	});

	it("reports HTTP failures once without exposing reflected response credentials", async () => {
		for (const provider of [
			new BraveSearchProvider(() => "private-secret", fetcher),
			new TavilySearchProvider(() => "private-secret", fetcher),
			new ExaSearchProvider(() => "private-secret", fetcher),
			new FirecrawlSearchProvider(() => "private-secret", fetcher),
		]) {
			for (const status of [401, 429]) {
				let error: unknown;
				try {
					await provider.search({ query: String(status), limit: 5 });
				} catch (failure) {
					error = failure;
				}
				expect(String(error)).toContain(`HTTP ${status}`);
				expect(String(error)).not.toContain("private-secret");
			}
		}
		expect(requests).toHaveLength(8);
		await expect(
			new BraveSearchProvider(() => "private-secret", fetcher).search({ query: "invalid", limit: 5 }),
		).rejects.toThrow("invalid JSON");
	});

	it("passes cancellation to pending HTTP work and does not retry", async () => {
		const controller = new AbortController();
		const pending = new TavilySearchProvider(() => "private-secret", fetcher).search(
			{ query: "wait", limit: 5 },
			controller.signal,
		);
		await expect.poll(() => requests.length).toBe(1);
		controller.abort(new Error("private-secret"));
		await expect(pending).rejects.toThrow("cancelled");
		expect(requests).toHaveLength(1);
	});

	it("enforces the 30-second provider timeout without retry", async () => {
		// Node's native AbortSignal.timeout uses internal timers, not Vitest's fake clock.
		// This integration test deliberately observes the platform timeout against real HTTP.
		await expect(
			new BraveSearchProvider(() => "private-secret", fetcher).search({ query: "wait", limit: 5 }),
		).rejects.toThrow("timed out after 30 seconds");
		expect(requests).toHaveLength(1);
	}, 35_000);

	it("reads changed defaults and keys on each call and never falls back", async () => {
		const snapshot: SettingsSnapshot = {
			search: { defaultProvider: "brave", configured: { brave: false, tavily: true, exa: false, firecrawl: false } },
			teams: { maxConcurrentAgents: 4, maxDepth: 3 },
		};
		const keys: { brave?: string; tavily?: string; exa?: string; firecrawl?: string } = { tavily: "private-secret" };
		const settings: Pick<SettingsService, "get" | "getSearchKey"> = {
			get: () => snapshot,
			getSearchKey: (id) => keys[id],
		};
		const search = new SearchService(settings, fetcher);
		await expect(search.search({ query: "query" })).rejects.toThrow("Brave API key is not configured");
		expect(requests).toHaveLength(0);
		snapshot.search.defaultProvider = "tavily";
		expect((await search.search({ query: "query" })).provider).toBe("tavily");
		keys.brave = "new-private-key";
		expect((await search.search({ query: "query", provider: "brave" })).provider).toBe("brave");
		expect(requests[1].headers["x-subscription-token"]).toBe("new-private-key");
		snapshot.search.defaultProvider = "exa";
		await expect(search.search({ query: "query" })).rejects.toThrow("Exa API key is not configured");
		keys.exa = "exa-private-key";
		expect((await search.search({ query: "query" })).provider).toBe("exa");
		keys.firecrawl = "firecrawl-private-key";
		expect((await search.search({ query: "query", provider: "firecrawl" })).provider).toBe("firecrawl");
		expect(requests[3].headers.authorization).toBe("Bearer firecrawl-private-key");
		await expect(search.search({ query: " " })).rejects.toThrow("must not be empty");
		await expect(search.search({ query: "query", provider: "unknown" })).rejects.toThrow("Invalid search request");
		await expect(search.search({ query: "a".repeat(601), provider: "brave" })).rejects.toThrow("600 characters");
		await expect(
			search.search({ query: Array.from({ length: 76 }, () => "word").join(" "), provider: "brave" }),
		).rejects.toThrow("75 words");
		expect(requests).toHaveLength(4);
	});
});
