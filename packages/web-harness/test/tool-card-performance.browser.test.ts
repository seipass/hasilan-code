import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("defers unopened tool results and preserves the body after opening", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { createRoot } from "react-dom/client";
import { ToolInspector } from "./src/client/ToolInspector.tsx";
const tools = Array.from({ length: 20 }, (_, index) => ({
 key: "tool-" + index, callId: "call-" + index, sessionId: "session", name: "read", status: "success",
 input: { path: "file-" + index + ".ts" }, result: {
 details: { kind: "text", totalLines: 100 },
 content: [{ type: "text", text: Array.from({ length: 100 }, (_, line) => (line + 1) + ":const value = 123;").join("\\n") }],
 },
}));
createRoot(document.getElementById("root")).render(<ToolInspector tools={tools} onFile={() => {}} />);`,
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
		const page = await browser.newPage();
		await page.setContent('<div id="root"></div>');
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		await expect.poll(() => page.locator(".tool-card").count()).toBe(20);
		expect(await page.locator(".tool-read-line").count()).toBe(0);
		const card = page.locator(".tool-card").first();
		await card.locator(":scope > summary").click();
		await expect.poll(() => page.locator(".tool-read-line").count()).toBe(100);
		await card.locator(":scope > summary").click();
		// Keep nested accordions and translation state until the virtualized row unmounts.
		expect(await page.locator(".tool-read-line").count()).toBe(100);
		// Virtualized messages restore the native details state programmatically.
		await page
			.locator(".tool-card")
			.nth(1)
			.evaluate((element) => {
				(element as HTMLDetailsElement).open = true;
			});
		await expect.poll(() => page.locator(".tool-read-line").count()).toBe(200);
	} finally {
		await browser.close();
	}
}, 30000);
