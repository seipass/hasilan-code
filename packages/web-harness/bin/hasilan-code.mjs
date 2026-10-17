#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_HELP, parseCliArgs } from "../dist/server/cli.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
try {
	if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
		console.log(`Hasilan Code ${manifest.version} (Pi ${manifest.hasilanCode.piVersion})`);
	} else if (args[0] === "setup") {
		for (const option of args.slice(1)) {
			if (option !== "--build-pty" && option !== "--skip-browser")
				throw new Error(`Unknown setup option: ${option}`);
		}
		if (args.includes("--build-pty")) {
			console.log("Building node-pty only; this explicitly runs its reviewed install scripts.");
			const command = process.platform === "win32" ? "cmd.exe" : "npm";
			const prefix = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];
			const result = spawnSync(
				command,
				[...prefix, "rebuild", "node-pty", "--ignore-scripts=false", "--foreground-scripts"],
				{ cwd: root, stdio: "inherit" },
			);
			if (result.error) throw result.error;
			if (result.status !== 0)
				throw new Error(
					"node-pty build failed. Install your platform's C++ build tools and Python before retrying.",
				);
		}
		const require = createRequire(import.meta.url);
		if (process.platform === "darwin") {
			const ptyRoot = dirname(require.resolve("node-pty/package.json"));
			for (const directory of [`prebuilds/darwin-${process.arch}`, "build/Release"]) {
				const helper = join(ptyRoot, directory, "spawn-helper");
				if (existsSync(helper)) chmodSync(helper, 0o755);
			}
		}
		if (!args.includes("--skip-browser")) {
			const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
			const result = spawnSync(process.execPath, [cli, "install", "chromium"], { cwd: root, stdio: "inherit" });
			if (result.error) throw result.error;
			if (result.status !== 0)
				throw new Error("Chromium installation failed. Check the Playwright platform dependencies.");
		}
		console.log("Hasilan Code setup completed.");
	} else {
		const options = parseCliArgs(args);
		if (options.help) console.log(CLI_HELP);
		else {
			const child = spawn(process.execPath, [join(root, "dist/server/main.js"), ...args], { stdio: "inherit" });
			child.once("error", (error) => {
				console.error(error.message);
				process.exitCode = 1;
			});
			for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
			child.once("exit", (code, signal) => {
				process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
			});
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
