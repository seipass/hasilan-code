import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import * as undici from "undici";
import { startHarness } from "../../src/server/main.ts";
import { WidgetData } from "../../src/server/widget-data.ts";

const root = await mkdtemp(join(tmpdir(), "hasilan-http-startup-"));
process.env.HASILAN_CODE_AGENT_DIR = join(root, "agent");
process.env.PI_OFFLINE = "1";
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) {
	delete process.env[key];
}
let harness;
const server = createServer((socket) => {
	socket.on("error", () => {});
	socket.once("data", () => {
		socket.end(
			"HTTP/1.1 200 OK\r\n" +
				"Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\n" +
				"Content-Length: 100\r\nConnection: close\r\n\r\n",
		);
	});
});
try {
	harness = await startHarness({ cwd: root, port: 0, noOpen: true, help: false, lan: false, development: false });
	assert.equal(globalThis.fetch, undici.fetch, "Hasilan must use the patched undici fetch");
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const widgets = new WidgetData();
	await assert.rejects(widgets.read(new URL(`http://127.0.0.1:${address.port}/`), 0, (value) => value));
	await setTimeout(100);
} finally {
	await harness?.shutdown();
	if (server.listening) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	await undici.getGlobalDispatcher().close();
	await rm(root, { recursive: true, force: true });
}
console.log("survived excessive content encodings");
