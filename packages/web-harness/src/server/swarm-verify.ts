import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getShellConfig } from "@hasilan-code/pi-coding-agent";
import { createHarnessSettings } from "./config.ts";

const OUTPUT_LIMIT = 16_384;

export interface VerificationRunResult {
	exitCode: number;
	output: string;
	truncated: boolean;
	timedOut: boolean;
}

function terminateChild(pid: number | undefined, kill: () => void): void {
	if (pid && process.platform !== "win32") {
		try {
			process.kill(-pid, "SIGTERM");
			return;
		} catch {
			// Fall back to direct child kill if the process group already exited.
		}
	}
	try {
		kill();
	} catch {
		// Process already exited.
	}
}

export async function runSwarmVerification(
	command: string,
	cwd: string,
	options: { agentDir?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<VerificationRunResult> {
	options.signal?.throwIfAborted();
	const settings = options.agentDir ? createHarnessSettings(cwd, options.agentDir) : undefined;
	const config = getShellConfig(settings?.getShellPath());
	const commandPrefix = settings?.getShellCommandPrefix();
	const fullCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
	const stdinTransport = config.commandTransport === "stdin";
	const args = stdinTransport ? [...config.args] : [...config.args, fullCommand];
	const child = spawn(config.shell, args, {
		cwd,
		env: { ...process.env },
		detached: process.platform !== "win32",
		windowsHide: true,
		stdio: [stdinTransport ? "pipe" : "ignore", "pipe", "pipe"],
	});
	if (stdinTransport && child.stdin) {
		child.stdin.end(`${fullCommand}\n`);
	}
	return new Promise<VerificationRunResult>((resolve, reject) => {
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let output = "";
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const append = (chunk: string) => {
			if (!chunk) return;
			output += chunk;
			if (output.length > OUTPUT_LIMIT) {
				output = output.slice(-OUTPUT_LIMIT);
				truncated = true;
			}
		};
		const cleanup = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			terminateChild(child.pid, () => child.kill("SIGTERM"));
			if (!settled) {
				settled = true;
				cleanup();
				reject(new Error("Verification cancelled"));
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			terminateChild(child.pid, () => child.kill("SIGTERM"));
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => append(stdoutDecoder.write(chunk)));
		child.stderr?.on("data", (chunk: Buffer) => append(stderrDecoder.write(chunk)));
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			cleanup();
			append(stdoutDecoder.end());
			append(stderrDecoder.end());
			const exitCode = timedOut ? 124 : (code ?? (signal ? 1 : 0));
			resolve({ exitCode, output: output.trim(), truncated, timedOut });
		});
	});
}
