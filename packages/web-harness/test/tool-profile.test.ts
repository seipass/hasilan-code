import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadToolProfile, type ToolPlugin } from "../src/server/plugins/tool-profile.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "hasilan-plugins-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

it("uses the standard profile by default and only loads the selected implementations", async () => {
	const builtin = vi.fn((): ToolPlugin => ({ apiVersion: 1, tools: () => [] }));
	const builtins = new Map([["search", builtin]]);
	const report = vi.fn();
	const session = { sessionId: "test", workspaceId: "workspace", cwd: dir };
	expect(loadToolProfile(dir, builtins, report)(session)).toEqual([]);
	expect(builtin).toHaveBeenCalledTimes(1);

	await writeFile(join(dir, "plugins.json"), JSON.stringify({ search: false }));
	expect(loadToolProfile(dir, builtins, report)(session)).toEqual([]);
	expect(builtin).toHaveBeenCalledTimes(1);

	await writeFile(join(dir, "plugins.json"), JSON.stringify({ search: "./local.cjs", broken: "./missing.cjs" }));
	await writeFile(
		join(dir, "local.cjs"),
		"exports.apiVersion = 1; exports.tools = ({ sessionId }) => [{ name: sessionId, parameters: {}, execute() {} }];",
	);
	expect(loadToolProfile(dir, builtins, report)(session)).toMatchObject([{ name: "test" }]);
	expect(builtin).toHaveBeenCalledTimes(1);
	expect(report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Plugin broken failed to load"));
});
