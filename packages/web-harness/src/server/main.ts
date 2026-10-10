import { fileURLToPath } from "node:url";
import { getAgentDir, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	credentialSchema,
	modelSchema,
	promptSchema,
	sessionCreateSchema,
	terminalCreateSchema,
	workspaceCreateSchema,
} from "../shared/contracts.ts";
import { ArtifactStore } from "./artifacts.ts";
import { openBrowser, parseCliArgs, resolveCliWorkspace } from "./cli.ts";
import { EventHub } from "./events.ts";
import { fileView } from "./file-view.ts";
import { createHttpHost, HttpError, readJson, sendJson } from "./http-host.ts";
import { HarnessError, SessionRegistry } from "./session-registry.ts";
import { type SearchProviderId, SettingsService, settingsPatchSchema } from "./settings.ts";
import { TeamManager } from "./team-manager.ts";
import { TerminalManager } from "./terminal-manager.ts";
import { BrowserManager } from "./tools/browser.ts";
import { createHashlineTools } from "./tools/hashline/index.ts";
import { SearchService } from "./tools/search.ts";
import { imageMime, WorkspaceFiles } from "./workspace-files.ts";

async function main() {
	const options = parseCliArgs(process.argv.slice(2));
	if (options.help) {
		console.log(
			"Hasilan Code: --no-open --port <0..65535> --cwd <directory>\nLocal single-user execution; file checks are not a sandbox.",
		);
		return;
	}
	const cwd = await resolveCliWorkspace(options);
	const agentDir = getAgentDir();
	const modelRuntime = await ModelRuntime.create();
	const settings = await SettingsService.open(agentDir, modelRuntime);
	const artifacts = new ArtifactStore();
	const browser = new BrowserManager(artifacts);
	const search = new SearchService(settings);
	let events: EventHub | undefined;
	const files = new WorkspaceFiles({ onChanged: (event) => events?.publish("workspace", event.workspaceId, event) });
	let teams: TeamManager;
	const registry = new SessionRegistry({
		agentDir,
		modelRuntime,
		workspaceFiles: files,
		getDefaultModel: (workspaceCwd) => settings.getEffectiveDefaultModel(workspaceCwd),
		// Pi validates each tool's declared schema before execution; erase only the registry's heterogeneous generic boundary.
		customTools: (descriptor) =>
			[
				...createHashlineTools(files, descriptor.workspaceId),
				browser.createTool(descriptor.sessionId, teams.agentIdForSession(descriptor.sessionId)),
				search.createTool(),
				teams.createTool(descriptor.sessionId),
			] as unknown as ToolDefinition[],
	});
	teams = new TeamManager(registry, {
		getLimits: () => settings.get().teams,
		onStopSession: (id) => browser.closeSession(id),
	});
	await registry.initialize();
	await teams.initialize();
	await registry.addWorkspace(cwd);
	const terminals = new TerminalManager({ getWorkspaceRoot: (id) => files.getWorkspaceRoot(id) });
	events = new EventHub((channel, id) =>
		channel === "session" ? registry.get(id) : { sessions: registry.list(id), teams: teams.snapshot(id) },
	);
	const hub = events;
	registry.subscribe((event) => {
		if (event.sessionId) hub.publish("session", event.sessionId);
		hub.publish("workspace", event.workspaceId);
	});
	teams.subscribe((event) => hub.publish("workspace", event.workspaceId));
	let shuttingDown = false;
	const host = createHttpHost({
		port: options.port,
		staticDir: fileURLToPath(new URL("../client/", import.meta.url)),
		artifacts,
		acceptWebSocket: (url) =>
			url.pathname === "/api/events" || /^\/api\/terminals\/[^/]+\/events$/.test(url.pathname),
		handleWebSocket: (socket, _request, url) => {
			if (url.pathname === "/api/events") hub.attach(socket);
			else {
				const id = decodeURIComponent(url.pathname.split("/")[3]);
				void terminals.attach(id, socket).catch(() => socket.close(1008, "Terminal unavailable"));
			}
		},
		handleApi: async (request, response, url) => {
			try {
				if (shuttingDown) throw new HttpError(503, "Host shutting down");
				const method = request.method;
				const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
				const reply = (data: unknown, status = 200) => {
					sendJson(response, status, data);
					return true;
				};
				if (url.pathname === "/api/workspaces") {
					if (method === "GET")
						return reply(registry.listWorkspaces().map((item) => ({ ...item, workspaceId: item.id })));
					if (method === "POST") {
						const { path } = await readJson(request, workspaceCreateSchema);
						const workspace = await registry.addWorkspace(path);
						return reply({ ...workspace, workspaceId: workspace.id }, 201);
					}
				}
				if (url.pathname === "/api/sessions") {
					if (method === "GET") return reply(registry.list(url.searchParams.get("workspaceId") ?? undefined));
					if (method === "POST") {
						const session = await registry.create(await readJson(request, sessionCreateSchema));
						await teams.ensureRoot(session.sessionId);
						return reply(registry.get(session.sessionId), 201);
					}
				}
				if (parts[1] === "sessions" && parts[2]) {
					const id = parts[2];
					if (parts.length === 3 && method === "GET") return reply(registry.get(id));
					if (parts[3] === "prompt" && method === "POST")
						return reply(await teams.prompt(id, await readJson(request, promptSchema)), 202);
					if (parts[3] === "abort" && method === "POST") return reply(await teams.stop(id));
					if (parts[3] === "model" && (method === "POST" || method === "PATCH")) {
						await registry.setModel(id, await readJson(request, modelSchema));
						return reply(registry.get(id));
					}
				}
				if (url.pathname === "/api/settings") {
					if (method === "GET") {
						const workspaceId = url.searchParams.get("workspaceId");
						return reply({
							...settings.get(workspaceId ? registry.getWorkspaceRoot(workspaceId) : cwd),
							browser: browser.status(),
						});
					}
					if (method === "PATCH") return reply(await settings.patch(await readJson(request, settingsPatchSchema)));
				}
				if (url.pathname === "/api/models" && method === "GET") return reply(settings.getModels());
				if (parts[1] === "credentials" && parts[2] === "search" && parts[3]) {
					if (parts[3] !== "brave" && parts[3] !== "tavily") throw new HttpError(400, "Unknown search provider");
					const provider: SearchProviderId = parts[3];
					if (method === "PUT") {
						const { key } = await readJson(request, credentialSchema);
						await settings.setSearchKey(provider, key);
						return reply({ configured: true });
					}
					if (method === "DELETE") {
						await settings.deleteSearchKey(provider);
						return reply({ configured: false });
					}
				}
				if (parts[1] === "credentials" && parts[2] === "llm" && parts[3] && method === "PUT") {
					const { key } = await readJson(request, credentialSchema);
					await settings.setRuntimeApiKey(parts[3], key);
					return reply({ configured: true, persistent: false });
				}
				if (parts[1] === "workspaces" && parts[2]) {
					const id = parts[2];
					const path = url.searchParams.get("path") ?? "";
					if (parts[3] === "files" && method === "GET") return reply(await files.list(id, path));
					if (parts[3] === "file" && method === "GET")
						return reply(
							fileView(
								await files.read(id, path),
								Number(url.searchParams.get("offset") ?? 1),
								Number(url.searchParams.get("limit") ?? 200),
							),
						);
					if (parts[3] === "file-content" && method === "GET") {
						const snapshot = await files.read(id, path);
						if (snapshot.revision !== url.searchParams.get("revision"))
							throw new HttpError(409, "File revision changed; refresh the viewer");
						const mime = imageMime(snapshot.bytes);
						if (!mime || mime === "image/bmp" || snapshot.bytes.length > 10 * 1024 * 1024)
							throw new HttpError(415, "File is not a supported image");
						response.writeHead(200, {
							"Content-Type": mime,
							"Content-Length": snapshot.bytes.length,
							"X-Content-Type-Options": "nosniff",
							"Cache-Control": "private, no-store",
						});
						response.end(snapshot.bytes);
						return true;
					}
				}
				if (url.pathname === "/api/terminals") {
					if (method === "GET") {
						const id = url.searchParams.get("workspaceId");
						if (!id) throw new HttpError(400, "workspaceId is required");
						return reply(terminals.list(id));
					}
					if (method === "POST")
						return reply(await terminals.create(await readJson(request, terminalCreateSchema)), 201);
				}
				if (parts[1] === "terminals" && parts[2] && method === "DELETE") {
					await terminals.close(parts[2]);
					return reply({ closed: true });
				}
				return false;
			} catch (error) {
				if (error instanceof HarnessError) throw new HttpError(error.statusCode, error.message);
				throw error;
			}
		},
	});
	const launch = await host.listen();
	console.log(`Hasilan Code: ${launch.url}`);
	if (!(await openBrowser(launch.launchUrl, { noOpen: options.noOpen })))
		console.log(`Open authenticated launch URL: ${launch.launchUrl}`);
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		await teams.close();
		await Promise.all([browser.close(), terminals.shutdown()]);
		await registry.close();
		hub.close();
		artifacts.close();
		await host.close();
	};
	process.once("SIGINT", () => {
		void shutdown().catch(() => {
			process.exitCode = 1;
		});
	});
	process.once("SIGTERM", () => {
		void shutdown().catch(() => {
			process.exitCode = 1;
		});
	});
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Web harness startup failed");
	process.exitCode = 1;
});
