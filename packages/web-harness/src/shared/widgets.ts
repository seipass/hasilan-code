export interface WeatherPlace {
	id: number;
	name: string;
	region: string;
	country: string;
	latitude: number;
	longitude: number;
}

export interface WeatherSnapshot {
	temperature: number;
	code: number;
	high: number;
	low: number;
	wind: number;
	time: number;
	fetchedAt: number;
}

export interface QuakeNotice {
	id: string;
	place: string;
	time: string;
	reportedAt: string;
	intensity: string;
	magnitude: string;
	title: string;
	depth: number | null;
	detailFile: string | null;
	tsunami: { text: string; noRisk: boolean } | null;
}

export interface QuakeSnapshot {
	notices: QuakeNotice[];
	fetchedAt: number;
}

export interface NewsArticle {
	title: string;
	url: string;
	publishedAt: number;
}

export interface NewsSnapshot {
	articles: NewsArticle[];
	fetchedAt: number;
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function validCoordinate(value: unknown, limit: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

export function weatherPlaces(value: unknown): WeatherPlace[] {
	const entries = objectValue(value)?.results;
	if (!Array.isArray(entries)) return [];
	return entries
		.flatMap((entry) => {
			const item = objectValue(entry);
			if (
				!item ||
				typeof item.id !== "number" ||
				typeof item.name !== "string" ||
				!validCoordinate(item.latitude, 90) ||
				!validCoordinate(item.longitude, 180)
			)
				return [];
			return [
				{
					id: item.id,
					name: item.name,
					region: typeof item.admin1 === "string" ? item.admin1 : "",
					country: typeof item.country === "string" ? item.country : "",
					latitude: item.latitude,
					longitude: item.longitude,
				},
			];
		})
		.slice(0, 8);
}

export function weatherSnapshot(value: unknown, fetchedAt: number): WeatherSnapshot {
	const root = objectValue(value);
	const current = objectValue(root?.current);
	const daily = objectValue(root?.daily);
	const high = Array.isArray(daily?.temperature_2m_max) ? daily.temperature_2m_max[0] : undefined;
	const low = Array.isArray(daily?.temperature_2m_min) ? daily.temperature_2m_min[0] : undefined;
	const values = [current?.temperature_2m, current?.weather_code, current?.wind_speed_10m, current?.time, high, low];
	if (!values.every((entry) => typeof entry === "number" && Number.isFinite(entry)))
		throw new Error("天気の応答に必要な値がありません。");
	const [temperature, code, wind, time, maximum, minimum] = values as number[];
	return { temperature, code, wind, time: time * 1000, high: maximum, low: minimum, fetchedAt };
}

/** The JMA list can contain several reports for one event; keep its newest report. */
export function quakeSnapshot(value: unknown, fetchedAt: number): QuakeSnapshot {
	if (!Array.isArray(value)) throw new Error("地震情報の応答形式が不正です。");
	const reports = value
		.flatMap((entry) => {
			const item = objectValue(entry);
			if (
				!item ||
				typeof item.eid !== "string" ||
				!/^\d{14}$/.test(item.eid) ||
				typeof item.rdt !== "string" ||
				!Number.isFinite(Date.parse(item.rdt))
			)
				return [];
			if (typeof item.ttl !== "string" || typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at)))
				return [];
			const coordinate =
				typeof item.cod === "string"
					? /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/$/.exec(item.cod)
					: null;
			const depth =
				coordinate?.[3] && validCoordinate(Number(coordinate[1]), 90) && validCoordinate(Number(coordinate[2]), 180)
					? -Number(coordinate[3]) / 1000
					: null;
			return [
				{
					id: item.eid,
					title: item.ttl,
					time: item.at,
					reportedAt: item.rdt,
					place: typeof item.anm === "string" && item.anm ? item.anm : "震源情報なし",
					intensity:
						typeof item.maxi === "string"
							? item.maxi.replace("5-", "5弱").replace("5+", "5強").replace("6-", "6弱").replace("6+", "6強")
							: "",
					magnitude: typeof item.mag === "string" ? item.mag : "",
					depth: depth !== null && depth >= 0 && depth <= 1000 ? Math.max(0, depth) : null,
					detailFile:
						typeof item.json === "string" &&
						/^\d{14}_\d{14}_VXSE5[0-9A-Za-z]_\d+\.json$/.test(item.json) &&
						item.json.split("_")[1] === item.eid
							? item.json
							: null,
					tsunami: null,
				},
			];
		})
		.sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt));
	const latest = new Map<string, QuakeNotice>();
	for (const report of reports) if (!latest.has(report.id)) latest.set(report.id, report);
	const notices = [...latest.values()].slice(0, 10);
	if (value.length > 0 && notices.length === 0) throw new Error("有効な地震情報を取得できませんでした。");
	return { notices, fetchedAt };
}

/** A missing or unrelated report must never become a "no tsunami" message. */
export function quakeTsunami(value: unknown, eventId: string): QuakeNotice["tsunami"] {
	const root = objectValue(value);
	const head = objectValue(root?.Head);
	const body = objectValue(root?.Body);
	if (!head || head.EventID !== eventId || !body || !["発表", "訂正"].includes(String(head.InfoType)))
		throw new Error("地震情報の詳細が一致しません。");
	const comment = objectValue(objectValue(body.Comments)?.ForecastComment);
	if (typeof comment?.Text !== "string" || !comment.Text.trim()) return null;
	const text = comment.Text.trim();
	return { text, noRisk: comment.Code === "0215" && text === "この地震による津波の心配はありません。" };
}
