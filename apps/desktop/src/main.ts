import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from "electron";
import { autoUpdater } from "electron-updater";
import { DesktopHost } from "./host.ts";
import { type DesktopWindowState, describeActivity, externalLink } from "./protocol.ts";

app.setName("Hasilan Code");
if (process.env.HASILAN_CODE_DESKTOP_DATA_DIR) {
	const directory = process.env.HASILAN_CODE_DESKTOP_DATA_DIR;
	if (!isAbsolute(directory)) throw new Error("HASILAN_CODE_DESKTOP_DATA_DIR must be absolute");
	mkdirSync(directory, { recursive: true });
	app.setPath("userData", directory);
	app.setPath("sessionData", directory);
}
if (!app.requestSingleInstanceLock()) app.quit();
else
	void app
		.whenReady()
		.then(start)
		.catch((error: unknown) => {
			dialog.showErrorBox(
				"Hasilan Codeを起動できませんでした",
				error instanceof Error ? error.message : "起動に失敗しました",
			);
			quitting = true;
			app.quit();
		});

let window: BrowserWindow;
let tray: Tray | undefined;
let host: DesktopHost | undefined;
let quitting = false;
let checkingQuit = false;
let starting = false;
let updateDownloaded = false;
let updateBusy = false;
let updateError = false;
const shellAssets = join(app.getAppPath(), "dist");
const fallbackPage = join(shellAssets, "startup.html");
const boundsPath = join(app.getPath("userData"), "window.json");

