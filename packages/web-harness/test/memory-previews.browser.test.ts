import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("releases hidden images without losing zoom and keeps attachment originals intact", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreview } from "./src/client/files/ImagePreview.tsx";
import { ComposerAttachmentImage } from "./src/client/ComposerAttachmentImage.tsx";
const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 400;
const ctx = canvas.getContext("2d"); ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 800, 400);
const source = canvas.toDataURL("image/png");
function App() {
  const [visible, setVisible] = useState(true);
  const attachment = {id:"a", name:"image.png", mimeType:"image/png", size:1, data:source.split(",")[1]};
  return <><button onClick={() => setVisible(v => !v)}>Toggle</button><ImagePreview path="image.png" src={source} size={1} revision="1" visible={visible} /><ComposerAttachmentImage attachment={attachment} /><output id="original">{attachment.data.length}</output></>;
}
createRoot(document.getElementById("root")).render(<App />);`,
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
		const page = await browser.newPage();
		page.setDefaultTimeout(3000);
		await page.route("http://fixture.test/", (route) =>
			route.fulfill({
				contentType: "text/html",
				headers: {
					"Content-Security-Policy":
						"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
				},
				body: '<div id="root"></div>',
			}),
		);
		await page.goto("http://fixture.test/");
		await page.addStyleTag({
			content:
				".image-viewer-stage { height: 220px; overflow: hidden; } .image-viewer-image { max-width: 200px; max-height: 200px; }",
		});
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const viewer = page.locator(".image-viewer-image");
		const thumbnail = page.locator('img[alt="image.png"]').last();
		await expect.poll(() => viewer.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(800);
		await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(128);
		const originalLength = await page.locator("#original").textContent();
		await page.getByRole("button", { name: "拡大", exact: true }).click();
		await page.getByRole("button", { name: "透過" }).click();
		await page.getByRole("button", { name: "Toggle" }).click();
		await expect.poll(() => viewer.count()).toBe(0);
		await page.getByRole("button", { name: "Toggle" }).click();
		await expect.poll(() => viewer.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(800);
		expect(await page.getByRole("button", { name: "150%" }).count()).toBe(1);
		expect(await page.getByRole("button", { name: "透過" }).getAttribute("aria-pressed")).toBe("true");
		expect(await page.locator("#original").textContent()).toBe(originalLength);
	} finally {
		await browser.close();
	}
}, 30000);
