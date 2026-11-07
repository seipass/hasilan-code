import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("does not render unchanged replies when a streaming message changes", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "./src/client/Conversation.tsx";
const replies = Array.from({ length: 100 }, (_, index) => ({
 messageId: "reply-" + index, role: "assistant", content: "Completed reply " + index,
 timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
}));
const tools = [];
const onFile = () => {};
function Fixture() {
 const [text, setText] = useState("Streaming");
 return <><button onClick={() => setText(value => value + " next")}>Stream</button>
 <Conversation messages={[...replies, { messageId: "live", role: "assistant", partial: true, content: text }]}
 tools={tools} onFile={onFile} followRequest={0} onEdit={() => {}}
 onRetry={messageId => { document.body.dataset.retry = messageId + ":" + text; }} /></>;
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
		const page = await browser.newPage();
		await page.setContent(
			'<style>.conversation{height:600px;overflow:auto}.message{min-height:100px}</style><div id="root"></div>',
		);
		const metrics = await page.evaluateHandle(() => {
			const metrics = { replies: 0 };
			const rendered = new Set<number>();
			const format = Date.prototype.toLocaleString;
			Date.prototype.toLocaleString = function (...args: Parameters<typeof format>) {
				if (rendered.has(this.getTime())) metrics.replies++;
				rendered.add(this.getTime());
				return format.apply(this, args);
			};
			return metrics;
		});
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		await page.getByText("Streaming", { exact: true }).waitFor();
		await expect.poll(() => page.locator(".message-meta").count()).toBeGreaterThan(1);
		await metrics.evaluate((value) => {
			value.replies = 0;
		});
		await page.getByRole("button", { name: "Stream", exact: true }).click();
		await page.getByText("Streaming next", { exact: true }).waitFor();
		expect((await metrics.jsonValue()).replies).toBe(0);
		await page.getByRole("button", { name: "最後の依頼を再送", exact: true }).click();
		expect(await page.locator("body").getAttribute("data-retry")).toBe("reply-99:Streaming next");
	} finally {
		await browser.close();
	}
}, 30000);
