import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("animates graph commands but yields immediately to the wheel", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { createRoot } from "react-dom/client";
import { TeamPane } from "./src/client/TeamPane.tsx";
const root = { agentId: "root", teamId: "team", sessionId: "session", name: "Root", role: "root" };
const children = Array.from({ length: 12 }, (_, i) => ({ agentId: "child-" + i, teamId: "team", sessionId: "child-session-" + i, parentAgentId: "root", name: "Child " + i, role: "worker" }));
createRoot(document.getElementById("root")).render(<div className="detail-auxiliary"><TeamPane snapshot={{ teams: [], agents: [root, ...children], runs: [] }} sessions={[]} selectedSessionId="session" onSelect={() => {}} onStop={() => {}} onFile={() => {}} /></div>);
`,
		},
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const css = ["styles.css", "TeamPane.css", "TeamGraphAppearance.css", "NoMotion.css"]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, reducedMotion: "no-preference" });
		await page.setContent(
			`<style>${css} .detail-auxiliary { position: relative; width: 1100px; height: 900px; }</style><div id="root"></div>`,
		);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		await page.locator(".team-graph-node").first().waitFor();
		await page.locator(".team-graph-controls > summary").click();
		const result = await page.evaluate(async () => {
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const canvas = document.querySelector<HTMLElement>(".team-graph-canvas")!;
			const viewport = document.querySelector<HTMLElement>(".team-graph-viewport")!;
			const zoom = () => new DOMMatrix(getComputedStyle(canvas).transform).a;
			document.querySelector<HTMLElement>("[aria-label='関係図を拡大']")!.click();
			const samples: number[] = [];
			for (let index = 0; index < 7; index++) {
				await frame();
				samples.push(zoom());
			}
			const beforeReverse = zoom();
			document.querySelector<HTMLElement>("[aria-label='関係図を縮小']")!.click();
			await frame();
			const afterReverse = zoom();
			viewport.dispatchEvent(
				new WheelEvent("wheel", { deltaY: -100, clientX: 300, clientY: 300, bubbles: true, cancelable: true }),
			);
			await frame();
			await frame();
			const afterWheel = zoom();
			for (let index = 0; index < 5; index++) await frame();
			return { samples, beforeReverse, afterReverse, afterWheel, settled: zoom() };
		});
		expect(new Set(result.samples.map((value) => Math.round(value * 1000))).size).toBeGreaterThan(2);
		expect(result.samples.at(-1)).toBeGreaterThan(result.samples[0]);
		expect(Math.abs(result.afterReverse - result.beforeReverse), JSON.stringify(result)).toBeLessThan(0.1);
		expect(Math.abs(result.afterWheel - result.settled)).toBeLessThan(0.001);
		await page.emulateMedia({ reducedMotion: "reduce" });
		const reduced = await page.evaluate(async () => {
			const canvas = document.querySelector<HTMLElement>(".team-graph-canvas")!;
			const zoom = () => new DOMMatrix(getComputedStyle(canvas).transform).a;
			document.querySelector<HTMLElement>("[aria-label='関係図を拡大']")!.click();
			await new Promise(requestAnimationFrame);
			await new Promise(requestAnimationFrame);
			const first = zoom();
			for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame);
			return { first, last: zoom() };
		});
		expect(Math.abs(reduced.first - reduced.last)).toBeLessThan(0.001);
	} finally {
		await browser.close();
	}
}, 30000);
