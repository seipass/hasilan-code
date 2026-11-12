import { readFile } from "node:fs/promises";
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
import { ModelMenu } from "./src/client/ModelMenu.tsx";
const models = Array.from({ length: 1000 }, (_, index) => ({
 provider: index < 800 ? "fixture" : "other", id: "model-" + index,
 name: (index % 2 ? "Beta " : "Alpha ") + String(index).padStart(4, "0"), contextWindow: 10000,
 thinkingLevels: index === 2 ? ["low", "high"] : ["low", "medium", "high", "max"],
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
function MenuFixture() {
 const [value, setValue] = useState(catalog.models[0]);
 const [thinking, setThinking] = useState("medium");
 const [commits, setCommits] = useState(0);
 const [open, setOpen] = useState(false);
 return <><button className="model-trigger" onClick={() => setOpen(!open)}>モデル設定</button>
 {open && <ModelMenu catalog={catalog} value={value} thinkingLevel={thinking} disabled={false}
  onChange={async selection => { setValue(selection); setThinking("low"); }}
  onThinkingChange={async level => { setCommits(count => count + 1); setThinking(level); }}
  onSettings={() => {}} onClose={() => setOpen(false)} />}
 <output aria-label="Thinking writes">{commits}:{thinking}</output></>;
}
createRoot(document.getElementById("root")).render(document.body.dataset.menu ? <MenuFixture /> : <Fixture />);`,
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

it("switches between the effort slider and model list and saves once after dragging", async () => {
	const page = await browser.newPage({ viewport: { width: 1120, height: 740 } });
	try {
		await page.setContent(
			'<style>.model-trigger { position: absolute; right: 80px; bottom: 100px; } .model-picker-results { overflow: auto; }</style><body data-menu="true"><div id="root"></div></body>',
		);
		await page.addStyleTag({
			content: await readFile(new URL("../src/client/ModelMenu.css", import.meta.url), "utf8"),
		});
		await page.addScriptTag({ content: script });
		const trigger = page.getByRole("button", { name: "モデル設定" });
		await trigger.click();
		const dialog = page.getByRole("dialog", { name: "モデル・Thinking" });
		const slider = dialog.getByRole("slider", { name: "推論レベル" });
		const writes = page.getByLabel("Thinking writes");
		expect(await slider.getAttribute("aria-valuetext")).toBe("中");
		const bounds = await slider.boundingBox();
		if (!bounds) throw new Error("Missing effort slider");
		const y = bounds.y + bounds.height / 2;
		await page.mouse.move(bounds.x + bounds.width / 3, y);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width - 5, y, { steps: 5 });
		await expect.poll(() => slider.getAttribute("aria-valuetext")).toBe("最大");
		expect(await writes.textContent()).toBe("0:medium");
		await page.mouse.up();
		await expect.poll(() => writes.textContent()).toBe("1:max");
		await slider.press("ArrowLeft");
		await expect.poll(() => writes.textContent()).toBe("2:high");
		await dialog.getByRole("button", { name: "モデル一覧を開く" }).click();
		const search = dialog.getByRole("combobox", { name: "モデルを検索" });
		await search.fill("Alpha 0002");
		await search.press("Enter");
		await expect
			.poll(() => dialog.getByRole("button", { name: "モデル一覧を開く" }).textContent())
			.toContain("Alpha 0002");
		expect(await slider.getAttribute("max")).toBe("1");
		await slider.press("Escape");
		await dialog.waitFor({ state: "hidden" });
		expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
	} finally {
		await page.close();
	}
}, 30000);
