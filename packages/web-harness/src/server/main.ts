import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, type ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { CANVAS_LIMITS, canvasSaveSchema, isCanvasDocument, serializeCanvasDesign } from "../shared/canvas.ts";
import {
	credentialSchema,
	modelSchema,
	pendingInputActionSchema,
	promptSchema,
	sessionCreateSchema,
	teamMessageSchema,
	terminalCreateSchema,
	thinkingSchema,
	workspaceCreateSchema,
	workspacePickerSchema,
} from "../shared/contracts.ts";
import { goalActionSchema } from "../shared/goals.ts";
import { swarmStartSchema } from "../shared/swarm.ts";
import { readAccountUsage } from "./account-usage.ts";
import { ArtifactStore } from "./artifacts.ts";
import { AuthLoginManager, authLoginPromptSchema, authLoginSchema } from "./auth-login.ts";
import { CanvasStore, CanvasStoreError } from "./canvas-store.ts";
import { CLI_HELP, openBrowser, parseCliArgs, resolveCliWorkspace } from "./cli.ts";
import { createHarnessSettings, getHarnessAgentDir } from "./config.ts";
import { EventHub } from "./events.ts";
import { fileView } from "./file-view.ts";
import { pickWorkspaceFolder } from "./folder-picker.ts";
import { createHttpHost, HttpError, readJson, sendJson } from "./http-host.ts";
import { HarnessError, SessionRegistry } from "./session-registry.ts";
import { type SearchProviderId, SettingsService, settingsPatchSchema } from "./settings.ts";
import { TeamManager } from "./team-manager.ts";
import { TerminalManager } from "./terminal-manager.ts";
import { BrowserManager } from "./tools/browser.ts";
import { createHashlineTools } from "./tools/hashline/index.ts";
import { SearchService } from "./tools/search.ts";
import { serveVideo, videoView } from "./video.ts";
import { imageMime, WorkspaceFiles } from "./workspace-files.ts";

