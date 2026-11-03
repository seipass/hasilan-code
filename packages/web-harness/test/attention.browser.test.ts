import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, it } from "vitest";

// A background tab has no other completion signal, so the title must carry the run state.
it.skipIf(!existsSync(chromium.executablePath()))(
	"advertises running and settled sessions in the title",
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
			await page.goto(`${server.resolvedUrls!.local[0]}test/fixtures/attention.html`);
			await expect.poll(() => page.title()).toBe("(1) 実行中 · first");
			await expect.poll(() => page.getByTestId("favicon").textContent()).toContain("data:image/png");
			await page.getByRole("button", { name: "toggle first" }).click();
			await expect.poll(() => page.title()).toBe("(1) 完了 · first");
			await page.getByRole("button", { name: "toggle second" }).click();
			await expect.poll(() => page.title()).toBe("(1) 実行中 · first");
			await expect.poll(() => page.title()).toBe("(1) 実行中 · first");
		} finally {
			await browser.close();
			await server.close();
		}
	},
	30_000,
);
