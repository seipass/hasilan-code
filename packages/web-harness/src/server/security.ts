import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const LOOPBACK_HOST = "127.0.0.1";

export class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

function equalSecret(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual, "utf8");
	const expectedBytes = Buffer.from(expected, "utf8");
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
	let count = 0;
	for (let i = 0; i < request.rawHeaders.length; i += 2) {
		if (request.rawHeaders[i].toLowerCase() === name) count++;
	}
	if (count > 1) throw new HttpError(400, `Duplicate ${name} header`);
	const value = request.headers[name];
	return typeof value === "string" ? value : undefined;
}

/** Secrets are scoped to this host launch and are never part of service projections. */
export class LoopbackSecurity {
	private readonly launchToken = randomBytes(32).toString("base64url");
	private readonly cookieToken = randomBytes(32).toString("base64url");
	private port: number | undefined;

	setPort(port: number): void {
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid listening port");
		if (this.port !== undefined) throw new Error("Listening port is already assigned");
		this.port = port;
	}

	get origin(): string {
		if (this.port === undefined) throw new Error("Host has not started listening");
		return `http://${LOOPBACK_HOST}:${this.port}`;
	}

	get launchUrl(): string {
		return `${this.origin}/?token=${this.launchToken}`;
	}

	private get cookieName(): string {
		if (this.port === undefined) throw new Error("Host has not started listening");
		return `pi_web_harness_${this.port}`;
	}

	checkHost(request: IncomingMessage): void {
		if (singleHeader(request, "host") !== `${LOOPBACK_HOST}:${this.port}`) {
			throw new HttpError(403, "Host is not allowed");
		}
	}

	parseUrl(request: IncomingMessage): URL {
		const target = request.url ?? "/";
		if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) {
			throw new HttpError(400, "Invalid request target");
		}
		const url = new URL(target, this.origin);
		if (url.origin !== this.origin) throw new HttpError(400, "Invalid request target");
		return url;
	}

	exchangeLaunchToken(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
		if (request.method !== "GET" || url.pathname !== "/" || !url.searchParams.has("token")) return false;
		const tokens = url.searchParams.getAll("token");
		if (tokens.length !== 1 || !equalSecret(tokens[0], this.launchToken)) {
			throw new HttpError(401, "Invalid launch token");
		}
		response.setHeader("Set-Cookie", `${this.cookieName}=${this.cookieToken}; HttpOnly; SameSite=Strict; Path=/`);
		response.setHeader("Cache-Control", "private, no-store");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.writeHead(303, { Location: "/" });
		response.end();
		return true;
	}

	requireAuthentication(request: IncomingMessage): void {
		const cookieHeader = singleHeader(request, "cookie") ?? "";
		const matches: string[] = [];
		for (const cookie of cookieHeader.split(";")) {
			const separator = cookie.indexOf("=");
			if (separator === -1) continue;
			if (cookie.slice(0, separator).trim() === this.cookieName) {
				matches.push(cookie.slice(separator + 1).trim());
			}
		}
		if (matches.length !== 1 || !equalSecret(matches[0], this.cookieToken)) {
			throw new HttpError(401, "Authentication required; open the launch URL");
		}
	}

	requireOrigin(request: IncomingMessage): void {
		if (singleHeader(request, "origin") !== this.origin) throw new HttpError(403, "Origin is not allowed");
	}

	authorizeApi(request: IncomingMessage): void {
		this.requireAuthentication(request);
		if (request.method !== "GET" && request.method !== "HEAD") this.requireOrigin(request);
	}

	authorizeWebSocket(request: IncomingMessage): void {
		this.checkHost(request);
		this.requireAuthentication(request);
		this.requireOrigin(request);
	}
}

export function setSecurityHeaders(response: ServerResponse): void {
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
	);
}
