import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { appDirectory, provision } from "./provision.mjs";

const temporary = await mkdtemp(join(tmpdir(), "hasilan-browser-probe-"));
const owned = relative(await realpath(tmpdir()), await realpath(temporary));
if (!owned || owned === ".." || owned.startsWith(`..${sep}`)) throw new Error("Unsafe fixture directory");
const workspace = join(temporary, "workspace");
await mkdir(workspace);
const site = createServer((_request, response) => {
	response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	response.end(
		"<!doctype html><title>注釈テスト</title><h1 id='target'>選択する見出し</h1><p>ここはテスト用のページです。</p>",
	);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${site.address().port}/`;
const env = {
	...process.env,
	PI_OFFLINE: "1",
	HASILAN_CODE_AGENT_DIR: join(temporary, "agent"),
	HASILAN_CODE_DESKTOP_DATA_DIR: join(temporary, "desktop"),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
	app = await electron.launch({ executablePath: await provision(), args: [appDirectory], env, timeout: 60_000 });
	const page = await app.firstWindow();
	await page.waitForURL("http://127.0.0.1:*/", { timeout: 60_000 });
	await page.locator("#message").waitFor();
	await app.evaluate(({ dialog }, directory) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
	}, workspace);
	await page.getByRole("button", { name: "ワークスペースを追加" }).click();
	await page.locator('.workspace-accordion[data-selected="true"]').waitFor();
	const detail = page.getByRole("button", { name: "詳細", exact: true });
	if ((await detail.getAttribute("aria-expanded")) !== "true") await detail.click();
	await page.keyboard.press("Escape");
	await expect(detail).toHaveAttribute("aria-expanded", "true");
	await app.evaluate(({ shell }) => {
		globalThis.externalLinks = [];
		shell.openExternal = async (target) => {
			globalThis.externalLinks.push(target);
		};
	});
	await page.evaluate((address) => {
		const link = document.createElement("a");
		link.href = address;
		link.textContent = "テストリンク";
		Object.assign(link.style, { position: "fixed", left: "300px", top: "40px", zIndex: "2000" });
		document.body.append(link);
	}, url);
	await page.getByRole("link", { name: "テストリンク" }).click();
	await page.getByRole("button", { name: "システムブラウザ" }).click();
	await expect.poll(() => app.evaluate(() => globalThis.externalLinks.length)).toBe(1);
	assert.deepEqual(await app.evaluate(() => globalThis.externalLinks), [url]);
	await page.getByRole("link", { name: "テストリンク" }).click();
	await page.getByRole("button", { name: "内蔵ブラウザ" }).click();
	await expect(page.getByRole("textbox", { name: "アドレス" })).toHaveValue(url);
	await page.getByRole("button", { name: "ブラウザを閉じる" }).click();
	await page.getByRole("button", { name: "新しいタブを開く" }).click();
	await page.getByRole("button", { name: "ブラウザ", exact: true }).click();
	await page.getByRole("textbox", { name: "アドレス" }).fill(url);
	await page.getByRole("button", { name: "開く", exact: true }).click();
	await expect
		.poll(
			() =>
				app.evaluate(
					({ webContents }, address) =>
						webContents
							.getAllWebContents()
							.some((item) => item.getType() === "webview" && item.getURL() === address),
					url,
				),
			{ timeout: 15_000 },
		)
		.toBe(true);
	await page.getByRole("button", { name: "要素", exact: true }).click();
	const rect = await app.evaluate(async ({ webContents }) => {
		const guest = webContents.getAllWebContents().find((item) => item.getType() === "webview");
		return guest.executeJavaScript("document.querySelector('#target').getBoundingClientRect().toJSON()");
	});
	const view = await page.locator("webview").boundingBox();
	assert.ok(view);
	await page.mouse.click(view.x + rect.x + 10, view.y + rect.y + 10);
	await page.getByRole("textbox", { name: "注釈" }).fill("見出しを大きく");
	await page.getByRole("button", { name: "入力欄に追加" }).click();
	await expect(page.getByRole("list", { name: "ブラウザ注釈" })).toContainText("見出しを大きく");
	await page.getByRole("button", { name: "注釈 1 を削除" }).click();
	await expect(page.getByRole("list", { name: "ブラウザ注釈" })).toHaveCount(0);
	await page.getByRole("button", { name: "範囲", exact: true }).click();
	await page.mouse.move(view.x + 20, view.y + 20);
	await page.mouse.down();
	await page.mouse.move(view.x + 150, view.y + 90, { steps: 5 });
	await page.mouse.up();
	await page.getByRole("textbox", { name: "注釈" }).fill("範囲を変更");
	await page.getByRole("button", { name: "入力欄に追加" }).click();
	await expect(page.getByRole("list", { name: "ブラウザ注釈" })).toContainText("範囲を変更");
	await page.getByRole("button", { name: "テキスト", exact: true }).click();
	await page.mouse.move(view.x + rect.x + 4, view.y + rect.y + 10);
	await page.mouse.down();
	await page.mouse.move(view.x + rect.x + 110, view.y + rect.y + 10, { steps: 5 });
	await page.mouse.up();
	await page.getByRole("textbox", { name: "注釈" }).fill("文字を変更");
	await page.getByRole("button", { name: "入力欄に追加" }).click();
	await expect(page.getByRole("list", { name: "ブラウザ注釈" })).toContainText("文字を変更");
	await page.getByRole("tab", { name: "ファイルを選択" }).click();
	await page.getByRole("tab", { name: "ブラウザ" }).click();
	await expect(page.getByRole("textbox", { name: "アドレス" })).toHaveValue(url);
	console.log("Browser probe passed: navigation, selection, screenshot, annotation and removal.");
} finally {
	await app?.close();
	await new Promise((resolve) => {
		site.close(resolve);
		site.closeAllConnections();
	});
	await rm(temporary, { recursive: true, force: true });
}
