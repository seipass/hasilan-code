#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
let version;
let prefix = join(process.env.LOCALAPPDATA ?? join(homedir(), ".local/share"), "hasilan-code");
let setup = false;
let buildPty = false;
for (let index = 0; index < args.length; index++) {
	if (args[index] === "--version" && args[index + 1]) version = args[++index];
	else if (args[index] === "--prefix" && args[index + 1]) prefix = resolve(args[++index]);
	else if (args[index] === "--setup") setup = true;
	else if (args[index] === "--build-pty") {
		setup = true;
		buildPty = true;
	} else if (args[index] === "--help") {
		console.log(
			"Usage: node install-hasilan.mjs [--version X.Y.Z] [--prefix directory] [--setup] [--build-pty]\nRequires Node.js >=22.19. --setup installs Chromium; --build-pty explicitly runs node-pty's native build scripts.",
		);
		process.exit(0);
	} else throw new Error(`Unknown installer option: ${args[index]}`);
}
if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid Hasilan Code version");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error("Node.js 22.19 or newer is required");
const repository = "https://api.github.com/repos/seipass/hasilan-code";
const response = await fetch(`${repository}/releases/${version ? `tags/hasilan-v${version}` : "latest"}`, {
	headers: { accept: "application/vnd.github+json", "user-agent": "hasilan-code-installer" },
});
if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
const release = await response.json();
const match = /^hasilan-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name);
if (!match || release.draft || (version && version !== match[1])) throw new Error("Unexpected Hasilan Code release");
version = match[1];
const filename = `hasilan-code-${version}.tgz`;
const assets = new Map(release.assets.map((asset) => [asset.name, asset.browser_download_url]));
for (const name of [filename, "SHA256SUMS"]) {
	const url = new URL(assets.get(name) ?? "about:blank");
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		!url.pathname.startsWith(`/seipass/hasilan-code/releases/download/${release.tag_name}/`)
	)
		throw new Error(`Missing or invalid release asset: ${name}`);
}
const checksumsResponse = await fetch(assets.get("SHA256SUMS"));
if (!checksumsResponse.ok) throw new Error(`Checksum download failed: ${checksumsResponse.status}`);
const expected = (await checksumsResponse.text())
	.split(/\r?\n/)
	.map((line) => /^([a-f0-9]{64}) {2}(.+)$/.exec(line))
	.find((entry) => entry?.[2] === filename)?.[1];
if (!expected) throw new Error(`Release checksum missing for ${filename}`);
const temporary = await mkdtemp(join(tmpdir(), "hasilan-install-"));
try {
	const artifact = join(temporary, filename);
	const download = await fetch(assets.get(filename));
	if (!download.ok || !download.body) throw new Error(`Package download failed: ${download.status}`);
	const hash = createHash("sha256");
	await pipeline(
		Readable.fromWeb(download.body),
		new Transform({
			transform(chunk, _encoding, callback) {
				hash.update(chunk);
				callback(null, chunk);
			},
		}),
		createWriteStream(artifact),
	);
	if (hash.digest("hex") !== expected) throw new Error("Package checksum mismatch; installation cancelled");
	const command = process.platform === "win32" ? "cmd.exe" : "npm";
	const npmPrefix = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];
	// npm.cmd needs a shell on Windows. Reject shell metacharacters rather than interpolating them.
	if (process.platform === "win32" && /[&|<>^%\r\n"]/.test(prefix + artifact))
		throw new Error("Windows installation paths cannot contain command-shell metacharacters");
	const install = spawnSync(
		command,
		[
			...npmPrefix,
			"install",
			"--global",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--prefix",
			prefix,
			artifact,
		],
		{ stdio: "inherit" },
	);
	if (install.error) throw install.error;
	if (install.status !== 0) throw new Error("npm installation failed");
	const directory =
		process.platform === "win32"
			? join(prefix, "node_modules/hasilan-code")
			: join(prefix, "lib/node_modules/hasilan-code");
	const cli = join(directory, "bin/hasilan-code.mjs");
	const check = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
	if (check.status !== 0 || !check.stdout.startsWith(`Hasilan Code ${version} `))
		throw new Error("Installed command verification failed");
	if (setup) {
		const result = spawnSync(process.execPath, [cli, "setup", ...(buildPty ? ["--build-pty"] : [])], {
			stdio: "inherit",
		});
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error("Package installed, but setup failed; rerun hasilan-code setup");
	}
	console.log(check.stdout.trim());
	console.log(`Installed to ${prefix}`);
	console.log(`Add ${process.platform === "win32" ? prefix : join(prefix, "bin")} to PATH, then run hasilan-code.`);
	if (!setup)
		console.log(
			"Run hasilan-code setup to prepare terminal permissions and install Chromium. Linux terminals also require hasilan-code setup --build-pty.",
		);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
