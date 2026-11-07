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
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelPicker } from "./src/client/ModelPicker.tsx";
const models = Array.from({ length: 1000 }, (_, index) => ({
 provider: index < 800 ? "fixture" : "other", id: "model-" + index,
 name: (index % 2 ? "Beta " : "Alpha ") + String(index).padStart(4, "0"), contextWindow: 10000,
}));
const catalog = { models, providers: [
 { id: "fixture", name: "Connected", configured: true },
 { id: "other", name: "Disconnected", configured: false },
] };
function Fixture() {
 const [value, setValue] = useState({ provider: "fixture", id: "model-0" });
 return <><ModelPicker catalog={catalog} compact={document.body.dataset.compact === "true"} value={value} onChange={setValue} />
 <output aria-label="Selected model">{value.id}</output></>;
}
createRoot(document.getElementById("root")).render(<Fixture />);`,
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

it.each([true, false])(
	"filters promptly without per-row layout measurement, compact=%s",
	async (compact) => {
		const page = await browser.newPage();
		page.setDefaultTimeout(5000);
		try {
			await page.setContent(
				`<style>.model-picker-results{position:relative;max-height:320px;overflow:auto;list-style:none;padding:0}.model-picker-option{height:32px;display:block;width:250px}</style><body data-compact="${compact}"><div id="root"></div></body>`,
			);
			const metrics = await page.evaluateHandle(() => {
				const metrics = { geometry: 0, animations: 0 };
				const bounds = Element.prototype.getBoundingClientRect;
				Element.prototype.getBoundingClientRect = function (this: Element) {
					if (this.closest(".model-picker-results")) metrics.geometry++;
					return bounds.call(this);
				};
				const rects = Element.prototype.getClientRects;
				Element.prototype.getClientRects = function (this: Element) {
					if (this.closest(".model-picker-results")) metrics.geometry++;
					return rects.call(this);
				};
				const animate = Element.prototype.animate;
				Element.prototype.animate = function (...args) {
					if (this.closest(".model-picker-results")) metrics.animations++;
					return animate.apply(this, args);
				};
				return metrics;
			});
			await page.addScriptTag({ content: script });
			const options = page.getByRole("listbox", { name: "モデル", exact: true }).getByRole("option");
			const count = page.locator('.model-picker-toolbar [role="status"]');
			await expect.poll(() => options.count()).toBe(compact ? 1000 : 20);
			await metrics.evaluate((value) => {
				value.geometry = 0;
				value.animations = 0;
			});
			const search = page.getByRole("combobox", { name: "モデルを検索", exact: true });
			await search.fill("Alpha");
			await expect.poll(() => options.filter({ hasText: /^Alpha/ }).count()).toBe(compact ? 500 : 20);
			if (!compact) await expect.poll(() => count.textContent()).toContain("500 件");
			const measured = await metrics.jsonValue();
			expect(measured.geometry).toBeLessThan(100);
			expect(measured.animations).toBeLessThanOrEqual(2);
			if (!compact) {
				await page.getByRole("button", { name: "次の20件" }).click();
				await expect.poll(() => options.first().locator("strong").textContent()).toBe("Alpha 0040");
				await page.getByLabel("接続済みのみ").check();
				await expect.poll(() => count.textContent()).toContain("400 件");
				await page.getByLabel("接続済みのみ").uncheck();
				await page.getByRole("combobox", { name: "プロバイダー", exact: true }).click();
				await page.getByRole("option", { name: "Disconnected · 未接続", exact: true }).click();
				await expect.poll(() => count.textContent()).toContain("100 件");
				await page.getByRole("combobox", { name: "プロバイダー", exact: true }).click();
				await page.getByRole("option", { name: "すべてのプロバイダー", exact: true }).click();
			}
			await search.fill("Alpha 000");
			await expect.poll(() => options.count()).toBe(5);
			await search.press("ArrowDown");
			await search.press("Enter");
			await expect.poll(() => page.getByLabel("Selected model").textContent()).toBe("model-2");
			await search.fill("missing-model");
			await expect.poll(() => options.count()).toBe(0);
			await search.press("Escape");
			await expect.poll(() => options.count()).toBe(compact ? 1000 : 20);
		} finally {
			await page.close();
		}
	},
	30000,
);
