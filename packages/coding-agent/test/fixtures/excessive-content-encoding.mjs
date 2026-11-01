import assert from "node:assert/strict";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import * as undici from "undici";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";

// Run in a child process: the regression escapes fetch's rejection handler.
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) {
	delete process.env[key];
}
if (process.argv[2] === "configured-global") configureHttpDispatcher();
const fetcher = process.argv[2] === "configured-global" ? globalThis.fetch : undici.fetch;
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
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	const address = server.address();
	assert(address && typeof address !== "string");
	await assert.rejects(fetcher(`http://127.0.0.1:${address.port}/`), /fetch failed/);
	// Give the prematurely closed body time to emit its asynchronous error.
	await setTimeout(100);
} finally {
	await undici.getGlobalDispatcher().close();
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
console.log("survived excessive content encodings");
