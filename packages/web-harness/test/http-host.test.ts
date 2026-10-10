import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ArtifactStore } from "../src/server/artifacts.ts";
import {
	createHttpHost,
	type HttpHost,
	type HttpHostOptions,
	readJson,
	sendJson,
	sendWebSocket,
} from "../src/server/http-host.ts";

interface Reply {
	status: number;
	headers: IncomingHttpHeaders;
	bytes: Buffer;
}

function http(
	origin: string,
	path: string,
	headers: Record<string, string> = {},
	method = "GET",
	body?: string,
): Promise<Reply> {
	const result = Promise.withResolvers<Reply>();
	const req = request(`${origin}${path}`, { method, headers }, (response) => {
		const chunks: Buffer[] = [];
		response.on("data", (chunk: Buffer) => chunks.push(chunk));
		response.once("end", () =>
			result.resolve({ status: response.statusCode ?? 0, headers: response.headers, bytes: Buffer.concat(chunks) }),
		);
		response.once("error", result.reject);
	});
	req.once("error", result.reject);
	req.end(body);
	return result.promise;
}

const hosts: HttpHost[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];

async function start(options: HttpHostOptions = {}) {
	const host = createHttpHost({ port: 0, ...options });
	hosts.push(host);
	const address = await host.listen();
	const exchange = await http(address.origin, new URL(address.launchUrl).pathname + new URL(address.launchUrl).search);
	const setCookie = exchange.headers["set-cookie"]?.[0];
	if (!setCookie) throw new Error("Launch exchange did not set a cookie");
	return { ...address, cookie: setCookie.split(";")[0], setCookie };
}

