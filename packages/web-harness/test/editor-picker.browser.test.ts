import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("edits and saves a file and collapses model provider groups", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { createRoot } from "react-dom/client";
import { FilePreview } from "./src/client/files/FilePreview.tsx";
import { ModelPicker } from "./src/client/ModelPicker.tsx";
createRoot(document.getElementById("root")).render(<><FilePreview workspaceId="w" file={{path:"a.js",offset:1}} visible refreshKey="1" id="preview" onOpen={() => {}} onChange={() => {}} onTransformHandled={() => {}} /><FilePreview workspaceId="w" file={{path:"a.js",offset:1}} visible refreshKey="1" id="preview2" onOpen={() => {}} onChange={() => {}} onTransformHandled={() => {}} /><ModelPicker compact catalog={{ providers: [{ id: "p", name: "Provider", configured: true }], models: [{ provider: "p", id: "m", name: "Model" }] }} onChange={() => {}} /></>);`,
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
		let saved: unknown;
		await page.route("http://fixture.test/**", async (route) => {
			if (new URL(route.request().url()).pathname === "/")
				return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
			if (route.request().method() === "PUT") {
				saved = route.request().postDataJSON();
				return route.fulfill({ json: { revision: "b".repeat(64) } });
			}
			if (new URL(route.request().url()).pathname.endsWith("/file"))
				return route.fulfill({
					json: {
						path: "a.js",
						kind: "text",
						size: 26,
						revision: "a".repeat(64),
						lines: [{ number: 1, text: "const existingName = 1;" }],
					},
				});
			return route.fulfill({ json: { text: "const existingName = 1;\r\n", revision: "a".repeat(64) } });
		});
		await page.goto("http://fixture.test/");
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const editors = page.getByRole("textbox", { name: "a.js を編集" });
		const editor = editors.first();
		await expect.poll(() => editors.count()).toBe(2);
		expect(await page.getByRole("group", { name: "ソースの表示方法" }).count()).toBe(0);
		await expect
			.poll(() =>
				page
					.locator(".cm-line span")
					.evaluateAll((spans) =>
						spans.some(
							(span) => span.textContent === "const" && getComputedStyle(span).color === "rgb(203, 166, 247)",
						),
					),
			)
			.toBe(true);
		await editor.fill("const existingName = 1;\nex");
		await expect.poll(() => editors.last().innerText()).toContain("existingName = 1;");
		await editor.press("Control+End");
		await editor.press("Control+Space");
		await expect.poll(() => page.locator(".cm-tooltip-autocomplete").innerText()).toContain("existingName");
		await page
			.getByRole("option", { name: /existingName/ })
			.first()
			.click();
		await editor.press("Control+s");
		await expect
			.poll(() => saved)
			.toEqual({ revision: "a".repeat(64), text: "const existingName = 1;\r\nexistingName" });
		await expect.poll(() => page.getByText("保存済み").count()).toBe(2);
		await page.getByRole("button", { name: "▾ Provider" }).click();
		await expect.poll(() => page.getByRole("option", { name: "Model" }).count()).toBe(0);
		await page.getByRole("button", { name: "▸ Provider" }).click();
		await expect.poll(() => page.getByRole("option", { name: "Model" }).count()).toBe(1);
	} finally {
		await browser.close();
	}
}, 30000);
