import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Provider } from "@hasilan-code/pi-ai";
import type { ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { Check } from "typebox/value";
import {
	type ExternalPanelEntry,
	type PluginChoice,
	type PluginProfile,
	type PluginStatus,
	type ThemePlugin,
	themePluginSchema,
	WORKSPACE_UI_ID,
} from "../../shared/plugin-profile.ts";
import { validateState } from "../session-registry.ts";
import { readPluginChoices } from "./profile-config.ts";
import type { RuntimeContextFactory, ToolFactory, ToolSession } from "./session.ts";
import type { SessionPersistence, SessionStorage } from "./session-storage.ts";

export type PluginApi = (
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	parts: readonly string[],
) => boolean | Promise<boolean>;

export interface ServerPlugin {
	readonly apiVersion: 1;
	readonly requires?: readonly string[];
	readonly tools?: ToolFactory;
	readonly context?: RuntimeContextFactory;
	readonly providers?: readonly Provider[];
	readonly sessionStorage?: SessionStorage;
	readonly handleApi?: PluginApi;
	readonly panel?: { readonly title: string; readonly script: string; readonly scope?: "application" };
	readonly bundledApplication?: true;
	readonly bundledModelProviders?: true;
	readonly theme?: ThemePlugin;
	readonly closeSession?: (sessionId: string) => void | Promise<void>;
	readonly close?: () => void | Promise<void>;
}

function isProvider(value: unknown): value is Provider {
	if (!value || typeof value !== "object") return false;
	const provider = value as Partial<Provider>;
	return (
		typeof provider.id === "string" &&
		!!provider.id.trim() &&
		typeof provider.name === "string" &&
		!!provider.name.trim() &&
		!!provider.auth &&
		typeof provider.auth === "object" &&
		!!(provider.auth.apiKey || provider.auth.oauth) &&
		typeof provider.getModels === "function" &&
		typeof provider.stream === "function" &&
		typeof provider.streamSimple === "function"
	);
}

export async function loadServerProfile(
	agentDir: string,
	builtins: ReadonlyMap<string, () => ServerPlugin>,
	report = (message: string) => console.error(message),
) {
	const profilePath = join(agentDir, "plugins.json");
	let choices = new Map<string, PluginChoice>();
	try {
		choices = readPluginChoices(profilePath, report);
	} catch (error) {
		report(`Cannot read plugins.json: ${error instanceof Error ? error.message : String(error)}`);
	}

	const requirePlugin = createRequire(profilePath);
	const candidates = new Map<
		string,
		{
			plugin: ServerPlugin;
			panel?: ExternalPanelEntry;
			script?: string;
			theme?: ThemePlugin;
		}
	>();
	const inventory = new Map<string, PluginStatus>();
	const panels: PluginProfile["panels"] = [];
	const themes: PluginProfile["themes"] = [];
	const scripts = new Map<string, string>();
	for (const id of new Set([...builtins.keys(), ...choices.keys()])) {
		const choice = choices.get(id);
		const status: PluginStatus = {
			id,
			title: id,
			source: choice?.module || !builtins.has(id) ? "external" : "built-in",
			status: "disabled",
			requires: [],
		};
		inventory.set(id, status);
		if (choice?.enabled === false) continue;
		try {
			const modulePath = choice?.module ? requirePlugin.resolve(resolve(agentDir, choice.module)) : undefined;
			const plugin: unknown = modulePath ? requirePlugin(modulePath) : builtins.get(id)?.();
			if (
				!plugin ||
				typeof plugin !== "object" ||
				!("apiVersion" in plugin) ||
				plugin.apiVersion !== 1 ||
				("tools" in plugin && typeof plugin.tools !== "function") ||
				("context" in plugin && typeof plugin.context !== "function") ||
				("handleApi" in plugin && typeof plugin.handleApi !== "function") ||
				("closeSession" in plugin && typeof plugin.closeSession !== "function") ||
				("close" in plugin && typeof plugin.close !== "function") ||
				("bundledApplication" in plugin && (modulePath || plugin.bundledApplication !== true)) ||
				("bundledModelProviders" in plugin && (modulePath || plugin.bundledModelProviders !== true)) ||
				!(
					"tools" in plugin ||
					"context" in plugin ||
					"providers" in plugin ||
					"sessionStorage" in plugin ||
					"handleApi" in plugin ||
					"panel" in plugin ||
					"theme" in plugin ||
					"bundledApplication" in plugin ||
					"bundledModelProviders" in plugin
				)
			)
				throw new Error("expected apiVersion 1 and a supported plugin contribution");
			if ("providers" in plugin && (!Array.isArray(plugin.providers) || !plugin.providers.every(isProvider)))
				throw new Error("providers must be a list of Pi providers");
			if ("sessionStorage" in plugin) {
				const storage = plugin.sessionStorage as Partial<SessionStorage> | undefined;
				if (
					!storage ||
					typeof storage.sessionsDirectory !== "string" ||
					!isAbsolute(storage.sessionsDirectory) ||
					typeof storage.importAssetsDirectory !== "string" ||
					!isAbsolute(storage.importAssetsDirectory) ||
					typeof storage.readState !== "function" ||
					typeof storage.writeState !== "function"
				)
					throw new Error("sessionStorage must declare absolute directories and provide readState and writeState");
			}
			const requires = "requires" in plugin ? plugin.requires : [];
			if (!Array.isArray(requires) || requires.some((name: unknown) => typeof name !== "string" || !name.trim()))
				throw new Error("requires must be a list of plugin IDs");
			status.requires = [...new Set(requires)];
			const theme = "theme" in plugin ? plugin.theme : undefined;
			if ("theme" in plugin && (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) || !Check(themePluginSchema, theme)))
				throw new Error("invalid theme declaration");
			let entry: ExternalPanelEntry | undefined;
			let script: string | undefined;
			if ("panel" in plugin) {
				const panel = plugin.panel;
				if (
					!modulePath ||
					id === "chat" ||
					!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) ||
					!panel ||
					typeof panel !== "object" ||
					!("title" in panel) ||
					typeof panel.title !== "string" ||
					!panel.title.trim() ||
					panel.title.length > 100 ||
					!("script" in panel) ||
					typeof panel.script !== "string" ||
					!/\.(?:m?js)$/.test(panel.script) ||
					("scope" in panel && panel.scope !== "application")
				)
					throw new Error("invalid panel declaration");
				const directory = dirname(realpathSync(modulePath));
				script = realpathSync(resolve(directory, panel.script));
				const fromModule = relative(directory, script);
				if (!fromModule || isAbsolute(fromModule) || fromModule === ".." || fromModule.startsWith(`..${sep}`))
					throw new Error("panel script must be inside the plugin directory");
				entry = { id, title: panel.title.trim(), ...("scope" in panel ? { scope: "application" as const } : {}) };
			}
			const palette = Check(themePluginSchema, theme) ? theme : undefined;
			status.title = entry?.title ?? palette?.title ?? id;
			candidates.set(id, { plugin: plugin as ServerPlugin, panel: entry, script, theme: palette });
		} catch (error) {
			status.status = "failed";
			status.reason = error instanceof Error ? error.message : String(error);
			report(`Plugin ${id} failed to load: ${status.reason}`);
		}
	}
	const active = new Map<string, ServerPlugin>();
	const providers = new Map<string, Provider>();
	const persistence: { selected: SessionPersistence | null } = { selected: null };
	const visiting = new Set<string>();
	async function activate(id: string): Promise<boolean> {
		const candidate = candidates.get(id);
		const status = inventory.get(id);
		if (!candidate || !status || status.status === "blocked" || status.status === "failed") return false;
		if (active.has(id)) return true;
		visiting.add(id);
		for (const dependency of status.requires) {
			const cycle = visiting.has(dependency);
			if (!cycle && (await activate(dependency))) continue;
			status.status = "blocked";
			status.reason = cycle
				? `Dependency cycle involving ${dependency}`
				: `Required plugin ${dependency} is unavailable`;
			report(`Plugin ${id} could not activate: ${status.reason}`);
			visiting.delete(id);
			return false;
		}
		visiting.delete(id);
		const contributedProviders = new Map<string, Provider>();
		for (const provider of candidate.plugin.providers ?? []) {
			if (providers.has(provider.id) || contributedProviders.has(provider.id)) {
				status.status = "failed";
				status.reason = `Duplicate model provider: ${provider.id}`;
				report(`Plugin ${id} could not activate: ${status.reason}`);
				return false;
			}
			contributedProviders.set(provider.id, provider);
		}
		const storage = candidate.plugin.sessionStorage;
		if (storage) {
			try {
				if (persistence.selected) throw new Error("A session storage plugin is already active");
				const state = await storage.readState();
				if (state !== undefined) validateState(state);
				persistence.selected = { storage, restoredState: state };
			} catch (error) {
				status.status = "failed";
				status.reason = error instanceof Error ? error.message : String(error);
				report(`Plugin ${id} could not activate: ${status.reason}`);
				try {
					await candidate.plugin.close?.();
				} catch (cleanupError) {
					report(
						`Plugin ${id} failed to clean up: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
					);
				}
				return false;
			}
		}
		for (const [providerId, provider] of contributedProviders) providers.set(providerId, provider);
		status.status = "enabled";
		active.set(id, candidate.plugin);
		if (candidate.panel && candidate.script) {
			panels.push(candidate.panel);
			scripts.set(id, candidate.script);
		}
		if (candidate.theme) themes.push({ id, customizable: status.source === "built-in", ...candidate.theme });
		return true;
	}
	for (const id of candidates.keys()) await activate(id);
	const applicationPanels = panels.filter((panel) => panel.scope === "application");
	const bundledApplication = active.get(WORKSPACE_UI_ID)?.bundledApplication === true;
	const applicationPanel =
		applicationPanels.find((panel) => panel.id === WORKSPACE_UI_ID) ??
		(bundledApplication ? undefined : applicationPanels[0]);
	const application: PluginProfile["application"] = applicationPanel
		? { kind: "external", panel: applicationPanel }
		: bundledApplication
			? { kind: "built-in" }
			: null;
	function toolsForSession(session: ToolSession) {
		const tools = new Map<string, ToolDefinition>();
		for (const [id, plugin] of active) {
			if (!plugin.tools) continue;
			try {
				const contributed = [...plugin.tools(session)];
				const names = new Set<string>();
				for (const tool of contributed) {
					if (!tool?.name || typeof tool.execute !== "function" || !tool.parameters)
						throw new Error("invalid tool definition");
					if (tools.has(tool.name) || names.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
					names.add(tool.name);
				}
				for (const tool of contributed) tools.set(tool.name, tool);
			} catch (error) {
				report(`Plugin ${id} could not provide tools: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return [...tools.values()];
	}
	const contextPlugins = [...active].filter(([, plugin]) => plugin.context);
	const contextForSession: RuntimeContextFactory = (session) => {
		const sections: string[] = [];
		for (const [id, plugin] of contextPlugins) {
			try {
				const result = plugin.context?.(session);
				if (!Array.isArray(result) || result.some((section: unknown) => typeof section !== "string"))
					throw new Error("context must return a list of strings");
				for (const section of result) if (section.trim()) sections.push(section);
			} catch (error) {
				report(`Plugin ${id} could not provide context: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return sections;
	};
	const handleApi: PluginApi = async (request, response, url, parts) => {
		for (const plugin of active.values()) {
			if (plugin.handleApi && (await plugin.handleApi(request, response, url, parts))) return true;
		}
		return false;
	};
	async function dispose(action: (plugin: ServerPlugin) => void | Promise<void>) {
		for (const [id, plugin] of [...active].reverse()) {
			try {
				await action(plugin);
			} catch (error) {
				report(`Plugin ${id} failed to clean up: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return {
		profile: {
			activeIds: [...active.keys()],
			panels,
			themes,
			plugins: [...inventory.values()],
			persistentSessions: persistence.selected !== null,
			application,
		} satisfies PluginProfile,
		choices,
		builtinIds: [...builtins.keys()],
		includeBuiltinProviders: [...active.values()].some((plugin) => plugin.bundledModelProviders === true),
		providers: [...providers.values()],
		takePersistence() {
			const selected = persistence.selected;
			persistence.selected = null;
			return selected;
		},
		isBuiltinActive: (id: string) => inventory.get(id)?.source === "built-in" && active.has(id),
		toolsForSession,
		contextForSession,
		handleApi,
		closeSession: (sessionId: string) => dispose((plugin) => plugin.closeSession?.(sessionId)),
		close: () => dispose((plugin) => plugin.close?.()),
		async panelScript(id: string) {
			const path = scripts.get(id);
			return path ? readFile(path) : undefined;
		},
	};
}
