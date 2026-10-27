import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desktopPython } from "../src/server/tools/computer/python.ts";

const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;
const fixture = fileURLToPath(new URL("./fixtures/computer-helper.py", import.meta.url));

describe.skipIf(!available)("Production Python helper with OS library doubles (requires Python)", () => {
	let directory: string;
	let script: string;
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "hasilan-computer-python-"));
		script = join(directory, "helper.py");
		await writeFile(script, desktopPython);
	});
	afterAll(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});
	async function run(
		input: Record<string, unknown>,
		scenario = "",
		platform = "linux",
	): Promise<{ events: unknown[][]; error?: string; png?: string }> {
		const child = spawn(python, ["-I", "-u", fixture, script], {
			windowsHide: true,
			env: { ...process.env, COMPUTER_TEST_SCENARIO: scenario, COMPUTER_TEST_PLATFORM: platform },
		});
		const chunks: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const result = new Promise<{ events: unknown[][]; error?: string; png?: string }>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch {
					reject(new Error(stderr));
				}
			});
		});
		child.stdin.write(`${JSON.stringify({ monitor: 1, ...input })}\n`);
		return result;
	}

	it.each(["win32", "darwin", "linux"])("captures through the production helper on %s", async (platform) => {
		const result = await run({ action: "screenshot" }, "", platform);
		expect(result.error).toBeUndefined();
		expect(result.png).toBeTruthy();
		expect(result.events).toContainEqual(["capture", { left: -100, top: 20, width: 100, height: 50 }]);
		if (platform === "win32") expect(result.events[0]).toEqual(["dpi"]);
	});
	it("checks geometry before pointer motion or input", async () => {
		const result = await run({
			action: "click",
			x: 5,
			y: 5,
			button: "left",
			count: 1,
			bounds: { left: 0, top: 0, width: 100, height: 50 },
		});
		expect(result.error).toMatch(/geometry changed/);
		expect(result.events).toEqual([]);
	});
	it("types Unicode without interpreting quotes or newline as code", async () => {
		const text = "日本語'\n";
		const result = await run({ action: "type", text });
		expect(result.error).toBeUndefined();
		expect(result.events.filter((event) => event[0] === "type")).toEqual(
			[...text].map((character) => ["type", character]),
		);
	});
	it("moves the pointer without clicking and preserves double-click counts", async () => {
		const hover = await run({ action: "move", x: -50, y: 25 });
		expect(hover.events[0]).toEqual(["move", [-50, 25]]);
		expect(hover.events.some((event) => event[0] === "click")).toBe(false);
		const click = await run({ action: "click", x: -50, y: 25, button: "right", count: 2 });
		expect(click.events).toContainEqual(["click", "right", 2]);
	});
	it("stops text input cooperatively", async () => {
		const result = await run({ action: "type", text: "abcdef" }, "cancel-type");
		expect(result.error).toMatch(/cancelled/);
		expect(result.events).toEqual([["type", "a"]]);
	});
	it("releases held modifier and regular keys even after a key injection error", async () => {
		const result = await run({ action: "press", key: "enter", modifiers: ["ctrl", "shift"] }, "press-error");
		expect(result.error).toBe("input rejected");
		expect(result.events).toEqual([
			["key-down", "ctrl"],
			["key-down", "shift"],
			["key-down", "enter"],
			["key-up", "enter"],
			["key-up", "shift"],
			["key-up", "ctrl"],
		]);
	});
	it("releases the mouse button when a drag is cancelled", async () => {
		const result = await run({ action: "drag", x: -100, y: 20, toX: -20, toY: 50 }, "cancel-drag");
		expect(result.error).toMatch(/cancelled/);
		expect(result.events).toContainEqual(["mouse-down", "left"]);
		expect(result.events.at(-1)).toEqual(["mouse-up", "left"]);
		expect(result.events.some((event) => event[0] === "capture")).toBe(false);
	});
	it.each([
		["up", 0, 3],
		["down", 0, -3],
		["left", -3, 0],
		["right", 3, 0],
	])("maps %s scrolling to the correct axes", async (direction, x, y) => {
		const result = await run({ action: "scroll", x: -20, y: 30, direction, amount: 3 });
		expect(result.events).toContainEqual(["scroll", x, y]);
	});
	it.each([
		["wayland", "linux", "Wayland"],
		["accessibility-denied", "darwin", "Accessibility"],
		["recording-denied", "darwin", "Screen Recording"],
	])("rejects %s before desktop input", async (scenario, platform, message) => {
		const result = await run({ action: "click", x: 1, y: 1 }, scenario, platform);
		expect(result.error).toContain(message);
		expect(result.events).toEqual([]);
	});
});
