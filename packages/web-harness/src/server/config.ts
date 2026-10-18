import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SettingsManager } from "@hasilan-code/pi-coding-agent";

/** Never consult PI_CODING_AGENT_DIR or Pi's default directory. */
export function getHarnessAgentDir(): string {
	const configured = process.env.HASILAN_CODE_AGENT_DIR;
	if (!configured) return join(homedir(), ".hasilan-code", "agent");
	const expanded =
		configured === "~"
			? homedir()
			: configured.startsWith("~/") || configured.startsWith("~\\")
				? join(homedir(), configured.slice(2))
				: configured;
	if (!isAbsolute(expanded)) throw new Error("HASILAN_CODE_AGENT_DIR must be an absolute path");
	return resolve(expanded);
}

/** Preserve SDK settings semantics while selecting the application's project namespace. */
export function createHarnessSettings(cwd: string, agentDir: string): SettingsManager {
	return SettingsManager.create(cwd, agentDir, { projectConfigDirName: ".hasilan-code" });
}
