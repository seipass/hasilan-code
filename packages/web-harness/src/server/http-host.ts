import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import { WebSocket, WebSocketServer } from "ws";
import type { ArtifactStore } from "./artifacts.ts";
import { getLanAddresses } from "./network.ts";
import { HttpError, LOOPBACK_HOST, LoopbackSecurity, setSecurityHeaders } from "./security.ts";

export { HttpError } from "./security.ts";

export interface HttpHostOptions {
	port?: number;
	lan?: boolean;
	staticDir?: string;
	artifacts?: ArtifactStore;
	handleApi?: (request: IncomingMessage, response: ServerResponse, url: URL) => boolean | Promise<boolean>;
	handleWebSocket?: (socket: WebSocket, request: IncomingMessage, url: URL) => void;
	acceptWebSocket?: (url: URL) => boolean;
}

export interface ListeningHost {
	origin: string;
	url: string;
	/** Use only to open the browser or explicitly show launch instructions, not in ordinary logs. */
	launchUrl: string;
	/** Authenticated LAN links; do not publish through APIs or projections. */
	lanLaunchUrls: string[];
}

const STATIC_MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

export function sendJson(response: ServerResponse, status: number, data: unknown): void {
	const bytes = Buffer.from(JSON.stringify(data), "utf8");
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": bytes.length,
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(bytes);
}

/** Close only the overloaded client; producers and agent runs remain independent. */
export function sendWebSocket(socket: WebSocket, payload: unknown): boolean {
	if (socket.readyState !== WebSocket.OPEN) return false;
	const data = JSON.stringify(payload);
	if (socket.bufferedAmount + Buffer.byteLength(data, "utf8") > 2 * 1024 * 1024) {
		socket.close(1013, "Client is too slow; reconnect for a snapshot");
		return false;
	}
	socket.send(data);
	return true;
}

export async function readJson<T extends TSchema>(
	request: IncomingMessage,
	schema: T,
	maxBytes = 1024 * 1024,
): Promise<Static<T>> {
	if (!/^application\/json(?:\s*;[^\r\n]*)?$/i.test(request.headers["content-type"] ?? "")) {
		request.resume();
		throw new HttpError(415, "Content-Type must be application/json");
	}
	const declaredLength = request.headers["content-length"];
	if (declaredLength !== undefined && Number(declaredLength) > maxBytes) {
		request.resume();
		throw new HttpError(413, "Request body is too large");
	}
	const body = Promise.withResolvers<Buffer>();
	const chunks: Buffer[] = [];
	let length = 0;
	const cleanup = () => {
		request.off("data", onData);
		request.off("end", onEnd);
		request.off("error", onError);
		request.off("aborted", onAborted);
	};
	const onData = (chunk: Buffer) => {
		length += chunk.length;
		if (length > maxBytes) {
			cleanup();
			request.once("error", body.reject);
			request.resume();
			body.reject(new HttpError(413, "Request body is too large"));
		} else {
			chunks.push(chunk);
		}
	};
	const onEnd = () => {
		cleanup();
		body.resolve(Buffer.concat(chunks, length));
	};
	const onError = () => {
		cleanup();
		body.reject(new HttpError(400, "Could not read request body"));
	};
	const onAborted = () => {
		cleanup();
		request.once("error", body.reject);
		body.reject(new HttpError(400, "Request body was aborted"));
	};
	request.on("data", onData);
	request.once("end", onEnd);
	request.once("error", onError);
	request.once("aborted", onAborted);
	const bytes = await body.promise;
	let data: unknown;
	try {
		data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new HttpError(400, "Request body is not valid UTF-8 JSON");
	}
	if (!Check(schema, data)) throw new HttpError(400, "Request body does not match the expected schema");
	return data as Static<T>;
}

