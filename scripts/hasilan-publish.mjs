import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execNpmSync } from "./npm-command.mjs";

const args = process.argv.slice(2);
const publish = args.includes("--publish");
const directory = resolve(args.find((arg) => arg !== "--publish") ?? ".artifacts/hasilan-code");
const release = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
assert.equal(release.name, "hasilan-code");
const tarball = join(directory, release.tarball);
const expected = createHash("sha512");
for await (const chunk of createReadStream(tarball)) expected.update(chunk);
const integrity = `sha512-${expected.digest("base64")}`;
const versionUrl = `https://registry.npmjs.org/${release.name}/${release.version}`;

async function verifyPublished() {
	const response = await fetch(versionUrl, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(30000),
	});
	if (response.status === 404) return false;
	if (!response.ok) throw new Error(`npm metadata lookup failed: ${response.status}`);
	const metadata = await response.json();
	assert.equal(metadata.name, release.name);
	assert.equal(metadata.version, release.version);
	assert.equal(metadata.dist.integrity, integrity, "Published version differs from the verified release archive");
	const download = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(120000) });
	if (download.status === 404) return false;
	if (!download.ok || !download.body) throw new Error(`npm archive download failed: ${download.status}`);
	const actual = createHash("sha512");
	for await (const chunk of download.body) actual.update(chunk);
	assert.equal(
		`sha512-${actual.digest("base64")}`,
		integrity,
		"Public npm archive differs from the verified release archive",
	);
	return true;
}

if (!(await verifyPublished())) {
	if (!publish) throw new Error(`${release.name}@${release.version} is not publicly available`);
	execNpmSync(["publish", tarball, "--tag", "latest", "--access", "public", "--provenance", "--ignore-scripts"], {
		cwd: directory,
		stdio: "inherit",
	});
	// Match the upstream release announcement's bounded registry propagation window.
	const deadline = Date.now() + 10 * 60 * 1000;
	while (!(await verifyPublished())) {
		if (Date.now() >= deadline)
			throw new Error(`${release.name}@${release.version} was accepted but is not publicly available`);
		console.log(`Waiting for public npm availability: ${release.name}@${release.version}`);
		await delay(5000);
	}
}
console.log(`Verified public npm archive: ${release.name}@${release.version} (${integrity})`);
