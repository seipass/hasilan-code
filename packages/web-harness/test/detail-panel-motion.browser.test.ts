import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("moves the detail panel and its boundary together and reverses continuously", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "./src/client/Conversation.tsx";
const messages = Array.from({ length: 80 }, (_, i) => ({ messageId: String(i), role: "assistant", content: "A message which wraps when the conversation width changes. ".repeat(4), partial: false }));
function Fixture() {
 const [open, setOpen] = useState(false);
 const desktop = window.innerWidth > 900;
 return <div className={"app-shell sidebar-closed " + (open ? "inspector-open" : "")}>
  <div className="workspace-surface"><header className="topbar"><button id="toggle" onClick={() => setOpen(!open)}>Detail</button></header>
   <div className="main-layout"><main className="chat-column"><section className="chat-pane has-messages"><Conversation messages={messages} tools={[]} onFile={() => {}} followRequest={0} /></section></main>
    <div className="detail-resize-slot"><div className="panel-resize" /></div>
    <aside className="right-panel" aria-hidden={!open} inert={!open} style={desktop ? { width: 620, marginRight: open ? 0 : -620 } : undefined}><div className="right-panel-body detail-panel-body">Detail content</div></aside>
   </div>
  </div>
 </div>;
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
	const css = [
		"styles.css",
		"Conversation.css",
		"GlassSurfaces.css",
		"CleanAppearance.css",
		"Mobile.css",
		"NoMotion.css",
	]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, reducedMotion: "no-preference" });
		await page.setContent(`<style>${css}</style><div id="root"></div>`);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		await page.locator(".virtual-message").first().waitFor();
		const sample = await page.evaluate(async () => {
			const toggle = document.getElementById("toggle")!;
			const panel = document.querySelector<HTMLElement>(".right-panel")!;
			const slot = document.querySelector<HTMLElement>(".detail-resize-slot")!;
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const initial = panel.getBoundingClientRect().left;
			toggle.click();
			const opening: number[] = [];
			let largestGap = 0;
			for (let index = 0; index < 8; index++) {
				await frame();
				const left = panel.getBoundingClientRect().left;
				opening.push(left);
				largestGap = Math.max(largestGap, Math.abs(slot.getBoundingClientRect().left - left));
			}
			const beforeClose = panel.getBoundingClientRect().left;
			toggle.click();
			await frame();
			return {
				initial,
				opening,
				largestGap,
				beforeClose,
				afterClose: panel.getBoundingClientRect().left,
				visibility: getComputedStyle(panel).visibility,
				boundaryVisibility: getComputedStyle(slot).visibility,
			};
		});
		expect(new Set(sample.opening.map(Math.round)).size).toBeGreaterThan(2);
		expect(sample.opening.at(-1)).toBeLessThan(sample.initial);
		expect(sample.largestGap).toBeLessThan(1);
		expect(Math.abs(sample.afterClose - sample.beforeClose), JSON.stringify(sample)).toBeLessThan(65);
		expect(sample.visibility).toBe("visible");
		expect(sample.boundaryVisibility).toBe("visible");
		await page.emulateMedia({ reducedMotion: "reduce" });
		expect(
			await page.locator(".right-panel").evaluate((element) => getComputedStyle(element).transitionProperty),
		).toBe("none");
		const mobile = await browser.newPage({ viewport: { width: 600, height: 900 }, reducedMotion: "no-preference" });
		try {
			await mobile.setContent(`<style>${css}</style><div id="root"></div>`);
			await mobile.addScriptTag({ content: bundle.outputFiles[0].text });
			const positions = await mobile.evaluate(async () => {
				const panel = document.querySelector<HTMLElement>(".right-panel")!;
				document.getElementById("toggle")!.click();
				const values: number[] = [];
				for (let index = 0; index < 8; index++) {
					await new Promise(requestAnimationFrame);
					values.push(panel.getBoundingClientRect().left);
				}
				return values;
			});
			expect(new Set(positions.map(Math.round)).size).toBeGreaterThan(2);
			expect(positions.at(-1)).toBeLessThan(positions[0]);
		} finally {
			await mobile.close();
		}
	} finally {
		await browser.close();
	}
}, 30000);
