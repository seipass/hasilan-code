import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PythonDesktop } from "../src/server/tools/computer/backend.ts";
import { desktopPython } from "../src/server/tools/computer/python.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1EAAAAASUVORK5CYII=",
	"base64",
);

describe("Computer Python process boundary", () => {
	let desktop: PythonDesktop;
	let child: EventEmitter & {
		stdin: PassThrough;
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	beforeEach(() => {
		child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		});
		vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
		desktop = new PythonDesktop("unused-agent-dir", "python-for-computer-use");
	});
	afterEach(async () => {
		await desktop.close();
		vi.restoreAllMocks();
	});

	it("passes Unicode and quotes through stdin without placing them in command source or shell arguments", async () => {
		const input = { action: "type" as const, monitor: 1, text: "日本語\n'quoted' $() ; value" };
		let sent = "";
		child.stdin.on("data", (chunk: Buffer) => {
			sent += chunk.toString("utf8");
		});
		const response = desktop.frame(input);
		expect(spawn).toHaveBeenCalledWith(
			"python-for-computer-use",
			["-I", "-u", "-c", desktopPython],
			expect.objectContaining({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }),
		);
		expect(JSON.parse(sent)).toEqual(input);
		child.stdout.write(
			JSON.stringify({
				bounds: { left: -1, top: 0, width: 1, height: 1 },
				width: 1,
				height: 1,
				png: png.toString("base64"),
			}),
		);
		child.emit("close", 0);
		expect(await response).toMatchObject({ png, bounds: { left: -1, top: 0, width: 1, height: 1 } });
	});

	it("reports a permission/setup failure instead of claiming the desktop is ready", async () => {
		const response = desktop.status();
		child.stdout.write(JSON.stringify({ error: "Screen Recording permission is required" }));
		child.emit("close", 1);
		expect(await response).toMatchObject({
			ready: false,
			error: "Screen Recording permission is required",
			setup: expect.arrayContaining([expect.stringContaining("-m pip install mss==10.2.0 pynput==1.8.2")]),
		});
	});

	it.each([
		{ width: 2, height: 1, png: png.toString("base64") },
		{ width: 1, height: 1, png: Buffer.from("not a PNG").toString("base64") },
	])("rejects invalid image bytes or mismatched screenshot geometry: %j", async (image) => {
		const response = desktop.frame({ action: "screenshot", monitor: 1 });
		const rejected = expect(response).rejects.toThrow("invalid PNG");
		child.stdout.write(JSON.stringify({ bounds: { left: 0, top: 0, width: 1, height: 1 }, ...image }));
		child.emit("close", 0);
		await rejected;
	});

	it("requests cooperative cancellation and waits for the helper to release inputs before rejecting", async () => {
		const controller = new AbortController();
		let sent = "";
		child.stdin.on("data", (chunk: Buffer) => {
			sent += chunk.toString("utf8");
		});
		const response = desktop.frame({ action: "drag", monitor: 1 }, controller.signal);
		const rejected = expect(response).rejects.toThrow("cancelled");
		controller.abort();
		expect(sent).toContain("\ncancel\n");
		expect(child.kill).not.toHaveBeenCalled();
		child.emit("close", 1);
		await rejected;
	});

	it("terminates an unresponsive helper after the cancellation grace period", async () => {
		vi.useFakeTimers();
		try {
			const controller = new AbortController();
			const response = desktop.screens(controller.signal);
			const rejected = expect(response).rejects.toThrow("cancelled");
			controller.abort();
			await vi.advanceTimersByTimeAsync(4_999);
			expect(child.kill).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(child.kill).toHaveBeenCalledTimes(1);
			child.emit("close", null);
			await rejected;
		} finally {
			vi.useRealTimers();
		}
	});

	it("sanitizes Python import tracebacks and reports missing executables", async () => {
		const failed = desktop.screens();
		const rejected = expect(failed).rejects.toThrow("check desktop permissions");
		child.stderr.write("Traceback with private environment data");
		child.emit("close", 1);
		await rejected;
		const missing = desktop.screens();
		const missingRejected = expect(missing).rejects.toThrow("Cannot start Python");
		child.emit("error", new Error("ENOENT"));
		child.emit("close", -2);
		await missingRejected;
	});
});
