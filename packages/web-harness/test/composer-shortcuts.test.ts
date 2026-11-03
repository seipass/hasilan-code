import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, it } from "vitest";

it.skipIf(!existsSync(chromium.executablePath()))(
	"sends the intended input mode without breaking newlines or pickers",
	async () => {
		const server = await createServer({
			configFile: false,
			root: fileURLToPath(new URL("..", import.meta.url)),
			plugins: [react()],
			server: { host: "127.0.0.1", port: 0, hmr: false },
			logLevel: "silent",
		});
		await server.listen();
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.route("**/api/ui-preferences**", (route) => route.fulfill({ json: {} }));
			await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/composer-shortcuts.html`);
			const input = page.getByRole("combobox", { name: "メッセージ" });
			const sent = page.getByTestId("sent");
			await input.fill("first");
			await input.press("Shift+Enter");
			await input.type("second");
			expect(await input.inputValue()).toBe("first\nsecond");
			await input.press("Control+Enter");
			expect(await sent.textContent()).toBe("[]");
			expect(await input.inputValue()).toBe("first\nsecond");
			await input.press("Enter");
			await expect.poll(() => sent.textContent()).toContain('"mode":"prompt"');
			await input.fill("/can");
			await input.press("Enter");
			expect(await input.inputValue()).toBe("/canvas");
			expect(JSON.parse((await sent.textContent())!).length).toBe(1);
			await input.press("Enter");
			await expect.poll(() => sent.textContent()).toContain('"text":"/canvas"');
			await input.fill("route");
			await input.press("Control+Shift+Enter");
			await expect.poll(() => sent.textContent()).toContain('"kind":"auto"');
			await input.press("Enter");
			await expect.poll(() => sent.textContent()).toContain('"kind":"new"');
			await page.getByRole("button", { name: "Toggle busy" }).click();
			expect(await page.getByLabel("追加指示の送信方法").count()).toBe(0);
			await input.fill("steer");
			await input.press("Enter");
			await expect.poll(() => sent.textContent()).toContain('"mode":"steer"');
			await input.fill("follow up");
			await input.press("Control+Enter");
			await expect.poll(() => sent.textContent()).toContain('"mode":"followUp"');
			await input.fill("button");
			await page.getByRole("button", { name: "送信", exact: true }).click();
			await expect.poll(() => sent.textContent()).toContain('"text":"button","mode":"steer"');
			await input.fill("composing");
			const count = JSON.parse((await sent.textContent())!).length;
			await input.evaluate((element) =>
				element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })),
			);
			expect(JSON.parse((await sent.textContent())!).length).toBe(count);
		} finally {
			await browser.close();
			await server.close();
		}
	},
	30_000,
);
