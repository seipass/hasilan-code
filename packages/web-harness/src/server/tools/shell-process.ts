import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getShellConfig, type ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { Type } from "typebox";

const schema = Type.Union([
	Type.Object({
		action: Type.Literal("start"),
		command: Type.String({ minLength: 1, maxLength: 131072 }),
		yieldMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
	}),
	Type.Object({
		action: Type.Literal("poll"),
		processId: Type.String(),
		yieldMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
	}),
	Type.Object({
		action: Type.Literal("input"),
		processId: Type.String(),
		text: Type.String({ maxLength: 131072 }),
		yieldMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
	}),
	Type.Object({ action: Type.Literal("stop"), processId: Type.String() }),
]);

interface ProcessEntry {
	child: ChildProcessWithoutNullStreams;
	output: string;
	truncated: boolean;
	finished: boolean;
	exitCode?: number | null;
	error?: string;
	waiters: Set<() => void>;
	expires?: NodeJS.Timeout;
}

/** Owns AI-launched shell processes separately for each conversation. */
export class ShellProcessManager {
	private readonly sessions = new Map<string, Map<string, ProcessEntry>>();

	createTool(
		sessionId: string,
		cwd: string,
		options?: { shellPath?: string; commandPrefix?: string },
	): ToolDefinition<typeof schema> {
		return {
			name: "shell_process",
			label: "Shell process",
			parameters: schema,
			executionMode: "sequential",
			description:
				"Start a shell command and yield while it continues. Use poll to read new output, input to send text to stdin, and stop to terminate it. Each process belongs to this conversation. Output is bounded and consumed by each poll; no pseudo-terminal is allocated.",
			promptSnippet: "Start a long-running shell command, then poll its output or send input",
			promptGuidelines: [
				"Use shell_process for commands that must continue while you work. Poll them for completion and stop processes that are no longer needed.",
			],
			execute: async (_id, input, signal, _update, ctx) => {
				signal?.throwIfAborted();
				const processes = this.sessions.get(sessionId) ?? new Map<string, ProcessEntry>();
				this.sessions.set(sessionId, processes);
				let processId: string;
				let entry: ProcessEntry;
				if (input.action === "start") {
					if (processes.size >= 8)
						throw new Error("Too many retained shell processes; poll completed processes or stop one.");
					const config = getShellConfig(options?.shellPath);
					if (config.commandTransport === "stdin")
						throw new Error(
							"This shell cannot accept both a command and later stdin; use the bash tool instead.",
						);
					const command = options?.commandPrefix ? `${options.commandPrefix}\n${input.command}` : input.command;
					const env: NodeJS.ProcessEnv = { ...process.env, PI_SESSION_ID: sessionId };
					delete env.PI_SESSION_FILE;
					delete env.PI_PROVIDER;
					delete env.PI_MODEL;
					delete env.PI_REASONING_LEVEL;
					const sessionFile = ctx?.sessionManager?.getSessionFile();
					if (sessionFile) env.PI_SESSION_FILE = sessionFile;
					if (ctx?.model) {
						env.PI_PROVIDER = ctx.model.provider;
						env.PI_MODEL = ctx.model.id;
					}
					if (ctx?.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
					const child = spawn(config.shell, [...config.args, command], {
						cwd,
						env,
						detached: process.platform !== "win32",
						windowsHide: true,
						stdio: ["pipe", "pipe", "pipe"],
					});
					processId = randomUUID();
					entry = { child, output: "", truncated: false, finished: false, waiters: new Set() };
					processes.set(processId, entry);
					const append = (value: string) => {
						entry.output += value;
						if (entry.output.length > 256 * 1024) {
							entry.output = entry.output.slice(-256 * 1024);
							entry.truncated = true;
						}
					};
					for (const stream of [child.stdout, child.stderr]) {
						const decoder = new StringDecoder("utf8");
						stream.on("data", (chunk: Buffer) => append(decoder.write(chunk)));
						stream.on("end", () => append(decoder.end()));
					}
					child.stdin.on("error", () => {});
					child.once("error", (error) => {
						entry.error = error.message;
					});
					child.once("close", (code) => {
						entry.finished = true;
						entry.exitCode = code;
						for (const wake of entry.waiters) wake();
						if (this.sessions.get(sessionId) !== processes) return;
						entry.expires = setTimeout(
							() => {
								processes.delete(processId);
								if (!processes.size && this.sessions.get(sessionId) === processes)
									this.sessions.delete(sessionId);
							},
							10 * 60 * 1000,
						);
						entry.expires.unref();
					});
				} else {
					processId = input.processId;
					const found = processes.get(processId);
					if (!found) throw new Error("Shell process not found in this conversation.");
					entry = found;
					if (input.action === "input") {
						if (entry.finished || !entry.child.stdin.writable)
							throw new Error("Shell process is no longer accepting input.");
						entry.child.stdin.write(input.text);
					}
					if (input.action === "stop") this.kill(entry);
				}
				const yieldMs = input.action === "stop" ? 0 : (input.yieldMs ?? 1000);
				if (!entry.finished && yieldMs > 0)
					await new Promise<void>((resolve, reject) => {
						const finish = () => {
							clearTimeout(timer);
							entry.waiters.delete(finish);
							signal?.removeEventListener("abort", abort);
							resolve();
						};
						const abort = () => {
							clearTimeout(timer);
							entry.waiters.delete(finish);
							signal?.removeEventListener("abort", abort);
							if (input.action === "start") this.kill(entry);
							reject(new Error("Operation aborted"));
						};
						const timer = setTimeout(finish, yieldMs);
						entry.waiters.add(finish);
						signal?.addEventListener("abort", abort, { once: true });
						if (signal?.aborted) abort();
					});
				const result = {
					processId,
					status: entry.finished ? "finished" : "running",
					...(entry.finished ? { exitCode: entry.exitCode, error: entry.error } : {}),
					output: entry.output,
					truncated: entry.truncated,
				};
				entry.output = "";
				entry.truncated = false;
				if (entry.finished) {
					clearTimeout(entry.expires);
					processes.delete(processId);
					if (!processes.size && this.sessions.get(sessionId) === processes) this.sessions.delete(sessionId);
				}
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					details: undefined,
					isError: entry.finished && (entry.exitCode !== 0 || !!entry.error),
				};
			},
		};
	}

	private kill(entry: ProcessEntry): void {
		if (entry.finished || !entry.child.pid) return;
		if (process.platform === "win32") {
			const killer = spawn(
				join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(entry.child.pid)],
				{ windowsHide: true, stdio: "ignore" },
			);
			killer.on("error", () => {});
		} else {
			try {
				process.kill(-entry.child.pid, "SIGKILL");
			} catch {
				entry.child.kill("SIGKILL");
			}
		}
	}

	closeSession(sessionId: string): void {
		const processes = this.sessions.get(sessionId);
		if (!processes) return;
		for (const entry of processes.values()) {
			clearTimeout(entry.expires);
			this.kill(entry);
		}
		this.sessions.delete(sessionId);
	}

	close(): void {
		for (const sessionId of this.sessions.keys()) this.closeSession(sessionId);
	}
}
