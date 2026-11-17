import type { ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { createHarnessSettings } from "../config.ts";
import { createHashlineTools } from "../tools/hashline/index.ts";
import { ShellProcessManager } from "../tools/shell-process.ts";
import type { WorkspaceFiles } from "../workspace-files.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function hashlinePlugin(files: WorkspaceFiles, isolatedFiles: WorkspaceFiles): ServerPlugin {
	return {
		apiVersion: 1,
		tools: ({ isolated, sessionId, workspaceId }) =>
			createHashlineTools(isolated ? isolatedFiles : files, isolated ? sessionId : workspaceId),
	};
}

export function shellProcessPlugin(agentDir: string): ServerPlugin {
	const processes = new ShellProcessManager();
	return {
		apiVersion: 1,
		tools: ({ sessionId, cwd, selectedTools }) => {
			if (selectedTools && !selectedTools.includes("bash")) return [];
			const settings = createHarnessSettings(cwd, agentDir);
			return [
				processes.createTool(sessionId, cwd, {
					shellPath: settings.getShellPath(),
					commandPrefix: settings.getShellCommandPrefix(),
				}) as unknown as ToolDefinition,
			];
		},
		closeSession: (id) => processes.closeSession(id),
		close: () => processes.close(),
	};
}
