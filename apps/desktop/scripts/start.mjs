import { spawn } from "node:child_process";
import { appDirectory, provision } from "./provision.mjs";

const executable = await provision();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// This is the user-facing GUI. SW_HIDE suppresses its first show/paint on Windows.
const child = spawn(executable, [appDirectory, ...process.argv.slice(2)], {
	stdio: "inherit",
	windowsHide: false,
	env,
});
child.once("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
child.once("exit", (code) => {
	process.exitCode = code ?? 1;
});
