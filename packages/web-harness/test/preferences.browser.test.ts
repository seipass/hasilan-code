import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { EventHub } from "../src/server/events.ts";
import { createHttpHost, type HttpHost, sendJson } from "../src/server/http-host.ts";
import { UiPreferencesStore } from "../src/server/ui-preferences.ts";

let browser: Browser;
let directory: string;
let host: HttpHost;
let hub: EventHub;
let store: UiPreferencesStore;

async function start() {
	store = await UiPreferencesStore.open(directory);
	hub = new EventHub(() => ({ sessions: [], teams: { teams: [], agents: [], runs: [] } }));
	host = createHttpHost({
		port: 0,
		staticDir: directory,
		handleWebSocket: (socket) => hub.attach(socket),
		handleApi: async (request, response, url) => {
			if (await store.handle(request, response, url)) return true;
			if (url.pathname === "/api/workspaces")
				sendJson(response, 200, [{ workspaceId: "workspace", path: directory }]);
			else if (url.pathname === "/api/models")
				sendJson(response, 200, {
					models: [{ provider: "fixture", id: "fixture", name: "Fixture model", contextWindow: 10000 }],
					providers: [{ id: "fixture", name: "Fixture", configured: true }],
				});
			else if (url.pathname === "/api/sessions" || url.pathname === "/api/terminals") sendJson(response, 200, []);
			else return false;
			return true;
		},
	});
	return host.listen();
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "hasilan-preferences-browser-"));
	const bundle = await build({
		entryPoints: [fileURLToPath(new URL("../src/client/main.tsx", import.meta.url))],
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	await writeFile(join(directory, "app.js"), bundle.outputFiles[0].text);
	await writeFile(
		join(directory, "index.html"),
		'<!doctype html><div id="root"></div><script src="/app.js"></script>',
	);
	browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
	await browser?.close();
	hub?.close();
	await host?.close();
	await store?.close();
	if (directory) await rm(directory, { recursive: true, force: true });
});

it("boots the real UI after migration and restores text, attachments, background and model on another port", async () => {
	const first = await start();
	const web = await browser.newContext({ reducedMotion: "reduce" });
	const page = await web.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await web.addInitScript(() => {
		localStorage.setItem(
			"pi-web-model-selection",
			JSON.stringify({ model: { provider: "fixture", id: "fixture" }, thinkingLevel: "max" }),
		);
		localStorage.setItem("pi-web-draft:new:workspace", "移行した下書き");
		localStorage.setItem(
			"hasilan-home-background",
			JSON.stringify({
				name: "background.png",
				image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
			}),
		);
	});
	await page.goto(first.launchUrl);
	await page.locator("textarea#message").waitFor();
	await expect.poll(() => page.locator("textarea#message").inputValue()).toBe("移行した下書き");
	await page.locator("textarea#message").fill("共有する下書き");
	const input = page.locator('input[type="file"][multiple]');
	await expect.poll(() => input.isEnabled()).toBe(true);
	await input.setInputFiles({ name: "remove.txt", mimeType: "text/plain", buffer: Buffer.from("abc") });
	await page.getByRole("button", { name: "remove.txtを取り外す" }).click();
	await expect.poll(() => page.locator(".composer-attachment").count()).toBe(0);
	await input.setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("keep") });
	await expect.poll(() => page.locator(".composer-attachment").count()).toBe(1);
	await page.evaluate(() => window.hasilanFlushPreferences?.());
	await web.close();
	hub.close();
	await host.close();
	await store.close();
	const second = await start();
	expect(second.origin).not.toBe(first.origin);
	const desktop = await browser.newContext({ reducedMotion: "reduce" });
	const restored = await desktop.newPage();
	restored.on("pageerror", (error) => errors.push(error.message));
	await restored.goto(second.launchUrl);
	await expect.poll(() => restored.locator("textarea#message").inputValue()).toBe("共有する下書き");
	await expect.poll(() => restored.locator(".composer-attachment").textContent()).toContain("keep.txt");
	expect(await restored.locator(".composer-attachment").textContent()).not.toContain("remove.txt");
	expect(await restored.locator(".model-trigger").textContent()).toContain("Fixture model");
	expect(await restored.locator(".model-trigger").textContent()).toContain("max");
	expect(await restored.locator(".home-backdrop img").getAttribute("src")).toContain("data:image/png;base64,");
	expect(errors).toEqual([]);
	await desktop.close();
}, 30000);
