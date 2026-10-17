import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { WebSocket } from "ws";
import { execNpmSync } from "./npm-command.mjs";

const releaseDirectory = resolve(".artifacts/hasilan-code");
const release = JSON.parse(readFileSync(join(releaseDirectory, "release.json"), "utf8"));
const temporary = mkdtempSync(join(tmpdir(), "hasilan-installed-smoke-"));
let server;
let socket;
try {
	const consumer = join(temporary, "consumer");
	const workspace = join(temporary, "workspace");
	mkdirSync(consumer);
	mkdirSync(workspace);
	writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
	writeFileSync(join(workspace, "smoke.txt"), "Packaged Hasilan Code workspace\n");
	execNpmSync(["install", "--ignore-scripts", "--no-audit", "--no-fund", join(releaseDirectory, release.tarball)], {
		cwd: consumer,
		stdio: "inherit",
	});
	const application = join(consumer, "node_modules/hasilan-code");
	const cli = join(application, "bin/hasilan-code.mjs");
	assert.equal(
		execFileSync(process.execPath, [cli, "--version"], { cwd: workspace, encoding: "utf8" }).trim(),
		`Hasilan Code ${release.version} (Pi ${release.piVersion})`,
	);
	assert.match(
		execFileSync(process.execPath, [cli, "--help"], { cwd: workspace, encoding: "utf8" }),
		/Usage: hasilan-code/,
	);
	const contract = join(temporary, "sdk-contract.mjs");
	writeFileSync(
		contract,
		`import assert from "node:assert/strict";\nimport { AgentSession } from ${JSON.stringify(pathToFileURL(join(application, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href)};\nimport { resolveBlock } from ${JSON.stringify(pathToFileURL(join(application, "dist/server/tools/hashline/blocks.js")).href)};\nassert.equal(typeof AgentSession.prototype.resumeContext, "function");\nassert.equal(typeof AgentSession.prototype.mutateQueuedInput, "function");\nassert.deepEqual(resolveBlock("smoke.ts", ["export function example() {", "  return 1;", "}"], 1), { start: 1, end: 3 });\n`,
	);
	execFileSync(process.execPath, [contract], { cwd: workspace, stdio: "inherit" });
	execFileSync(
		process.execPath,
		[cli, "setup", "--skip-browser", ...(process.argv.includes("--build-pty") ? ["--build-pty"] : [])],
		{
			cwd: workspace,
			stdio: "inherit",
		},
	);
	const launched = Promise.withResolvers();
	let logs = "";
	server = spawn(process.execPath, [cli, "--port", "0", "--cwd", workspace], {
		cwd: workspace,
		env: { ...process.env, HASILAN_CODE_AGENT_DIR: join(temporary, "agent"), PI_OFFLINE: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.once("error", launched.reject);
	server.once("exit", (code) =>
		launched.reject(
			new Error(`Packaged server exited: ${code}; ${logs.replace(/\?token=\S+/g, "?token=<REDACTED>")}`),
		),
	);
	for (const stream of [server.stdout, server.stderr])
		stream.on("data", (data) => {
			logs += data;
			const match = /Open authenticated launch URL: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(logs);
			if (match) launched.resolve(match[1]);
		});
	const timeout = setTimeout(() => launched.reject(new Error("Packaged server launch timed out")), 90_000);
	let launchUrl;
	try {
		launchUrl = await launched.promise;
	} finally {
		clearTimeout(timeout);
	}
	const origin = new URL(launchUrl).origin;
	const exchange = await fetch(launchUrl, { redirect: "manual" });
	assert.equal(exchange.status, 303);
	const cookie = exchange.headers.get("set-cookie").split(";")[0];
	const headers = { cookie, origin, "content-type": "application/json" };
	const page = await fetch(origin, { headers });
	assert.equal(page.status, 200);
	assert.match(await page.text(), /<title>Hasilan Code<\/title>/);
	const workspaces = await (await fetch(`${origin}/api/workspaces`, { headers })).json();
	const directory = workspaces.find((entry) => entry.path === realpathSync.native(workspace));
	assert.ok(directory, "Packaged launch keeps the caller's workspace");
	const created = await fetch(`${origin}/api/terminals`, {
		method: "POST",
		headers,
		body: JSON.stringify({ workspaceId: directory.id, cols: 80, rows: 24 }),
	});
	assert.equal(created.status, 201, await created.clone().text());
	const terminal = await created.json();
	const output = Promise.withResolvers();
	let screen = "";
	let sent = false;
	socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/terminals/${terminal.terminalId}/events`, {
		headers: { cookie, origin },
	});
	socket.once("error", output.reject);
	socket.on("message", (bytes) => {
		const message = JSON.parse(String(bytes));
		if (message.type === "snapshot" || message.type === "data") {
			screen += message.vt ?? message.data;
			socket.send(JSON.stringify({ type: "ack", generation: terminal.generation, seq: message.seq }));
			if (
				stripVTControlCharacters(screen)
					.split(/[\r\n]+/)
					.includes("HASILAN_PACKAGE_PTY_OK")
			)
				output.resolve();
		}
		if (message.type === "control" && !message.controller) socket.send('{"type":"take_control"}');
		if (message.type === "control" && message.controller && !sent) {
			sent = true;
			socket.send(
				JSON.stringify({ type: "input", generation: terminal.generation, data: "echo HASILAN_PACKAGE_PTY_OK\r" }),
			);
		}
		if (message.type === "error") output.reject(new Error(message.message));
	});
	const terminalTimeout = setTimeout(
		() => output.reject(new Error(`Packaged PTY did not execute the smoke command: ${JSON.stringify(screen)}`)),
		30_000,
	);
	try {
		await output.promise;
	} finally {
		clearTimeout(terminalTimeout);
	}
	assert.deepEqual(
		await (await fetch(`${origin}/api/terminals/${terminal.terminalId}`, { method: "DELETE", headers })).json(),
		{ closed: true },
	);
	console.log(
		`Installed Hasilan Code ${release.version}: patched SDK, CLI, authenticated HTTP, workspace and actual PTY passed.`,
	);
} finally {
	socket?.terminate();
	if (server && server.exitCode === null) {
		const stopped = once(server, "exit");
		if (process.platform === "win32")
			execFileSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
		else server.kill("SIGTERM");
		await stopped;
	}
	rmSync(temporary, { recursive: true, force: true });
}