function showWindow(): void {
	if (!window || window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

async function status(message: string, failed = false): Promise<void> {
	await window.loadFile(fallbackPage, { query: { message, failed: String(failed) } });
}

async function launchHost(): Promise<void> {
	if (starting) return;
	starting = true;
	try {
		await flushPreferences();
		await status("ワークスペースを準備しています…");
		await host?.stop();
		host = new DesktopHost();
		host.on("crashed", () => {
			if (!starting && !quitting) void status("サーバーが終了しました。再起動して作業を再開できます。", true);
		});
		const root = app.isPackaged
			? join(process.resourcesPath, "harness/node_modules/hasilan-code")
			: resolve(app.getAppPath(), "../../packages/web-harness");
		const launchUrl = await host.start({
			executable: process.execPath,
			entry: join(root, "dist/server/desktop-host.js"),
			cwd: homedir(),
			pickFolder: async (cwd) => {
				showWindow();
				const result = await dialog.showOpenDialog(window, {
					title: "ワークスペースを選択",
					defaultPath: cwd,
					properties: ["openDirectory", "createDirectory"],
				});
				return result.canceled ? undefined : result.filePaths[0];
			},
		});
		if (!quitting) await window.loadURL(launchUrl);
	} catch (error) {
		if (!quitting) await status(error instanceof Error ? error.message : "サーバーを起動できませんでした。", true);
	} finally {
		starting = false;
	}
}

async function requestQuit(install = false): Promise<void> {
	if (checkingQuit || quitting) return;
	checkingQuit = true;
	try {
		if (host?.url) {
			try {
				const activity = await host.activity();
				if (activity.runs + activity.queued + activity.terminals > 0) {
					showWindow();
					const result = await dialog.showMessageBox(window, {
						type: "question",
						title: "作業を停止して終了しますか？",
						message: describeActivity(activity),
						buttons: ["作業を続ける", install ? "停止して更新" : "停止して終了"],
						defaultId: 0,
						cancelId: 0,
					});
					if (result.response !== 1) return;
				}
			} catch {
				const result = await dialog.showMessageBox(window, {
					type: "warning",
					message: "作業状態を確認できません。サーバーを停止して終了しますか？",
					buttons: ["戻る", "終了する"],
					defaultId: 0,
					cancelId: 0,
				});
				if (result.response !== 1) return;
			}
		}
		await flushPreferences();
		await host?.stop();
		quitting = true;
		if (install) autoUpdater.quitAndInstall(false, true);
		else app.quit();
	} catch (error) {
		dialog.showErrorBox(
			"終了を完了できませんでした",
			error instanceof Error ? error.message : "終了処理に失敗しました",
		);
	} finally {
		checkingQuit = false;
	}
}

async function flushPreferences(): Promise<void> {
	if (!window || window.isDestroyed() || !host?.origin || !window.webContents.getURL().startsWith(`${host.origin}/`))
		return;
	await window.webContents.executeJavaScript("window.hasilanFlushPreferences?.()");
}

async function checkUpdates(): Promise<void> {
	if (updateBusy) return;
	if (!app.isPackaged) {
		await dialog.showMessageBox(window, {
			message: "開発実行では更新しません。配布版ではアプリ全体を更新できます。",
		});
		return;
	}
	if (updateDownloaded) {
		await requestQuit(true);
		return;
	}
	updateBusy = true;
	updateError = false;
	try {
		const result = await autoUpdater.checkForUpdates();
		if (updateError || !result) return;
		if (!result.isUpdateAvailable) {
			await dialog.showMessageBox(window, { message: "最新のバージョンです。" });
			return;
		}
		const answer = await dialog.showMessageBox(window, {
			message: `Hasilan Code ${result.updateInfo.version}をダウンロードしますか？`,
			buttons: ["ダウンロード", "あとで"],
			defaultId: 0,
			cancelId: 1,
		});
		if (answer.response !== 0) return;
		await autoUpdater.downloadUpdate();
		updateDownloaded = true;
		const install = await dialog.showMessageBox(window, {
			message: "更新の準備ができました。再起動して適用しますか？",
			buttons: ["再起動して更新", "あとで"],
			defaultId: 1,
			cancelId: 1,
		});
		if (install.response === 0) await requestQuit(true);
	} catch {
		if (!updateError)
			await dialog.showMessageBox(window, {
				type: "warning",
				message:
					"更新を確認できませんでした。配布ファイルが未公開の場合や、ネットワークに接続できない場合があります。",
			});
	} finally {
		updateBusy = false;
	}
}

async function start(): Promise<void> {
	app.setAppUserModelId("dev.hasilan.code");
	let bounds = { width: 1360, height: 900, x: undefined as number | undefined, y: undefined as number | undefined };
	try {
		const stored = JSON.parse(readFileSync(boundsPath, "utf8")) as Record<string, unknown>;
		if (
			[stored.width, stored.height, stored.x, stored.y].every(
				(value) => typeof value === "number" && Number.isFinite(value),
			)
		) {
			const rectangle = {
				width: stored.width as number,
				height: stored.height as number,
				x: stored.x as number,
				y: stored.y as number,
			};
			if (
				rectangle.width >= 640 &&
				rectangle.height >= 480 &&
				screen
					.getAllDisplays()
					.some(
						({ workArea }) =>
							rectangle.x < workArea.x + workArea.width - 64 &&
							rectangle.x + rectangle.width > workArea.x + 64 &&
							rectangle.y >= workArea.y &&
							rectangle.y < workArea.y + workArea.height - 64,
					)
			)
				bounds = rectangle;
		}
	} catch {
		/* First launch uses the centered default. */
	}
	const icon = nativeImage.createFromPath(join(shellAssets, "icon.png"));
	window = new BrowserWindow({
		...bounds,
		minWidth: 640,
		minHeight: 480,
		show: false,
		title: "Hasilan Code",
		backgroundColor: "#1e1e2e",
		titleBarStyle: "hidden",
		titleBarOverlay: process.platform === "darwin" ? { height: 35 } : false,
		autoHideMenuBar: false,
		icon,
		webPreferences: {
			preload: join(shellAssets, "preload.cjs"),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webviewTag: true,
			partition: "persist:hasilan-desktop",
		},
	});
	window.once("ready-to-show", showWindow);
	const trustedWindowRequest = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => {
		if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
		try {
			const url = new URL(event.senderFrame.url);
			return (
				url.origin === host?.origin ||
				(url.protocol === "file:" && url.href.split("?")[0] === pathToFileURL(fallbackPage).href)
			);
		} catch {
			return false;
		}
	};
	const windowState = (): DesktopWindowState => ({
		maximized: window.isMaximized(),
		fullscreen: window.isFullScreen(),
		focused: window.isFocused(),
	});
	const publishWindowState = () => {
		if (!window.isDestroyed()) window.webContents.send("hasilan:window-state", windowState());
	};
	ipcMain.handle("hasilan:window-state", (event) => {
		if (!trustedWindowRequest(event)) throw new Error("Window request is unavailable");
		return windowState();
	});
	ipcMain.on("hasilan:window-action", (event, action: unknown) => {
		if (!trustedWindowRequest(event)) return;
		if (action === "minimize") window.minimize();
		else if (action === "toggle-maximize") {
			if (window.isMaximized()) window.unmaximize();
			else window.maximize();
		} else if (action === "close") window.close();
	});
	ipcMain.on("hasilan:open-external", (event, value: unknown) => {
		if (!trustedWindowRequest(event) || typeof value !== "string") return;
		const url = externalLink(value);
		if (url) void shell.openExternal(url);
	});
	window.on("maximize", publishWindowState);
	window.on("unmaximize", publishWindowState);
	window.on("enter-full-screen", publishWindowState);
	window.on("leave-full-screen", publishWindowState);
	window.on("focus", publishWindowState);
	window.on("blur", publishWindowState);
	window.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		if (tray) window.hide();
		else void requestQuit();
	});
	window.on("resize", saveBounds);
	window.on("move", saveBounds);
	let boundsTimer: ReturnType<typeof setTimeout> | undefined;
	function saveBounds(): void {
		clearTimeout(boundsTimer);
		boundsTimer = setTimeout(() => {
			if (window.isDestroyed() || window.isMaximized() || window.isMinimized()) return;
			try {
				writeFileSync(boundsPath, JSON.stringify(window.getBounds()));
			} catch {
				/* Window placement must not prevent normal use when the disk is unavailable. */
			}
		}, 250);
		boundsTimer.unref();
	}
	// The web UI puts run counts and the conversation name in document.title.
	window.on("page-title-updated", (event, title) => {
		event.preventDefault();
		const label = title.trim() || "Hasilan Code";
		window.setTitle(label);
		tray?.setToolTip(label);
		// The web UI prefixes "(n) 実行中" or "(n) 完了"; mirror that count on the dock/taskbar.
		const pending = /^\((\d+)\)/.exec(label)?.[1];
		app.setBadgeCount(pending ? Number(pending) : 0);
	});
	const navigate = (event: Electron.Event, url: string) => {
		try {
			if (host?.origin && new URL(url).origin === host.origin) return;
		} catch {
			/* Malformed links are blocked below. */
		}
		event.preventDefault();
		const external = externalLink(url);
		if (external) void shell.openExternal(external);
	};
	window.webContents.on("will-navigate", (event, url) => {
		if (url === "hasilan-desktop:retry") {
			event.preventDefault();
			void launchHost();
			return;
		}
		navigate(event, url);
	});
	window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
		if (!host?.origin || !window.webContents.getURL().startsWith(`${host.origin}/`) || params.src !== "about:blank") {
			event.preventDefault();
			return;
		}
		delete params.preload;
		params.partition = "persist:hasilan-browser";
		webPreferences.preload = join(shellAssets, "browser-preload.cjs");
		webPreferences.nodeIntegration = false;
		webPreferences.contextIsolation = true;
		webPreferences.sandbox = true;
		webPreferences.webSecurity = true;
		webPreferences.partition = "persist:hasilan-browser";
	});
	window.webContents.on("did-attach-webview", (_event, contents) => {
		contents.setWindowOpenHandler(({ url }) => {
			const target = externalLink(url);
			if (target && (target.startsWith("https:") || target.startsWith("http:"))) void contents.loadURL(target);
			return { action: "deny" };
		});
		contents.on("will-navigate", (event, url) => {
			const target = externalLink(url);
			if (!target || !(target.startsWith("https:") || target.startsWith("http:"))) event.preventDefault();
		});
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		const external = externalLink(url);
		if (external) void shell.openExternal(external);
		return { action: "deny" };
	});
	window.webContents.on("render-process-gone", () => {
		if (!quitting) void status("画面が終了しました。メニューから再読み込みできます。", true);
	});
	session.fromPartition("persist:hasilan-desktop").setPermissionRequestHandler((contents, permission, callback) => {
		callback(
			permission === "clipboard-sanitized-write" &&
				!!host?.origin &&
				contents.getURL().startsWith(`${host.origin}/`),
		);
	});
	session
		.fromPartition("persist:hasilan-browser")
		.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	const menu: Electron.MenuItemConstructorOptions[] = [
		{
			label: "Hasilan Code",
			submenu: [
				{ label: "ウィンドウを表示", click: showWindow },
				{
					label: "更新を確認…",
					click: () => {
						void checkUpdates();
					},
				},
				{ type: "separator" },
				{
					label: "終了",
					accelerator: "CmdOrCtrl+Q",
					click: () => {
						void requestQuit();
					},
				},
			],
		},
		{
			label: "編集",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "表示",
			submenu: [
				{
					label: "再読み込み",
					accelerator: "CmdOrCtrl+R",
					click: async () => {
						try {
							await flushPreferences();
							if (host?.url) await window.loadURL(host.url);
						} catch (error) {
							dialog.showErrorBox(
								"再読み込みできませんでした",
								error instanceof Error ? error.message : "設定を保存できませんでした",
							);
						}
					},
				},
				{
					label: "サーバーを再起動",
					click: async () => {
						const result = await dialog.showMessageBox(window, {
							message: "処理を停止してサーバーを再起動しますか？",
							buttons: ["戻る", "再起動"],
							defaultId: 0,
							cancelId: 0,
						});
						if (result.response === 1) await launchHost();
					},
				},
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ role: "togglefullscreen" },
				...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
	if (process.platform !== "darwin") window.setMenuBarVisibility(false);
	try {
		tray = new Tray(icon.resize({ width: 20, height: 20 }));
		tray.setToolTip("Hasilan Code — ウィンドウを閉じても作業を続けます");
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: "Hasilan Codeを開く", click: showWindow },
				{
					label: "更新を確認…",
					click: () => {
						void checkUpdates();
					},
				},
				{ type: "separator" },
				{ label: "表示", submenu: menu[2].submenu },
				{
					label: "終了",
					click: () => {
						void requestQuit();
					},
				},
			]),
		);
		tray.on("click", showWindow);
	} catch {
		tray = undefined;
	}
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;
	autoUpdater.logger = null;
	autoUpdater.on("error", () => {
		updateError = true;
		if (quitting) {
			quitting = false;
			showWindow();
			void status("更新を適用できませんでした。もう一度起動して作業を再開できます。", true);
		}
		void dialog.showMessageBox(window, {
			type: "warning",
			message: "更新を取得できませんでした。接続と配布状況を確認してください。",
		});
	});
	await launchHost();
}

app.on("second-instance", showWindow);
app.on("activate", showWindow);
app.on("window-all-closed", () => {
	/* The tray owns the host lifetime. */
});
app.on("before-quit", (event) => {
	if (!quitting) {
		event.preventDefault();
		void requestQuit();
	}
});
app.on("will-quit", () => tray?.destroy());

// Packaging errors fail explicitly before attempting to spawn a missing backend.
if (
	app.isPackaged &&
	!existsSync(join(process.resourcesPath, "harness/node_modules/hasilan-code/dist/server/desktop-host.js"))
) {
	dialog.showErrorBox("Hasilan Code", "サーバーファイルが見つかりません。アプリを再インストールしてください。");
	quitting = true;
	app.quit();
}