async function wsStatus(origin: string, headers: Record<string, string>): Promise<number> {
	const status = Promise.withResolvers<number>();
	const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/events`, { headers });
	sockets.push(socket);
	socket.once("unexpected-response", (_request, response) => {
		response.resume();
		status.resolve(response.statusCode ?? 0);
		socket.terminate();
	});
	socket.once("open", () => status.resolve(101));
	socket.once("error", status.reject);
	return status.promise;
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) {
		if (socket.readyState === WebSocket.OPEN) socket.terminate();
	}
	await Promise.all(hosts.splice(0).map((host) => host.close()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("loopback HTTP boundary", () => {
	it("exchanges only the launch token for a scoped HttpOnly cookie and redirects without the token", async () => {
		const address = await start({
			handleApi: (_request, response) => {
				sendJson(response, 200, { ok: true });
				return true;
			},
		});
		expect(new URL(address.launchUrl).searchParams.get("token")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(address.setCookie).toContain("HttpOnly");
		expect(address.setCookie).toContain("SameSite=Strict");
		expect(address.setCookie).toContain("Path=/");
		const valid = await http(address.origin, `/?token=${new URL(address.launchUrl).searchParams.get("token")}`);
		expect(valid.status).toBe(303);
		expect(valid.headers.location).toBe("/");
		expect(valid.headers["referrer-policy"]).toBe("no-referrer");
		expect((await http(address.origin, "/?token=incorrect")).status).toBe(401);
		expect((await http(address.origin, "/api/sessions")).status).toBe(401);
		expect((await http(address.origin, `/api/sessions${new URL(address.launchUrl).search}`)).status).toBe(401);
		expect((await http(address.origin, "/api/sessions", { Cookie: address.cookie })).status).toBe(200);
		expect(
			(await http(address.origin, "/api/sessions", { Cookie: `${address.cookie}; ${address.cookie}` })).status,
		).toBe(401);
	});

	it("rejects foreign Host and absent or foreign mutation Origin before invoking the API", async () => {
		let accepted = 0;
		const address = await start({
			handleApi: (_request, response) => {
				accepted++;
				sendJson(response, 200, { ok: true });
				return true;
			},
		});
		for (const host of ["evil.example", `localhost:${new URL(address.origin).port}`, "127.0.0.1:1"]) {
			expect((await http(address.origin, "/api/sessions", { Cookie: address.cookie, Host: host })).status).toBe(403);
			expect((await http(address.origin, "/", { Host: host })).status).toBe(403);
		}
		for (const origin of [undefined, "null", "http://evil.example", `${address.origin}0`]) {
			const headers: Record<string, string> = { Cookie: address.cookie };
			if (origin !== undefined) headers.Origin = origin;
			expect((await http(address.origin, "/api/sessions", headers, "POST")).status).toBe(403);
		}
		expect(accepted).toBe(0);
		const response = await http(
			address.origin,
			"/api/sessions",
			{ Cookie: address.cookie, Origin: address.origin },
			"POST",
		);
		expect(response.status).toBe(200);
		expect(accepted).toBe(1);
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("allows the static UI without authorizing the API and sets anti-execution headers", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-web-static-"));
		directories.push(directory);
		await writeFile(join(directory, "index.html"), "<!doctype html><title>Local UI</title>");
		const address = await start({ staticDir: directory });
		const response = await http(address.origin, "/");
		expect(response.status).toBe(200);
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		expect(response.headers["content-security-policy"]).toContain("object-src 'none'");
		expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
		expect((await http(address.origin, "/api/settings")).status).toBe(401);
		expect((await http(address.origin, "/%2e%2e%2fprivate.txt")).status).toBe(403);
		expect((await http(address.origin, "/C:%5cprivate.txt")).status).toBe(403);
	});

	it("requires cookie, exact Host and exact Origin on WebSocket upgrades", async () => {
		const address = await start({
			handleWebSocket: (socket) => {
				sendWebSocket(socket, { connected: true });
			},
		});
		expect(await wsStatus(address.origin, { Origin: address.origin })).toBe(401);
		expect(await wsStatus(address.origin, { Cookie: address.cookie })).toBe(403);
		expect(await wsStatus(address.origin, { Cookie: address.cookie, Origin: "http://evil.example" })).toBe(403);
		expect(
			await wsStatus(address.origin, { Cookie: address.cookie, Origin: address.origin, Host: "evil.example" }),
		).toBe(403);
		const received = Promise.withResolvers<string>();
		const socket = new WebSocket(`${address.origin.replace("http:", "ws:")}/api/events`, {
			headers: { Cookie: address.cookie, Origin: address.origin },
		});
		sockets.push(socket);
		socket.once("message", (data) => received.resolve(data.toString()));
		socket.once("error", received.reject);
		expect(JSON.parse(await received.promise)).toEqual({ connected: true });
	});

	it("serves only signature-checked authenticated image artifacts and removes session-owned content", async () => {
		const artifacts = new ArtifactStore();
		const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
		const reference = artifacts.put({ sessionId: "session", agentId: "agent", bytes: png, mimeType: "image/png" });
		expect(() =>
			artifacts.put({
				sessionId: "session",
				agentId: "agent",
				bytes: Buffer.from("<script>alert(1)</script>"),
				mimeType: "image/png",
			}),
		).toThrow("signature");
		const address = await start({ artifacts });
		expect((await http(address.origin, reference.url)).status).toBe(401);
		const response = await http(address.origin, reference.url, { Cookie: address.cookie });
		expect(response.status).toBe(200);
		expect(response.bytes).toEqual(png);
		expect(response.headers["content-type"]).toBe("image/png");
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		expect(response.headers["cache-control"]).toBe("private, no-store");
		artifacts.deleteSession("session");
		expect((await http(address.origin, reference.url, { Cookie: address.cookie })).status).toBe(404);
	});

	it("validates bounded UTF-8 JSON and redacts unexpected errors", async () => {
		const schema = Type.Object({ text: Type.String() }, { additionalProperties: false });
		const address = await start({
			handleApi: async (req, res, url) => {
				if (url.pathname === "/api/secret-error") throw new Error("secret-key-do-not-expose");
				const body = await readJson(req, schema, 128);
				sendJson(res, 200, body);
				return true;
			},
		});
		const headers = { Cookie: address.cookie, Origin: address.origin, "Content-Type": "application/json" };
		expect((await http(address.origin, "/api/input", headers, "POST", '{"text":"ok"}')).status).toBe(200);
		expect((await http(address.origin, "/api/input", headers, "POST", '{"text":1}')).status).toBe(400);
		expect((await http(address.origin, "/api/input", headers, "POST", "not-json")).status).toBe(400);
		expect(
			(await http(address.origin, "/api/input", headers, "POST", JSON.stringify({ text: "a".repeat(129) }))).status,
		).toBe(413);
		expect(
			(await http(address.origin, "/api/input", { ...headers, "Content-Type": "text/plain" }, "POST", "text"))
				.status,
		).toBe(415);
		const failure = await http(address.origin, "/api/secret-error", headers);
		expect(failure.status).toBe(500);
		expect(failure.bytes.toString()).toBe('{"error":"Internal server error"}');
	});

	it("reports port collisions without selecting a different port", async () => {
		const first = await start();
		const second = createHttpHost({ port: Number(new URL(first.origin).port) });
		hosts.push(second);
		await expect(second.listen()).rejects.toMatchObject({ code: "EADDRINUSE" });
		expect(() => createHttpHost({ port: -1 })).toThrow("Port");
	});
});
