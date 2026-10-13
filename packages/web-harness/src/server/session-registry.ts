import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_INJECTION_CUSTOM_TYPE,
	type ContextInjection,
	isContextInjection,
} from "../shared/context-injection.ts";
import type { PendingInputAction } from "../shared/contracts.ts";
import { createHarnessSettings } from "./config.ts";
import type { AgentRecord, PendingInput, RunRecord, TeamRecord } from "./team-manager.ts";

export interface ModelSelection {
	provider: string;
	id: string;
}
export interface WorkspaceDirectory {
	id: string;
	path: string;
}
export interface WorkspaceDirectoryService {
	register(root: string, preferredId?: string): Promise<WorkspaceDirectory>;
	getWorkspaceRoot(id: string): string;
	getWorkspaces(): WorkspaceDirectory[];
}
export interface SessionDescriptor {
	sessionId: string;
	workspaceId: string;
	cwd: string;
	path?: string;
	materialized: boolean;
	parentSessionId?: string;
	role?: string;
	systemPrompt?: string;
	model?: ModelSelection;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	availability: "ready" | "missing";
}
export interface ProjectedMessage {
	messageId: string;
	role: string;
	content: unknown;
	partial: boolean;
	runId?: string;
	contextInjection?: ContextInjection;
}
export interface ProjectedTool {
	key: string;
	sessionId: string;
	runId?: string;
	callId: string;
	name: string;
	input: unknown;
	result?: unknown;
	status: "running" | "success" | "error" | "cancelled";
}
export interface ContextUsageSnapshot {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}
export interface PendingInputProjection extends PendingInput {
	manageable: boolean;
}

