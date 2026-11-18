import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
	type PluginChoice,
	type PluginManagementEntry,
	pluginManagementActionSchema,
} from "../../shared/plugin-profile.ts";
import { HttpError, readJson, sendJson } from "../http-host.ts";
import { readPluginChoices } from "./profile-config.ts";
import type { loadServerProfile, ServerPlugin } from "./server-profile.ts";

type Runtime = Pick<Awaited<ReturnType<typeof loadServerProfile>>, "profile" | "choices" | "builtinIds">;

export function pluginManager(agentDir: string, getRuntime: () => Runtime): ServerPlugin {
	const path = join(agentDir, "plugins.json");
	const requirePlugin = createRequire(path);
	let pending = Promise.resolve();

	function read(): Map<string, PluginChoice> {
		try {
			return readPluginChoices(path);
		} catch (error) {
			throw new HttpError(409, error instanceof Error ? error.message : "Cannot read plugins.json");
		}
	}

	function entries(config: ReadonlyMap<string, PluginChoice>, runtime: Runtime): PluginManagementEntry[] {
		const current = new Map(runtime.profile.plugins.map((plugin) => [plugin.id, plugin]));
		return [...new Set([...current.keys(), ...config.keys()])].map((id) => {
			const builtin = runtime.builtinIds.includes(id);
			const next = config.get(id) ?? { enabled: builtin };
			const running = runtime.choices.get(id) ?? { enabled: builtin };
			return {
				...(current.get(id) ?? { id, title: id, source: "external", status: "disabled", requires: [] }),
				enabled: next.enabled,
				canEnable: !!next.module || builtin,
				module: next.module,
				pending: next.enabled !== running.enabled || next.module !== running.module,
			};
		});
	}

	return {
		apiVersion: 1,
		async handleApi(request, response, url) {
			if (url.pathname !== "/api/plugin-management") return false;
			const runtime = getRuntime();
			if (request.method === "GET") {
				sendJson(response, 200, entries(read(), runtime));
				return true;
			}
			if (request.method !== "PATCH") throw new HttpError(405, "Method is not allowed");
			const action = await readJson(request, pluginManagementActionSchema);
			const task = pending.then(async () => {
				const config = read();
				const builtin = runtime.builtinIds.includes(action.id);
				const current = config.get(action.id);
				if (action.op === "add") {
					try {
						requirePlugin.resolve(resolve(agentDir, action.module));
					} catch {
						throw new HttpError(400, "指定されたプラグインモジュールが見つかりません。");
					}
					config.set(action.id, { module: action.module, enabled: true });
				} else if (action.op === "remove") {
					if (!current?.module && (builtin || !current))
						throw new HttpError(404, "外部プラグインが見つかりません。");
					config.delete(action.id);
				} else {
					if (!builtin && !current?.module) throw new HttpError(404, "プラグインモジュールを登録してください。");
					if (builtin && !current?.module && action.enabled) config.delete(action.id);
					else config.set(action.id, { ...current, enabled: action.enabled });
				}
				const temp = `${path}.${randomUUID()}.tmp`;
				try {
					await writeFile(temp, `${JSON.stringify(Object.fromEntries(config), null, 2)}\n`, {
						flag: "wx",
						mode: 0o600,
					});
					await rename(temp, path);
				} finally {
					await rm(temp, { force: true });
				}
				return entries(config, runtime);
			});
			pending = task.then(
				() => undefined,
				() => undefined,
			);
			sendJson(response, 200, await task);
			return true;
		},
	};
}
