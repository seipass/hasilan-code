import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("opens active work, respects a manual close, and closes when work finishes", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "./src/client/Conversation.tsx";
import { preferences } from "./src/client/preferences.ts";
preferences.setItem("pi-web-beta-turn-activity", "true");
const onFile = () => {};
function Fixture() {
 const [active, setActive] = useState(true);
 const [count, setCount] = useState(1);
 const messages = [{ role: "assistant", messageId: "m1", runId: "r1", content: Array.from({length: count}, (_, i) => ({type: "thinking", thinking: "step " + i})) }];
 return <><button onClick={() => setCount(2)}>Add work</button><button onClick={() => setActive(value => !value)}>Toggle run</button>
 <Conversation messages={messages} tools={[]} activeRunId={active ? "r1" : undefined} onFile={onFile} followRequest={0} /></>;
}
createRoot(document.getElementById("root")).render(<Fixture />);`,
		},
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
	});
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.setContent('<div id="root"></div>');
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const activity = page.locator("details.turn-activity");
		await expect.poll(() => activity.getAttribute("open")).not.toBeNull();
		await activity.locator(":scope > summary").click();
		await expect.poll(() => activity.getAttribute("open")).toBeNull();
		await page.getByRole("button", { name: "Add work" }).click();
		await expect.poll(() => activity.getAttribute("open")).toBeNull();
		await activity.locator(":scope > summary").click();
		await expect.poll(() => activity.getAttribute("open")).not.toBeNull();
		await page.getByRole("button", { name: "Toggle run" }).click();
		await expect.poll(() => activity.getAttribute("open")).toBeNull();
		await page.getByRole("button", { name: "Toggle run" }).click();
		await expect.poll(() => activity.getAttribute("open")).not.toBeNull();
	} finally {
		await browser.close();
	}
}, 30000);
