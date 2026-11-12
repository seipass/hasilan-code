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

it("keeps the visible message stationary when scrolling away from live output and mounting older rows", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Conversation } from "./src/client/Conversation.tsx";
const replies = Array.from({ length: 40 }, (_, index) => ({
 messageId: "reply-" + index, role: "assistant", content: "Reply " + index,
}));
function Fixture() {
 const [stream, setStream] = useState("Streaming");
 useEffect(() => {
  const next = () => flushSync(() => setStream(text => text + " next"));
  window.addEventListener("stream-next", next);
  return () => window.removeEventListener("stream-next", next);
 }, []);
 return <Conversation messages={[...replies, { messageId: "live", role: "assistant", partial: true, content: stream }]}
  tools={[]} activeRunId="live-run" onFile={() => {}} followRequest={0} />;
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
		await page.setContent(`<style>
.conversation { height: 480px; overflow: auto; overflow-anchor: none; }
.virtual-message { display: flow-root; }
.message { margin: 0; min-height: 100px; }
[data-message-id="reply-28"] { height: 740px; }
.back-to-bottom { position: absolute; }
</style><div id="root"></div>`);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		await page.getByText("Streaming", { exact: true }).waitFor();
		await expect
			.poll(() => page.locator(".conversation").evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
			.toBe(0);
		const actual = await page.locator(".conversation").evaluate((element) => {
			const reply = element.querySelector('[data-message-id="reply-38"]')!;
			element.scrollTop -= 100;
			const beforeStream = reply.getBoundingClientRect().top;
			window.dispatchEvent(new Event("stream-next"));
			const afterStream = reply.getBoundingClientRect().top;
			let olderJump: number | undefined;
			for (let step = 0; step < 20; step++) {
				const visible = [...element.querySelectorAll(".virtual-message")].find(
					(row) => row.getBoundingClientRect().bottom > element.getBoundingClientRect().top + 110,
				)!;
				element.scrollTop -= 90;
				const expectedTop = visible.getBoundingClientRect().top;
				window.dispatchEvent(new Event("stream-next"));
				if (element.querySelector('[data-message-id="reply-28"]')) {
					olderJump = visible.getBoundingClientRect().top - expectedTop;
					break;
				}
			}
			return { streamJump: afterStream - beforeStream, olderJump };
		});
		expect(actual).toEqual({ streamJump: 0, olderJump: 0 });
	} finally {
		await browser.close();
	}
}, 30000);