export class HttpHost {
	private readonly options: HttpHostOptions;
	private readonly security: LoopbackSecurity;
	private readonly server: Server;
	private readonly webSockets: WebSocketServer;
	private started = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: HttpHostOptions = {}) {
		this.options = options;
		const lanAddresses = options.lan ? getLanAddresses() : [];
		if (options.lan && lanAddresses.length === 0)
			throw new Error("No private IPv4 LAN address found; connect to a LAN before using --lan");
		this.security = new LoopbackSecurity(lanAddresses);
		const port = options.port ?? 3080;
		if (!Number.isInteger(port) || port < 0 || port > 65535)
			throw new Error("Port must be an integer from 0 to 65535");
		this.server = createServer((request, response) => {
			void this.handleRequest(request, response).catch((error: unknown) => {
				if (response.headersSent) {
					response.destroy();
					return;
				}
				const status = error instanceof HttpError ? error.status : 500;
				const message = error instanceof HttpError ? error.message : "Internal server error";
				sendJson(response, status, { error: message });
			});
		});
		this.server.requestTimeout = 30_000;
		this.server.headersTimeout = 10_000;
		this.webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
		this.server.on("upgrade", (request, socket, head) => {
			try {
				this.security.authorizeWebSocket(request);
				const url = this.security.parseUrl(request);
				const accepted =
					this.options.acceptWebSocket?.(url) ??
					(url.pathname === "/api/events" || /^\/api\/terminals\/[^/]+\/events$/.test(url.pathname));
				if (!this.options.handleWebSocket || !accepted) throw new HttpError(404, "WebSocket endpoint not found");
				this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
					webSocket.on("error", () => webSocket.close(1011, "WebSocket transport error"));
					try {
						this.options.handleWebSocket?.(webSocket, request, url);
					} catch {
						webSocket.close(1011, "WebSocket handler failed");
					}
				});
			} catch (error) {
				this.rejectUpgrade(socket, error instanceof HttpError ? error.status : 500);
			}
		});
	}

	async listen(): Promise<ListeningHost> {
		if (this.started) throw new Error("Host has already been started");
		if (this.closePromise) throw new Error("Host has already been closed");
		this.started = true;
		const listening = Promise.withResolvers<void>();
		const onError = (error: Error) => {
			this.server.off("listening", onListening);
			listening.reject(error);
		};
		const onListening = () => {
			this.server.off("error", onError);
			const address = this.server.address();
			if (!address || typeof address === "string") {
				listening.reject(new Error("HTTP host did not bind a TCP port"));
				return;
			}
			this.security.setPort(address.port);
			listening.resolve();
		};
		this.server.once("error", onError);
		this.server.once("listening", onListening);
		this.server.listen({ host: this.options.lan ? "0.0.0.0" : LOOPBACK_HOST, port: this.options.port ?? 3080 });
		await listening.promise;
		return {
			origin: this.security.origin,
			url: `${this.security.origin}/`,
			launchUrl: this.security.launchUrl,
			lanLaunchUrls: this.security.lanLaunchUrls,
		};
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		const closed = Promise.withResolvers<void>();
		this.closePromise = closed.promise;
		for (const socket of this.webSockets.clients) socket.terminate();
		this.webSockets.close(() => {
			if (!this.server.listening) {
				closed.resolve();
				return;
			}
			this.server.close((error) => {
				if (error) closed.reject(error);
				else closed.resolve();
			});
			this.server.closeAllConnections();
		});
		return this.closePromise;
	}

	private rejectUpgrade(socket: Duplex, status: number): void {
		const phrases: Record<number, string> = {
			400: "Bad Request",
			401: "Unauthorized",
			403: "Forbidden",
			404: "Not Found",
			500: "Internal Server Error",
		};
		const phrase = phrases[status] ?? "Bad Request";
		socket.end(
			`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`,
		);
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		setSecurityHeaders(response);
		this.security.checkHost(request);
		const url = this.security.parseUrl(request);
		if (this.security.exchangeLaunchToken(request, response, url)) return;
		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			this.security.authorizeApi(request);
			if (url.pathname.startsWith("/api/artifacts/")) {
				this.serveArtifact(request, response, url);
				return;
			}
			if (await this.options.handleApi?.(request, response, url)) return;
			throw new HttpError(404, "API endpoint not found");
		}
		await this.serveStatic(request, response, url);
	}

	private serveArtifact(request: IncomingMessage, response: ServerResponse, url: URL): void {
		if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method is not allowed");
		const id = url.pathname.slice("/api/artifacts/".length);
		const artifact = this.options.artifacts?.get(id);
		if (!artifact) throw new HttpError(404, "Artifact not found");
		response.writeHead(200, {
			"Content-Type": artifact.mimeType,
			"Content-Length": artifact.size,
			"Content-Disposition": `inline; filename="${artifact.id}.${artifact.mimeType.split("/")[1]}"`,
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		});
		response.end(request.method === "HEAD" ? undefined : artifact.bytes);
	}

	private async serveStatic(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
		if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method is not allowed");
		if (!this.options.staticDir) throw new HttpError(404, "Static UI not found; build the web harness first");
		let decoded: string;
		try {
			decoded = decodeURIComponent(url.pathname);
		} catch {
			throw new HttpError(400, "Invalid URL encoding");
		}
		if (
			decoded.includes("\0") ||
			decoded.includes("\\") ||
			decoded.includes(":") ||
			decoded.split("/").includes("..")
		) {
			throw new HttpError(403, "Static path is not allowed");
		}
		try {
			const root = await realpath(this.options.staticDir);
			const path = await realpath(resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`));
			const child = relative(root, path);
			if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`))
				throw new HttpError(403, "Static path is not allowed");
			const info = await stat(path);
			if (!info.isFile()) throw new HttpError(404, "Static file not found");
			const bytes = request.method === "HEAD" ? undefined : await readFile(path);
			response.writeHead(200, {
				"Content-Type": STATIC_MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
				"Content-Length": info.size,
				"Cache-Control": "private, no-store",
			});
			response.end(bytes);
		} catch (error) {
			if (error instanceof HttpError) throw error;
			if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) {
				throw new HttpError(404, "Static file not found; build the web harness first");
			}
			throw error;
		}
	}
}

export function createHttpHost(options: HttpHostOptions = {}): HttpHost {
	return new HttpHost(options);
}
