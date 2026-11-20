import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } from "@hasilan-code/pi-ai";
import { ModelRuntime } from "@hasilan-code/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { startHarness } from "../src/server/main.ts";
import { loadServerProfile, type ServerPlugin } from "../src/server/plugins/server-profile.ts";
import { hashlinePlugin, shellProcessPlugin } from "../src/server/plugins/workspace-tools.ts";
import { SessionRegistry } from "../src/server/session-registry.ts";
import { TeamManager } from "../src/server/team-manager.ts";
import { fileRevision, WorkspaceFiles } from "../src/server/workspace-files.ts";
import { emptyCanvasDocument } from "../src/shared/canvas.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "hasilan-plugins-"));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

it("applies plugin management changes on restart and preserves existing Canvas data", async () => {
	vi.stubEnv("HASILAN_CODE_AGENT_DIR", dir);
	vi.stubEnv("PI_OFFLINE", "1");
	const options = { cwd: dir, port: 0, noOpen: true, help: false, lan: false, development: false };
	async function withHost(
		run: (
			api: (path: string, body?: unknown, method?: string) => Promise<Response>,
			connect: (path: string) => WebSocket,
		) => Promise<void>,
	) {
		const harness = await startHarness(options);
		try {
			const { origin, launchUrl } = harness.launch;
			const login = await fetch(launchUrl, { redirect: "manual" });
			const cookie = login.headers.getSetCookie()[0].split(";")[0];
			await run(
				(path, body, method = "PUT") =>
					fetch(
						origin + path,
						body === undefined
							? { headers: { cookie } }
							: {
									method,
									headers: { cookie, origin, "Content-Type": "application/json" },
									body: JSON.stringify(body),
								},
					),
				(path) =>
					new WebSocket(origin.replace("http:", "ws:") + path, { headers: { Cookie: cookie, Origin: origin } }),
			);
		} finally {
			await harness.shutdown();
		}
	}

	let path = "";
	let swarmPath = "";
	let builtinIds: string[] = [];
	const management = "/api/plugin-management";
	await writeFile(
		join(dir, "notes.cjs"),
		'exports.apiVersion = 1; exports.panel = { title: "Notes", script: "notes.js" };',
	);
	await writeFile(join(dir, "notes.js"), "/* Notes panel */");
	await withHost(async (api) => {
		const profile = await (await api("/api/plugin-profile")).json();
		builtinIds = profile.activeIds;
		expect(profile).toMatchObject({
			activeIds: [
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
			],
			panels: [],
			application: { kind: "built-in" },
			persistentSessions: true,
			themes: [expect.objectContaining({ id: "theme-default", customizable: true })],
			plugins: expect.arrayContaining([
				{ id: "hyakki", title: "hyakki", status: "enabled", source: "built-in", requires: ["team-tools"] },
			]),
		});
		const [{ workspaceId }] = await (await api("/api/workspaces")).json();
		expect((await (await api("/api/models")).json()).providers).toContainEqual(
			expect.objectContaining({ id: "openrouter" }),
		);
		expect(await (await api("/api/sessions/search?q=missing")).json()).toEqual([]);
		expect(await (await api("/api/session-archive")).json()).toEqual([]);
		expect((await api("/api/session-imports/sources")).status).toBe(200);
		expect((await api("/api/storage")).status).toBe(200);
		expect((await api(`/api/workspaces/${workspaceId}/file?path=notes.js`)).status).toBe(200);
		expect(await (await api(`/api/terminals?workspaceId=${workspaceId}`)).json()).toEqual([]);
		path = `/api/workspaces/${workspaceId}/canvas`;
		swarmPath = `/api/workspaces/${workspaceId}/swarm`;
		expect((await api(swarmPath, {}, "POST")).status).toBe(400);
		const saved = await api(path, emptyCanvasDocument());
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({ revision: 1 });
		expect(await (await api(management, { op: "add", id: "notes", module: "./notes.cjs" }, "PATCH")).json()).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "notes", enabled: true, pending: true })]),
		);
		const disabled = await api(management, { op: "enable", id: "notes", enabled: false }, "PATCH");
		expect(await disabled.json()).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "notes", enabled: false, module: "./notes.cjs" })]),
		);
		for (const id of ["canvas", "goal", "hashline", "shell-process", "team-tools"])
			expect((await api(management, { op: "enable", id, enabled: false }, "PATCH")).status).toBe(200);
		expect((await api(path)).status).toBe(200);
	});
	await withHost(async (api) => {
		expect(await (await api("/api/plugin-profile")).json()).toMatchObject({
			activeIds: [
				"browser-tools",
				"computer-tools",
				"jev-computer",
				"web-search",
				"model-providers",
				"theme-default",
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
			],
			panels: [],
			plugins: expect.arrayContaining([
				expect.objectContaining({
					id: "hyakki",
					status: "blocked",
					reason: "Required plugin team-tools is unavailable",
				}),
				expect.objectContaining({ id: "team-tools", status: "disabled" }),
				expect.objectContaining({ id: "notes", status: "disabled" }),
			]),
		});
		expect((await api(path)).status).toBe(404);
		expect((await api(swarmPath, {}, "POST")).status).toBe(404);
		for (const id of ["canvas", "notes"])
			expect((await api(management, { op: "enable", id, enabled: true }, "PATCH")).status).toBe(200);
	});
	await withHost(async (api) => {
		expect(await (await api(path)).json()).toMatchObject({ revision: 1 });
		expect(await (await api("/api/plugin-profile")).json()).toMatchObject({
			panels: [{ id: "notes", title: "Notes" }],
		});
		const script = await api("/api/plugin-profile/notes/panel.js");
		expect(script.status).toBe(200);
		expect(script.headers.get("content-type")).toContain("application/javascript");
		expect(await script.text()).toBe("/* Notes panel */");
		expect((await api("/api/plugin-profile/canvas/panel.js")).status).toBe(404);
		expect((await api(management, { op: "remove", id: "notes" }, "PATCH")).status).toBe(200);
		expect((await api("/api/plugin-profile/notes/panel.js")).status).toBe(200);
	});
	const statePath = join(dir, "web-harness", "state.json");
	const originalState = await readFile(statePath, "utf8");
	const disabled = Object.fromEntries(builtinIds.map((id) => [id, false]));
	await writeFile(join(dir, "plugins.json"), JSON.stringify({ ...disabled, "custom-app": "./custom.cjs" }));
	const model = fauxProvider({ provider: "local-provider" }).getModel();
	await writeFile(
		join(dir, "custom.cjs"),
		`exports.apiVersion = 1;
exports.panel = { title: "Custom app", script: "notes.js", scope: "application" };
exports.webSocket = (url) => url.pathname === "/api/probe/events" ? (socket) => {
	socket.send("custom websocket");
	socket.close();
} : undefined;
exports.providers = [{
	id: "local-provider",
	name: "Local provider",
	auth: { apiKey: { name: "Local", async resolve() { return { auth: {} }; } } },
	getModels() { return [${JSON.stringify(model)}]; },
	stream() { throw new Error("Unexpected stream"); },
	streamSimple() { throw new Error("Unexpected stream"); },
}];`,
	);
	await withHost(async (api, connect) => {
		expect(await (await api("/api/plugin-profile")).json()).toMatchObject({
			activeIds: ["custom-app"],
			persistentSessions: false,
			application: { kind: "external", panel: { id: "custom-app", title: "Custom app", scope: "application" } },
		});
		expect((await api("/api/plugin-profile/custom-app/panel.js")).status).toBe(200);
		const [{ workspaceId }] = await (await api("/api/workspaces")).json();
		expect((await api(`/api/workspaces/${workspaceId}/files`)).status).toBe(404);
		expect((await api(`/api/terminals?workspaceId=${workspaceId}`)).status).toBe(404);
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const socket = connect("/api/terminals/missing/events");
			socket.once("unexpected-response", (_request, response) => {
				response.resume();
				resolve(response.statusCode);
			});
			socket.once("open", () => {
				socket.close();
				reject(new Error("Terminal socket unexpectedly accepted"));
			});
			socket.once("error", reject);
		});
		expect(status).toBe(404);
		const message = await new Promise<string>((resolve, reject) => {
			const socket = connect("/api/probe/events");
			socket.once("message", (data) => resolve(data.toString()));
			socket.once("error", reject);
		});
		expect(message).toBe("custom websocket");
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
			"base64",
		);
		const revision = fileRevision(png);
		const attachment = `.hasilan-code/attachments/${revision}-test.png`;
		await mkdir(join(dir, ".hasilan-code", "attachments"), { recursive: true });
		await writeFile(join(dir, attachment), png);
		const response = await api(
			`/api/workspaces/${workspaceId}/file-content?path=${encodeURIComponent(attachment)}&revision=${revision}`,
		);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
		expect(await (await api("/api/models")).json()).toMatchObject({
			providers: [{ id: "local-provider", name: "Local provider", configured: true }],
			models: [{ id: model.id, provider: "local-provider" }],
		});
		expect((await api(management)).status).toBe(404);
		for (const route of [
			"/api/home/github",
			"/api/account-usage",
			"/api/sessions/search?q=missing",
			"/api/session-imports/sources",
			"/api/session-archive",
			"/api/storage",
			"/api/sessions/missing/git-review",
		]) {
			expect((await api(route)).status).toBe(404);
		}
		for (const route of ["/api/text-transform", "/api/browser-adjustments", "/api/workspaces/route"]) {
			expect((await api(route, {}, "POST")).status).toBe(404);
		}
	});
	expect(await readFile(statePath, "utf8")).toBe(originalState);
	await writeFile(join(dir, "plugins.json"), JSON.stringify({ ...disabled, "local-storage": "./local-storage.cjs" }));
	const localStatePath = join(dir, "local-state.json");
	await writeFile(
		join(dir, "local-storage.cjs"),
		`const fs = require("node:fs/promises");
const path = ${JSON.stringify(localStatePath)};
exports.apiVersion = 1;
exports.sessionStorage = {
	sessionsDirectory: ${JSON.stringify(join(dir, "local-sessions"))},
	importAssetsDirectory: ${JSON.stringify(join(dir, "local-assets"))},
	async readState() {
		try { return JSON.parse(await fs.readFile(path, "utf8")); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
	},
	writeState(snapshot) { return fs.writeFile(path, snapshot); },
};`,
	);
	let savedSession: string;
	await withHost(async (api) => {
		const [{ workspaceId }] = await (await api("/api/workspaces")).json();
		const response = await api("/api/sessions", { workspaceId }, "POST");
		expect(response.status).toBe(201);
		const { sessionId, path: transcript } = await response.json();
		expect(transcript).toContain(join(dir, "local-sessions"));
		savedSession = sessionId;
	});
	await withHost(async (api) => {
		const response = await api(`/api/sessions/${savedSession}`);
		expect(response.status).toBe(200);
	});
	await writeFile(localStatePath, '{"schemaVersion":999}');
	await withHost(async (api) => {
		expect(await (await api("/api/plugin-profile")).json()).toMatchObject({
			activeIds: [],
			plugins: expect.arrayContaining([expect.objectContaining({ id: "local-storage", status: "failed" })]),
		});
		expect((await api("/api/workspaces")).status).toBe(200);
	});
	expect(await readFile(localStatePath, "utf8")).toBe('{"schemaVersion":999}');
	expect(await readFile(statePath, "utf8")).toBe(originalState);
}, 30_000);

