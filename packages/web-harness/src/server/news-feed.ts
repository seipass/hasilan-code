import type { NewsArticle, NewsSnapshot } from "../shared/widgets.ts";

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Read the plain-text fields of the fixed Yahoo RSS feed; never interpret feed HTML. */
function rssText(item: string, tag: "title" | "link" | "pubDate"): string {
	const value = new RegExp(`<${tag}\\s*>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(item)?.[1] ?? "";
	return value
		.replace(
			/<!\[CDATA\[([\s\S]*?)\]\]>|&(amp|lt|gt|quot|apos|#x[\da-f]+|#\d+);/gi,
			(match: string, cdata: string | undefined, entity: string | undefined) => {
				if (cdata !== undefined) return cdata;
				if (!entity) return match;
				if (!entity.startsWith("#")) return XML_ENTITIES[entity.toLowerCase()] ?? match;
				const point =
					entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
				return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
					? String.fromCodePoint(point)
					: "\ufffd";
			},
		)
		.trim();
}

export function newsSnapshot(value: unknown, fetchedAt: number): NewsSnapshot {
	if (
		typeof value !== "string" ||
		!/<rss\b/i.test(value) ||
		!/<channel\s*>[\s\S]*<\/channel\s*>\s*<\/rss\s*>\s*$/i.test(value)
	)
		throw new Error("ニュースの応答形式が不正です。");
	const articles: NewsArticle[] = [];
	const seen = new Set<string>();
	const items = [...value.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<item\s*>([\s\S]*?)<\/item\s*>/gi)];
	for (const item of items) {
		const title = rssText(item[1], "title").replace(/\s+/g, " ").slice(0, 300);
		const publishedAt = Date.parse(rssText(item[1], "pubDate"));
		const link = rssText(item[1], "link");
		if (!title || !Number.isFinite(publishedAt) || link.length > 2048) continue;
		let url: URL;
		try {
			url = new URL(link);
		} catch {
			continue;
		}
		if (url.origin !== "https://news.yahoo.co.jp" || url.username || url.password || seen.has(url.href)) continue;
		seen.add(url.href);
		articles.push({ title, url: url.href, publishedAt });
		if (articles.length === 12) break;
	}
	if (items.length && !articles.length) throw new Error("有効なニュースを取得できませんでした。");
	return { articles, fetchedAt };
}
