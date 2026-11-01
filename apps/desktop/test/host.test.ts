import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopHost } from "../src/host.ts";
import { externalLink, localOrigin, readActivity } from "../src/protocol.ts";

test("only an authenticated loopback host and ordinary external links are accepted", () => {
	assert.equal(localOrigin("http://127.0.0.1:3081/?token=private"), "http://127.0.0.1:3081");
	for (const url of ["https://example.com/", "http://localhost:3080/", "http://user@127.0.0.1:3080/"])
		assert.throws(() => localOrigin(url));
	assert.equal(externalLink("https://example.com/test"), "https://example.com/test");
	assert.equal(externalLink("file:///C:/Windows/system.ini"), undefined);
	assert.equal(externalLink("javascript:alert(1)"), undefined);
	assert.equal(readActivity({ runs: 1, queued: 2, terminals: 3 })?.runs, 1);
	assert.equal(readActivity({ runs: 0, queued: -1, terminals: 0 }), undefined);
});

test("private host IPC carries readiness, native picker and activity; shutdown waits for exit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-desktop-ipc-"));
	const entry = join(directory, "host.mjs");
	await writeFile(
		entry,
		`
process.send({type:"pick-folder",id:1,cwd:process.cwd()});
process.on("message", m => {
  if(m.type==="folder" && m.path==="chosen") process.send({type:"ready",url:"http://127.0.0.1:12345/",launchUrl:"http://127.0.0.1:12345/?token=private"});
  if(m.type==="activity") process.send({type:"activity",id:m.id,runs:2,queued:1,terminals:1});
  if(m.type==="shutdown") process.disconnect();
});
process.on("disconnect",()=>process.exit());
`,
	);
	const host = new DesktopHost();
	try {
		const url = await host.start({
			executable: process.execPath,
			entry,
			cwd: directory,
			pickFolder: async () => "chosen",
		});
		assert.match(url, /token=private/);
		assert.deepEqual(await host.activity(), { runs: 2, queued: 1, terminals: 1 });
		await host.stop();
		assert.equal(host.url, undefined);
		await host.stop();
	} finally {
		await host.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("startup errors are reported and the owned child is stopped", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-desktop-failure-"));
	const entry = join(directory, "failure.mjs");
	await writeFile(
		entry,
		'process.send({type:"fatal",message:"Profile is already open"}); process.on("message",()=>process.disconnect());',
	);
	const host = new DesktopHost();
	try {
		await assert.rejects(
			host.start({ executable: process.execPath, entry, cwd: directory, pickFolder: async () => undefined }),
			/Profile is already open/,
		);
	} finally {
		await host.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
