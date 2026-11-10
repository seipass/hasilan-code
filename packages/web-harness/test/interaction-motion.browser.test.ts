import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("animates interaction colors without moving controls and respects reduced motion", async () => {
	const css = readFileSync(fileURLToPath(new URL("../src/client/NoMotion.css", import.meta.url)), "utf8");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ reducedMotion: "no-preference" });
		await page.setContent(`<style>
			button { width: 120px; height: 36px; border: 1px solid black; background: rgb(0, 0, 0); color: white; }
			button:hover { background: rgb(200, 200, 200); color: black; }
			${css}
		</style><button>Action</button>`);
		const button = page.getByRole("button", { name: "Action" });
		const before = await button.boundingBox();
		await button.hover();
		await expect.poll(() => button.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0);
		expect(await button.boundingBox()).toEqual(before);
		await page.mouse.move(200, 100);
		expect(await button.boundingBox()).toEqual(before);
		await button.hover();
		expect(await button.boundingBox()).toEqual(before);
		await button.evaluate(async (element) => {
			await Promise.all(element.getAnimations().map((animation) => animation.finished));
		});
		expect(await button.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(200, 200, 200)");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.mouse.move(200, 100);
		await button.hover();
		expect(await button.evaluate((element) => getComputedStyle(element).transitionProperty)).toBe("none");
		expect(await button.evaluate((element) => element.getAnimations().length)).toBe(0);
		expect(await button.boundingBox()).toEqual(before);
	} finally {
		await browser.close();
	}
}, 30000);
