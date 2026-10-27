import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { COMPUTER_REQUIREMENTS, type ComputerStatus } from "../../../shared/computer.ts";
import { desktopPython } from "./python.ts";

export const boundsSchema = Type.Object({
	left: Type.Integer(),
	top: Type.Integer(),
	width: Type.Integer({ minimum: 1 }),
	height: Type.Integer({ minimum: 1 }),
});
export type ScreenBounds = Static<typeof boundsSchema>;
const screensSchema = Type.Object({
	screens: Type.Array(Type.Intersect([boundsSchema, Type.Object({ index: Type.Integer({ minimum: 1 }) })]), {
		minItems: 1,
	}),
});
const frameSchema = Type.Object({
	bounds: boundsSchema,
	width: Type.Integer({ minimum: 1, maximum: 32768 }),
	height: Type.Integer({ minimum: 1, maximum: 32768 }),
	png: Type.String({ maxLength: 12 * 1024 * 1024 }),
});
export interface DesktopFrame {
	bounds: ScreenBounds;
	width: number;
	height: number;
	png: Buffer;
}
export interface DesktopRequest {
	action: "screens" | "screenshot" | "move" | "click" | "drag" | "scroll" | "type" | "press";
	monitor?: number;
	bounds?: ScreenBounds;
	x?: number;
	y?: number;
	toX?: number;
	toY?: number;
	button?: "left" | "right" | "middle";
	count?: number;
	direction?: "up" | "down" | "left" | "right";
	amount?: number;
	text?: string;
	key?: string;
	modifiers?: string[];
}
export interface DesktopBackend {
	status(): Promise<ComputerStatus>;
	screens(signal?: AbortSignal): Promise<Static<typeof screensSchema>["screens"]>;
	frame(request: DesktopRequest, signal?: AbortSignal): Promise<DesktopFrame>;
	close(): Promise<void>;
}

/** One short-lived, isolated Python process per operation. No shell, clipboard, or global input listener. */
export class PythonDesktop implements DesktopBackend {
	private readonly python: string;
	private readonly shutdown = new AbortController();
	private readonly pending = new Set<Promise<unknown>>();
	constructor(agentDir: string, python?: string) {
		const managed = join(
			agentDir,
			"computer-use",
			process.platform === "win32" ? "Scripts/python.exe" : "bin/python3",
		);
		this.python =
			python ??
			process.env.HASILAN_CODE_COMPUTER_PYTHON ??
			(existsSync(managed) ? managed : process.platform === "win32" ? "python" : "python3");
	}
	async status(): Promise<ComputerStatus> {
		const executable =
			process.platform === "win32"
				? `& '${this.python.replaceAll("'", "''")}'`
				: `'${this.python.replaceAll("'", "'\\''")}'`;
		const setup = [
			`${executable} -m pip install ${COMPUTER_REQUIREMENTS.join(" ")}`,
			"別のPythonを使う場合は HASILAN_CODE_COMPUTER_PYTHON に実行ファイルのパスを指定してください。",
		];
		try {
			await this.screens();
			return { ready: true, platform: process.platform, setup };
		} catch (error) {
			return {
				ready: false,
				platform: process.platform,
				setup,
				error: error instanceof Error ? error.message : "Computer use is unavailable",
			};
		}
	}
	async screens(signal?: AbortSignal) {
		const result = await this.run({ action: "screens" }, signal);
		if (!Check(screensSchema, result)) throw new Error("Invalid monitor response from computer backend");
		return result.screens;
	}
	async frame(request: DesktopRequest, signal?: AbortSignal): Promise<DesktopFrame> {
		const result = await this.run(request, signal);
		if (!Check(frameSchema, result)) throw new Error("Invalid screenshot response from computer backend");
		const png = Buffer.from(result.png, "base64");
		if (
			png.length > 8 * 1024 * 1024 ||
			png.length < 24 ||
			png.readUInt32BE(0) !== 0x89504e47 ||
			png.readUInt32BE(4) !== 0x0d0a1a0a ||
			png.toString("ascii", 12, 16) !== "IHDR" ||
			png.readUInt32BE(16) !== result.width ||
			png.readUInt32BE(20) !== result.height
		)
			throw new Error("Computer backend returned an invalid PNG screenshot");
		return { bounds: result.bounds, width: result.width, height: result.height, png };
	}
	async close(): Promise<void> {
		this.shutdown.abort();
		await Promise.allSettled(this.pending);
	}
	private run(request: DesktopRequest, signal?: AbortSignal): Promise<unknown> {
		const combined = AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]);
		combined.throwIfAborted();
		const operation = new Promise<unknown>((resolve, reject) => {
			const child = spawn(this.python, ["-I", "-u", "-c", desktopPython], {
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const chunks: Buffer[] = [];
			let size = 0;
			let failure: Error | undefined;
			let killing: ReturnType<typeof setTimeout> | undefined;
			const cancel = (reason: string) => {
				failure ??= new Error(reason);
				if (killing) return;
				child.stdin.end("cancel\n");
				// Cooperative cancellation lets the helper release held keys/buttons first.
				killing = setTimeout(() => child.kill(), 5_000);
			};
			const onAbort = () => cancel("Computer operation cancelled");
			const timeout = setTimeout(() => cancel("Computer operation timed out"), 20_000);
			child.stdout.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > 12 * 1024 * 1024) cancel("Computer backend response exceeds the output limit");
				else chunks.push(chunk);
			});
			child.stderr.resume();
			child.stdin.on("error", () => undefined);
			child.on("error", () => {
				failure ??= new Error(
					"Cannot start Python for computer use; check Settings and HASILAN_CODE_COMPUTER_PYTHON",
				);
			});
			child.on("close", (code) => {
				clearTimeout(timeout);
				clearTimeout(killing);
				combined.removeEventListener("abort", onAbort);
				if (failure) {
					reject(failure);
					return;
				}
				try {
					const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					if (result && typeof result === "object" && "error" in result && typeof result.error === "string")
						throw new Error(result.error.slice(0, 500));
					if (code !== 0)
						throw new Error("Computer backend failed; check desktop permissions and Python packages in Settings");
					resolve(result);
				} catch (error) {
					reject(
						error instanceof SyntaxError
							? new Error("Computer backend failed; check desktop permissions and Python packages in Settings")
							: error,
					);
				}
			});
			child.stdin.write(`${JSON.stringify(request)}\n`);
			combined.addEventListener("abort", onAbort, { once: true });
			if (combined.aborted) onAbort();
		});
		this.pending.add(operation);
		void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
		return operation;
	}
}
