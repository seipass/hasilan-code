import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("moves workspace rows continuously and keeps the new conversation button independent", async () => {
	const css = ["styles.css", "CleanAppearance.css", "NoMotion.css"]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ reducedMotion: "no-preference" });
		await page.setContent(`<style>${css}</style><nav class="history-navigation" style="width: 300px; height: 500px">
			<details class="workspace-accordion"><summary>Workspace <button class="workspace-new-conversation" aria-label="新しい会話">+</button></summary>
				<ul class="session-list"><li>One</li><li>Two</li><li>Three</li><li>Four</li></ul>
			</details>
			<details class="workspace-accordion"><summary>Next workspace</summary></details>
		</nav>`);
		await page.evaluate(() => {
			const summary = document.querySelector<HTMLElement>(".workspace-accordion > summary")!;
			const details = summary.parentElement as HTMLDetailsElement;
			summary.addEventListener("click", (event) => {
				event.preventDefault();
				details.open = !details.open;
			});
			summary.querySelector("button")!.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
			});
		});
		const first = page.locator(".workspace-accordion").first();
		await first.locator("button").click({ force: true });
		expect(await first.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
		const samples = await first.evaluate(async (element) => {
			const details = element as HTMLDetailsElement;
			const next = details.nextElementSibling!;
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const nextTop = () => next.getBoundingClientRect().top;
			const opening: number[] = [];
			details.open = true;
			for (let index = 0; index < 8; index++) {
				await frame();
				opening.push(nextTop());
			}
			const beforeClose = nextTop();
			details.open = false;
			await frame();
			const afterClose = nextTop();
			for (let index = 0; index < 3; index++) await frame();
			const beforeReopen = nextTop();
			details.open = true;
			await frame();
			return { opening, beforeClose, afterClose, beforeReopen, afterReopen: nextTop() };
		});
		expect(new Set(samples.opening.map((value) => Math.round(value))).size).toBeGreaterThan(2);
		expect(samples.opening.at(-1)).toBeGreaterThan(samples.opening[0]);
		expect(Math.abs(samples.afterClose - samples.beforeClose), JSON.stringify(samples)).toBeLessThan(25);
		expect(Math.abs(samples.afterReopen - samples.beforeReopen), JSON.stringify(samples)).toBeLessThan(25);
		await page.emulateMedia({ reducedMotion: "reduce" });
		expect(await first.evaluate((element) => getComputedStyle(element, "::details-content").transitionProperty)).toBe(
			"none",
		);
	} finally {
		await browser.close();
	}
}, 30000);
