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
import { FileEditor } from "./src/client/files/FileEditor.tsx";
import { ModelPicker } from "./src/client/ModelPicker.tsx";
createRoot(document.getElementById("root")).render(<><FileEditor workspaceId="w" path="a.txt" /><ModelPicker compact catalog={{ providers: [{ id: "p", name: "Provider", configured: true }], models: [{ provider: "p", id: "m", name: "Model" }] }} onChange={() => {}} /></>);`,
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
			return route.fulfill({ json: { text: "first\r\n", revision: "a".repeat(64) } });
		});
		await page.goto("http://fixture.test/");
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const editor = page.getByRole("textbox", { name: "a.txt を編集" });
		await editor.fill("second\n");
		await editor.press("Control+s");
		await expect.poll(() => saved).toEqual({ revision: "a".repeat(64), text: "second\r\n" });
		await expect.poll(() => page.getByText("保存済み").count()).toBe(1);
		await page.getByRole("button", { name: "▾ Provider" }).click();
		await expect.poll(() => page.getByRole("option", { name: "Model" }).count()).toBe(0);
		await page.getByRole("button", { name: "▸ Provider" }).click();
		await expect.poll(() => page.getByRole("option", { name: "Model" }).count()).toBe(1);
	} finally {
		await browser.close();
	}
}, 30000);
