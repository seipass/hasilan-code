import { describe, expect, it, vi } from "vitest";
import { newsSnapshot } from "../src/server/news-feed.ts";
import { WidgetData } from "../src/server/widget-data.ts";

const item = (title: string, link = "https://news.yahoo.co.jp/pickup/1?source=rss") =>
	`<item><title>${title}</title><link>${link}</link><pubDate>Sun, 25 Oct 2026 13:45:25 GMT</pubDate></item>`;
const feed = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;

describe("news widget feed", () => {
	it("decodes RSS text once, preserves source order, and deduplicates article links", () => {
		const snapshot = newsSnapshot(
			feed(
				[
					item("A &amp; B &#x65B0; &#65;"),
					item("duplicate"),
					item("<![CDATA[A &amp; <B>]]>", "https://news.yahoo.co.jp/pickup/2?a=1&amp;b=2"),
				].join(""),
			),
			100,
		);
		expect(snapshot).toEqual({
			fetchedAt: 100,
			articles: [
				{
					title: "A & B 新 A",
					url: "https://news.yahoo.co.jp/pickup/1?source=rss",
					publishedAt: Date.parse("2026-10-25T13:45:25Z"),
				},
				{
					title: "A &amp; <B>",
					url: "https://news.yahoo.co.jp/pickup/2?a=1&b=2",
					publishedAt: Date.parse("2026-10-25T13:45:25Z"),
				},
			],
		});
	});

	it("excludes unsafe article destinations and invalid publication dates", () => {
		const unsafe = [
			"javascript:alert(1)",
			"http://news.yahoo.co.jp/pickup/1",
			"https://example.com/",
			"https://user@news.yahoo.co.jp/pickup/1",
		];
		const snapshot = newsSnapshot(
			feed(
				unsafe.map((url) => item("Unsafe", url)).join("") +
					item("Invalid date").replace("Sun, 25 Oct 2026 13:45:25 GMT", "invalid") +
					item("Safe"),
			),
			100,
		);
		expect(snapshot.articles.map((article) => article.title)).toEqual(["Safe"]);
	});

	it("distinguishes empty feeds from failed or unusable feed responses", () => {
		expect(newsSnapshot(feed(""), 100).articles).toEqual([]);
		expect(() => newsSnapshot("<html>Unavailable</html>", 100)).toThrow();
		expect(() => newsSnapshot(feed(item("", "invalid")), 100)).toThrow();
	});

	it("fetches a fixed RSS source once for concurrent and cached requests", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(feed(item("Headline"))));
		const service = new WidgetData(fetcher);
		const url = new URL("http://localhost/api/widgets/news?url=https://example.com/");
		const [first, second] = await Promise.all([service.query(url), service.query(url)]);
		expect(first).toMatchObject({ articles: [{ title: "Headline" }] });
		expect(second).toEqual(first);
		expect(await service.query(url)).toEqual(first);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(String(fetcher.mock.calls[0][0])).toBe("https://news.yahoo.co.jp/rss/topics/top-picks.xml");
		expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
			Accept: expect.stringContaining("application/rss+xml"),
		});
	});
});
