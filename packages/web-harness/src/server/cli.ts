import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Actionable remedy shown when the terminal native module is missing. */
function terminalSupportRemedy(platform: NodeJS.Platform): string {
	return platform === "linux"
		? "No prebuilt binary is bundled for Linux. Install a C++ compiler, make and Python, then run: hasilan-code setup --build-pty"
		: "Reinstall Hasilan Code with the command you used before, then run: hasilan-code setup";
}

/**
 * Reports a terminal addon that cannot load before the server starts, so the user reads the remedy
 * instead of a node-pty stack trace. `load` performs the real native import.
 */
export function terminalSupportFailure(load: () => unknown, platform: NodeJS.Platform): Error | undefined {
	try {
		load();
		return undefined;
	} catch (error) {
		return new Error(
			`The terminal native module (node-pty) cannot be loaded.\n${terminalSupportRemedy(platform)}\nDetails: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export interface CliOptions {
	port: number;
	cwd: string;
	noOpen: boolean;
	help: boolean;
	lan: boolean;
}

export const CLI_HELP = `Hasilan Code

Usage: hasilan-code [--lan] [--no-open] [--port <0..65535>] [--cwd <directory>]

  --port     Loopback HTTP port (default 3080; 0 chooses an OS-assigned port)
  --cwd      Initial workspace directory (default current working directory)
  --no-open  Show launch instructions only (default; never opens a browser automatically)
  --lan      Share on private IPv4 LAN addresses and print authenticated links and terminal QR codes
  --help     Show this help
  --version  Show the Hasilan Code and bundled Pi versions
  setup      Install Chromium; --build-pty explicitly builds the terminal addon

Source checkout: npm run web -- [options]

The server binds to 127.0.0.1 by default; --lan binds to 0.0.0.0 and permits only
local network clients. Shell and browser tools run with your user permissions;
workspace path checks are not a sandbox. LAN HTTP traffic is not encrypted.
`;

export function parseCliArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		port: 3080,
		cwd: process.env.INIT_CWD ?? process.cwd(),
		noOpen: true,
		help: false,
		lan: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--lan") {
			options.lan = true;
			continue;
		}
		if (argument === "--no-open") {
			options.noOpen = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			options.help = true;
			continue;
		}
		const equals = argument.indexOf("=");
		const name = equals === -1 ? argument : argument.slice(0, equals);
		if (name !== "--port" && name !== "--cwd") throw new Error(`Unknown argument: ${name}`);
		const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
		if (value === undefined || value.length === 0 || value.startsWith("--"))
			throw new Error(`${name} requires a value`);
		if (name === "--port") {
			if (!/^\d+$/.test(value) || Number(value) > 65535)
				throw new Error("--port must be an integer from 0 to 65535");
			options.port = Number(value);
		} else {
			options.cwd = value;
		}
	}
	return options;
}

/** An invalid workspace is a startup error; never substitute another directory. */
export async function resolveCliWorkspace(options: Pick<CliOptions, "cwd">): Promise<string> {
	let canonical: string;
	try {
		canonical = await realpath(resolve(options.cwd));
		if (!(await stat(canonical)).isDirectory()) throw new Error("Not a directory");
	} catch {
		throw new Error(`Workspace directory does not exist or is not accessible: ${options.cwd}`);
	}
	return canonical;
}

export interface OpenBrowserOptions {
	noOpen: boolean;
	env?: NodeJS.ProcessEnv;
}

/** Returns false for explicit no-open or SSH; opening failure remains an explicit error. */
export async function openBrowser(url: string, options: OpenBrowserOptions): Promise<boolean> {
	const env = options.env ?? process.env;
	if (options.noOpen || env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) {
		throw new Error("Only the loopback launch URL can be opened");
	}
	const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
	const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
	const opened = Promise.withResolvers<void>();
	const child = spawn(command, args, { env, stdio: "ignore", shell: false, windowsHide: true });
	child.once("error", () => opened.reject(new Error("Could not open the browser; use the launch URL manually")));
	child.once("exit", (code) => {
		if (code === 0) opened.resolve();
		else opened.reject(new Error("Could not open the browser; use the launch URL manually"));
	});
	await opened.promise;
	return true;
}
