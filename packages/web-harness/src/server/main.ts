import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	applyHttpProxySettings,
	configureHttpDispatcher,
	ModelRuntime,
	type ToolDefinition,
} from "@hasilan-code/pi-coding-agent";
import { toString as qrCodeText } from "qrcode";
import { ATTACHMENT_LIMITS } from "../shared/attachments.ts";
import {
	credentialSchema,
	modelSchema,
	pendingInputActionSchema,
	promptSchema,
	responsibilitySchema,
	sessionCompactSchema,
	sessionCreateSchema,
	sessionRenameSchema,
	sessionSplitSchema,
	teamMessageSchema,
	thinkingSchema,
	workspaceCreateSchema,
	workspacePickerSchema,
} from "../shared/contracts.ts";
import {
	ACCOUNT_USAGE_ID,
	BROWSER_ADJUSTMENTS_ID,
	DEFAULT_THEME_ID,
	GIT_REVIEW_ID,
	GITHUB_DASHBOARD_ID,
	PLUGIN_MANAGER_ID,
	SESSION_ARCHIVE_ID,
	SESSION_IMPORT_ID,
	SESSION_SEARCH_ID,
	STORAGE_USAGE_ID,
	standardTheme,
	TERMINAL_ID,
	TEXT_TRANSFORM_ID,
	WORKSPACE_FILES_ID,
	WORKSPACE_ROUTER_ID,
	WORKSPACE_UI_ID,
} from "../shared/plugin-profile.ts";
import { TOOL_RESULT_PAGE_CHARS } from "../shared/session-history.ts";
import { surfaceActionSchema } from "../shared/surfaces.ts";
import { AgentWorktrees } from "./agent-worktrees.ts";
import { ArtifactStore } from "./artifacts.ts";
import { AuthLoginManager, authLoginPromptSchema, authLoginSchema } from "./auth-login.ts";
import { CLI_HELP, type CliOptions, openBrowser, parseCliArgs, resolveCliWorkspace } from "./cli.ts";
import { createHarnessSettings, getHarnessAgentDir } from "./config.ts";
import { EventHub } from "./events.ts";
import { pickWorkspaceFolder } from "./folder-picker.ts";
import { createHttpHost, HttpError, readJson, sendJson } from "./http-host.ts";
import { serveWorkspaceImage } from "./image-content.ts";
import { canvasPlugin } from "./plugins/canvas.ts";
import { goalPlugin } from "./plugins/goal.ts";
import { hyakkiPlugin } from "./plugins/hyakki.ts";
import { accountUsagePlugin, githubDashboardPlugin } from "./plugins/integrations.ts";
import { pluginManager } from "./plugins/manager.ts";
import {
	browserAdjustmentsPlugin,
	gitReviewPlugin,
	textTransformPlugin,
	workspaceRouterPlugin,
} from "./plugins/product-features.ts";
import { runtimeContextPlugin } from "./plugins/runtime-context.ts";
import { loadServerProfile, type ServerPlugin } from "./plugins/server-profile.ts";
import { pluginSession } from "./plugins/session.ts";
import {
	sessionArchivePlugin,
	sessionImportPlugin,
	sessionSearchPlugin,
	storageUsagePlugin,
} from "./plugins/session-history.ts";
import { fileSessionStorage } from "./plugins/session-storage.ts";
import { terminalPlugin } from "./plugins/terminal.ts";
import { webSearchPlugin } from "./plugins/web-search.ts";
import { workspaceFilesPlugin } from "./plugins/workspace-files.ts";
import { hashlinePlugin, shellProcessPlugin } from "./plugins/workspace-tools.ts";
import { acquireProfile } from "./profile-lock.ts";
import { readAttachmentImages, savePromptAttachments } from "./prompt-attachments.ts";
import { HarnessError, SessionRegistry } from "./session-registry.ts";
import { classifyMidTurnSplit, deriveSplitMetadata } from "./session-splitter.ts";
import { type SearchProviderId, SettingsService, settingsPatchSchema } from "./settings.ts";
import { TeamManager } from "./team-manager.ts";
import { PythonDesktop } from "./tools/computer/backend.ts";
import { ComputerManager } from "./tools/computer/index.ts";
import { JevComputer } from "./tools/computer/jev.ts";
import { LazyBrowserManager } from "./tools/lazy-browser.ts";
import { UiPreferencesStore } from "./ui-preferences.ts";
import { WorkspaceFiles } from "./workspace-files.ts";

