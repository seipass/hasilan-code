import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultWidgetPreferences,
	parseWidgetPreferences,
	readWidgetPreferences,
	timerElapsed,
	timerLabel,
} from "../src/client/widgets/state.ts";
import { WidgetData } from "../src/server/widget-data.ts";
import { quakeSnapshot, quakeTsunami, weatherSnapshot } from "../src/shared/widgets.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("widget preferences and clocks", () => {
	it("preserves combinations, an empty layout, and notes without accepting unknown widgets", () => {
		const preferences = defaultWidgetPreferences();
		const value = parseWidgetPreferences(
			JSON.stringify({
				...preferences,
				order: ["music", "notes", "music", "unknown", "countup"],
				note: "first\nsecond",
			}),
		);
		expect(value.order).toEqual(["music", "notes", "countup"]);
		expect(value.note).toBe("first\nsecond");
		expect(parseWidgetPreferences(JSON.stringify({ ...preferences, order: [] })).order).toEqual([]);
	});
	it("retains the maximum note length even when JSON must escape every character", () => {
		const note = "\u0001".repeat(50_000);
		expect(parseWidgetPreferences(JSON.stringify({ ...defaultWidgetPreferences(), note })).note).toBe(note);
	});
	it("rejects invalid persisted coordinates and timer values without losing a valid note", () => {
		const value = parseWidgetPreferences(
			JSON.stringify({
				order: ["weather"],
				place: { id: 1, name: "Bad", region: "", country: "", latitude: 91, longitude: 1 },
				countdown: { duration: -1, elapsed: 0, startedAt: null },
				note: "keep",
			}),
		);
		expect(value.place).toBeNull();
		expect(value.countdown).toEqual(defaultWidgetPreferences().countdown);
		expect(value.note).toBe("keep");
	});
	it("recovers when storage is unavailable or malformed", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("blocked");
			},
		});
		expect(readWidgetPreferences()).toEqual(defaultWidgetPreferences());
		expect(parseWidgetPreferences("broken")).toEqual(defaultWidgetPreferences());
	});
	it("counts actual elapsed time through reloads, pauses, and suspended tabs", () => {
		const timer = { duration: 300_000, elapsed: 12_000, startedAt: 1000 };
		const restored = parseWidgetPreferences(JSON.stringify({ ...defaultWidgetPreferences(), countup: timer }));
		expect(timerElapsed(restored.countup, 3_661_000)).toBe(3_672_000);
		expect(timerElapsed({ ...timer, startedAt: null }, 3_661_000)).toBe(12_000);
		expect(timerElapsed(timer, 0)).toBe(12_000);
		expect(timerLabel(3_672_000)).toBe("1:01:12");
		expect(timerLabel(-1000)).toBe("00:00");
	});
});

const weather = {
	current: { temperature_2m: 19.5, weather_code: 3, wind_speed_10m: 2.5, time: 1000 },
	daily: { temperature_2m_max: [23], temperature_2m_min: [16] },
};
const quake = {
	eid: "20261025010000",
	ttl: "震源・震度情報",
	at: "2026-10-25T01:00:00+09:00",
	rdt: "2026-10-25T01:03:00+09:00",
	anm: "テスト震源",
	maxi: "5-",
	mag: "5.0",
};