it("uses the standard profile by default and only loads the selected implementations", async () => {
	const builtin = vi.fn((): ServerPlugin => ({ apiVersion: 1, tools: () => [] }));
	const builtins = new Map([["search", builtin]]);
	const report = vi.fn();
	const session = { sessionId: "test", workspaceId: "workspace", cwd: dir };
	expect((await loadServerProfile(dir, builtins, report)).toolsForSession(session)).toEqual([]);
	expect(builtin).toHaveBeenCalledTimes(1);

	await writeFile(join(dir, "plugins.json"), JSON.stringify({ search: false }));
	expect((await loadServerProfile(dir, builtins, report)).toolsForSession(session)).toEqual([]);
	expect(builtin).toHaveBeenCalledTimes(1);

	await writeFile(join(dir, "plugins.json"), JSON.stringify({ search: "./local.cjs", broken: "./missing.cjs" }));
	await writeFile(
		join(dir, "local.cjs"),
		"exports.apiVersion = 1; exports.tools = ({ sessionId }) => [{ name: sessionId, parameters: {}, execute() {} }];",
	);
	expect((await loadServerProfile(dir, builtins, report)).toolsForSession(session)).toMatchObject([{ name: "test" }]);
	expect(builtin).toHaveBeenCalledTimes(1);
	expect(report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Plugin broken failed to load"));
});

it("exports installed theme palettes and excludes invalid theme plugins", async () => {
	const dark = { background: "#000011", foreground: "#ffffff", accent: "#aabbcc", contrast: 50 };
	const light = { ...dark, background: "#ffffff", foreground: "#000000" };
	const theme = { title: "Dusk", dark, light };
	await writeFile(join(dir, "plugins.json"), '{"dusk":"./dusk.cjs","invalid":"./invalid.cjs"}');
	await writeFile(join(dir, "dusk.cjs"), `module.exports = ${JSON.stringify({ apiVersion: 1, theme })};`);
	await writeFile(join(dir, "invalid.cjs"), 'module.exports = { apiVersion: 1, theme: { title: "Invalid" } };');
	const report = vi.fn();
	const { profile } = await loadServerProfile(dir, new Map(), report);
	expect(profile.themes).toEqual([{ id: "dusk", customizable: false, ...theme }]);
	expect(profile.activeIds).toEqual(["dusk"]);
	expect(report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("invalid theme declaration"));
});

it("cleans up active plugins in reverse order even when a cleanup throws", async () => {
	const calls: string[] = [];
	const report = vi.fn();
	const builtins = new Map<string, () => ServerPlugin>(
		["first", "second"].map((id) => [
			id,
			() => ({
				apiVersion: 1,
				tools: () => [],
				closeSession: (sessionId) => {
					calls.push(`${id}:${sessionId}`);
					if (id === "second") throw new Error("cleanup failed");
				},
				close: () => {
					calls.push(id);
				},
			}),
		]),
	);
	const profile = await loadServerProfile(dir, builtins, report);
	await profile.closeSession("s1");
	await profile.close();
	expect(calls).toEqual(["second:s1", "first:s1", "second", "first"]);
	expect(report).toHaveBeenCalledExactlyOnceWith("Plugin second failed to clean up: cleanup failed");
});

it("activates dependencies first and excludes missing and cyclic registrations", async () => {
	const plugin =
		(requires: string[]): (() => ServerPlugin) =>
		() => ({ apiVersion: 1, requires, tools: () => [] });
	const builtins = new Map([
		["dependent", plugin(["base"])],
		["base", plugin([])],
		["missing", plugin(["uninstalled"])],
		["loop-a", plugin(["loop-b"])],
		["loop-b", plugin(["loop-a"])],
		["independent", plugin([])],
	]);
	const report = vi.fn();
	const runtime = await loadServerProfile(dir, builtins, report);
	expect(runtime.profile.activeIds).toEqual(["base", "dependent", "independent"]);
	expect(runtime.isBuiltinActive("dependent")).toBe(true);
	expect(runtime.isBuiltinActive("missing")).toBe(false);
	expect(runtime.profile.plugins).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: "missing",
				status: "blocked",
				reason: "Required plugin uninstalled is unavailable",
			}),
			expect.objectContaining({ id: "loop-a", status: "blocked" }),
			expect.objectContaining({
				id: "loop-b",
				status: "blocked",
				reason: expect.stringContaining("Dependency cycle"),
			}),
		]),
	);
	expect(report).toHaveBeenCalledTimes(3);
});

