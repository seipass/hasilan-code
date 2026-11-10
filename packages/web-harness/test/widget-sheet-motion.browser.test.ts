import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("opens from the widget button and reverses its visible shape", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MobileSheet } from "./src/client/MobileSheet.tsx";
function Fixture() {
 const [open, setOpen] = useState(false);
 const anchor = useRef(null);
 window.openSheet = () => setOpen(true);
 return <><button id="launch" ref={anchor} onClick={() => setOpen(true)}>Widget</button><MobileSheet open={open} side="top" title="Widget" className="widget-top-sheet" motionAnchor={anchor} style={{ "--widget-sheet-left": "300px", "--widget-sheet-top": "52px", "--widget-sheet-width": "420px" }} onClosing={() => setOpen(false)} onClose={() => setOpen(false)}><textarea aria-label="Memo" /></MobileSheet></>;
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
	const css = ["styles.css", "MobileSheet.css", "widgets/WidgetSpace.css", "NoMotion.css"]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, reducedMotion: "no-preference" });
		await page.setContent(
			`<style>${css} #launch { position: fixed; left: 330px; top: 12px; width: 48px; height: 32px; }</style><div id="root"></div>`,
		);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const result = await page.evaluate(async () => {
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			document.getElementById("launch")!.click();
			await frame();
			await frame();
			const sheet = document.querySelector<HTMLDialogElement>(".widget-top-sheet")!;
			const opacity = () => Number.parseFloat(getComputedStyle(sheet).opacity);
			const opening: number[] = [];
			for (let index = 0; index < 6; index++) {
				await frame();
				opening.push(opacity());
			}
			const hasShape = getComputedStyle(sheet).clipPath.startsWith("polygon(");
			const beforeClose = opacity();
			sheet.querySelector<HTMLElement>("[aria-label='Widgetを閉じる']")!.click();
			await frame();
			const afterClose = opacity();
			(window as unknown as { openSheet: () => void }).openSheet();
			await frame();
			return { opening, hasShape, beforeClose, afterClose, afterReopen: opacity(), open: sheet.open };
		});
		expect(new Set(result.opening.map((value) => Math.round(value * 100))).size).toBeGreaterThan(2);
		expect(result.opening.at(-1)).toBeGreaterThan(result.opening[0]);
		expect(result.hasShape).toBe(true);
		expect(Math.abs(result.afterClose - result.beforeClose), JSON.stringify(result)).toBeLessThan(0.35);
		expect(Math.abs(result.afterReopen - result.afterClose), JSON.stringify(result)).toBeLessThan(0.35);
		expect(result.open).toBe(true);
		await page.getByRole("textbox", { name: "Memo" }).fill("draft retained");
		expect(await page.getByRole("textbox", { name: "Memo" }).inputValue()).toBe("draft retained");
		await page.getByRole("button", { name: "Widgetを閉じる" }).click();
		await expect
			.poll(() => page.locator(".widget-top-sheet").evaluate((element) => getComputedStyle(element).display))
			.toBe("none");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.locator("#launch").click();
		expect(await page.locator(".widget-top-sheet").evaluate((element) => element.getAnimations().length)).toBe(0);
	} finally {
		await browser.close();
	}
}, 30000);
