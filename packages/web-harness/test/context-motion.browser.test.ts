import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("opens and reverses a context accordion continuously without moving its header", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { createRoot } from "react-dom/client";
import { Conversation } from "./src/client/Conversation.tsx";
const messages = [{
 messageId: "context", role: "toolResult", partial: false, content: "",
 contextInjection: { injectionId: "injection", content: "First line\\n\\nSecond line\\n\\nThird line", source: { type: "team_message", agentId: "agent", agentName: "Agent" } }
}, { messageId: "next", role: "assistant", partial: false, content: "Next message" }];
createRoot(document.getElementById("root")).render(<Conversation messages={messages} tools={[]} onFile={() => {}} followRequest={0} />);
`,
		},
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const css = ["styles.css", "Conversation.css", "CleanAppearance.css", "NoMotion.css"]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ reducedMotion: "no-preference" });
		await page.setContent(`<style>#root { display: flex; height: 600px; } ${css}</style><div id="root"></div>`);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const accordion = page.locator(".context-entry");
		await accordion.waitFor();
		const samples = await accordion.evaluate(async (element) => {
			const details = element as HTMLDetailsElement;
			const summary = details.querySelector("summary")!;
			const height = () => Number.parseFloat(getComputedStyle(details, "::details-content").height);
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const top = summary.getBoundingClientRect().top;
			details.open = true;
			const opening: number[] = [];
			for (let index = 0; index < 8; index++) {
				await frame();
				opening.push(height());
			}
			const beforeClose = height();
			details.open = false;
			await frame();
			const afterClose = height();
			for (let index = 0; index < 3; index++) await frame();
			const beforeReopen = height();
			details.open = true;
			await frame();
			const afterReopen = height();
			return {
				opening,
				beforeClose,
				afterClose,
				beforeReopen,
				afterReopen,
				headerDelta: summary.getBoundingClientRect().top - top,
			};
		});
		expect(new Set(samples.opening.map((value) => Math.round(value))).size).toBeGreaterThan(2);
		expect(samples.opening.at(-1)).toBeGreaterThan(samples.opening[0]);
		expect(Math.abs(samples.afterClose - samples.beforeClose), JSON.stringify(samples)).toBeLessThan(35);
		expect(Math.abs(samples.afterReopen - samples.beforeReopen), JSON.stringify(samples)).toBeLessThan(35);
		expect(Math.abs(samples.headerDelta)).toBeLessThan(1);
		await page.emulateMedia({ reducedMotion: "reduce" });
		expect(
			await accordion.evaluate((element) => getComputedStyle(element, "::details-content").transitionProperty),
		).toBe("none");
	} finally {
		await browser.close();
	}
}, 30000);
