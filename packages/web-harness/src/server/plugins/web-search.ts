import type { ToolDefinition } from "@hasilan-code/pi-coding-agent";
import type { SettingsService } from "../settings.ts";
import { SearchService } from "../tools/search.ts";
import type { ToolPlugin } from "./tool-profile.ts";

export function webSearchPlugin(settings: SettingsService): ToolPlugin {
	const search = new SearchService(settings);
	// Pi validates parameters against the tool's own schema before calling execute.
	return { apiVersion: 1, tools: () => [search.createTool() as unknown as ToolDefinition] };
}
