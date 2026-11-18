import type { ToolDefinition } from "@hasilan-code/pi-coding-agent";
import type { SettingsService } from "../settings.ts";
import { SearchService } from "../tools/search.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function webSearchPlugin(getSettings: () => SettingsService): ServerPlugin {
	let search: SearchService | undefined;
	// Pi validates parameters against the tool's own schema before calling execute.
	return {
		apiVersion: 1,
		tools: () => {
			search ??= new SearchService(getSettings());
			return [search.createTool() as unknown as ToolDefinition];
		},
	};
}