it("isolates invalid runtime context and keeps unrelated contributions in registration order", async () => {
	const report = vi.fn();
	const profile = await loadServerProfile(
		dir,
		new Map<string, () => ServerPlugin>([
			["first", () => ({ apiVersion: 1, context: ({ sessionId }) => [sessionId] })],
			[
				"broken",
				() => ({
					apiVersion: 1,
					context: () => {
						throw new Error("cannot read context");
					},
				}),
			],
			["last", () => ({ apiVersion: 1, context: ({ workspaceId }) => ["  ", workspaceId] })],
		]),
		report,
	);
	expect(profile.contextForSession({ sessionId: "session", workspaceId: "workspace", cwd: dir })).toEqual([
		"session",
		"workspace",
	]);
	expect(report).toHaveBeenCalledExactlyOnceWith("Plugin broken could not provide context: cannot read context");
});

it("does not expose Pi file or persistent shell tools when their plugins are disabled", async () => {
	await writeFile(join(dir, "plugins.json"), '{"hashline":false,"shell-process":false}');
	const files = new WorkspaceFiles();
	const plugins = await loadServerProfile(
		dir,
		new Map([
			["hashline", () => hashlinePlugin(files, files)],
			["shell-process", () => shellProcessPlugin(dir)],
		]),
	);
	const faux = fauxProvider({ provider: "plugin-test" });
	faux.setResponses([fauxAssistantMessage("Done")]);
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const registry = new SessionRegistry({
		agentDir: dir,
		workspaceFiles: files,
		modelRuntime,
		pluginOwnedTools: ["read", "edit", "write"],
		customTools: plugins.toolsForSession,
	});
	const teams = new TeamManager(registry);
	try {
		await registry.initialize();
		await teams.initialize();
		const workspace = await registry.addWorkspace(dir);
		const { provider, id } = faux.getModel();
		const { sessionId } = await registry.create({ workspaceId: workspace.id, model: { provider, id } });
		await teams.prompt(sessionId, { text: "Hello", mode: "prompt" });
		await expect.poll(() => registry.get(sessionId).currentRun).toBeUndefined();
		expect(faux.state.callCount).toBe(1);
		const tools = registry.activeTools(sessionId);
		expect(tools).toContain("bash");
		for (const name of ["read", "edit", "write", "shell_process"]) expect(tools).not.toContain(name);
	} finally {
		await teams.close();
		await registry.close();
	}
});

