import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryModelsStore } from "@hasilan-code/pi-ai";
import { ModelRuntime } from "@hasilan-code/pi-coding-agent";
import { type Browser, chromium } from "playwright";
import { build, type Manifest } from "vite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { EventHub } from "../src/server/events.ts";
import { createHttpHost, type HttpHost, sendJson } from "../src/server/http-host.ts";
import { startHarness } from "../src/server/main.ts";
import { pluginManager } from "../src/server/plugins/manager.ts";
import { UiPreferencesStore } from "../src/server/ui-preferences.ts";
import { emptyCanvasDocument } from "../src/shared/canvas.ts";
import {
	DEFAULT_THEME_ID,
	PLUGIN_MANAGER_ID,
	type PluginProfile,
	SESSION_ARCHIVE_ID,
	SESSION_IMPORT_ID,
	SESSION_SEARCH_ID,
	standardTheme,
	TERMINAL_ID,
	WORKSPACE_FILES_ID,
} from "../src/shared/plugin-profile.ts";

let browser: Browser;
let directory: string;
let preferenceDirectory: string;
let host: HttpHost;
let hub: EventHub;
let store: UiPreferencesStore;
let workspaceBundle: string;

const dusk = {
	id: "dusk",
	title: "Dusk",
	customizable: false,
	dark: { ...standardTheme.dark, background: "#102030" },
	light: { ...standardTheme.light, background: "#faf0e6" },
};

async function start(activeIds = ["canvas"]) {
	const application: PluginProfile["application"] = { kind: "built-in" };
	store = await UiPreferencesStore.open(preferenceDirectory);
	const manager = pluginManager(preferenceDirectory, () => ({
		choices: new Map(),
		builtinIds: ["canvas"],
		profile: {
			activeIds,
			application,
			persistentSessions: true,
			panels: [],
			themes: [],
			plugins: [{ id: "canvas", title: "Canvas", source: "built-in", status: "enabled", requires: [] }],
		},
	}));
	hub = new EventHub(() => ({ sessions: [], teams: { teams: [], agents: [], runs: [] } }));
	host = createHttpHost({
		port: 0,
		staticDir: directory,
		handleWebSocket: (socket) => hub.attach(socket),
		handleApi: async (request, response, url) => {
			if (await store.handle(request, response, url)) return true;
			if (activeIds.includes(PLUGIN_MANAGER_ID) && (await manager.handleApi?.(request, response, url, [])))
				return true;
			if (url.pathname === "/api/workspaces")
				sendJson(response, 200, [{ workspaceId: "workspace", path: directory }]);
			else if (url.pathname === "/api/plugin-profile")
				sendJson(response, 200, {
					activeIds,
					application,
					persistentSessions: true,
					plugins: [],
					panels: activeIds.includes("notes") ? [{ id: "notes", title: "Notes" }] : [],
					themes: [
						{ id: DEFAULT_THEME_ID, customizable: true, ...standardTheme },
						...(activeIds.includes("dusk") ? [dusk] : []),
					],
				});
			else if (url.pathname === "/api/plugin-profile/notes/panel.js" && activeIds.includes("notes")) {
				response.writeHead(200, { "Content-Type": "application/javascript" });
				response.end(`document.currentScript.dispatchEvent(new CustomEvent("hasilan:panel", { detail(root, ctx) {
					const button = document.createElement("button");
					button.textContent = "Insert " + ctx.workspaceId;
					button.onclick = () => ctx.insertDraft("from Notes");
					root.append(button);
				} }));`);
			} else if (url.pathname === "/api/workspaces/workspace/canvas" && activeIds.includes("canvas"))
				sendJson(response, 200, emptyCanvasDocument());
			else if (url.pathname === "/api/models")
				sendJson(response, 200, {
					models: [{ provider: "fixture", id: "fixture", name: "Fixture model", contextWindow: 10000 }],
					providers: [{ id: "fixture", name: "Fixture", configured: true }],
				});
			else if (url.pathname === "/api/sessions" || url.pathname === "/api/terminals") sendJson(response, 200, []);
			else return false;
			return true;
		},
	});
	return host.listen();
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "hasilan-preferences-browser-"));
	await build({
		configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
		logLevel: "error",
		build: { outDir: directory, sourcemap: false, manifest: true },
	});
	const manifest = JSON.parse(await readFile(join(directory, ".vite", "manifest.json"), "utf8")) as Manifest;
	const workspace = manifest["src/client/App.tsx"];
	expect(workspace?.isDynamicEntry).toBe(true);
	workspaceBundle = workspace.file;
	browser = await chromium.launch({ headless: true });
}, 30000);

beforeEach(async () => {
	preferenceDirectory = await mkdtemp(join(directory, "profile-"));
});

