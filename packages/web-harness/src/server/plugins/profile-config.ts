import { readFileSync } from "node:fs";
import { Check } from "typebox/value";
import { type PluginChoice, pluginChoiceSchema } from "../../shared/plugin-profile.ts";

export function readPluginChoices(path: string, onInvalid?: (message: string) => void): Map<string, PluginChoice> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
		throw error;
	}
	const data: unknown = JSON.parse(text);
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new Error("expected a map of plugin IDs to configuration");
	const choices = new Map<string, PluginChoice>();
	for (const [id, value] of Object.entries(data) as [string, unknown][]) {
		if (!Check(pluginChoiceSchema, value)) {
			const message = `Plugin ${id}: invalid configuration in plugins.json`;
			if (!onInvalid) throw new Error(message);
			onInvalid(message);
			continue;
		}
		choices.set(
			id,
			typeof value === "string" ? { enabled: true, module: value } : value === false ? { enabled: false } : value,
		);
	}
	return choices;
}
