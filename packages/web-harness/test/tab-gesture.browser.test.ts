import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("keeps gesture hints inside the viewport and opens a file only after a directional release", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { createRoot } from "react-dom/client";
import { DetailPane } from "./src/client/DetailPane.tsx";
createRoot(document.getElementById("root")).render(<DetailPane workspaceId="test" refreshToken={0} visible view="tabs" onViewChange={() => {}} team={null} tools={null} />);`,
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
		const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
		await page.route("http://fixture.test/**", (route) =>
			route.fulfill(
				new URL(route.request().url()).pathname === "/"
					? { contentType: "text/html", body: '<div id="root"></div>' }
					: { json: [] },
			),
		);
		await page.goto("http://fixture.test/");
		const css = await readFile(new URL("../src/client/DetailPane.css", import.meta.url), "utf8");
		await page.addStyleTag({
			content: `:root { --glass-surface:#202020ee; --glass-filter:blur(24px); --surface:#141414; --surface-hover:#2a2a2a; --on-surface:#e8e8e8; --on-surface-muted:#929292; --on-surface-secondary:#b5b5b5; --border-strong:#ffffff29; --border-subtle:#ffffff0d; } body { background:#141414; font-family:Arial; } #root { margin-left:520px; height:500px; } ${css}`,
		});
		await page.addStyleTag({ content: ".detail-tab-add { position:fixed; right:12px; top:24px; }" });
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const button = page.getByRole("button", { name: "新しいタブを開く" });
		await expect.poll(() => page.locator(".detail-toolbar").getAttribute("inert")).toBeNull();
		const rect = await button.boundingBox();
		const x = rect!.x + rect!.width / 2;
		const y = rect!.y + rect!.height / 2;
		const before = await page.getByRole("tab").count();
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + 4, y);
		await expect.poll(() => page.locator(".detail-gesture-hints").isVisible()).toBe(true);
		const hint = await page.locator(".detail-gesture-hints").boundingBox();
		expect(hint!.x + hint!.width).toBeLessThanOrEqual(800);
		expect(await page.getByRole("tab").count()).toBe(before);
		await page.mouse.move(x + 28, y);
		expect(await page.locator('.detail-gesture-hint[data-active="true"]').getAttribute("data-part")).toBe("file");
		await expect
			.poll(async () => {
				const transform = await page.locator('[data-selection="head"]').getAttribute("transform");
				return Number(transform?.match(/translate\(([^ ]+)/)?.[1]);
			})
			.toBeGreaterThan(101);
		await page.mouse.move(x, y + 28);
		expect(await page.locator('.detail-gesture-hint[data-active="true"]').getAttribute("data-part")).toBe("terminal");
		await expect
			.poll(async () => {
				const transform = await page.locator('[data-selection="head"]').getAttribute("transform");
				return Number(transform?.match(/translate\([^ ]+ ([^)]+)/)?.[1]);
			})
			.toBeGreaterThan(101);
		await page.mouse.move(x + 28, y);
		await page.mouse.up();
		await expect.poll(() => page.getByRole("tab").count()).toBe(before + 1);
		expect(await page.locator(".detail-gesture-hints").count()).toBe(0);
	} finally {
		await browser.close();
	}
});