afterAll(async () => {
	await browser?.close();
	hub?.close();
	await host?.close();
	await store?.close();
	if (directory) await rm(directory, { recursive: true, force: true });
});

it("runs Pi with a custom application and tool while every built-in plugin is disabled", async () => {
	const faux = fauxProvider({ provider: "external-plugin-test", tokenSize: { min: 1, max: 1 } });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("plugin_echo", {}), { stopReason: "toolUse" }),
		(context) =>
			fauxAssistantMessage(
				JSON.stringify(context.messages).includes("External plugin context.") &&
					context.messages.some(
						(message) =>
							message.role === "toolResult" &&
							message.toolName === "plugin_echo" &&
							message.content.some((item) => item.type === "text" && item.text === "from external tool"),
					)
					? "Verified external tool"
					: "External tool did not run",
			),
	]);
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const { provider, id } = faux.getModel();
	const disabled = [
		"hashline",
		"shell-process",
		"browser-tools",
		"computer-tools",
		"jev-computer",
		"web-search",
		"team-tools",
		"model-providers",
		"theme-default",
		"hyakki",
		"goal",
		"plugin-manager",
		"workspace-ui",
		"runtime-context",
		"session-storage",
		"session-search",
		"session-import",
		"session-archive",
		"storage-usage",
		"workspace-files",
		"terminal",
		"git-review",
		"text-transform",
		"browser-adjustments",
		"workspace-router",
		"github-dashboard",
		"account-usage",
		"canvas",
	];
	await writeFile(
		join(preferenceDirectory, "plugins.json"),
		JSON.stringify({
			...Object.fromEntries(disabled.map((name) => [name, false])),
			"custom-app": "./plugin.cjs",
		}),
	);
	await writeFile(
		join(preferenceDirectory, "plugin.cjs"),
		`
		exports.apiVersion = 1;
		exports.context = () => ["External plugin context."];
		exports.panel = { title: "Custom app", script: "panel.js", scope: "application" };
		exports.tools = () => [{
			name: "plugin_echo", label: "External echo", description: "Return a test marker.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			execute: async () => ({ content: [{ type: "text", text: "from external tool" }], details: null }),
		}];
	`,
	);
	await writeFile(
		join(preferenceDirectory, "panel.js"),
		`
		document.currentScript.dispatchEvent(new CustomEvent("hasilan:panel", {
			detail(root, { signal }) {
				const button = document.createElement("button");
				button.textContent = "Run Pi";
				const result = document.createElement("output");
				const request = async (path, body) => {
					const response = await fetch(path, body === undefined ? { signal } : {
						method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
					});
					if (!response.ok) throw new Error(await response.text());
					return response.json();
				};
				button.addEventListener("click", async () => {
					button.disabled = true;
					try {
						const [workspace] = await request("/api/workspaces");
						const { sessionId } = await request("/api/sessions", {
							workspaceId: workspace.workspaceId, model: ${JSON.stringify({ provider, id })},
						});
						const path = "/api/sessions/" + encodeURIComponent(sessionId);
						await request(path + "/prompt", { text: "Run the external tool", mode: "prompt" });
						while (!signal.aborted) {
							const session = await request(path);
							if (!session.currentRun && session.latestRun) {
								result.textContent = session.latestRun.result ?? session.latestRun.error;
								break;
							}
							await new Promise((resolve) => setTimeout(resolve, 40));
						}
					} catch (error) {
						if (!signal.aborted) result.textContent = String(error);
					}
				}, { signal });
				root.append(button, result);
			}
		}));`,
	);
	const page = await browser.newPage();
	const workspaceRequests: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === `/${workspaceBundle}`) workspaceRequests.push(request.url());
	});
	vi.stubEnv("HASILAN_CODE_AGENT_DIR", preferenceDirectory);
	try {
		const harness = await startHarness(
			{ cwd: directory, port: 0, noOpen: true, help: false, lan: false, development: false },
			{ modelRuntime, staticDir: directory },
		);
		try {
			await page.goto(harness.launch.launchUrl);
			const profile = await page.evaluate(async () => (await fetch("/api/plugin-profile")).json());
			expect(profile.activeIds).toEqual(["custom-app"]);
			const application = page.getByRole("region", { name: "Custom app" });
			await application.getByRole("button", { name: "Run Pi" }).click();
			await expect.poll(() => application.getByRole("status").textContent()).toBe("Verified external tool");
			expect(await page.getByRole("combobox", { name: "メッセージ" }).count()).toBe(0);
			expect(workspaceRequests).toHaveLength(0);
			expect(faux.state.callCount).toBe(2);
		} finally {
			await page.close();
			await harness.shutdown();
		}
		await expect(readFile(join(preferenceDirectory, "web-harness", "state.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	} finally {
		vi.unstubAllEnvs();
	}
}, 30000);

it("opens built-in and external panels from the sidebar and preserves composer navigation", async () => {
	for (const enabled of [true, false]) {
		const address = await start(
			enabled
				? [
						"canvas",
						"notes",
						SESSION_SEARCH_ID,
						SESSION_IMPORT_ID,
						SESSION_ARCHIVE_ID,
						WORKSPACE_FILES_ID,
						TERMINAL_ID,
					]
				: [],
		);
		const page = await browser.newPage({ reducedMotion: "reduce" });
		page.setDefaultTimeout(5_000);
		try {
			const scriptRequests: string[] = [];
			page.on("request", (request) => {
				if (request.url().endsWith("/notes/panel.js")) scriptRequests.push(request.url());
			});
			await Promise.all([
				page.waitForResponse((response) => response.url().endsWith("/api/plugin-profile") && response.ok()),
				page.goto(address.launchUrl),
			]);
			await page.locator('.workspace-accordion[data-selected="true"]').waitFor({ state: "attached" });
			const input = page.getByRole("combobox", { name: "メッセージ" });
			const panelButton = page
				.getByRole("navigation", { name: "プラグイン", exact: true })
				.getByRole("button", { name: "設計キャンバス", exact: true });
			const canvas = page.getByRole("region", { name: "プロジェクト設計キャンバス" });
			const search = page.getByRole("textbox", { name: "会話を検索" });
			const importSession = page.getByRole("button", { name: "セッションを引き継ぐ" });
			const fileTree = page.getByRole("button", { name: "ファイルツリー", exact: true });
			if (enabled) {
				await search.waitFor();
				await importSession.waitFor();
				await fileTree.waitFor();
				await panelButton.waitFor();
				expect(
					await panelButton.evaluate((button) => button.parentElement?.previousElementSibling?.className),
				).toBe("sidebar-conversation-actions");
				await input.fill("保存する下書き");
				const currentUrl = page.url();
				await panelButton.click();
				await canvas.waitFor();
				expect(await panelButton.getAttribute("aria-current")).toBe("page");
				await input.waitFor({ state: "hidden" });
				await fileTree.waitFor({ state: "hidden" });
				expect(await page.getByRole("button", { name: "作業一覧", exact: true }).count()).toBe(0);
				expect(page.url()).toBe(currentUrl);
				await page.getByRole("button", { name: "会話に戻る", exact: true }).click();
				await canvas.waitFor({ state: "hidden" });
				await input.waitFor();
				expect(await input.inputValue()).toBe("保存する下書き");
				expect(await panelButton.getAttribute("aria-current")).toBeNull();
				const notesButton = page.getByRole("button", { name: "Notes", exact: true });
				expect(scriptRequests).toEqual([]);
				await notesButton.click();
				await page.getByRole("region", { name: "Notes" }).getByRole("button", { name: "Insert workspace" }).click();
				await expect.poll(() => input.inputValue()).toBe("from Notes");
				expect(scriptRequests).toHaveLength(1);
			}
			await input.fill("/canvas");
			const option = page.getByRole("option", { name: /\/canvas/ });
			if (enabled) {
				await option.waitFor();
				await input.press("Enter");
				await input.press("Enter");
				await canvas.waitFor();
			} else {
				await page.getByRole("button", { name: "送信", exact: true }).click();
				await page.getByText("設計キャンバスが無効です。", { exact: true }).waitFor();
				expect(await option.count()).toBe(0);
				expect(await canvas.count()).toBe(0);
				expect(await panelButton.count()).toBe(0);
				expect(await search.count()).toBe(0);
				expect(await importSession.count()).toBe(0);
				expect(await fileTree.count()).toBe(0);
			}
			await page.getByRole("button", { name: "設定", exact: true }).click();
			const settings = page.getByRole("dialog", { name: "設定" });
			await settings.waitFor();
			expect(await settings.getByRole("tab", { name: "アーカイブ" }).count()).toBe(enabled ? 1 : 0);
		} finally {
			await page.close();
			hub.close();
			await host.close();
			await store.close();
		}
	}
}, 30000);

it("saves plugin changes from the sidebar and keeps the running state visible until restart", async () => {
	const address = await start(["canvas", PLUGIN_MANAGER_ID]);
	const page = await browser.newPage({ reducedMotion: "reduce" });
	try {
		await page.goto(address.launchUrl);
		await page.getByRole("button", { name: "プラグイン", exact: true }).click();
		const manager = page.getByRole("region", { name: "プラグイン管理" });
		await manager.getByRole("button", { name: "Canvasを無効化" }).click();
		await manager.getByText("再起動すると保存した変更が反映されます。").waitFor();
		await manager.getByText("組み込み · 有効 · 次回起動時は無効").waitFor();
		expect(await page.getByRole("button", { name: "設計キャンバス", exact: true }).isVisible()).toBe(true);
		await manager.getByRole("button", { name: "Canvasを有効化" }).click();
		await manager.getByText("再起動すると保存した変更が反映されます。").waitFor({ state: "hidden" });
	} finally {
		await page.close();
		hub.close();
		await host.close();
		await store.close();
	}
}, 30000);

it("selects an external palette, keeps it after reload, and restores the built-in palette", async () => {
	const address = await start(["dusk"]);
	const page = await browser.newPage({ reducedMotion: "reduce" });
	try {
		await page.goto(address.launchUrl);
		const openAppearance = async () => {
			await page.getByRole("button", { name: "設定", exact: true }).click();
			await page.getByRole("tab", { name: "外観", exact: true }).click();
		};
		const background = () => page.evaluate(() => document.documentElement.style.getPropertyValue("--surface"));
		await openAppearance();
		await page.getByRole("combobox", { name: "配色", exact: true }).click();
		await page.getByRole("option", { name: "Dusk", exact: true }).click();
		await expect.poll(background).toBe("#102030");
		await page.evaluate(() => window.hasilanFlushPreferences?.());
		await page.reload();
		await expect.poll(background).toBe("#102030");
		await openAppearance();
		await page.getByRole("combobox", { name: "配色", exact: true }).click();
		await page.getByRole("option", { name: "標準", exact: true }).click();
		await expect.poll(background).toBe("#070708");
	} finally {
		await page.close();
		hub.close();
		await host.close();
		await store.close();
	}
}, 30000);

it("boots the real UI after migration and restores text, attachments, background and model on another port", async () => {
	const first = await start();
	const web = await browser.newContext({ reducedMotion: "reduce" });
	const page = await web.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await web.addInitScript(() => {
		localStorage.setItem("pi-web-sidebar-open", "true");
		localStorage.setItem("pi-web-ui-font", JSON.stringify("Meiryo"));
		localStorage.setItem(
			"pi-web-model-selection",
			JSON.stringify({ model: { provider: "fixture", id: "fixture" }, thinkingLevel: "max" }),
		);
		localStorage.setItem("pi-web-draft:new:workspace", "移行した下書き");
		localStorage.setItem(
			"hasilan-home-background",
			JSON.stringify({
				name: "background.png",
				image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
			}),
		);
	});
	await page.goto(first.launchUrl);
	await page.locator("textarea#message").waitFor();
	await expect.poll(() => page.locator("textarea#message").inputValue()).toBe("移行した下書き");
	await page.locator("textarea#message").fill("共有する下書き");
	const input = page.locator('input[type="file"][multiple]');
	await expect.poll(() => input.isEnabled()).toBe(true);
	await input.setInputFiles({ name: "remove.txt", mimeType: "text/plain", buffer: Buffer.from("abc") });
	await page.getByRole("button", { name: "remove.txtを取り外す" }).click();
	await expect.poll(() => page.locator(".composer-attachment").count()).toBe(0);
	await input.setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("keep") });
	await expect.poll(() => page.locator(".composer-attachment").count()).toBe(1);
	await expect
		.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontFamily))
		.toContain("Meiryo");
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await page.getByRole("tab", { name: "外観", exact: true }).click();
	await page.getByRole("combobox", { name: "画面のフォント" }).fill("Arial");
	await expect
		.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontFamily))
		.toContain("Arial");
	await page.evaluate(() => window.hasilanFlushPreferences?.());
	await web.close();
	hub.close();
	await host.close();
	await store.close();
	const second = await start();
	expect(second.origin).not.toBe(first.origin);
	const desktop = await browser.newContext({ reducedMotion: "reduce" });
	const restored = await desktop.newPage();
	restored.on("pageerror", (error) => errors.push(error.message));
	await restored.goto(second.launchUrl);
	await expect.poll(() => restored.locator("textarea#message").inputValue()).toBe("共有する下書き");
	await expect.poll(() => restored.locator(".composer-attachment").textContent()).toContain("keep.txt");
	expect(await restored.locator(".composer-attachment").textContent()).not.toContain("remove.txt");
	expect(await restored.locator(".model-trigger").textContent()).toContain("Fixture model");
	expect(await restored.locator(".model-trigger").textContent()).toContain("max");
	expect(await restored.locator(".home-backdrop img").getAttribute("src")).toContain("data:image/png;base64,");
	expect(await restored.evaluate(() => getComputedStyle(document.documentElement).fontFamily)).toContain("Arial");
	expect(errors).toEqual([]);
	await desktop.close();
}, 30000);
