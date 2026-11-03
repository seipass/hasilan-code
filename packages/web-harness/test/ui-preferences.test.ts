import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreferenceStorage } from "../src/client/preferences.ts";
import { createHttpHost, type HttpHost } from "../src/server/http-host.ts";
import { UiPreferencesStore } from "../src/server/ui-preferences.ts";
import type { UiPreferencesSnapshot } from "../src/shared/ui-preferences.ts";

function browserStorage(entries: [string, string][]): Storage {
	const values = new Map(entries);
	return {
		get length() {
			return values.size;
		},
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
		clear: () => values.clear(),
		key: (index) => [...values.keys()][index] ?? null,
	};
}

describe("shared Web and desktop preferences", () => {
	let directory: string;
	let store: UiPreferencesStore;
	let host: HttpHost;
	let origin: string;
	let cookie: string;
	const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
		const response = await fetch(`${origin}${path}`, {
			...init,
			headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return (await response.json()) as T;
	};
	async function start() {
		store = await UiPreferencesStore.open(directory);
		host = createHttpHost({ port: 0, handleApi: (request, response, url) => store.handle(request, response, url) });
		const launch = await host.listen();
		origin = launch.origin;
		const exchange = await fetch(launch.launchUrl, { redirect: "manual" });
		cookie = exchange.headers.get("set-cookie")!.split(";")[0];
	}
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "hasilan-ui-preferences-"));
		await start();
	});
	afterEach(async () => {
		await store?.close();
		await host?.close();
		await rm(directory, { recursive: true, force: true });
	});

	it("migrates browser preferences, then restores them in a different origin with no browser storage", async () => {
		const image = JSON.stringify({
			image: `data:image/png;base64,${"YWFh".repeat(300_000)}`,
			name: "background.png",
		});
		const legacy = browserStorage([
			["hasilan-home-background", image],
			["hasilan-widgets-v1", JSON.stringify({ order: ["weather", "notes"], note: "keep my note" })],
			["pi-web-draft:new:workspace-1", "未送信の文章"],
			[
				"pi-web-model-selection",
				JSON.stringify({ model: { provider: "commandcode", id: "model" }, thinkingLevel: "max" }),
			],
			["pi-web-keybindings", JSON.stringify({ "composer.send": ["alt+enter"], "composer.followUp": ["alt+f"] })],
			["auth.json", "must not migrate"],
		]);
		const web = new PreferenceStorage(request);
		await web.initialize(legacy);
		const oldOrigin = origin;
		await host.close();
		await store.close();
		await start();
		expect(origin).not.toBe(oldOrigin);
		const desktop = new PreferenceStorage(request);
		await desktop.initialize();
		for (const key of [
			"hasilan-widgets-v1",
			"pi-web-draft:new:workspace-1",
			"pi-web-model-selection",
			"pi-web-keybindings",
		])
			expect(desktop.getItem(key)).toBe(legacy.getItem(key));
		// The home background is fetched on demand so it does not inflate startup snapshots.
		expect(desktop.getItem("hasilan-home-background")).toBeNull();
		await desktop.load("hasilan-home-background");
		expect(desktop.getItem("hasilan-home-background")).toBe(legacy.getItem("hasilan-home-background"));
		expect(desktop.getItem("auth.json")).toBeNull();
	});

	it("never replaces a shared value or resurrects deleted drafts during another browser's migration", async () => {
		await store.patch({
			entries: [
				{ key: "pi-web-draft:session-1", value: "shared" },
				{ key: "hasilan-home-background", value: null },
			],
		});
		const web = new PreferenceStorage(request);
		await web.initialize(
			browserStorage([
				["pi-web-draft:session-1", "outdated"],
				["hasilan-home-background", JSON.stringify({ image: "old", name: "old" })],
			]),
		);
		expect(web.getItem("pi-web-draft:session-1")).toBe("shared");
		expect(web.getItem("hasilan-home-background")).toBeNull();
		web.removeItem("pi-web-draft:session-1");
		await web.flush();
		await host.close();
		await store.close();
		await start();
		const desktop = new PreferenceStorage(request);
		await desktop.initialize(browserStorage([["pi-web-draft:session-1", "outdated"]]));
		expect(desktop.getItem("pi-web-draft:session-1")).toBeNull();
	});

	it("merges independent client writes and refreshes subscribed values without rewriting the image", async () => {
		await store.patch({
			entries: [
				{
					key: "hasilan-home-background",
					value: JSON.stringify({ image: "data:image/png;base64,YQ==", name: "a.png" }),
				},
			],
		});
		const path = join(
			directory,
			"web-harness",
			"ui-preferences",
			(await readdir(join(directory, "web-harness", "ui-preferences")))[0],
		);
		const before = await stat(path);
		const web = new PreferenceStorage(request);
		const desktop = new PreferenceStorage(request);
		await web.initialize();
		await desktop.initialize();
		let notified = 0;
		web.subscribe("pi-web-right-width", () => {
			notified++;
		});
		web.setItem("pi-web-draft:session-1", "from web");
		desktop.setItem("pi-web-right-width", "720");
		await web.flush();
		await desktop.flush();
		await web.sync();
		expect(web.getItem("pi-web-right-width")).toBe("720");
		expect(store.get("pi-web-draft:session-1")).toBe("from web");
		expect(notified).toBe(1);
		expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
		const delta = await request<UiPreferencesSnapshot>(
			`/api/ui-preferences?since=${encodeURIComponent(store.snapshot().revision)}`,
		);
		expect(delta).toBeNull();
	});

	it("loads attachment drafts on demand, preserves removal across restarts, and excludes data from snapshots", async () => {
		const key = "pi-web-attachments:new:workspace-1";
		const attachments = JSON.stringify([
			{
				id: "attachment-1",
				name: "audio.mp3",
				mimeType: "audio/mpeg",
				data: "YWJj".repeat(400_000),
				size: 1_200_000,
			},
		]);
		const web = new PreferenceStorage(request);
		await web.initialize();
		web.setItem(key, attachments);
		await web.flush();
		const snapshot = await request<UiPreferencesSnapshot>("/api/ui-preferences");
		expect(snapshot.values[key]).toBeUndefined();
		expect(JSON.stringify(snapshot)).not.toContain("YWJj");
		await host.close();
		await store.close();
		await start();
		const desktop = new PreferenceStorage(request);
		await desktop.initialize();
		expect(desktop.getItem(key)).toBeNull();
		await desktop.load(key);
		expect(desktop.getItem(key)).toBe(attachments);
		desktop.removeItem(key);
		await desktop.flush();
		await web.sync();
		expect(web.getItem(key)).toBeNull();
	});

	it("retains edits arriving during an in-flight save and ignores stale refresh responses", async () => {
		let finishSave: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			finishSave = resolve;
		});
		let blocked = false;
		const client = new PreferenceStorage(async <T>(path: string, init?: RequestInit): Promise<T> => {
			if (init?.method === "PATCH" && !blocked) {
				blocked = true;
				await gate;
			}
			return request<T>(path, init);
		});
		await client.initialize();
		client.setItem("pi-web-draft:session-1", "first");
		const saving = client.flush();
		client.setItem("pi-web-draft:session-1", "newer");
		finishSave!();
		await saving;
		expect(store.get("pi-web-draft:session-1")).toBe("newer");
		let finishRefresh: (() => void) | undefined;
		const refreshGate = new Promise<void>((resolve) => {
			finishRefresh = resolve;
		});
		const stale = new PreferenceStorage(async <T>(path: string, init?: RequestInit): Promise<T> => {
			const result = await request<T>(path, init);
			if (path.includes("since=")) await refreshGate;
			return result;
		});
		await stale.initialize();
		await store.patch({ entries: [{ key: "pi-web-draft:session-1", value: "remote" }] });
		const refreshing = stale.sync();
		stale.setItem("pi-web-draft:session-1", "typing");
		await stale.flush();
		finishRefresh!();
		await refreshing;
		expect(stale.getItem("pi-web-draft:session-1")).toBe("typing");
	});

	it("rejects credential keys, malformed layouts and oversized drafts before changing saved values", async () => {
		for (const [key, value] of [
			["auth.json", "secret"],
			["../../settings", "{}"],
			["pi-web-right-width", "null"],
			["pi-web-tabs:workspace", "{}"],
			["pi-web-draft:session", "a".repeat(1_000_001)],
		]) {
			await expect(
				request("/api/ui-preferences", { method: "PATCH", body: JSON.stringify({ entries: [{ key, value }] }) }),
			).rejects.toThrow("HTTP 400");
		}
		expect(store.snapshot().values).toEqual({});
	});
});