it("loads the bundled sample external tool, panel, and theme plugins", async () => {
	const examplesRoot = join(import.meta.dirname, "..", "examples", "plugins");
	await writeFile(
		join(dir, "plugins.json"),
		JSON.stringify({
			"sample-tool": join(examplesRoot, "sample-tool", "plugin.cjs"),
			"sample-panel": join(examplesRoot, "sample-panel", "plugin.cjs"),
			"sample-dusk": join(examplesRoot, "sample-theme", "plugin.cjs"),
		}),
	);
	const profile = await loadServerProfile(dir, new Map());
	expect(profile.profile.activeIds).toEqual(["sample-tool", "sample-panel", "sample-dusk"]);
	expect(profile.profile.panels).toEqual([{ id: "sample-panel", title: "サンプルメモ" }]);
	expect(profile.profile.themes).toContainEqual(
		expect.objectContaining({ id: "sample-dusk", title: "Dusk (Sample)", customizable: false }),
	);
	expect((await profile.panelScript("sample-panel"))?.toString("utf8")).toContain("hasilan:panel");
	const tools = profile.toolsForSession({ sessionId: "s1", workspaceId: "w1", cwd: dir });
	expect(tools.map((tool) => tool.name)).toEqual(["workspace_info"]);
});

it("runs Pi with zero built-in plugins and responds using only external plugins", async () => {
	vi.stubEnv("HASILAN_CODE_AGENT_DIR", dir);
	vi.stubEnv("PI_OFFLINE", "1");
	const examplesRoot = join(import.meta.dirname, "..", "examples", "plugins");
	const faux = fauxProvider({ provider: "minimal-provider" });
	faux.setResponses([fauxAssistantMessage("Minimal host response")]);
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const builtIns = [
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
		join(dir, "plugins.json"),
		JSON.stringify({
			...Object.fromEntries(builtIns.map((id) => [id, false])),
			"sample-tool": join(examplesRoot, "sample-tool", "plugin.cjs"),
		}),
	);
	const harness = await startHarness(
		{ cwd: dir, port: 0, noOpen: true, help: false, lan: false, development: false },
		{ modelRuntime },
	);
	try {
		const { origin, launchUrl } = harness.launch;
		const login = await fetch(launchUrl, { redirect: "manual" });
		const cookie = login.headers.getSetCookie()[0].split(";")[0];
		const api = (path: string, body?: unknown) =>
			fetch(
				origin + path,
				body === undefined
					? { headers: { cookie } }
					: {
							method: "POST",
							headers: { cookie, origin, "Content-Type": "application/json" },
							body: JSON.stringify(body),
						},
			);
		const profile = await (await api("/api/plugin-profile")).json();
		expect(profile.activeIds).toEqual(["sample-tool"]);
		expect(profile.application).toBeNull();
		const [{ workspaceId }] = await (await api("/api/workspaces")).json();
		const { provider, id } = faux.getModel();
		const created = await (await api("/api/sessions", { workspaceId, model: { provider, id } })).json();
		expect((await api(`/api/sessions/${created.sessionId}/prompt`, { text: "Ping", mode: "prompt" })).status).toBe(
			202,
		);
		await expect
			.poll(async () => (await (await api(`/api/sessions/${created.sessionId}`)).json()).currentRun)
			.toBeUndefined();
		const detail = await (await api(`/api/sessions/${created.sessionId}`)).json();
		expect(detail.messages.some((message: { role?: string }) => message.role === "assistant")).toBe(true);
		expect(faux.state.callCount).toBe(1);
	} finally {
		await harness.shutdown();
	}
});
