import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { ToolDefinition } from "@hasilan-code/pi-coding-agent";

export interface ToolSession {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly cwd: string;
}

export type ToolFactory = (session: ToolSession) => readonly ToolDefinition[];

export type PluginApi = (
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	parts: readonly string[],
) => boolean | Promise<boolean>;

export interface ServerPlugin {
	readonly apiVersion: 1;
	readonly tools?: ToolFactory;
	readonly handleApi?: PluginApi;
}

export function loadServerProfile(
	agentDir: string,
	builtins: ReadonlyMap<string, () => ServerPlugin>,
	report = (message: string) => console.error(message),
) {
	const profilePath = join(agentDir, "plugins.json");
	const choices = new Map<string, false | string>();
	try {
		const profile: unknown = JSON.parse(readFileSync(profilePath, "utf8"));
		if (!profile || typeof profile !== "object" || Array.isArray(profile))
			throw new Error("expected a map of plugin IDs to module paths or false");
		for (const [id, value] of Object.entries(profile) as [string, unknown][]) {
			if (value === false || (typeof value === "string" && value.trim())) choices.set(id, value);
			else report(`Plugin ${id}: expected a module path or false in plugins.json`);
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			report(`Cannot read plugins.json: ${error instanceof Error ? error.message : String(error)}`);
	}

	const requirePlugin = createRequire(profilePath);
	const active = new Map<string, ServerPlugin>();
	for (const id of new Set([...builtins.keys(), ...choices.keys()])) {
		const choice = choices.get(id);
		if (choice === false) continue;
		try {
			const plugin: unknown = choice === undefined ? builtins.get(id)?.() : requirePlugin(resolve(agentDir, choice));
			if (
				!plugin ||
				typeof plugin !== "object" ||
				!("apiVersion" in plugin) ||
				plugin.apiVersion !== 1 ||
				("tools" in plugin && typeof plugin.tools !== "function") ||
				("handleApi" in plugin && typeof plugin.handleApi !== "function") ||
				!("tools" in plugin || "handleApi" in plugin)
			)
				throw new Error("expected apiVersion 1 and a tools or handleApi function");
			active.set(id, plugin as ServerPlugin);
		} catch (error) {
			report(`Plugin ${id} failed to load: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	function toolsForSession(session: ToolSession, occupied: readonly ToolDefinition[] = []) {
		const reserved = new Set(occupied.map((tool) => tool.name));
		const tools = new Map<string, ToolDefinition>();
		for (const [id, plugin] of active) {
			if (!plugin.tools) continue;
			try {
				const contributed = [...plugin.tools(session)];
				const names = new Set<string>();
				for (const tool of contributed) {
					if (!tool?.name || typeof tool.execute !== "function" || !tool.parameters)
						throw new Error("invalid tool definition");
					if (reserved.has(tool.name) || tools.has(tool.name) || names.has(tool.name))
						throw new Error(`duplicate tool name: ${tool.name}`);
					names.add(tool.name);
				}
				for (const tool of contributed) tools.set(tool.name, tool);
			} catch (error) {
				report(`Plugin ${id} could not provide tools: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return [...tools.values()];
	}
	const handleApi: PluginApi = async (request, response, url, parts) => {
		for (const plugin of active.values()) {
			if (plugin.handleApi && (await plugin.handleApi(request, response, url, parts))) return true;
		}
		return false;
	};
	return { toolsForSession, handleApi };
}
