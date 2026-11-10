import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("opens and closes the session import dialog continuously", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Presence } from "./src/client/Motion.tsx";
import { SessionImportDialog } from "./src/client/SessionImportDialog.tsx";
window.fetch = async () => new Response(JSON.stringify({ paths: [], warnings: [], candidates: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
function Fixture() {
 const [open, setOpen] = useState(false);
 window.openImport = () => setOpen(true);
 return <><button id="launch" onClick={() => setOpen(true)}>Open</button><Presence show={open}><div className="motion-contents"><SessionImportDialog workspace={{ workspaceId: "workspace", path: "C:/workspace" }} onClose={() => setOpen(false)} onImported={() => {}} onFile={() => {}} /></div></Presence></>;
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
	const css = ["styles.css", "Motion.css", "SessionImportDialog.css", "CleanAppearance.css", "NoMotion.css"]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ reducedMotion: "no-preference" });
		await page.setContent(`<style>${css}</style><div id="root"></div>`);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const result = await page.evaluate(async () => {
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			document.getElementById("launch")!.click();
			await frame();
			await frame();
			const dialog = document.querySelector<HTMLDialogElement>(".session-import-dialog")!;
			const opacity = () => Number.parseFloat(getComputedStyle(dialog).opacity);
			const opening: number[] = [];
			for (let index = 0; index < 4; index++) {
				await frame();
				opening.push(opacity());
			}
			const beforeClose = opacity();
			dialog.querySelector<HTMLElement>("[aria-label='セッション引き継ぎを閉じる']")!.click();
			await frame();
			const afterClose = opacity();
			(window as unknown as { openImport: () => void }).openImport();
			await frame();
			return { opening, beforeClose, afterClose, afterReopen: opacity(), open: dialog.open };
		});
		expect(result.opening.at(-1)).toBeGreaterThan(result.opening[0]);
		expect(Math.abs(result.afterClose - result.beforeClose), JSON.stringify(result)).toBeLessThan(0.3);
		expect(result.afterReopen, JSON.stringify(result)).toBeGreaterThan(0.02);
		expect(Math.abs(result.afterReopen - result.afterClose), JSON.stringify(result)).toBeLessThan(0.3);
		expect(result.open).toBe(true);
		await page.getByRole("button", { name: "セッション引き継ぎを閉じる" }).click();
		await expect.poll(() => page.locator(".session-import-dialog").count()).toBe(0);
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.locator("#launch").click();
		expect(
			await page
				.locator(".session-import-dialog")
				.evaluate((element) => getComputedStyle(element).transitionProperty),
		).toBe("none");
		await page.getByRole("button", { name: "セッション引き継ぎを閉じる" }).click();
		await expect.poll(() => page.locator(".session-import-dialog").count()).toBe(0);
	} finally {
		await browser.close();
	}
}, 30000);
