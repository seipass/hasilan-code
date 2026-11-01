import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appDirectory } from "../scripts/provision.mjs";

test("normal startup paints and shows its window without browser DevTools", { timeout: 20_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-desktop-launch-"));
	const endpoint = Promise.withResolvers();
	const env = {
		...process.env,
		PI_OFFLINE: "1",
		HASILAN_CODE_AGENT_DIR: join(directory, "agent"),
		HASILAN_CODE_DESKTOP_DATA_DIR: join(directory, "desktop"),
	};
	delete env.ELECTRON_RUN_AS_NODE;
	// Inspect only Node's main process. Attaching Chromium DevTools can trigger a paint and hide this bug.
	const child = spawn(process.execPath, [join(appDirectory, "scripts/start.mjs"), "--inspect=0"], {
		env,
		windowsHide: true,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let socket;
	let stderr = "";
	const exited = new Promise((resolve) => child.once("exit", resolve));
	const timeout = setTimeout(() => endpoint.reject(new Error("Electron main inspector did not start")), 10_000);
	child.stderr.on("data", (data) => {
		stderr += data.toString();
		const match = stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/);
		if (match) endpoint.resolve(match[1]);
	});
	child.once("error", endpoint.reject);
	child.once("exit", () => endpoint.reject(new Error("Desktop exited before startup inspection")));
	try {
		socket = new WebSocket(await endpoint.promise);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		const deadline = Date.now() + 10_000;
		let windows = [];
		for (let id = 1; Date.now() < deadline; id++) {
			const response = Promise.withResolvers();
			socket.onmessage = ({ data }) => {
				const value = JSON.parse(data);
				if (value.id === id) response.resolve(value.result);
			};
			socket.send(
				JSON.stringify({
					id,
					method: "Runtime.evaluate",
					params: {
						expression: `process.getBuiltinModule('node:module').createRequire(${JSON.stringify(join(appDirectory, "package.json"))})('electron').BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible() }))`,
						returnByValue: true,
					},
				}),
			);
			windows = (await response.promise).result.value;
			if (windows.length === 1 && windows[0].visible) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(windows.length, 1);
		assert.equal(windows[0].visible, true, "The window must appear without a DevTools-triggered paint");
	} finally {
		clearTimeout(timeout);
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(
				JSON.stringify({
					id: -1,
					method: "Runtime.evaluate",
					params: {
						expression: `process.getBuiltinModule('node:module').createRequire(${JSON.stringify(join(appDirectory, "package.json"))})('electron').app.exit(0)`,
					},
				}),
			);
		}
		socket?.close();
		let exitTimeout;
		await Promise.race([
			exited,
			new Promise((resolve) => {
				exitTimeout = setTimeout(resolve, 1000);
			}),
		]);
		clearTimeout(exitTimeout);
		if (child.pid && child.exitCode === null) {
			if (process.platform === "win32") {
				try {
					execFileSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
						windowsHide: true,
						stdio: "ignore",
					});
				} catch {
					/* It may already have exited. */
				}
			} else child.kill("SIGTERM");
		}
		await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
