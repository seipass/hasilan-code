import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("keeps thinking content during a reversible close, then releases it", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { createRoot } from "react-dom/client";
import { Conversation } from "./src/client/Conversation.tsx";
const messages = [{ messageId: "thinking", role: "assistant", partial: false, content: [{ type: "thinking", thinking: "First line\\n\\nSecond line\\n\\nThird line" }] }];
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
		const thinking = page.locator("details.thinking");
		await thinking.waitFor();
		const summary = thinking.locator("summary");
		expect(await thinking.locator("p").count()).toBe(0);
		await summary.click();
		await expect.poll(() => thinking.locator("p").count()).toBe(3);
		await expect
			.poll(() =>
				thinking.evaluate((element) => Number.parseFloat(getComputedStyle(element, "::details-content").height)),
			)
			.toBeGreaterThan(5);
		const beforeClose = await thinking.evaluate((element) =>
			Number.parseFloat(getComputedStyle(element, "::details-content").height),
		);
		await summary.click();
		expect(await thinking.locator("p").count()).toBe(3);
		const afterClose = await thinking.evaluate((element) =>
			Number.parseFloat(getComputedStyle(element, "::details-content").height),
		);
		expect(Math.abs(afterClose - beforeClose)).toBeLessThan(35);
		await summary.click();
		expect(await thinking.locator("p").count()).toBe(3);
		expect(await thinking.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
		await summary.click();
		await expect.poll(() => thinking.locator("p").count()).toBe(0);
		await page.emulateMedia({ reducedMotion: "reduce" });
		await summary.press("Enter");
		await expect.poll(() => thinking.locator("p").count()).toBe(3);
		await summary.press("Enter");
		await expect.poll(() => thinking.locator("p").count()).toBe(0);
	} finally {
		await browser.close();
	}
}, 30000);
