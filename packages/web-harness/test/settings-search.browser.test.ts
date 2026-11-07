import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";

let browser: Browser;
let script: string;

beforeAll(async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "./src/client/SettingsDialog.tsx";
createRoot(document.getElementById("root")).render(<SettingsDialog onClose={() => {}} onSaved={() => {}} onHomeBackgroundChange={() => {}} />);`,
		},
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	script = bundle.outputFiles[0].text;
	browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
	await browser?.close();
});

it("shows the RustXNG warning and saves its endpoint without an API key", async () => {
	const page = await browser.newPage();
	page.setDefaultTimeout(5000);
	let search = {
		defaultProvider: "brave",
		rustxngUrl: "http://127.0.0.1:8888",
		configured: { brave: false, tavily: false, exa: false, firecrawl: false, rustxng: true },
	};
	let saved: unknown;
	try {
		await page.route("http://fixture.test/**", async (route) => {
			const url = new URL(route.request().url());
			if (url.pathname === "/") {
				await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
			} else if (url.pathname === "/api/models") {
				await route.fulfill({ json: { classifiers: [], models: [], providers: [] } });
			} else if (url.pathname === "/api/settings") {
				if (route.request().method() === "PATCH") {
					saved = route.request().postDataJSON();
					const patch = saved as { search: { defaultProvider: string; rustxngUrl: string } };
					search = { ...search, ...patch.search };
				}
				await route.fulfill({
					json: {
						search,
						translation: { language: "日本語" },
						teams: { maxConcurrentAgents: 4, maxDepth: 3 },
						jev: { configured: false },
					},
				});
			} else await route.abort();
		});
		await page.goto("http://fixture.test/");
		await page.addScriptTag({ content: script });
		await page.getByRole("tab", { name: "検索" }).click();
		await expect.poll(() => page.locator("body").innerText()).toContain("Web 検索");
		const section = page.locator('section[role="tabpanel"][id$="-search-panel"]');
		await section.getByRole("combobox", { name: "プロバイダー", exact: true }).click();
		await page.getByRole("option", { name: "RustXNG", exact: true }).click();
		await expect.poll(() => section.getByText(/IPアドレスが検索サイトから/).count()).toBe(1);
		await expect.poll(() => section.getByLabel("RustXNGの接続先URL").inputValue()).toBe("http://127.0.0.1:8888");
		await section.getByLabel("RustXNGの接続先URL").fill("http://127.0.0.1:9898");
		await section.getByRole("button", { name: "既定の検索サービスを保存" }).click();
		await expect
			.poll(() => saved)
			.toEqual({ search: { defaultProvider: "rustxng", rustxngUrl: "http://127.0.0.1:9898" } });
		await expect.poll(() => section.getByText(/現在の既定: RustXNG/).count()).toBe(1);
		expect(await section.getByLabel(/RustXNG.*キー/).count()).toBe(0);
	} finally {
		await page.close();
	}
}, 30000);
