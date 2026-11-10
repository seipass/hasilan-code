import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("moves the sidebar and workspace continuously when interrupted", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "./src/client/Conversation.tsx";
const messages = Array.from({ length: 80 }, (_, i) => ({ messageId: String(i), role: "assistant", content: "A message with enough content to wrap when the width changes. ".repeat(4), partial: false }));
function Fixture() {
 const [open, setOpen] = useState(true);
 return <div className={"app-shell " + (open ? "sidebar-open" : "sidebar-closed")}>
  <button className="sidebar-toggle" aria-label="履歴" onClick={() => setOpen(!open)} />
  <button className="navigation-scrim" onClick={() => setOpen(false)} />
  <aside className="sidebar" aria-hidden={!open} inert={!open}>Conversation history</aside>
  <div className="workspace-surface"><header className="topbar"><div className="topbar-leading"><span className="page-title">Conversation title</span></div></header>
   <main className="chat-column"><section className="chat-pane has-messages"><Conversation messages={messages} tools={[]} onFile={() => {}} followRequest={0} /></section></main>
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
		const result = await page.evaluate(async () => {
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const toggle = document.querySelector<HTMLElement>(".sidebar-toggle")!;
			const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
			const workspace = document.querySelector<HTMLElement>(".workspace-surface")!;
			const title = document.querySelector<HTMLElement>(".page-title")!;
			const initial = workspace.getBoundingClientRect().left;
			const initialTitle = title.getBoundingClientRect().left;
			toggle.click();
			const closing: number[] = [];
			const titlePositions: number[] = [];
			for (let index = 0; index < 8; index++) {
				await frame();
				closing.push(workspace.getBoundingClientRect().left);
				titlePositions.push(title.getBoundingClientRect().left);
			}
			const visibleWhileClosing = getComputedStyle(sidebar).visibility;
			const beforeReopen = workspace.getBoundingClientRect().left;
			toggle.click();
			await frame();
			return {
				initial,
				initialTitle,
				closing,
				titlePositions,
				visibleWhileClosing,
				beforeReopen,
				afterReopen: workspace.getBoundingClientRect().left,
			};
		});
		expect(new Set(result.closing.map(Math.round)).size).toBeGreaterThan(2);
		expect(result.closing.at(-1)).toBeLessThan(result.initial);
		expect(result.visibleWhileClosing).toBe("visible");
		expect(Math.abs(result.titlePositions[0] - result.initialTitle), JSON.stringify(result)).toBeLessThan(50);
		expect(Math.abs(result.afterReopen - result.beforeReopen), JSON.stringify(result)).toBeLessThan(45);
		for (let index = 1; index < result.titlePositions.length; index++)
			expect(Math.abs(result.titlePositions[index] - result.titlePositions[index - 1])).toBeLessThan(50);
		await page.emulateMedia({ reducedMotion: "reduce" });
		expect(await page.locator(".sidebar").evaluate((element) => getComputedStyle(element).transitionProperty)).toBe(
			"none",
		);
		await page.setViewportSize({ width: 600, height: 900 });
		await page.emulateMedia({ reducedMotion: "no-preference" });
		const mobile = await page.evaluate(async () => {
			const toggle = document.querySelector<HTMLElement>(".sidebar-toggle")!;
			const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
			const workspace = document.querySelector<HTMLElement>(".workspace-surface")!;
			const before = workspace.getBoundingClientRect().left;
			toggle.click();
			const positions: number[] = [];
			for (let index = 0; index < 8; index++) {
				await new Promise(requestAnimationFrame);
				positions.push(sidebar.getBoundingClientRect().left);
			}
			return { positions, workspaceDelta: workspace.getBoundingClientRect().left - before };
		});
		expect(new Set(mobile.positions.map(Math.round)).size).toBeGreaterThan(2);
		expect(Math.abs(mobile.workspaceDelta)).toBeLessThan(1);
	} finally {
		await browser.close();
	}
}, 30000);
