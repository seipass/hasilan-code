import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("fades settings in and out without moving the underlying page and always closes", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "./src/client/SettingsDialog.tsx";
function Fixture() {
 const [open, setOpen] = useState(false);
 return <><button onClick={() => setOpen(true)}>Open settings</button><div id="anchor">Page</div>
 {open && <SettingsDialog onClose={() => setOpen(false)} onSaved={() => {}} onHomeBackgroundChange={() => {}} />}</>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`,
		},
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const css = ["styles.css", "Motion.css", "SettingsMotion.css", "CleanAppearance.css", "NoMotion.css"]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ reducedMotion: "no-preference" });
		await page.route("http://fixture.test/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/")
				await route.fulfill({ contentType: "text/html", body: `<style>${css}</style><div id="root"></div>` });
			else if (path === "/api/models") await route.fulfill({ json: { providers: [], models: [], classifiers: [] } });
			else if (path === "/api/settings")
				await route.fulfill({
					json: {
						translation: { language: "日本語" },
						search: { defaultProvider: "brave", configured: {}, rustxngUrl: "" },
						teams: { maxConcurrentAgents: 4, maxDepth: 2 },
						jev: { configured: false },
					},
				});
			else await route.abort();
		});
		await page.goto("http://fixture.test/");
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const anchor = page.locator("#anchor");
		const position = await anchor.boundingBox();
		await page.getByRole("button", { name: "Open settings" }).click();
		const dialog = page.getByRole("dialog", { name: "設定" });
		await dialog.waitFor();
		await expect.poll(() => dialog.evaluate((node) => node.getAnimations().length)).toBeGreaterThan(0);
		expect(await anchor.boundingBox()).toEqual(position);
		await dialog.evaluate(async (node) => {
			await Promise.all(node.getAnimations().map((animation) => animation.finished));
		});
		await dialog.getByRole("heading", { name: "プロバイダーの認証" }).waitFor();
		const tabs = dialog.getByRole("tablist");
		const tabPosition = await tabs.boundingBox();
		await dialog.getByRole("tab", { name: "検索" }).click();
		const searchPanel = dialog.locator('section[role="tabpanel"][id$="-search-panel"]');
		await searchPanel.waitFor();
		await expect.poll(() => searchPanel.evaluate((node) => node.getAnimations().length)).toBeGreaterThan(0);
		expect(await tabs.boundingBox()).toEqual(tabPosition);
		await dialog.getByRole("tab", { name: "プロバイダー" }).click();
		await dialog.getByRole("heading", { name: "プロバイダーの認証" }).waitFor();
		await dialog.getByRole("button", { name: "設定を閉じる" }).click();
		await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
		expect(await anchor.boundingBox()).toEqual(position);

		const interrupted = await page.evaluate(async () => {
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			document.querySelector<HTMLButtonElement>("#root > button")!.click();
			for (let index = 0; index < 4; index++) await frame();
			const dialog = document.querySelector<HTMLElement>(".settings-dialog")!;
			const before = Number(getComputedStyle(dialog).opacity);
			dialog.querySelector<HTMLButtonElement>('[aria-label="設定を閉じる"]')!.click();
			await frame();
			const after = Number(getComputedStyle(dialog).opacity);
			return { before, after };
		});
		expect(interrupted.before).toBeGreaterThan(0);
		expect(Math.abs(interrupted.after - interrupted.before)).toBeLessThan(0.35);
		await expect.poll(() => page.getByRole("dialog").count()).toBe(0);

		// Even if CSS transitions are disabled after startup, the dialog must not get stuck.
		await page.addStyleTag({ content: ".settings-dialog.settings-dialog { transition: none !important; }" });
		await page.getByRole("button", { name: "Open settings" }).click();
		await page.getByRole("button", { name: "設定を閉じる" }).click();
		await expect.poll(() => page.getByRole("dialog").count()).toBe(0);

		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.getByRole("button", { name: "Open settings" }).click();
		await page.getByRole("heading", { name: "プロバイダーの認証" }).waitFor();
		await page.getByRole("tab", { name: "検索" }).click();
		expect(await searchPanel.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
		await page.getByRole("button", { name: "設定を閉じる" }).click();
		await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
	} finally {
		await browser.close();
	}
}, 30000);
