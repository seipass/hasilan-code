import {
	type QuakeSnapshot,
	quakeSnapshot,
	quakeTsunami,
	validCoordinate,
	weatherPlaces,
	weatherSnapshot,
} from "../shared/widgets.ts";
import { HttpError } from "./http-host.ts";
import { newsSnapshot } from "./news-feed.ts";

/** Only fixed public data sources are fetched. Responses and concurrent requests share a bounded cache. */
export class WidgetData {
	private readonly fetcher: typeof fetch;
	private readonly cache = new Map<string, { expires: number; pending: Promise<unknown> }>();

	constructor(fetcher: typeof fetch = fetch) {
		this.fetcher = fetcher;
	}

	async query(url: URL): Promise<unknown> {
		try {
			if (url.pathname === "/api/widgets/news") {
				return await this.read(
					new URL("https://news.yahoo.co.jp/rss/topics/top-picks.xml"),
					300_000,
					newsSnapshot,
					"rss",
				);
			}
			if (url.pathname === "/api/widgets/places") {
				const query = url.searchParams.get("q")?.trim() ?? "";
				if (query.length < 2 || query.length > 80)
					throw new HttpError(400, "地域名は2〜80文字で入力してください。");
				const source = new URL("https://geocoding-api.open-meteo.com/v1/search");
				source.search = new URLSearchParams({ name: query, count: "8", language: "ja", format: "json" }).toString();
				return await this.read(source, 3600_000, weatherPlaces);
			}
			if (url.pathname === "/api/widgets/weather") {
				const latitude = url.searchParams.get("latitude");
				const longitude = url.searchParams.get("longitude");
				if (
					!latitude?.trim() ||
					!longitude?.trim() ||
					!validCoordinate(Number(latitude), 90) ||
					!validCoordinate(Number(longitude), 180)
				)
					throw new HttpError(400, "天気の地域を選択してください。");
				const source = new URL("https://api.open-meteo.com/v1/forecast");
				source.search = new URLSearchParams({
					latitude: String(Number(latitude)),
					longitude: String(Number(longitude)),
					current: "temperature_2m,weather_code,wind_speed_10m",
					daily: "temperature_2m_max,temperature_2m_min",
					forecast_days: "1",
					timezone: "auto",
					timeformat: "unixtime",
					wind_speed_unit: "ms",
				}).toString();
				return await this.read(source, 600_000, weatherSnapshot);
			}
			if (url.pathname === "/api/widgets/earthquakes") {
				const snapshot = (await this.read(
					new URL("https://www.jma.go.jp/bosai/quake/data/list.json"),
					30_000,
					quakeSnapshot,
				)) as QuakeSnapshot;
				const latest = snapshot.notices[0];
				if (!latest?.detailFile) return snapshot;
				try {
					const tsunami = await this.read(
						new URL(`https://www.jma.go.jp/bosai/quake/data/${latest.detailFile}`),
						600_000,
						(value) => quakeTsunami(value, latest.id),
					);
					return { ...snapshot, notices: [{ ...latest, tsunami }, ...snapshot.notices.slice(1)] };
				} catch {
					return snapshot;
				}
			}
			throw new HttpError(404, "ウィジェットの情報が見つかりません。");
		} catch (error) {
			if (error instanceof HttpError) throw error;
			throw new HttpError(502, "外部の情報を取得できませんでした。しばらくしてから更新してください。");
		}
	}

	private async read(
		url: URL,
		ttl: number,
		decode: (data: unknown, fetchedAt: number) => unknown,
		format: "json" | "rss" = "json",
	): Promise<unknown> {
		const key = url.href;
		const previous = this.cache.get(key);
		if (previous && previous.expires > Date.now()) return previous.pending;
		const pending = (async () => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 8000);
			try {
				const response = await this.fetcher(url, {
					signal: controller.signal,
					redirect: "error",
					headers: {
						Accept:
							format === "rss"
								? "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8"
								: "application/json",
					},
				});
				if (!response.ok || !response.body) throw new Error("Source unavailable");
				const reader = response.body.getReader();
				let text = "";
				let bytes = 0;
				const decoder = new TextDecoder("utf-8", { fatal: true });
				try {
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
						bytes += chunk.value.byteLength;
						if (bytes > 2 * 1024 * 1024) throw new Error("Source response too large");
						text += decoder.decode(chunk.value, { stream: true });
					}
					text += decoder.decode();
				} finally {
					await reader.cancel().catch(() => undefined);
				}
				return decode(format === "rss" ? text : (JSON.parse(text) as unknown), Date.now());
			} finally {
				clearTimeout(timeout);
			}
		})();
		this.cache.set(key, { expires: Date.now() + ttl, pending });
		while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
		try {
			return await pending;
		} catch (error) {
			if (this.cache.get(key)?.pending === pending) this.cache.delete(key);
			throw error;
		}
	}
}
