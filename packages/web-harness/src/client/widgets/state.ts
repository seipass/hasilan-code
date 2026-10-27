import { objectValue, validCoordinate, type WeatherPlace } from "../../shared/widgets.ts";

export const WIDGET_KEY = "hasilan-widgets-v1";
export const WIDGET_KINDS = [
	"weather",
	"usage",
	"countdown",
	"countup",
	"earthquake",
	"news",
	"music",
	"notes",
] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];
export const WIDGET_LABELS: Record<WidgetKind, string> = {
	weather: "天気",
	usage: "使用量",
	countdown: "カウントダウン",
	countup: "カウントアップ",
	earthquake: "地震情報",
	news: "ニュース",
	music: "音楽",
	notes: "メモ帳",
};

export interface WidgetTimer {
	duration: number;
	elapsed: number;
	startedAt: number | null;
}

export interface WidgetPreferences {
	order: WidgetKind[];
	place: WeatherPlace | null;
	countdown: WidgetTimer;
	countup: WidgetTimer;
	note: string;
}

export function defaultWidgetPreferences(): WidgetPreferences {
	return {
		order: ["usage", "notes"],
		place: null,
		countdown: { duration: 300_000, elapsed: 0, startedAt: null },
		countup: { duration: 0, elapsed: 0, startedAt: null },
		note: "",
	};
}

function storedTimer(value: unknown, fallback: WidgetTimer): WidgetTimer {
	const item = objectValue(value);
	if (
		!item ||
		typeof item.duration !== "number" ||
		!Number.isFinite(item.duration) ||
		item.duration < 0 ||
		item.duration > 7 * 86400_000 ||
		typeof item.elapsed !== "number" ||
		!Number.isFinite(item.elapsed) ||
		item.elapsed < 0 ||
		item.elapsed > Number.MAX_SAFE_INTEGER ||
		(item.startedAt !== null &&
			(typeof item.startedAt !== "number" ||
				!Number.isFinite(item.startedAt) ||
				item.startedAt < 0 ||
				item.startedAt > 8_640_000_000_000_000))
	)
		return fallback;
	return { duration: item.duration, elapsed: item.elapsed, startedAt: item.startedAt };
}

export function parseWidgetPreferences(raw: string | null): WidgetPreferences {
	const defaults = defaultWidgetPreferences();
	if (!raw || raw.length > 500_000) return defaults;
	try {
		const value: unknown = JSON.parse(raw);
		const item = objectValue(value);
		if (!item || !Array.isArray(item.order)) return defaults;
		const place = objectValue(item.place);
		return {
			order: [
				...new Set(
					item.order.filter(
						(kind): kind is WidgetKind =>
							typeof kind === "string" && WIDGET_KINDS.some((entry) => entry === kind),
					),
				),
			],
			place:
				place &&
				typeof place.id === "number" &&
				typeof place.name === "string" &&
				typeof place.region === "string" &&
				typeof place.country === "string" &&
				validCoordinate(place.latitude, 90) &&
				validCoordinate(place.longitude, 180)
					? {
							id: place.id,
							name: place.name.slice(0, 100),
							region: place.region.slice(0, 100),
							country: place.country.slice(0, 100),
							latitude: place.latitude,
							longitude: place.longitude,
						}
					: null,
			countdown: storedTimer(item.countdown, defaults.countdown),
			countup: storedTimer(item.countup, defaults.countup),
			note: typeof item.note === "string" ? item.note.slice(0, 50_000) : "",
		};
	} catch {
		return defaults;
	}
}

export function readWidgetPreferences(): WidgetPreferences {
	try {
		return parseWidgetPreferences(localStorage.getItem(WIDGET_KEY));
	} catch {
		return defaultWidgetPreferences();
	}
}

/** Elapsed time comes from a timestamp, so hidden tabs and reloads do not lose ticks. */
export function timerElapsed(timer: WidgetTimer, now: number): number {
	return timer.elapsed + (timer.startedAt === null ? 0 : Math.max(0, now - timer.startedAt));
}

export function timerLabel(milliseconds: number): string {
	const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
	const hours = Math.floor(seconds / 3600);
	return `${hours ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function weatherLabel(code: number): string {
	if (code === 0) return "快晴";
	if (code === 1) return "晴れ";
	if (code === 2) return "晴れ時々曇り";
	if (code === 3) return "曇り";
	if (code === 45 || code === 48) return "霧";
	if ([51, 53, 55, 56, 57].includes(code)) return "霧雨";
	if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "雨";
	if ([71, 73, 75, 77, 85, 86].includes(code)) return "雪";
	if ([95, 96, 97, 99].includes(code)) return "雷雨";
	return "天気情報";
}