async function main() {
	const options = parseCliArgs(process.argv.slice(2));
	if (options.help) {
		console.log(CLI_HELP);
		return;
	}
	const cwd = await resolveCliWorkspace(options);
	const agentDir = getHarnessAgentDir();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
	});
	const settings = await SettingsService.open(agentDir, modelRuntime);
	const agentSettings = createHarnessSettings(cwd, agentDir);
	const authLogin = new AuthLoginManager(modelRuntime, { getDeviceId: () => agentSettings.getOrCreateDeviceId() });
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
		// Pi validates each tool's declared schema before execution; erase only the registry's heterogeneous generic boundary.
		customTools: (descriptor) =>
			[
				...createHashlineTools(files, descriptor.workspaceId),
				browser.createTool(descriptor.sessionId, teams.agentIdForSession(descriptor.sessionId)),
				search.createTool(),
				teams.createTool(descriptor.sessionId),
				teams.createGoalTool(descriptor.sessionId),
			] as unknown as ToolDefinition[],
	});
	teams = new TeamManager(registry, {
		agentDir,
		getLimits: () => settings.get().teams,
		onStopSession: (id) => browser.closeSession(id),
	});
	await registry.initialize();
	await teams.initialize();
	await registry.addWorkspace(cwd);
	const canvases = new CanvasStore(agentDir, (id) => {
		registry.getWorkspaceRoot(id);
	});
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
	const folderPickerAbort = new AbortController();
	let selectingWorkspace = false;
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
				if (url.pathname === "/api/account-usage" && method === "GET") {
					const controller = new AbortController();
					const abort = () => controller.abort();
					response.once("close", abort);
					try {
						return reply(await readAccountUsage(modelRuntime, controller.signal));
					} finally {
						response.off("close", abort);
					}
				}
				if (url.pathname === "/api/workspaces") {
					if (method === "GET")
						return reply(registry.listWorkspaces().map((item) => ({ ...item, workspaceId: item.id })));
					if (method === "POST") {
						const { path } = await readJson(request, workspaceCreateSchema);
						const workspace = await registry.addWorkspace(path);
						return reply({ ...workspace, workspaceId: workspace.id }, 201);
					}
				}
				if (url.pathname === "/api/workspaces/pick" && method === "POST") {
					await readJson(request, workspacePickerSchema);
					if (selectingWorkspace) throw new HttpError(409, "フォルダー選択はすでに開いています。");
					selectingWorkspace = true;
					try {
						const selected = await pickWorkspaceFolder(cwd, folderPickerAbort.signal);
						if (!selected) return reply({ workspace: null });
						const workspace = await registry.addWorkspace(selected);
						return reply({ workspace: { ...workspace, workspaceId: workspace.id } }, 201);
					} finally {
						selectingWorkspace = false;
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
					if (parts[3] === "goal" && parts.length === 4) {
						if (method === "GET") return reply(await teams.goal(id, { op: "get" }));
						if (method === "POST") return reply(await teams.goal(id, await readJson(request, goalActionSchema)));
					}
					if (parts[3] === "swarm" && parts.length === 4 && method === "POST")
						return reply(await teams.startSwarm(id, await readJson(request, swarmStartSchema)), 202);
					if (parts[3] === "prompt" && method === "POST")
						return reply(await teams.prompt(id, await readJson(request, promptSchema)), 202);
					if (parts[3] === "pending-inputs" && parts.length === 5 && method === "PATCH") {
						await teams.updatePendingInput(id, parts[4], await readJson(request, pendingInputActionSchema));
						return reply(registry.get(id));
					}
					if (parts[3] === "abort" && method === "POST") return reply(await teams.stop(id));
					if (parts[3] === "team-message" && parts.length === 4 && method === "POST") {
						const { agentId, message } = await readJson(request, teamMessageSchema);
						return reply(await teams.send(id, agentId, message), 202);
					}
					if (parts[3] === "model" && (method === "POST" || method === "PATCH")) {
						await registry.setModel(id, await readJson(request, modelSchema));
						return reply(registry.get(id));
					}
					if (parts[3] === "thinking" && method === "PATCH") {
						const { level } = await readJson(request, thinkingSchema);
						await registry.setThinkingLevel(id, level);
						return reply(registry.get(id));
					}
				}
				if (url.pathname === "/api/settings") {
					if (method === "GET") {
						return reply({
							...settings.get(),
							browser: browser.status(),
						});
					}
					if (method === "PATCH") return reply(await settings.patch(await readJson(request, settingsPatchSchema)));
				}
				if (url.pathname === "/api/models" && method === "GET") return reply(settings.getModels());
				if (url.pathname === "/api/auth/login" && method === "POST") {
					const { provider } = await readJson(request, authLoginSchema, 64 * 1024);
					return reply(authLogin.start(provider), 202);
				}
				if (parts[1] === "auth" && parts[2] === "login" && parts[3]) {
					const id = parts[3];
					if (parts.length === 4 && method === "GET") return reply(authLogin.get(id));
					if (parts.length === 4 && method === "DELETE") return reply(authLogin.cancel(id));
					if (parts.length === 5 && parts[4] === "prompt" && method === "POST") {
						const { promptId, value } = await readJson(request, authLoginPromptSchema, 64 * 1024);
						return reply(authLogin.submit(id, promptId, value));
					}
				}
				if (parts[1] === "credentials" && parts[2] === "search" && parts[3]) {
					if (parts[3] !== "brave" && parts[3] !== "tavily" && parts[3] !== "exa" && parts[3] !== "firecrawl")
						throw new HttpError(400, "Unknown search provider");
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
					if (parts[3] === "canvas" && parts[4] === "compose" && parts.length === 5 && method === "POST") {
						const document = await readJson(request, canvasSaveSchema, CANVAS_LIMITS.bytes);
						if (!isCanvasDocument(document)) throw new HttpError(400, "設計データの ID・接続先が不正です。");
						const snapshot = await files.create(
							id,
							`.hasilan-code/canvas/design-${randomBytes(8).toString("hex")}.txt`,
							Buffer.from(`${serializeCanvasDesign(document.design)}\n`, "utf8"),
						);
						return reply({ path: snapshot.path }, 201);
					}
					if (parts[3] === "canvas" && parts.length === 4) {
						if (method === "GET") return reply(await canvases.get(id));
						if (method === "PUT")
							return reply(
								await canvases.save(id, await readJson(request, canvasSaveSchema, CANVAS_LIMITS.bytes)),
							);
					}
					if (parts[3] === "files" && method === "GET") return reply(await files.list(id, path));
					if (parts[3] === "file" && method === "GET")
						return reply(
							(await videoView(files, id, path)) ??
								fileView(
									await files.read(id, path),
									Number(url.searchParams.get("offset") ?? 1),
									Number(url.searchParams.get("limit") ?? 200),
								),
						);
					if (parts[3] === "file-content" && (method === "GET" || method === "HEAD")) {
						if (await serveVideo(files, id, path, url.searchParams.get("revision"), request, response))
							return true;
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
						response.end(method === "HEAD" ? undefined : snapshot.bytes);
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
				if (error instanceof CanvasStoreError) throw new HttpError(error.status, error.message);
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
		folderPickerAbort.abort();
		await authLogin.close();
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
