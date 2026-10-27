import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../packages/web-harness/bin/hasilan-code.mjs", import.meta.url));
const child = spawn(process.execPath, [launcher, "--dev", ...process.argv.slice(2)], {
	env: { ...process.env, NODE_ENV: "development" },
	stdio: "inherit",
	windowsHide: true,
});
child.once("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("exit", (code, signal) => {
	process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
