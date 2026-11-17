import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startHarness } from "../src/server/main.ts";
import { loadServerProfile, type ServerPlugin } from "../src/server/plugins/server-profile.ts";
import { emptyCanvasDocument } from "../src/shared/canvas.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "hasilan-plugins-"));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

it("keeps the authenticated Canvas API and its data across disable and re-enable", async () => {
	vi.stubEnv("HASILAN_CODE_AGENT_DIR", dir);
	vi.stubEnv("PI_OFFLINE", "1");
	const options = { cwd: dir, port: 0, noOpen: true, help: false, lan: false, development: false };
	async function withHost(run: (api: (path: string, body?: unknown) => Promise<Response>) => Promise<void>) {
		const harness = await startHarness(options);
		try {
			const { origin, launchUrl } = harness.launch;
			const login = await fetch(launchUrl, { redirect: "manual" });
			const cookie = login.headers.getSetCookie()[0].split(";")[0];
			await run((path, body) =>
				fetch(
					origin + path,
					body === undefined
						? { headers: { cookie } }
						: {
								method: "PUT",
								headers: { cookie, origin, "Content-Type": "application/json" },
								body: JSON.stringify(body),
							},
				),
			);
		} finally {
			await harness.shutdown();
		}
	}

	let path = "";
	await withHost(async (api) => {
		expect(await (await api("/api/plugin-profile")).json()).toEqual({
			activeIds: ["web-search", "theme-default", "canvas"],
			panels: [],
			themes: [expect.objectContaining({ id: "theme-default", customizable: true })],
		});
		const [{ workspaceId }] = await (await api("/api/workspaces")).json();
		path = `/api/workspaces/${workspaceId}/canvas`;
		const saved = await api(path, emptyCanvasDocument());
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({ revision: 1 });
	});
	await writeFile(join(dir, "plugins.json"), '{"canvas":false}');
	await withHost(async (api) => {
		expect(await (await api("/api/plugin-profile")).json()).toMatchObject({
			activeIds: ["web-search", "theme-default"],
			panels: [],
		});
		expect((await api(path)).status).toBe(404);
	});
	await writeFile(join(dir, "plugins.json"), '{"notes":"./notes.cjs"}');
	await writeFile(
		join(dir, "notes.cjs"),
		'exports.apiVersion = 1; exports.panel = { title: "Notes", script: "notes.js" };',
	);
	await writeFile(join(dir, "notes.js"), "/* Notes panel */");
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
	});
}, 30_000);

it("uses the standard profile by default and only loads the selected implementations", async () => {
	const builtin = vi.fn((): ServerPlugin => ({ apiVersion: 1, tools: () => [] }));
	const builtins = new Map([["search", builtin]]);
	const report = vi.fn();
	const session = { sessionId: "test", workspaceId: "workspace", cwd: dir };
	expect(loadServerProfile(dir, builtins, report).toolsForSession(session)).toEqual([]);
	expect(builtin).toHaveBeenCalledTimes(1);

	await writeFile(join(dir, "plugins.json"), JSON.stringify({ search: false }));
	expect(loadServerProfile(dir, builtins, report).toolsForSession(session)).toEqual([]);
	expect(builtin).toHaveBeenCalledTimes(1);

	await writeFile(join(dir, "plugins.json"), JSON.stringify({ search: "./local.cjs", broken: "./missing.cjs" }));
	await writeFile(
		join(dir, "local.cjs"),
		"exports.apiVersion = 1; exports.tools = ({ sessionId }) => [{ name: sessionId, parameters: {}, execute() {} }];",
	);
	expect(loadServerProfile(dir, builtins, report).toolsForSession(session)).toMatchObject([{ name: "test" }]);
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
	const { profile } = loadServerProfile(dir, new Map(), report);
	expect(profile.themes).toEqual([{ id: "dusk", customizable: false, ...theme }]);
	expect(profile.activeIds).toEqual(["dusk"]);
	expect(report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("invalid theme declaration"));
});