export interface HarnessHooks {
	pickFolder?: (cwd: string, signal: AbortSignal) => Promise<string | undefined>;
	modelRuntime?: ModelRuntime;
	staticDir?: string;
}

/** The CLI and desktop own the same services, API and persistence format. */
export async function startHarness(options: CliOptions, hooks: HarnessHooks = {}) {
	const release = await acquireProfile(getHarnessAgentDir());
	let closePlugins: (() => Promise<void>) | undefined;
	try {
		const harness = await createHarness(options, hooks, (close) => {
			closePlugins = close;
		});
		let stopping: Promise<void> | undefined;
		return {
			...harness,
			shutdown: () => {
				stopping ??= harness.shutdown().finally(release);
				return stopping;
			},
		};
	} catch (error) {
		await closePlugins?.();
		await release();
		throw error;
	}
}

async function createHarness(
	options: CliOptions,
	hooks: HarnessHooks,
	onPluginsLoaded: (close: () => Promise<void>) => void,
) {
	const cwd = await resolveCliWorkspace(options);
	const agentDir = getHarnessAgentDir();
	const agentSettings = createHarnessSettings(cwd, agentDir);
	applyHttpProxySettings(agentSettings.getGlobalSettings().httpProxy);
	configureHttpDispatcher(agentSettings.getHttpIdleTimeoutMs());
	const artifacts = new ArtifactStore();
	const browser = new LazyBrowserManager(artifacts);
	const computer = new ComputerManager(new PythonDesktop(agentDir), artifacts);
	let events: EventHub | undefined;
	const files = new WorkspaceFiles({ onChanged: (event) => events?.publish("workspace", event.workspaceId, event) });
	const agentWorktrees = new AgentWorktrees(agentDir);
	const isolatedFiles = new WorkspaceFiles();
	let teams: TeamManager;
	const plugins: Awaited<ReturnType<typeof loadServerProfile>> = await loadServerProfile(
		agentDir,
		new Map<string, () => ServerPlugin>([
			["hashline", () => hashlinePlugin(files, isolatedFiles)],
			["shell-process", () => shellProcessPlugin(agentDir)],
			[
				"browser-tools",
				() => ({
					apiVersion: 1,
					tools: ({ sessionId }) => [
						browser.createTool(sessionId, teams.agentIdForSession(sessionId)) as unknown as ToolDefinition,
					],
					closeSession: (sessionId) => browser.closeSession(sessionId),
					close: () => browser.close(),
				}),
			],
			[
				"computer-tools",
				() => ({
					apiVersion: 1,
					tools: ({ sessionId }) => [
						computer.createTool(sessionId, teams.agentIdForSession(sessionId)) as unknown as ToolDefinition,
					],
					closeSession: (sessionId) => computer.closeSession(sessionId),
					close: () => computer.close(),
				}),
			],
			[
				"jev-computer",
				() => ({
					apiVersion: 1,
					tools: ({ sessionId }) => [
						jevComputer.createTool(sessionId, teams.agentIdForSession(sessionId)) as unknown as ToolDefinition,
					],
				}),
			],
			["web-search", () => webSearchPlugin(() => settings)],
			[
				"team-tools",
				() => ({
					apiVersion: 1,
					tools: ({ sessionId }) => [teams.createTool(sessionId) as unknown as ToolDefinition],
				}),
			],
			["model-providers", () => ({ apiVersion: 1, bundledModelProviders: true })],
			[DEFAULT_THEME_ID, () => ({ apiVersion: 1, theme: standardTheme })],
			["hyakki", () => hyakkiPlugin(() => teams)],
			["goal", () => goalPlugin(() => teams)],
			[PLUGIN_MANAGER_ID, () => pluginManager(agentDir, () => plugins)],
			[WORKSPACE_UI_ID, () => ({ apiVersion: 1, bundledApplication: true })],
			["runtime-context", () => runtimeContextPlugin((): SessionRegistry => registry)],
			["session-storage", () => ({ apiVersion: 1, sessionStorage: fileSessionStorage(agentDir) })],
			[SESSION_SEARCH_ID, () => sessionSearchPlugin((): SessionRegistry => registry)],
			[
				SESSION_IMPORT_ID,
				() =>
					sessionImportPlugin(
						(): SessionRegistry => registry,
						(id) => teams.ensureRoot(id),
					),
			],
			[SESSION_ARCHIVE_ID, () => sessionArchivePlugin((): SessionRegistry => registry)],
			[STORAGE_USAGE_ID, () => storageUsagePlugin(agentDir, (): SessionRegistry => registry)],
			[WORKSPACE_FILES_ID, () => workspaceFilesPlugin(files)],
			[TERMINAL_ID, () => terminalPlugin((id) => files.getWorkspaceRoot(id))],
			[GIT_REVIEW_ID, () => gitReviewPlugin((): SessionRegistry => registry)],
			[
				TEXT_TRANSFORM_ID,
				() =>
					textTransformPlugin(
						() => settings,
						() => modelRuntime,
						files,
					),
			],
			[BROWSER_ADJUSTMENTS_ID, () => browserAdjustmentsPlugin(() => modelRuntime)],
			[
				WORKSPACE_ROUTER_ID,
				() =>
					workspaceRouterPlugin(
						files,
						() => modelRuntime,
						() => settings,
						(): SessionRegistry => registry,
					),
			],
			[GITHUB_DASHBOARD_ID, githubDashboardPlugin],
			[ACCOUNT_USAGE_ID, () => accountUsagePlugin(() => modelRuntime)],
			[
				"canvas",
				() =>
					canvasPlugin(
						agentDir,
						(id) => {
							registry.getWorkspaceRoot(id);
						},
						files,
					),
			],
		]),
	);
	onPluginsLoaded(plugins.close);
	const modelRuntime =
		hooks.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			modelsStorePath: join(agentDir, "models-store.json"),
			includeBuiltinProviders: plugins.includeBuiltinProviders,
			providers: plugins.providers,
		}));
	if (hooks.modelRuntime) {
		for (const provider of plugins.providers) modelRuntime.registerNativeProvider(provider);
	}
	const settings = await SettingsService.open(agentDir, modelRuntime);
	const uiPreferences = await UiPreferencesStore.open(agentDir);
	const authLogin = new AuthLoginManager(modelRuntime, { getDeviceId: () => agentSettings.getOrCreateDeviceId() });
	const jevComputer = new JevComputer(computer, modelRuntime, () => ({
		jev: settings.get().jev.model,
		textModel: settings.get().jevComputer?.textModel,
	}));
	const registry = new SessionRegistry({
		agentWorktrees,
		isolatedFiles,
		agentDir,
		modelRuntime,
		workspaceFiles: files,
		persistence: plugins.takePersistence(),
		goalEnabled: plugins.isBuiltinActive("goal"),
		swarmEnabled: plugins.isBuiltinActive("hyakki"),
		readAttachments: (workspaceId, attachments) => readAttachmentImages(files, workspaceId, attachments),
		pluginOwnedTools: ["read", "edit", "write"],
		customTools: (descriptor) => plugins.toolsForSession(pluginSession(descriptor)),
		runtimeContext: plugins.contextForSession,
	});
	teams = new TeamManager(registry, {
		agentWorktrees,
		getAgentModels: () => settings.get().agentModels ?? {},
		agentDir,
		getLimits: () => settings.get().teams,
		onStopSession: async (id) => {
			await plugins.closeSession(id);
		},
	});
	await registry.initialize();
	await teams.initialize();
	await registry.addWorkspace(cwd);
	events = new EventHub(
		(channel, id) =>
			channel === "session"
				? registry.state.sessions.some((session) => session.sessionId === id)
					? registry.projection(id)
					: undefined
				: { sessions: registry.list(id), teams: teams.snapshot(id) },
		(channel, id) => (channel === "session" ? registry.retainHistory(id) : () => {}),
	);
	const hub = events;
	registry.subscribe((event) => {
		if (event.sessionId) {
			if (event.type === "session_deleted") hub.removeSession(event.sessionId);
			else hub.publish("session", event.sessionId);
		}
		hub.publish("workspace", event.workspaceId);
	});
	registry.onExecutionEvent((sessionId, event) => {
		if (event.type !== "agent_settled") return;
		const child = registry.state.sessions.find((entry) => entry.sessionId === sessionId);
		if (!child?.splitFromSessionId) return;
		if (!registry.state.sessions.some((entry) => entry.sessionId === child.splitFromSessionId)) return;
		const snapshot = registry.projection(sessionId);
		const failed = snapshot.latestRun?.status === "failed";
		registry.surfaces.addSplitNotice(child.splitFromSessionId, {
			childSessionId: sessionId,
			childTitle: snapshot.title ?? "分割セッション",
			branchName: child.worktree?.branch,
			changedFiles: registry.changedFileCount(sessionId),
			status: failed ? "failed" : "completed",
		});
	});
	teams.subscribe((event) => {
		hub.publish("workspace", event.workspaceId);
		void computer
			.releaseIdle((sessionId) => {
				const agent = registry.state.agents.find((entry) => entry.sessionId === sessionId);
				return (
					!!agent &&
					registry.state.runs.some(
						(run) =>
							run.agentId === agent.agentId &&
							!["completed", "failed", "cancelled", "interrupted"].includes(run.status),
					)
				);
			})
			.catch(() => undefined);
	});
	let shuttingDown = false;
	const folderPickerAbort = new AbortController();
	let selectingWorkspace = false;
	const host = createHttpHost({
		port: options.port,
		lan: options.lan,
		development: options.development,
		staticDir: hooks.staticDir ?? fileURLToPath(new URL("../client/", import.meta.url)),
		artifacts,
		acceptWebSocket: (url) => !shuttingDown && (url.pathname === "/api/events" || !!plugins.webSocketHandler(url)),
		handleWebSocket: (socket, request, url) => {
			if (url.pathname === "/api/events") hub.attach(socket);
			else {
				const handle = plugins.webSocketHandler(url);
				if (handle) handle(socket, request);
				else socket.close(1008, "WebSocket endpoint unavailable");
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
				if (await uiPreferences.handle(request, response, url)) return true;
				if (url.pathname === "/api/plugin-profile" && method === "GET") return reply(plugins.profile);
				if (parts[1] === "plugin-profile" && parts.length === 4 && parts[3] === "panel.js" && method === "GET") {
					const script = await plugins.panelScript(parts[2]);
					if (!script) throw new HttpError(404, "Plugin panel not found");
					response.writeHead(200, {
						"Content-Type": "application/javascript; charset=utf-8",
						"Cache-Control": "no-store",
					});
					response.end(script);
					return true;
				}
				if (url.pathname === "/api/usage/daily" && method === "GET") return reply({ days: registry.dailyUsage() });
				if (url.pathname === "/api/work" && method === "GET") return reply(teams.workOverview());
				if (parts[1] === "work" && parts.length === 4 && parts[3] === "diff" && method === "GET")
					return reply(await teams.agentWork(parts[2], "diff"));
				if (url.pathname === "/api/workspaces") {
					if (method === "GET")
						return reply(registry.listWorkspaces().map((item) => ({ ...item, workspaceId: item.id })));
					if (method === "POST") {
						const { path } = await readJson(request, workspaceCreateSchema);
						const workspace = await registry.addWorkspace(path);
						return reply({ ...workspace, workspaceId: workspace.id }, 201);
					}
				}
				if (parts[1] === "workspaces" && parts[2] && parts.length === 3 && method === "DELETE") {
					await registry.removeWorkspace(parts[2]);
					return reply({ removed: true });
				}
				if (url.pathname === "/api/workspaces/pick" && method === "POST") {
					await readJson(request, workspacePickerSchema);
					if (selectingWorkspace) throw new HttpError(409, "フォルダー選択はすでに開いています。");
					selectingWorkspace = true;
					try {
						const selected = await (hooks.pickFolder ?? pickWorkspaceFolder)(cwd, folderPickerAbort.signal);
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
						return reply(registry.page(session.sessionId), 201);
					}
				}
				if (parts[1] === "sessions" && parts[2] && url.pathname !== "/api/sessions/search") {
					const id = parts[2];
					if (parts.length === 3 && method === "GET") return reply(registry.page(id));
					if (parts.length === 3 && method === "PATCH") {
						const { title } = await readJson(request, sessionRenameSchema);
						await registry.renameSession(id, title);
						return reply(registry.page(id));
					}
					if (parts.length === 3 && method === "DELETE") {
						const deletedSessionIds = await registry.deleteSession(id);
						for (const sessionId of deletedSessionIds) await plugins.closeSession(sessionId);
						for (const sessionId of deletedSessionIds) artifacts.deleteSession(sessionId);
						return reply({ deletedSessionIds });
					}
					if (parts[3] === "history" && parts.length === 4 && method === "GET") {
						const before = url.searchParams.get("before");
						if (!before || before.length > 128) throw new HttpError(400, "before cursor is required");
						return reply(registry.page(id, before));
					}
					if (parts[3] === "tool-result" && parts.length === 4 && method === "GET") {
						const key = url.searchParams.get("key");
						const offset = Number(url.searchParams.get("offset") ?? 0);
						if (!key || !Number.isSafeInteger(offset) || offset < 0)
							throw new HttpError(400, "無効なツール結果の参照です。");
						const json = registry.toolResult(id, key);
						if (json === undefined) throw new HttpError(404, "ツール結果がありません。");
						if (offset >= json.length) throw new HttpError(416, "無効な読み込み位置です。");
						const end = Math.min(json.length, offset + TOOL_RESULT_PAGE_CHARS);
						return reply({
							chunk: json.slice(offset, end),
							total: json.length,
							next: end < json.length ? end : undefined,
						});
					}
					if (parts[3] === "prompt" && method === "POST") {
						const input = await readJson(request, promptSchema, ATTACHMENT_LIMITS.requestBytes);
						const descriptor = registry.descriptor(id);
						if (!input.text.trim() && !input.attachments?.length)
							throw new HttpError(400, "メッセージか添付ファイルを追加してください。");
						const snapshot = registry.projection(id);
						if (
							input.mode === "steer" &&
							!input.skipSplitCheck &&
							!input.attachments?.length &&
							!descriptor.parentSessionId &&
							snapshot.currentRun
						) {
							const decision = await classifyMidTurnSplit({
								currentTask: snapshot.title ?? snapshot.currentRun.task,
								incomingText: input.text,
								runtime: modelRuntime,
								getClassifier: () => settings.get().jev.model,
							});
							if (decision.shouldSplit) {
								const proposal = registry.surfaces.createSplitProposal(id, {
									promptText: input.text,
									suggestedTitle: decision.suggestedTitle,
									branchName: decision.branchName,
									explanation: decision.explanation,
								});
								return reply(
									{
										runId: snapshot.currentRun.runId,
										disposition: "split_proposed",
										surfaceId: proposal.surfaceId,
									},
									202,
								);
							}
						}
						const attachments = await savePromptAttachments(
							files,
							descriptor.workspaceId,
							input.attachments ?? [],
						);
						return reply(await teams.prompt(id, { text: input.text, mode: input.mode, attachments }), 202);
					}
					if (parts[3] === "split" && parts.length === 4 && method === "POST") {
						const input = await readJson(request, sessionSplitSchema, ATTACHMENT_LIMITS.requestBytes);
						const meta = deriveSplitMetadata(input.text);
						const child = await registry.createSplitSession(id, {
							title: input.title ?? meta.suggestedTitle,
							branchName: input.branchName ?? meta.branchName,
						});
						await teams.ensureRoot(child.sessionId);
						await teams.prompt(child.sessionId, { text: input.text, mode: "prompt" });
						return reply({ session: registry.page(child.sessionId) }, 201);
					}
					if (parts[3] === "pending-inputs" && parts.length === 5 && method === "PATCH") {
						await teams.updatePendingInput(id, parts[4], await readJson(request, pendingInputActionSchema));
						return reply(registry.page(id));
					}
					if (parts[3] === "abort" && method === "POST") return reply(await teams.stop(id));
					if (parts[3] === "team-message" && parts.length === 4 && method === "POST") {
						const { agentId, message } = await readJson(request, teamMessageSchema);
						return reply(await teams.send(id, agentId, message), 202);
					}
					if (parts[3] === "model" && (method === "POST" || method === "PATCH")) {
						await registry.setModel(id, await readJson(request, modelSchema));
						return reply(registry.page(id));
					}
					if (parts[3] === "thinking" && method === "PATCH") {
						const { level } = await readJson(request, thinkingSchema);
						await registry.setThinkingLevel(id, level);
						return reply(registry.page(id));
					}
					if (parts[3] === "compact" && parts.length === 4 && method === "POST") {
						const { instructions } = await readJson(request, sessionCompactSchema);
						return reply(await registry.compact(id, instructions));
					}
					if (parts[3] === "usage-attribution" && parts.length === 4 && method === "GET") {
						return reply(registry.usageAttribution(id));
					}
					if (
						parts[3] === "surfaces" &&
						parts[4] &&
						parts[5] === "action" &&
						parts.length === 6 &&
						method === "POST"
					) {
						const action = await readJson(request, surfaceActionSchema, 256 * 1024);
						if (action.type === "accept_split" || action.type === "keep_here") {
							const surface = registry.surfaces.get(id, parts[4]);
							if (!surface || surface.kind !== "split_proposal")
								throw new HttpError(404, "対象の分割提案が見つかりません。");
							if (surface.status !== "pending")
								throw new HttpError(409, "この分割提案はすでに処理されています。");
							if (action.type === "accept_split") {
								const child = await registry.createSplitSession(id, {
									title: surface.suggestedTitle,
									branchName: surface.branchName,
								});
								await teams.ensureRoot(child.sessionId);
								await teams.prompt(child.sessionId, { text: surface.promptText, mode: "prompt" });
								return reply(registry.surfaces.resolveSplitProposal(id, parts[4], "split", child.sessionId));
							}
							const resolved = registry.surfaces.resolveSplitProposal(id, parts[4], "kept");
							const current = registry.projection(id).currentRun;
							await teams.prompt(id, { text: surface.promptText, mode: current ? "steer" : "prompt" });
							return reply(resolved);
						}
						return reply(registry.surfaces.handleAction(id, parts[4], action));
					}
				}
				if (url.pathname === "/api/settings") {
					if (method === "GET") {
						return reply({
							...settings.get(),
							browser: await browser.status(),
							computer: await computer.status(),
						});
					}
					if (method === "PATCH") return reply(await settings.patch(await readJson(request, settingsPatchSchema)));
				}
				if (url.pathname === "/api/models" && method === "GET") {
					await settings.refreshModelsIfStale();
					return reply(settings.getModels());
				}
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
					await settings.saveApiKey(parts[3], key);
					return reply({ configured: true, persistent: true });
				}
				if (parts[1] === "workspaces" && parts[2]) {
					const id = parts[2];
					if (parts[3] === "agents" && parts[4] && parts.length === 5 && method === "PATCH") {
						const { responsibility } = await readJson(request, responsibilitySchema);
						const team = teams.snapshot(id).teams.find((entry) => entry.scope === "workspace");
						const root = registry.state.agents.find((agent) => agent.agentId === team?.rootAgentId);
						if (!root) throw new HttpError(404, "Workspace team not found");
						return reply(await teams.describe(root.sessionId, parts[4], responsibility));
					}
					if (parts[3] === "file-content" && (method === "GET" || method === "HEAD")) {
						const path = url.searchParams.get("path") ?? "";
						const revision = url.searchParams.get("revision");
						// Existing chat projections use this URL for uploaded images.
						const attachment = /^\.hasilan-code\/attachments\/([0-9a-f]{64})-[^/\\]+$/.exec(path);
						if (
							!plugins.profile.activeIds.includes(WORKSPACE_FILES_ID) &&
							attachment &&
							attachment[1] === revision
						) {
							await serveWorkspaceImage(files, id, path, revision, request, response);
							return true;
						}
					}
				}
				return await plugins.handleApi(request, response, url, parts);
			} catch (error) {
				if (error instanceof HarnessError) throw new HttpError(error.statusCode, error.message);
				throw error;
			}
		},
	});
	const launch = await host.listen();
	registry.startHistoryHydration();
	// Workspaces registered before this rule existed still get the exclude entry.
	void Promise.allSettled(registry.listWorkspaces().map((workspace) => files.ignoreHarnessDirectory(workspace.id)));
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		folderPickerAbort.abort();
		// Attempt every cleanup even when a device or PTY refuses to close.
		const owners = await Promise.allSettled([authLogin.close(), teams.close()]);
		const [registryResult] = await Promise.allSettled([registry.close()]);
		await plugins.close();
		const results = await Promise.allSettled([uiPreferences.close()]);
		hub.close();
		artifacts.close();
		await host.close();
		const failed = [...owners, registryResult, ...results].find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	};
	return {
		launch,
		shutdown,
		activity: () => ({
			runs: registry.list().filter((session) => session.currentRun).length,
			queued: registry.list().reduce((count, session) => count + session.pendingInput.length, 0),
			terminals: plugins.runningTerminals(),
		}),
	};
}

async function main() {
	const options = parseCliArgs(process.argv.slice(2));
	if (options.help) {
		console.log(CLI_HELP);
		return;
	}
	const { launch, shutdown } = await startHarness(options);
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
	console.log(`Hasilan Code: ${launch.url}`);
	if (!(await openBrowser(launch.launchUrl, { noOpen: options.noOpen })))
		console.log(
			`${options.development ? "Open development URL" : "Open authenticated launch URL"}: ${launch.launchUrl}`,
		);
	for (const url of launch.lanLaunchUrls) {
		console.log(`LAN authenticated launch URL: ${url}`);
		if (process.stdout.isTTY)
			console.log(await qrCodeText(url, { type: "utf8", margin: 4, color: { dark: "#ffffff", light: "#000000" } }));
	}
	if (options.lan)
		console.log(
			"LAN access grants control of this account's files and terminal. Use only a trusted network; HTTP is not encrypted.",
		);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "Web harness startup failed");
		process.exitCode = 1;
	});
}
