import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("opens a lazily rendered tool card smoothly, including the first opening", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { createRoot } from "react-dom/client";
import { ToolCard } from "./src/client/ToolInspector.tsx";
const tool = { key: "tool", sessionId: "session", callId: "call", name: "bash", status: "success", input: { command: "echo hello" }, result: { content: [{type: "text", text: "hello"}] } };
createRoot(document.getElementById("root")).render(<div className="conversation"><ToolCard tool={tool} onFile={() => {}} /></div>);
`,
		},
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const css = ["styles.css", "CleanAppearance.css", "NoMotion.css"]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ reducedMotion: "no-preference" });
		await page.setContent(`<style>${css}</style><div id="root"></div>`);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const card = page.locator(".tool-card");
		const samples = await card.evaluate(async (element) => {
			const details = element as HTMLDetailsElement;
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const heights: number[] = [];
			details.querySelector<HTMLElement>("summary")!.click();
			for (let index = 0; index < 12; index++) {
				await frame();
				heights.push(Number.parseFloat(getComputedStyle(details, "::details-content").height));
			}
			return heights;
		});
		expect(new Set(samples.map((value) => Math.round(value))).size).toBeGreaterThan(2);
		expect(samples.at(-1)).toBeGreaterThan(samples[0]);
		const reversal = await card.evaluate(async (element) => {
			const details = element as HTMLDetailsElement;
			const summary = details.querySelector<HTMLElement>("summary")!;
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const height = () => Number.parseFloat(getComputedStyle(details, "::details-content").height);
			const beforeClose = height();
			summary.click();
			await frame();
			const afterClose = height();
			for (let index = 0; index < 3; index++) await frame();
			const beforeReopen = height();
			summary.click();
			await frame();
			return { beforeClose, afterClose, beforeReopen, afterReopen: height() };
		});
		expect(Math.abs(reversal.afterClose - reversal.beforeClose), JSON.stringify(reversal)).toBeLessThan(35);
		expect(Math.abs(reversal.afterReopen - reversal.beforeReopen), JSON.stringify(reversal)).toBeLessThan(35);
		await expect.poll(() => card.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
		await page.emulateMedia({ reducedMotion: "reduce" });
		expect(await card.evaluate((element) => getComputedStyle(element, "::details-content").transitionProperty)).toBe(
			"none",
		);
	} finally {
		await browser.close();
	}
}, 30000);
