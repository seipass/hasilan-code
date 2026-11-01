import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { appDirectory, provision } from "./provision.mjs";

const temporary = await mkdtemp(join(tmpdir(), "hasilan-desktop-smoke-"));
const owned = relative(await realpath(tmpdir()), await realpath(temporary));
if (!owned || owned === ".." || owned.startsWith(`..${sep}`)) throw new Error("Unsafe smoke data directory");
const selected = join(temporary, "workspace");
await mkdir(selected);
const packagedIndex = process.argv.indexOf("--executable");
const executable = packagedIndex < 0 ? await provision() : resolve(process.argv[packagedIndex + 1]);
const env = {
	...process.env,
	PI_OFFLINE: "1",
	HASILAN_CODE_AGENT_DIR: join(temporary, "agent"),
	HASILAN_CODE_DESKTOP_DATA_DIR: join(temporary, "desktop"),
};
delete env.ELECTRON_RUN_AS_NODE;
let application;
let origin;
let feed;
try {
	application = await electron.launch({
		executablePath: executable,
		args: packagedIndex < 0 ? [appDirectory] : [],
		env,
		timeout: 60_000,
	});
	const page = await application.firstWindow();
	await page.waitForURL("http://127.0.0.1:*/", { timeout: 60_000 });
	origin = new URL(page.url()).origin;
	assert.equal(new URL(page.url()).search, "", "Launch credentials must be removed from the address");
	await page.locator("textarea#message").waitFor();
	if (process.platform !== "darwin") {
		assert.equal(
			await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()),
			false,
		);
		await page.keyboard.press("Alt");
		assert.equal(
			await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()),
			false,
			"Alt must not reveal a native menu bar",
		);
	}
	const checkChrome = async () => {
		const chrome = await page.evaluate(() => {
			const header = document.querySelector(".topbar");
			const titlebar = document.querySelector(".desktop-titlebar");
			const controls = document.querySelector(".desktop-window-controls");
			const details = document.querySelector(".topbar .quiet-button");
			const sidebarToggle = document.querySelector(".sidebar-toggle");
			const title = document.querySelector(".page-title");
			return {
				platform: document.documentElement.dataset.desktopPlatform,
				controls: controls?.getBoundingClientRect().toJSON(),
				buttons: controls
					? [...controls.children].map((button) => ({
							width: button.getBoundingClientRect().width,
							iconWidth: button.querySelector("svg").getBoundingClientRect().width,
						}))
					: [],
				header: header.getBoundingClientRect().toJSON(),
				titlebar: titlebar.getBoundingClientRect().toJSON(),
				details: details.getBoundingClientRect().toJSON(),
				sidebarToggle: sidebarToggle.getBoundingClientRect().toJSON(),
				title: title.getBoundingClientRect().toJSON(),
				background: getComputedStyle(titlebar).backgroundColor,
				text: titlebar.textContent.trim(),
				drag: getComputedStyle(titlebar).getPropertyValue("-webkit-app-region"),
				buttonDrag: controls && getComputedStyle(controls).getPropertyValue("-webkit-app-region"),
			};
		});
		assert.equal(chrome.platform, process.platform);
		assert.equal(chrome.titlebar.height, 35);
		assert.equal(chrome.header.top, chrome.titlebar.bottom);
		assert.ok(chrome.details.top >= chrome.titlebar.bottom);
		assert.ok(chrome.sidebarToggle.top >= chrome.titlebar.bottom);
		assert.ok(chrome.title.top >= chrome.titlebar.bottom);
		assert.equal(chrome.background, "rgba(0, 0, 0, 0)");
		assert.equal(chrome.text, "");
		assert.equal(chrome.drag, "drag");
		if (process.platform !== "darwin") {
			assert.equal(chrome.buttonDrag, "no-drag");
			assert.equal(chrome.controls.height, 35);
			assert.deepEqual(
				chrome.buttons,
				Array.from({ length: 3 }, () => ({ width: 46, iconWidth: 16 })),
			);
			assert.equal(chrome.controls.top, chrome.titlebar.top);
		}
	};
	await checkChrome();
	const backdropTop = await page.evaluate(() => {
		const backdrop = document.createElement("div");
		backdrop.className = "home-backdrop";
		document.querySelector(".workspace-surface").append(backdrop);
		const top = backdrop.getBoundingClientRect().top;
		backdrop.remove();
		return top;
	});
	assert.equal(backdropTop, 0, "Home background must extend behind the title bar");
	await page.locator(".sidebar-toggle").click();
	await expect(page.locator(".app-shell")).toHaveClass(/sidebar-closed/);
	await page.locator(".sidebar-toggle").click();
	await expect(page.locator(".app-shell")).toHaveClass(/sidebar-open/);
	const detailsToggle = page.getByRole("button", { name: "詳細", exact: true });
	const detailsClosed = await detailsToggle.boundingBox();
	await detailsToggle.click();
	const detailsOpen = await detailsToggle.boundingBox();
	assert.equal(detailsOpen.x, detailsClosed.x, "Detail button must stay in place when the panel opens");
	await checkChrome();
	if (process.platform !== "darwin") {
		const close = page.getByRole("button", { name: "ウィンドウを閉じる", exact: true });
		await close.hover();
		assert.equal(
			await close.evaluate((button) => getComputedStyle(button).backgroundColor),
			"rgba(232, 17, 35, 0.9)",
		);
		const maximize = page.getByRole("button", { name: "最大化", exact: true });
		const maximizeIcon = await maximize.locator("path").getAttribute("d");
		await maximize.click();
		await expect
			.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()))
			.toBe(true);
		const restore = page.getByRole("button", { name: "元のサイズに戻す", exact: true });
		await expect(restore).toBeVisible();
		assert.notEqual(await restore.locator("path").getAttribute("d"), maximizeIcon);
		await checkChrome();
		await restore.click();
		await expect
			.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()))
			.toBe(false);
		await expect(maximize).toBeVisible();
		await checkChrome();
		await page.getByRole("button", { name: "最小化", exact: true }).click();
		await expect
			.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
			.toBe(true);
		await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0];
			window.restore();
			window.show();
			window.focus();
		});
	}
	assert.equal(await page.evaluate(() => typeof window.require), "undefined");
	assert.equal((await fetch(`${origin}/api/workspaces`)).status, 401);
	await application.evaluate(({ dialog }, directory) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
	}, selected);
	const workspace = await page.evaluate(async () => {
		const response = await fetch("/api/workspaces/pick", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		if (!response.ok) throw new Error(`Picker failed ${response.status}`);
		return (await response.json()).workspace;
	});
	assert.equal(workspace.path, selected);
	if (packagedIndex >= 0) {
		// Exercise the real updater and menu against an isolated feed, without installing another binary.
		let available = false;
		let requests = 0;
		feed = createServer((_request, response) => {
			requests++;
			response.writeHead(200, { "Content-Type": "text/yaml" });
			response.end(
				`version: ${available ? "999.0.0" : "0.0.1"}\nfiles:\n  - url: preview.exe\n    sha512: ${Buffer.alloc(64).toString("base64")}\n    size: 1\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`,
			);
		});
		await new Promise((resolve) => feed.listen(0, "127.0.0.1", resolve));
		const port = feed.address().port;
		await application.evaluate(({ app, dialog }, url) => {
			const require = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
			const updater = require("electron-updater").autoUpdater;
			updater.setFeedURL({ provider: "generic", url });
			globalThis.updatePrompts = [];
			dialog.showMessageBox = async (_window, options) => {
				globalThis.updatePrompts.push(options.message);
				return { response: 1, checkboxChecked: false };
			};
		}, `http://127.0.0.1:${port}/`);
		await application.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()
				.items[0].submenu.items.find((item) => item.label === "更新を確認…")
				.click(),
		);
		await expect
			.poll(() => application.evaluate(() => globalThis.updatePrompts.at(-1)))
			.toBe("最新のバージョンです。");
		available = true;
		await application.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()
				.items[0].submenu.items.find((item) => item.label === "更新を確認…")
				.click(),
		);
		await expect
			.poll(() => application.evaluate(() => globalThis.updatePrompts.at(-1)))
			.toMatch(/999\.0\.0をダウンロード/);
		assert.equal(requests, 2, "Declining an update must not download its installer");
		assert.equal(await page.evaluate(async () => (await fetch("/api/workspaces")).status), 200);
	}
	const terminal = await page.evaluate(async (workspaceId) => {
		const response = await fetch("/api/terminals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId, cols: 80, rows: 24 }),
		});
		if (!response.ok) throw new Error(`PTY failed ${response.status}: ${await response.text()}`);
		return response.json();
	}, workspace.workspaceId);
	assert.equal(terminal.status, "running");
	const output = await page.evaluate(
		async (terminalId) =>
			new Promise((resolve, reject) => {
				const socket = new WebSocket(
					`${location.origin.replace("http:", "ws:")}/api/terminals/${terminalId}/events`,
				);
				let text = "";
				const timer = setTimeout(() => {
					socket.close();
					reject(new Error("Terminal output timeout"));
				}, 15_000);
				socket.onmessage = ({ data }) => {
					const event = JSON.parse(data);
					if (event.type === "snapshot") {
						socket.send(JSON.stringify({ type: "ack", generation: event.generation, seq: event.seq }));
						socket.send(
							JSON.stringify({
								type: "input",
								generation: event.generation,
								data: "echo desktop-terminal-ok\r",
							}),
						);
					}
					if (event.type === "data") {
						text += event.data;
						socket.send(JSON.stringify({ type: "ack", generation: event.generation, seq: event.seq }));
					}
					if (text.includes("desktop-terminal-ok")) {
						clearTimeout(timer);
						socket.close();
						resolve(text);
					}
				};
				socket.onerror = () => {
					clearTimeout(timer);
					reject(new Error("Terminal WebSocket failed"));
				};
			}),
		terminal.terminalId,
	);
	assert.match(output, /desktop-terminal-ok/);
	if (process.platform !== "darwin")
		await page.getByRole("button", { name: "ウィンドウを閉じる", exact: true }).click();
	else await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
	await expect
		.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
		.toBe(false);
	assert.equal(
		await page.evaluate(async () => (await fetch("/api/workspaces")).status),
		200,
		"Host must continue while window is hidden",
	);
	await application.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()
			.items[0].submenu.items.find((item) => item.label === "ウィンドウを表示")
			.click(),
	);
	await application.evaluate(({ dialog }) => {
		globalThis.quitPrompts = [];
		dialog.showMessageBox = async (_window, options) => {
			globalThis.quitPrompts.push(options);
			return { response: 0, checkboxChecked: false };
		};
	});
	await application.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()
			.items[0].submenu.items.find((item) => item.label === "終了")
			.click(),
	);
	await expect.poll(() => application.evaluate(() => globalThis.quitPrompts.length)).toBe(1);
	const prompt = await application.evaluate(() => globalThis.quitPrompts[0].message);
	assert.match(prompt, /端末 1件/);
	assert.equal(
		await page.evaluate(async () => (await fetch("/api/workspaces")).status),
		200,
		"Cancelling quit must preserve the host",
	);
	const screenshots = resolve(appDirectory, "../../.artifacts/desktop");
	await mkdir(screenshots, { recursive: true });
	await page.screenshot({
		path: join(screenshots, packagedIndex < 0 ? "smoke-development.png" : "smoke-packaged.png"),
	});
	await application.evaluate(({ dialog }) => {
		dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
	});
	const closed = application.waitForEvent("close");
	await application.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()
			.items[0].submenu.items.find((item) => item.label === "終了")
			.click(),
	);
	await closed;
	application = undefined;
	await assert.rejects(fetch(`${origin}/api/workspaces`, { signal: AbortSignal.timeout(2000) }));
	assert.equal(
		(await readFile(join(temporary, "agent/web-harness/state.json"), "utf8")).includes(
			selected.replaceAll("\\", "\\\\"),
		),
		true,
	);
	console.log(
		"Desktop smoke passed: title bar and window controls, hidden menu, authenticated UI, native folder IPC, PTY/WebSocket, background lifetime, quit cancellation and shutdown.",
	);
} finally {
	await application?.close();
	if (feed)
		await new Promise((resolve) => {
			feed.close(resolve);
			feed.closeAllConnections();
		});
	await rm(temporary, { recursive: true, force: true });
}