export interface SessionSnapshot extends SessionDescriptor {
	title?: string;
	contextUsage?: ContextUsageSnapshot;
	messages: ProjectedMessage[];
	toolCalls: ProjectedTool[];
	activity: {
		queue?: { steering: readonly string[]; followUp: readonly string[] };
		retry?: unknown;
		compaction?: unknown;
	};
	currentRun?: RunRecord;
	latestRun?: RunRecord;
	pendingInput: PendingInputProjection[];
}
export interface HarnessState {
	schemaVersion: 1;
	workspaces: WorkspaceDirectory[];
	sessions: SessionDescriptor[];
	teams: TeamRecord[];
	agents: AgentRecord[];
	runs: RunRecord[];
	pendingInput: PendingInput[];
}
export interface ExecutionAdapter {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	deliverInput(text: string, mode: "steer" | "followUp", inputId: string): Promise<void>;
	injectContext(injection: ContextInjection, activeOnly?: boolean): Promise<boolean>;
	resumeContext(): Promise<void>;
	hasQueuedInput(inputId: string): boolean;
	mutateQueuedInput(inputId: string, action: PendingInputAction): boolean;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	clearQueue(): unknown;
	getActiveToolNames(): string[];
	getContextUsage?(): ContextUsageSnapshot | undefined;
	getThinkingLevel?(): ThinkingLevel;
	setThinkingLevel?(level: ThinkingLevel): void;
	setModel(selection: ModelSelection): Promise<void>;
	dispose(): void;
}
export interface RegistryOptions {
	agentDir: string;
	workspaceFiles: WorkspaceDirectoryService;
	modelRuntime?: ModelRuntime;
	customTools?: (descriptor: SessionDescriptor) => ToolDefinition[];
	/** An execution seam for deterministic boundary tests; production uses the Pi SDK. */
	adapterFactory?: (descriptor: SessionDescriptor, manager: SessionManager) => Promise<ExecutionAdapter>;
}
export interface RegistryEvent {
	type: "session_changed" | "workspace_changed";
	workspaceId: string;
	sessionId?: string;
}
export class HarnessError extends Error {
	readonly statusCode: number;
	constructor(message: string, statusCode = 400) {
		super(message);
		this.statusCode = statusCode;
	}
}
interface LiveSession {
	manager: SessionManager;
	adapter?: ExecutionAdapter;
	loading?: Promise<ExecutionAdapter>;
	unsubscribe?: () => void;
	projection: SessionSnapshot;
	liveMessageId?: string;
	runId?: string;
	finalText?: string;
	finalError?: string;
	aborted: boolean;
}
export interface ExecutionOutcome {
	aborted: boolean;
	result?: string;
	error?: string;
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
function validateState(value: unknown): asserts value is HarnessState {
	if (!value || typeof value !== "object") throw new Error("Invalid web-harness state");
	const state = value as Partial<HarnessState>;
	if (
		state.schemaVersion !== 1 ||
		!Array.isArray(state.workspaces) ||
		!Array.isArray(state.sessions) ||
		!Array.isArray(state.teams) ||
		!Array.isArray(state.agents) ||
		!Array.isArray(state.runs) ||
		!Array.isArray(state.pendingInput)
	) {
		throw new Error("Invalid web-harness state schema; refusing to overwrite it");
	}
	const ids = new Set<string>();
	for (const workspace of state.workspaces) {
		if (typeof workspace.id !== "string" || typeof workspace.path !== "string" || ids.has(workspace.id))
			throw new Error("Invalid workspace state");
		ids.add(workspace.id);
	}
	const sessions = new Set<string>();
	for (const session of state.sessions) {
		if (
			typeof session.sessionId !== "string" ||
			sessions.has(session.sessionId) ||
			!ids.has(session.workspaceId) ||
			typeof session.cwd !== "string" ||
			typeof session.materialized !== "boolean" ||
			(session.materialized && typeof session.path !== "string")
		)
			throw new Error("Invalid session state");
		sessions.add(session.sessionId);
	}
	const teams = new Set(state.teams.map((team) => team.teamId));
	const agents = new Set(state.agents.map((agent) => agent.agentId));
	if (teams.size !== state.teams.length || agents.size !== state.agents.length)
		throw new Error("Duplicate team or agent state");
	for (const session of state.sessions) {
		if (session.parentSessionId && !sessions.has(session.parentSessionId))
			throw new Error("Invalid parent session state");
		if (session.tools && (!Array.isArray(session.tools) || session.tools.some((tool) => typeof tool !== "string")))
			throw new Error("Invalid session tools state");
		if (session.model && (typeof session.model.provider !== "string" || typeof session.model.id !== "string"))
			throw new Error("Invalid session model state");
		if (
			session.thinkingLevel &&
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(session.thinkingLevel)
		)
			throw new Error("Invalid session thinking level");
	}
	const memberSessions = new Set<string>();
	for (const team of state.teams)
		if (typeof team.teamId !== "string" || !ids.has(team.workspaceId) || !agents.has(team.rootAgentId))
			throw new Error("Invalid team state");
	for (const agent of state.agents) {
		if (
			typeof agent.agentId !== "string" ||
			!teams.has(agent.teamId) ||
			!sessions.has(agent.sessionId) ||
			memberSessions.has(agent.sessionId) ||
			typeof agent.name !== "string" ||
			typeof agent.role !== "string"
		)
			throw new Error("Invalid agent state");
		memberSessions.add(agent.sessionId);
		let cursor = agent;
		const ancestry = new Set([agent.agentId]);
		while (cursor.parentAgentId) {
			const parent = state.agents.find((entry) => entry.agentId === cursor.parentAgentId);
			if (!parent || parent.teamId !== agent.teamId || ancestry.has(parent.agentId))
				throw new Error("Invalid agent ancestry state");
			ancestry.add(parent.agentId);
			cursor = parent;
		}
	}
	const runs = new Set(state.runs.map((run) => run.runId));
	const activeAgents = new Set<string>();
	if (runs.size !== state.runs.length) throw new Error("Duplicate run state");
	for (const run of state.runs) {
		if (
			typeof run.runId !== "string" ||
			!agents.has(run.agentId) ||
			typeof run.task !== "string" ||
			!["queued", "running", "waiting", "cancelling", "completed", "failed", "cancelled", "interrupted"].includes(
				run.status,
			) ||
			(run.inputKind !== undefined && run.inputKind !== "prompt" && run.inputKind !== "context")
		)
			throw new Error("Invalid run state");
		if (["queued", "running", "waiting", "cancelling"].includes(run.status)) {
			if (activeAgents.has(run.agentId)) throw new Error("Multiple unsettled runs for one agent");
			activeAgents.add(run.agentId);
		}
	}
	for (const input of state.pendingInput)
		if (
			!sessions.has(input.sessionId) ||
			!runs.has(input.runId) ||
			typeof input.inputId !== "string" ||
			typeof input.text !== "string" ||
			!["steer", "followUp"].includes(input.mode) ||
			!["pending", "undelivered"].includes(input.status) ||
			(input.contextInjection !== undefined && !isContextInjection(input.contextInjection))
		)
			throw new Error("Invalid pending input state");
}

/** Owns Pi conversations and projection only. TeamManager owns every run transition. */
export class SessionRegistry {
	readonly state: HarnessState = {
		schemaVersion: 1,
		workspaces: [],
		sessions: [],
		teams: [],
		agents: [],
		runs: [],
		pendingInput: [],
	};
	private readonly options: RegistryOptions;
	private readonly statePath: string;
	private readonly live = new Map<string, LiveSession>();
	private readonly listeners = new Set<(event: RegistryEvent) => void>();
	private readonly executionListeners = new Set<(sessionId: string, event: AgentSessionEvent) => void>();
	private saveQueue: Promise<void> = Promise.resolve();
	private mutationQueue: Promise<unknown> = Promise.resolve();
	private accepting = true;
	constructor(options: RegistryOptions) {
		this.options = options;
		this.statePath = join(options.agentDir, "web-harness", "state.json");
	}
	async initialize(): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.statePath, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (parsed !== undefined) {
			validateState(parsed);
			Object.assign(this.state, parsed);
		}
		for (const workspace of this.state.workspaces) {
			const registered = await this.options.workspaceFiles.register(workspace.path, workspace.id);
			if (registered.id !== workspace.id) throw new Error("Workspace identity mismatch in persisted state");
			workspace.path = registered.path;
		}
		for (const descriptor of this.state.sessions) {
			descriptor.cwd = this.getWorkspaceRoot(descriptor.workspaceId);
			const materialized = !!descriptor.path && existsSync(descriptor.path);
			descriptor.availability = descriptor.materialized && !materialized ? "missing" : "ready";
			if (descriptor.availability === "missing") continue;
			const manager =
				materialized && descriptor.path ? SessionManager.open(descriptor.path) : this.newManager(descriptor);
			if (manager.getSessionId() !== descriptor.sessionId)
				throw new Error("Conversation ID differs from web-harness state");
			descriptor.materialized = materialized;
			descriptor.path = manager.getSessionFile();
			this.addLive(descriptor, manager);
		}
	}
	private newManager(descriptor: SessionDescriptor): SessionManager {
		const parent = descriptor.parentSessionId ? this.descriptor(descriptor.parentSessionId) : undefined;
		return SessionManager.create(descriptor.cwd, join(this.options.agentDir, "web-harness", "sessions"), {
			id: descriptor.sessionId,
			parentSession: parent?.path,
		});
	}
	private addLive(descriptor: SessionDescriptor, manager: SessionManager): void {
		const messages = manager.buildSessionContext().messages.map(
			(message): ProjectedMessage => ({
				messageId: randomUUID(),
				role: message.role,
				content: structuredClone("content" in message ? message.content : message),
				partial: false,
				...(message.role === "custom" &&
				message.customType === CONTEXT_INJECTION_CUSTOM_TYPE &&
				isContextInjection(message.details)
					? { contextInjection: structuredClone(message.details) }
					: {}),
			}),
		);
		const toolCalls: ProjectedTool[] = [];
		for (const message of manager.buildSessionContext().messages) {
			if (message.role === "assistant")
				for (const part of message.content) {
					if (part.type === "toolCall")
						toolCalls.push({
							key: `${descriptor.sessionId}/history/${part.id}`,
							sessionId: descriptor.sessionId,
							callId: part.id,
							name: part.name,
							input: structuredClone(part.arguments),
							status: "cancelled",
						});
				}
			if (message.role === "toolResult") {
				const tool = toolCalls.find((entry) => entry.callId === message.toolCallId);
				if (tool) {
					tool.result = structuredClone(message);
					tool.status = message.isError ? "error" : "success";
				}
			}
		}
		this.live.set(descriptor.sessionId, {
			manager,
			projection: { ...descriptor, messages, toolCalls, activity: {}, pendingInput: [] },
			aborted: false,
		});
	}
	listWorkspaces(): WorkspaceDirectory[] {
		return structuredClone(this.state.workspaces);
	}
	getWorkspaceRoot(id: string): string {
		return this.options.workspaceFiles.getWorkspaceRoot(id);
	}
	async addWorkspace(cwd: string): Promise<WorkspaceDirectory> {
		return this.mutate(async () => {
			const workspace = await this.options.workspaceFiles.register(cwd);
			if (!this.state.workspaces.some((entry) => entry.id === workspace.id)) this.state.workspaces.push(workspace);
			await this.persist();
			this.emit({ type: "workspace_changed", workspaceId: workspace.id });
			return workspace;
		});
	}
	create(options: {
		workspaceId: string;
		parentSessionId?: string;
		role?: string;
		systemPrompt?: string;
		model?: ModelSelection;
		thinkingLevel?: ThinkingLevel;
		tools?: string[];
	}): Promise<SessionDescriptor> {
		return this.mutate(() => this.createWithinMutation(options));
	}
	/** TeamManager calls this only while holding the shared mutation gate. */
	async createWithinMutation(options: {
		workspaceId: string;
		parentSessionId?: string;
		role?: string;
		systemPrompt?: string;
		model?: ModelSelection;
		thinkingLevel?: ThinkingLevel;
		tools?: string[];
	}): Promise<SessionDescriptor> {
		if (!this.accepting) throw new HarnessError("Host is shutting down", 503);
		const cwd = this.getWorkspaceRoot(options.workspaceId);
		const model = options.model;
		if (model && this.options.modelRuntime && !this.options.modelRuntime.getModel(model.provider, model.id))
			throw new HarnessError("Model not found; select a model in the composer");
		const descriptor: SessionDescriptor = {
			...options,
			sessionId: randomUUID(),
			cwd,
			materialized: false,
			availability: "ready",
			model: model ? { ...model } : undefined,
		};
		if (descriptor.thinkingLevel && model && this.options.modelRuntime) {
			const selected = this.options.modelRuntime.getModel(model.provider, model.id);
			if (selected) descriptor.thinkingLevel = clampThinkingLevel(selected, descriptor.thinkingLevel);
		}
		const manager = this.newManager(descriptor);
		descriptor.path = manager.getSessionFile();
		this.state.sessions.push(descriptor);
		this.addLive(descriptor, manager);
		await this.persist();
		this.changed(descriptor.sessionId);
		return structuredClone(descriptor);
	}
	descriptor(id: string): SessionDescriptor {
		const descriptor = this.state.sessions.find((entry) => entry.sessionId === id);
		if (!descriptor) throw new HarnessError("Session not found", 404);
		return descriptor;
	}
	get(id: string): SessionSnapshot {
		const descriptor = this.descriptor(id);
		const projection = this.live.get(id)?.projection ?? {
			...descriptor,
			messages: [],
			toolCalls: [],
			activity: {},
			pendingInput: [],
		};
		const agent = this.state.agents.find((entry) => entry.sessionId === id);
		const runs = agent ? this.state.runs.filter((run) => run.agentId === agent.agentId) : [];
		const currentRun = runs.find((run) => !["completed", "failed", "cancelled", "interrupted"].includes(run.status));
		return structuredClone({
			...projection,
			...descriptor,
			contextUsage: this.live.get(id)?.adapter?.getContextUsage?.(),
			thinkingLevel: this.live.get(id)?.adapter?.getThinkingLevel?.() ?? descriptor.thinkingLevel,
			title: runs[0]?.task,
			currentRun,
			latestRun: runs.at(-1),
			pendingInput: this.state.pendingInput
				.filter((input) => input.sessionId === id)
				.map((input) => this.projectPendingInput(input, currentRun)),
		});
	}
	list(workspaceId?: string): Omit<SessionSnapshot, "messages" | "toolCalls" | "activity">[] {
		return this.state.sessions
			.filter((entry) => !workspaceId || entry.workspaceId === workspaceId)
			.map((descriptor) => {
				const agent = this.state.agents.find((entry) => entry.sessionId === descriptor.sessionId);
				const runs = agent ? this.state.runs.filter((run) => run.agentId === agent.agentId) : [];
				const currentRun = runs.find(
					(run) => !["completed", "failed", "cancelled", "interrupted"].includes(run.status),
				);
				return structuredClone({
					...descriptor,
					title: runs[0]?.task,
					currentRun,
					latestRun: runs.at(-1),
					pendingInput: this.state.pendingInput
						.filter((input) => input.sessionId === descriptor.sessionId)
						.map((input) => this.projectPendingInput(input, currentRun)),
				});
			});
	}
	subscribe(listener: (event: RegistryEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onExecutionEvent(listener: (id: string, event: AgentSessionEvent) => void): () => void {
		this.executionListeners.add(listener);
		return () => this.executionListeners.delete(listener);
	}
	private emit(event: RegistryEvent): void {
		for (const listener of this.listeners) listener(event);
	}
	changed(sessionId: string): void {
		this.emit({ type: "session_changed", sessionId, workspaceId: this.descriptor(sessionId).workspaceId });
	}
	/** Serialized state transitions. Never hold this gate while awaiting an agent. */
	mutate<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.mutationQueue.then(operation);
		this.mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	hasQueuedInput(sessionId: string, inputId: string): boolean {
		return this.live.get(sessionId)?.adapter?.hasQueuedInput(inputId) ?? false;
	}

	mutateQueuedInput(sessionId: string, inputId: string, action: PendingInputAction): boolean {
		return this.live.get(sessionId)?.adapter?.mutateQueuedInput(inputId, action) ?? false;
	}

	persist(): Promise<void> {
		this.state.workspaces = this.options.workspaceFiles.getWorkspaces();
		const bytes = JSON.stringify(this.state, null, 2);
		const save = this.saveQueue.then(async () => {
			await mkdir(join(this.options.agentDir, "web-harness"), { recursive: true, mode: 0o700 });
			const temporary = `${this.statePath}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, bytes, { mode: 0o600 });
				await rename(temporary, this.statePath);
			} finally {
				await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
		});
		this.saveQueue = save.catch(() => undefined);
		return save;
	}
	private async adapter(id: string): Promise<ExecutionAdapter> {
		const descriptor = this.descriptor(id);
		const live = this.live.get(id);
		if (!live || descriptor.availability === "missing") throw new HarnessError("Conversation file is missing", 409);
		if (live.adapter) return live.adapter;
		if (!live.loading)
			live.loading = (async () => {
				let adapter: ExecutionAdapter;
				if (this.options.adapterFactory) adapter = await this.options.adapterFactory(descriptor, live.manager);
				else {
					const runtime = this.options.modelRuntime;
					if (!runtime) throw new Error("Model runtime is not configured");
					if (!descriptor.model) throw new HarnessError("No model selected; choose a model in the composer");
					const settingsManager = createHarnessSettings(descriptor.cwd, this.options.agentDir);
					const loader = new DefaultResourceLoader({
						cwd: descriptor.cwd,
						agentDir: this.options.agentDir,
						projectConfigDirName: ".hasilan-code",
						settingsManager,
						extensionFactories: [
							(pi) => {
								pi.on("before_agent_start", (event) => {
									event.systemPromptOptions.defaultPreamble =
										"You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.";
									event.systemPromptOptions.includeDocumentation = false;
								});
							},
						],
						appendSystemPrompt: [
							descriptor.role ? `Agent role: ${descriptor.role}` : "",
							descriptor.systemPrompt ?? "",
						].filter(Boolean),
					});
					await loader.reload();
					const model = descriptor.model
						? runtime.getModel(descriptor.model.provider, descriptor.model.id)
						: undefined;
					if (descriptor.model && !model)
						throw new HarnessError("Configured model is unavailable; select a model in the composer");
					const { session } = await createAgentSession({
						cwd: descriptor.cwd,
						agentDir: this.options.agentDir,
						modelRuntime: runtime,
						model,
						sessionManager: live.manager,
						settingsManager,
						resourceLoader: loader,
						customTools: this.options.customTools?.(descriptor),
						tools: descriptor.tools,
					});
					if (descriptor.thinkingLevel) session.setThinkingLevel(descriptor.thinkingLevel);
					await session.bindExtensions({});
					const managedSession = session as unknown as {
						queueManagedInput(text: string, mode: "steer" | "followUp", inputId: string): Promise<unknown>;
						hasQueuedInput(inputId: string): boolean;
						mutateQueuedInput(inputId: string, action: PendingInputAction): boolean;
						resumeContext(): Promise<void>;
					};
					adapter = {
						subscribe: (listener) => session.subscribe(listener),
						prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
						deliverInput: async (text, mode, inputId) => {
							await managedSession.queueManagedInput(text, mode, inputId);
						},
						injectContext: async (injection, activeOnly) => {
							if (activeOnly && !session.isStreaming) return false;
							const injected = session.sendCustomMessage(
								{
									customType: CONTEXT_INJECTION_CUSTOM_TYPE,
									content: injection.content,
									display: true,
									details: structuredClone(injection),
								},
								{ triggerTurn: false },
							);
							// Request continuation before yielding, so a final turn cannot settle between injection and wake.
							const resumed = activeOnly ? managedSession.resumeContext() : undefined;
							await injected;
							await resumed;
							return true;
						},
						resumeContext: () => managedSession.resumeContext(),
						hasQueuedInput: (inputId) => managedSession.hasQueuedInput(inputId),
						mutateQueuedInput: (inputId, action) => managedSession.mutateQueuedInput(inputId, action),
						abort: () => session.abort(),
						waitForIdle: () => session.waitForIdle(),
						clearQueue: () => session.clearQueue(),
						getActiveToolNames: () => session.getActiveToolNames(),
						getContextUsage: () => session.getContextUsage(),
						getThinkingLevel: () => session.thinkingLevel,
						setThinkingLevel: (level) => session.setThinkingLevel(level),
						setModel: async (selection) => {
							const selected = runtime.getModel(selection.provider, selection.id);
							if (!selected) throw new HarnessError("Model not found");
							await session.setModel(selected);
						},
						dispose: () => session.dispose(),
					};
				}
				live.adapter = adapter;
				live.unsubscribe = adapter.subscribe((event) => this.project(id, event));
				return adapter;
			})().catch((error: unknown) => {
				live.loading = undefined;
				throw error;
			});
		return live.loading;
	}
	private project(id: string, event: AgentSessionEvent): void {
		const live = this.live.get(id);
		if (!live) return;
		const projection = live.projection;
		if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
			if (event.type === "message_start" || !live.liveMessageId) live.liveMessageId = randomUUID();
			const message: ProjectedMessage = {
				messageId: live.liveMessageId,
				role: event.message.role,
				content: structuredClone("content" in event.message ? event.message.content : event.message),
				partial: event.type !== "message_end",
				runId: live.runId,
				...(event.message.role === "custom" &&
				event.message.customType === CONTEXT_INJECTION_CUSTOM_TYPE &&
				isContextInjection(event.message.details)
					? { contextInjection: structuredClone(event.message.details) }
					: {}),
			};
			const index = projection.messages.findIndex((entry) => entry.messageId === message.messageId);
			if (index === -1) projection.messages.push(message);
			else projection.messages[index] = message;
			if (event.type === "message_end") {
				live.liveMessageId = undefined;
				if (event.message.role === "assistant") {
					live.finalText = messageText(event.message);
					live.finalError =
						event.message.stopReason === "error"
							? (event.message.errorMessage ?? "Model request failed")
							: undefined;
				}
			}
		} else if (event.type === "tool_execution_start") {
			projection.toolCalls.push({
				key: `${id}/${live.runId ?? "outside"}/${event.toolCallId}`,
				sessionId: id,
				runId: live.runId,
				callId: event.toolCallId,
				name: event.toolName,
				input: structuredClone(event.args),
				status: "running",
			});
		} else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			const tool = projection.toolCalls.findLast(
				(entry) => entry.callId === event.toolCallId && entry.runId === live.runId,
			);
			if (tool) {
				tool.result = structuredClone(event.type === "tool_execution_end" ? event.result : event.partialResult);
				if (event.type === "tool_execution_end") tool.status = event.isError ? "error" : "success";
			}
		} else if (event.type === "queue_update")
			projection.activity.queue = { steering: [...event.steering], followUp: [...event.followUp] };
		else if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
			projection.activity.retry = structuredClone(event);
			if (event.type === "auto_retry_end" && !event.success)
				live.finalError = event.finalError ?? "Model retry failed";
		} else if (event.type === "compaction_start" || event.type === "compaction_end")
			projection.activity.compaction = structuredClone(event);
		else if (event.type === "agent_settled") {
			live.aborted = event.aborted;
			for (const tool of projection.toolCalls)
				if (tool.runId === live.runId && tool.status === "running") tool.status = "cancelled";
		}
		for (const listener of this.executionListeners) listener(id, event);
		this.changed(id);
	}
	async execute(
		id: string,
		runId: string,
		text: string,
		signal: AbortSignal,
		inputKind: "prompt" | "context" = "prompt",
	): Promise<ExecutionOutcome> {
		const live = this.live.get(id);
		if (!live) return { aborted: false, error: "Conversation file is missing" };
		live.runId = runId;
		live.finalText = undefined;
		live.finalError = undefined;
		live.aborted = false;
		let abort: (() => void) | undefined;
		try {
			const adapter = await this.adapter(id);
			if (signal.aborted) return { aborted: true };
			abort = () => {
				void adapter.abort().catch(() => undefined);
			};
			signal.addEventListener("abort", abort, { once: true });
			if (inputKind === "context") {
				for (const input of this.state.pendingInput.filter(
					(entry) => entry.runId === runId && entry.status === "pending" && entry.contextInjection,
				)) {
					if (!input.delivered) {
						await adapter.injectContext(input.contextInjection!);
						input.delivered = true;
					}
				}
				await adapter.resumeContext();
			} else await adapter.prompt(text);
			await adapter.waitForIdle();
			return { aborted: live.aborted || signal.aborted, result: live.finalText, error: live.finalError };
		} catch (error) {
			return { aborted: signal.aborted, error: error instanceof Error ? error.message : String(error) };
		} finally {
			if (abort) signal.removeEventListener("abort", abort);
			live.runId = undefined;
			const descriptor = this.descriptor(id);
			descriptor.materialized = !!descriptor.path && existsSync(descriptor.path);
			await this.persist();
			this.changed(id);
		}
	}
	async deliver(id: string, text: string, mode: "steer" | "followUp", inputId: string): Promise<void> {
		const adapter = await this.adapter(id);
		await adapter.deliverInput(text, mode, inputId);
	}
	async deliverContext(id: string, injection: ContextInjection): Promise<boolean> {
		const adapter = await this.adapter(id);
		return adapter.injectContext(injection, true);
	}

	private projectPendingInput(input: PendingInput, currentRun?: RunRecord): PendingInputProjection {
		const userInput = !input.fromAgentId && !input.completionRunId;
		const manageable =
			userInput &&
			(input.status === "undelivered" ||
				(input.status === "pending" &&
					currentRun?.runId === input.runId &&
					currentRun.status !== "cancelling" &&
					(!input.delivered || this.hasQueuedInput(input.sessionId, input.inputId))));
		return { ...input, manageable };
	}

	activeTools(id: string): string[] {
		return (
			this.live.get(id)?.adapter?.getActiveToolNames() ??
			this.descriptor(id).tools ?? ["read", "edit", "write", "bash", "browser", "web_search", "team"]
		);
	}
	clearQueue(id: string): void {
		this.live.get(id)?.adapter?.clearQueue();
	}
	async setModel(id: string, selection: ModelSelection): Promise<void> {
		await this.mutate(async () => {
			if (this.get(id).currentRun) throw new HarnessError("Change the model only while the session is idle", 409);
			const descriptor = this.descriptor(id);
			const adapter = this.live.get(id)?.adapter;
			if (adapter) await adapter.setModel(selection);
			else if (this.options.modelRuntime && !this.options.modelRuntime.getModel(selection.provider, selection.id))
				throw new HarnessError("Model not found");
			descriptor.model = { ...selection };
			const selected = this.options.modelRuntime?.getModel(selection.provider, selection.id);
			if (selected && descriptor.thinkingLevel)
				descriptor.thinkingLevel =
					adapter?.getThinkingLevel?.() ?? clampThinkingLevel(selected, descriptor.thinkingLevel);
			await this.persist();
			this.changed(id);
		});
	}
	async setThinkingLevel(id: string, level: ThinkingLevel): Promise<void> {
		await this.mutate(async () => {
			if (this.get(id).currentRun) throw new HarnessError("Change thinking only while the session is idle", 409);
			const descriptor = this.descriptor(id);
			const model =
				descriptor.model && this.options.modelRuntime?.getModel(descriptor.model.provider, descriptor.model.id);
			if (model && !getSupportedThinkingLevels(model).includes(level))
				throw new HarnessError("Thinking level is not supported by this model", 400);
			const adapter = this.live.get(id)?.adapter;
			adapter?.setThinkingLevel?.(level);
			descriptor.thinkingLevel = adapter?.getThinkingLevel?.() ?? level;
			await this.persist();
			this.changed(id);
		});
	}
	async close(): Promise<void> {
		this.accepting = false;
		await Promise.all(
			[...this.live.values()].map(async (live) => {
				if (live.adapter) {
					await live.adapter.abort();
					live.unsubscribe?.();
					live.adapter.dispose();
				}
			}),
		);
		await this.persist();
		await this.saveQueue;
	}
}
