import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it.each(["bottom", "right"])(
	"opens and reverses the %s sheet without jumping",
	async (side) => {
		const bundle = await build({
			stdin: {
				resolveDir: fileURLToPath(new URL("../", import.meta.url)),
				loader: "tsx",
				contents: `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MobileSheet } from "./src/client/MobileSheet.tsx";
function Fixture() {
 const [open, setOpen] = useState(false);
 window.openSheet = () => setOpen(true);
 return <><button id="launch" onClick={() => setOpen(true)}>Open</button><MobileSheet open={open} side="${side}" title="Sheet" onClosing={() => setOpen(false)} onClose={() => setOpen(false)}><div style={{height: "300px"}}>Content</div></MobileSheet></>;
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
		const css = ["styles.css", "MobileSheet.css", "NoMotion.css"]
			.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
			.join("\n");
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage({ viewport: { width: 400, height: 800 }, reducedMotion: "no-preference" });
			await page.setContent(`<style>${css}</style><div id="root"></div>`);
			await page.addScriptTag({ content: bundle.outputFiles[0].text });
			const result = await page.evaluate(
				async (axis) => {
					const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					const sheet = document.querySelector<HTMLDialogElement>(".mobile-sheet")!;
					const position = () =>
						axis === "top" ? sheet.getBoundingClientRect().top : sheet.getBoundingClientRect().left;
					document.getElementById("launch")!.click();
					await frame();
					await frame();
					const opening: number[] = [];
					for (let index = 0; index < 7; index++) {
						await frame();
						opening.push(position());
					}
					const beforeClose = position();
					sheet.querySelector<HTMLElement>("[aria-label='Sheetを閉じる']")!.click();
					await frame();
					const afterClose = position();
					(window as unknown as { openSheet: () => void }).openSheet();
					await frame();
					return { opening, beforeClose, afterClose, afterReopen: position(), open: sheet.open };
				},
				side === "bottom" ? "top" : "left",
			);
			expect(new Set(result.opening.map(Math.round)).size).toBeGreaterThan(2);
			expect(result.opening.at(-1)).toBeLessThan(result.opening[0]);
			expect(Math.abs(result.afterClose - result.beforeClose), JSON.stringify(result)).toBeLessThan(60);
			expect(Math.abs(result.afterReopen - result.afterClose), JSON.stringify(result)).toBeLessThan(60);
			expect(result.open).toBe(true);
			await page.getByRole("button", { name: "Sheetを閉じる" }).click();
			await expect
				.poll(() => page.locator(".mobile-sheet").evaluate((element) => (element as HTMLDialogElement).open))
				.toBe(false);
			await page.emulateMedia({ reducedMotion: "reduce" });
			await page.locator("#launch").click();
			expect(
				await page.locator(".mobile-sheet").evaluate((element) => getComputedStyle(element).transitionProperty),
			).toBe("none");
		} finally {
			await browser.close();
		}
	},
	30000,
);
