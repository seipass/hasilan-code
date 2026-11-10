import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("opens and reverses the goal panel without moving the composer", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { createRoot } from "react-dom/client";
import { GoalPanel } from "./src/client/GoalPanel.tsx";
const goal = { id: "goal", objective: "First step\\nSecond step\\nThird step", status: "active", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
createRoot(document.getElementById("root")).render(<div className="composer-area"><GoalPanel goal={goal} busy={false} connected={true} unavailable={false} onAction={async () => {}} onDismiss={() => {}} /><div id="composer">Composer</div></div>);
`,
		},
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const css = ["styles.css", "GoalPanel.css", "NoMotion.css"]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ reducedMotion: "no-preference" });
		await page.setContent(
			`<style>${css} #root { height: 600px; display: flex; flex-direction: column; justify-content: flex-end; } .composer-area { position: static; } #composer { height: 80px; }</style><div id="root"></div>`,
		);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const panel = page.locator(".goal-panel");
		const samples = await panel.evaluate(async (element) => {
			const details = element as HTMLDetailsElement;
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const height = () => Number.parseFloat(getComputedStyle(details, "::details-content").height);
			const composer = document.getElementById("composer")!;
			const composerTop = composer.getBoundingClientRect().top;
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
			return {
				opening,
				beforeClose,
				afterClose,
				beforeReopen,
				afterReopen: height(),
				composerDelta: composer.getBoundingClientRect().top - composerTop,
			};
		});
		expect(new Set(samples.opening.map(Math.round)).size).toBeGreaterThan(2);
		expect(samples.opening.at(-1)).toBeGreaterThan(samples.opening[0]);
		expect(Math.abs(samples.afterClose - samples.beforeClose), JSON.stringify(samples)).toBeLessThan(35);
		expect(Math.abs(samples.afterReopen - samples.beforeReopen), JSON.stringify(samples)).toBeLessThan(35);
		expect(Math.abs(samples.composerDelta)).toBeLessThan(1);
		await page.emulateMedia({ reducedMotion: "reduce" });
		expect(await panel.evaluate((element) => getComputedStyle(element, "::details-content").transitionProperty)).toBe(
			"none",
		);
	} finally {
		await browser.close();
	}
}, 30000);
