import { createRequire } from "node:module";
import type { spawn } from "node-pty";
import { terminalCreateSchema } from "../../shared/contracts.ts";
import { terminalSupportFailure } from "../cli.ts";
import { HttpError, readJson, sendJson } from "../http-host.ts";
import { TerminalManager } from "../terminal-manager.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function terminalPlugin(getWorkspaceRoot: (id: string) => string): ServerPlugin {
	let native: { spawn: typeof spawn } | undefined;
	const failure = terminalSupportFailure(() => {
		const addon = createRequire(import.meta.url)("node-pty") as Partial<{ spawn: typeof spawn }>;
		if (typeof addon.spawn !== "function") throw new Error("node-pty does not export spawn");
		native = { spawn: addon.spawn };
	}, process.platform);
	if (!native) throw failure ?? new Error("Terminal support is unavailable");
	const terminals = new TerminalManager({ getWorkspaceRoot, spawn: native.spawn });
	return {
		apiVersion: 1,
		async handleApi(request, response, url, parts) {
			if (url.pathname === "/api/terminals" && request.method === "GET") {
				const id = url.searchParams.get("workspaceId");
				if (!id) throw new HttpError(400, "workspaceId is required");
				sendJson(response, 200, terminals.list(id));
			} else if (url.pathname === "/api/terminals" && request.method === "POST") {
				sendJson(response, 201, await terminals.create(await readJson(request, terminalCreateSchema)));
			} else if (parts[1] === "terminals" && parts[2] && request.method === "DELETE") {
				await terminals.close(parts[2]);
				sendJson(response, 200, { closed: true });
			} else return false;
			return true;
		},
		webSocket(url) {
			const match = /^\/api\/terminals\/([^/]+)\/events$/.exec(url.pathname);
			if (!match) return undefined;
			return (socket) => {
				void terminals
					.attach(decodeURIComponent(match[1]), socket)
					.catch(() => socket.close(1008, "Terminal unavailable"));
			};
		},
		runningTerminals: () => terminals.runningCount(),
		close: () => terminals.shutdown(),
	};
}
