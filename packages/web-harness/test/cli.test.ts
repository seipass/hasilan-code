import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBrowser, parseCliArgs, resolveCliWorkspace } from "../src/server/cli.ts";

vi.mock("node:child_process", () => ({
	spawn: () => {
		throw new Error("Unexpected automatic browser launch");
	},
}));

const directories: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CLI startup boundaries", () => {
	it("accepts explicit workspace and port options without exposing a bind option", () => {
		const options = parseCliArgs(["--port", "0", "--cwd", "C:/a folder", "--no-open"]);
		expect(options.port).toBe(0);
		expect(options.cwd).toBe("C:/a folder");
		const equalsOptions = parseCliArgs(["--port=65535", "--cwd=./workspace", "--help"]);
		expect(equalsOptions.port).toBe(65535);
		expect(equalsOptions.cwd).toBe("./workspace");
		expect(equalsOptions.help).toBe(true);
		for (const value of ["-1", "65536", "1.5", "NaN", "1e3", ""]) {
			expect(() => parseCliArgs([`--port=${value}`])).toThrow();
		}
		expect(() => parseCliArgs(["--port"])).toThrow("requires a value");
		expect(() => parseCliArgs(["--host", "0.0.0.0"])).toThrow("Unknown argument");
		expect(() => parseCliArgs(["--cwd", "--no-open"])).toThrow("requires a value");
	});

	it("uses the initiating directory rather than the npm workspace script directory", () => {
		vi.stubEnv("INIT_CWD", "C:/initiating directory");
		expect(parseCliArgs([]).cwd).toBe("C:/initiating directory");
		expect(parseCliArgs(["--cwd", "./explicit"]).cwd).toBe("./explicit");
		vi.stubEnv("INIT_CWD", undefined);
		expect(parseCliArgs([]).cwd).toBe(process.cwd());
	});

	it("canonicalizes real directories and does not substitute missing or file workspaces", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-web-cli-"));
		directories.push(directory);
		await writeFile(join(directory, "file.txt"), "not a directory");
		expect(await resolveCliWorkspace({ cwd: directory })).toBe(await realpath(directory));
		await expect(resolveCliWorkspace({ cwd: join(directory, "missing") })).rejects.toThrow("does not exist");
		await expect(resolveCliWorkspace({ cwd: join(directory, "file.txt") })).rejects.toThrow("does not exist");
	});

	it("does not launch a browser when started without flags", async () => {
		await expect(openBrowser("http://127.0.0.1:3080/", { ...parseCliArgs([]), env: {} })).resolves.toBe(false);
	});

	it("suppresses browser launch for no-open and SSH environments", async () => {
		expect(await openBrowser("http://127.0.0.1:3080/", { noOpen: true, env: {} })).toBe(false);
		for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
			expect(await openBrowser("http://127.0.0.1:3080/", { noOpen: false, env: { [key]: "present" } })).toBe(false);
		}
		await expect(openBrowser("https://evil.example/", { noOpen: false, env: {} })).rejects.toThrow(
			"loopback launch URL",
		);
	});
});