describe("public widget data", () => {
	it("normalizes source timestamps and distinguishes missing weather from zero", () => {
		expect(weatherSnapshot(weather, 5000)).toMatchObject({
			temperature: 19.5,
			high: 23,
			time: 1_000_000,
			fetchedAt: 5000,
		});
		expect(() =>
			weatherSnapshot({ ...weather, current: { ...weather.current, temperature_2m: null } }, 5000),
		).toThrow();
		expect(
			weatherSnapshot({ ...weather, current: { ...weather.current, temperature_2m: 0 } }, 5000).temperature,
		).toBe(0);
	});
	it("uses the latest JMA report for each event and normalizes intensity", () => {
		const older = { ...quake, rdt: "2026-10-25T01:01:00+09:00", maxi: "4" };
		const result = quakeSnapshot([older, { bad: true }, quake], 100);
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).toMatchObject({ intensity: "5弱", reportedAt: quake.rdt });
		expect(() => quakeSnapshot([{ bad: true }], 100)).toThrow();
		expect(quakeSnapshot([], 100).notices).toEqual([]);
	});
	it("extracts depth in kilometres without treating absent or invalid coordinates as a shallow earthquake", () => {
		for (const [coordinate, expected] of [
			["+41.9+141.7-90000/", 90],
			["+28.0+139.9-470000/", 470],
			["+32.6+130.7+0/", 0],
			["-21.2+168.5/", null],
			["+91.0+140.0-10000/", null],
			["bad", null],
		] as const) {
			expect(quakeSnapshot([{ ...quake, cod: coordinate }], 100).notices[0].depth).toBe(expected);
		}
	});
	it("only marks the exact JMA no-tsunami message for the matching event as no risk", () => {
		const detail = {
			Head: { EventID: quake.eid, InfoType: "発表" },
			Body: { Comments: { ForecastComment: { Code: "0215", Text: "この地震による津波の心配はありません。" } } },
		};
		expect(quakeTsunami(detail, quake.eid)).toMatchObject({ noRisk: true });
		expect(quakeTsunami({ ...detail, Body: {} }, quake.eid)).toBeNull();
		const caution = { Code: "0217", Text: "今後の情報に注意してください。" };
		expect(quakeTsunami({ ...detail, Body: { Comments: { ForecastComment: caution } } }, quake.eid)).toEqual({
			text: caution.Text,
			noRisk: false,
		});
		expect(() => quakeTsunami(detail, "20261025020000")).toThrow();
		expect(() => quakeTsunami({ ...detail, Head: { ...detail.Head, InfoType: "取消" } }, quake.eid)).toThrow();
	});
	it("enriches the latest earthquake from a validated official detail file and reuses its cache", async () => {
		const file = "20261025010300_20261025010000_VXSE5k_1.json";
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
			String(url).endsWith("list.json")
				? Response.json([{ ...quake, cod: "+41.9+141.7-90000/", json: file }])
				: Response.json({
						Head: { EventID: quake.eid, InfoType: "発表" },
						Body: {
							Comments: { ForecastComment: { Code: "0215", Text: "この地震による津波の心配はありません。" } },
						},
					}),
		);
		const service = new WidgetData(fetcher);
		const url = new URL("http://localhost/api/widgets/earthquakes");
		expect(await service.query(url)).toMatchObject({ notices: [{ depth: 90, tsunami: { noRisk: true } }] });
		await service.query(url);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(String(fetcher.mock.calls[1][0])).toBe(`https://www.jma.go.jp/bosai/quake/data/${file}`);
	});
	it("retains earthquake observations when details fail and never fetches an arbitrary detail destination", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json([
					{ ...quake, cod: "+41.9+141.7-90000/", json: "20261025010300_20261025010000_VXSE5k_1.json" },
				]),
			)
			.mockRejectedValueOnce(new Error("offline"));
		expect(await new WidgetData(fetcher).query(new URL("http://localhost/api/widgets/earthquakes"))).toMatchObject({
			notices: [{ depth: 90, tsunami: null }],
		});
		const unsafe = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json([{ ...quake, json: "https://example.com/report.json" }]));
		await new WidgetData(unsafe).query(new URL("http://localhost/api/widgets/earthquakes"));
		expect(unsafe).toHaveBeenCalledTimes(1);
	});
	it("deduplicates concurrent fetches and expires the quake cache without pretending cached data is fresh", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([quake]));
		const service = new WidgetData(fetcher);
		const url = new URL("http://localhost/api/widgets/earthquakes");
		const [first, second] = await Promise.all([service.query(url), service.query(url)]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(first).toEqual(second);
		expect(String(fetcher.mock.calls[0][0])).toBe("https://www.jma.go.jp/bosai/quake/data/list.json");
		await vi.advanceTimersByTimeAsync(31_000);
		expect(await service.query(url)).not.toEqual(first);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("rejects arbitrary destinations and invalid input before making requests", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const service = new WidgetData(fetcher);
		for (const path of [
			"weather",
			"weather?latitude=NaN&longitude=0",
			"weather?latitude=0&longitude=181",
			"places?q=a",
			"http://127.0.0.1/secret",
		]) {
			await expect(service.query(new URL(`http://localhost/api/widgets/${path}`))).rejects.toMatchObject({
				status: path.startsWith("http") ? 404 : 400,
			});
		}
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("does not retain failed or invalid source responses", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(Response.json({ ...weather, current: null }))
			.mockImplementation(async () => Response.json(weather));
		const service = new WidgetData(fetcher);
		const url = new URL("http://localhost/api/widgets/weather?latitude=35&longitude=139");
		await expect(service.query(url)).rejects.toMatchObject({ status: 502 });
		await expect(service.query(url)).rejects.toMatchObject({ status: 502 });
		expect(await service.query(url)).toMatchObject({ temperature: 19.5 });
		expect(fetcher).toHaveBeenCalledTimes(3);
	});
	it("limits public responses instead of buffering unbounded data", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(" ".repeat(2 * 1024 * 1024 + 1)));
		await expect(
			new WidgetData(fetcher).query(new URL("http://localhost/api/widgets/earthquakes")),
		).rejects.toMatchObject({ status: 502 });
	});
});
