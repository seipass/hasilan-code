import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("selects with keyboard and search inside a native modal without native select controls", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Select } from "./src/client/Select.tsx";
function Fixture() {
 const [value, setValue] = useState("0");
 const dialog = useRef(null);
 useEffect(() => dialog.current.showModal(), []);
 return <dialog ref={dialog} style={{width:400, height:240, overflow:"hidden", backdropFilter:"blur(24px)"}}><label>モデル<Select value={value} onChange={setValue}><optgroup label="Models">{Array.from({length:30}, (_, i) => <option key={i} value={String(i)} disabled={i===1}>Model {i}</option>)}</optgroup></Select></label><fieldset disabled><label>無効<Select value="a" onChange={() => {}}><option value="a">Disabled</option></Select></label></fieldset><output>{value}</output><button>次へ</button></dialog>;
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
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
		await page.setContent('<div id="root"></div>');
		await page.addStyleTag({ content: await readFile(new URL("../src/client/Select.css", import.meta.url), "utf8") });
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const trigger = page.getByRole("combobox", { name: "モデル" });
		await trigger.press("ArrowDown");
		const search = page.getByRole("searchbox", { name: "選択肢を検索" });
		await search.press("ArrowDown");
		await search.press("Enter");
		await expect.poll(() => page.locator("output").textContent()).toBe("2");
		await trigger.click();
		await search.fill("Model 29");
		await page.getByRole("option", { name: "Model 29", exact: true }).click();
		await expect.poll(() => page.locator("output").textContent()).toBe("29");
		await trigger.click();
		const menu = page.locator(".select-menu");
		const rectangle = await menu.boundingBox();
		expect(rectangle!.x).toBeGreaterThanOrEqual(0);
		expect(rectangle!.y + rectangle!.height).toBeLessThanOrEqual(600);
		await search.press("Escape");
		expect(await trigger.getAttribute("aria-expanded")).toBe("false");
		expect(await page.getByRole("combobox", { name: "無効" }).isDisabled()).toBe(true);
		expect(await page.locator("select").count()).toBe(0);
	} finally {
		await browser.close();
	}
});
