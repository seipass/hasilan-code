import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { createHttpHost, sendJson } from "../src/server/http-host.ts";

it("retains edits and undo while releasing hidden editor views", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-editor-memory-"));
	const bundle = await build({
		stdin: {
			contents: `import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {FileEditor} from ${JSON.stringify(fileURLToPath(new URL("../src/client/files/FileEditor.tsx", import.meta.url)))};
function Fixture() { const [first,setFirst]=useState(true); return <><button onClick={()=>setFirst(!first)}>Switch</button><div hidden={!first}><FileEditor workspaceId="w" path="first.ts" visible={first}/></div><div hidden={first}><FileEditor workspaceId="w" path="second.ts" visible={!first}/></div></>; }
createRoot(document.getElementById('root')).render(<Fixture/>);`,
			loader: "tsx",
			resolveDir: process.cwd(),
		},
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
	});
	await writeFile(join(directory, "app.js"), bundle.outputFiles[0].text);
	await writeFile(
		join(directory, "index.html"),
		'<!doctype html><div id="root"></div><script src="/app.js"></script>',
	);
	const host = createHttpHost({
		port: 0,
		staticDir: directory,
		handleApi: (_request, response, url) => {
			if (!url.pathname.endsWith("/file-edit")) return false;
			sendJson(response, 200, { text: "const value = 1;", revision: "original" });
			return true;
		},
	});
	const browser = await chromium.launch({ headless: true });
	try {
		const launch = await host.listen();
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(launch.launchUrl);
		const first = page.getByRole("textbox", { name: "first.ts を編集" });
		await first.waitFor();
		await expect.poll(() => page.locator(".cm-editor").count()).toBe(1);
		await first.click();
		await page.keyboard.press("Control+End");
		await page.keyboard.type(" // retained edit");
		await page.getByRole("button", { name: "Switch", exact: true }).click();
		await page.getByRole("textbox", { name: "second.ts を編集" }).waitFor();
		await expect.poll(() => page.locator(".cm-editor").count()).toBe(1);
		await page.getByRole("button", { name: "Switch", exact: true }).click();
		await first.waitFor();
		expect(await first.textContent()).toContain("retained edit");
		await first.click();
		await page.keyboard.press("Control+z");
		expect(await first.textContent()).not.toContain("retained edit");
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
