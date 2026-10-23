import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@hasilan-code/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@hasilan-code/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	estimateProjectedContextTokens,
	type ModelRuntime,
	SessionManager,
	type ToolDefinition,
} from "@hasilan-code/pi-coding-agent";
import {
	CONTEXT_INJECTION_CUSTOM_TYPE,
	type ContextInjection,
	isContextInjection,
} from "../shared/context-injection.ts";
import type { PendingInputAction } from "../shared/contracts.ts";
import type { Goal } from "../shared/goals.ts";
import { nextId } from "../shared/ids.ts";
import {
	HistoryCursorError,
	type HistoryMessage,
	type HistoryPosition,
	type HistoryTool,
	historyPage,
} from "../shared/session-history.ts";
import {
	type ImportedFrom,
	type ImportedTranscript,
	SESSION_IMPORT_CONTEXT_TYPE,
	SESSION_IMPORT_RECORD_TYPE,
	SESSION_IMPORT_SOURCES,
} from "../shared/session-import.ts";
import { SWARM_OBJECTIVE_MAX_LENGTH, type Swarm } from "../shared/swarm.ts";
import type { ModelUsage } from "../shared/usage.ts";
import { createHarnessSettings } from "./config.ts";
import { appendRuntimeContext } from "./runtime-context.ts";
import { sameWorkspace } from "./session-import/common.ts";
import { importedRecord, storeImport } from "./session-import/persistence.ts";
import { type ImportAsset, projectImport } from "./session-import/projection.ts";
import { SessionUsage } from "./session-usage.ts";
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
	title?: string;
	importedFrom?: ImportedFrom;
	model?: ModelSelection;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	goal?: Goal;
	swarm?: Swarm;
	availability: "ready" | "missing";
}
export type ProjectedMessage = HistoryMessage;
export type ProjectedTool = HistoryTool;
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
	usage?: ModelUsage[];
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
	type: "session_changed" | "workspace_changed" | "session_deleted";
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
	usage: SessionUsage;
	adapter?: ExecutionAdapter;
	loading?: Promise<ExecutionAdapter>;
	unsubscribe?: () => void;
	projection: SessionSnapshot;
	importAssets: Map<string, ImportAsset>;
	liveMessageId?: string;
	runId?: string;
	finalText?: string;
	finalError?: string;
	aborted: boolean;
	idleContextUsage?: { model: string; value: ContextUsageSnapshot };
	/** Implementation grants retained while the manager uses a read-only orchestration loadout. */
	delegatedTools?: string[];
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
		if (session.title !== undefined && typeof session.title !== "string") throw new Error("Invalid session title");
		if (
			session.importedFrom &&
			(!SESSION_IMPORT_SOURCES.some((source) => source.id === session.importedFrom?.source) ||
				typeof session.importedFrom.sourceSessionId !== "string" ||
				typeof session.importedFrom.revision !== "string" ||
				typeof session.importedFrom.importedAt !== "string")
		)
			throw new Error("Invalid imported session provenance");
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
		if (session.swarm) {
			const swarm = session.swarm;
			const legacy = swarm.status === undefined && swarm.updatedAt === undefined && swarm.reason === undefined;
			if (
				session.parentSessionId ||
				typeof swarm.id !== "string" ||
				!swarm.id ||
				typeof swarm.objective !== "string" ||
				!swarm.objective.trim() ||
				swarm.objective.length > SWARM_OBJECTIVE_MAX_LENGTH ||
				typeof swarm.createdAt !== "string" ||
				typeof swarm.rootRunId !== "string" ||
				!swarm.rootRunId ||
				(!legacy && !["active", "paused", "blocked", "complete"].includes(swarm.status)) ||
				(!legacy && typeof swarm.updatedAt !== "string") ||
				(swarm.reason !== undefined && typeof swarm.reason !== "string")
			)
				throw new Error("Invalid session swarm state");
			if (legacy) {
				swarm.status = "paused";
				swarm.updatedAt = new Date().toISOString();
				swarm.reason = "Saved swarm requires explicit restart with /hyakki";
			}
		}
		if (session.goal) {
			const goal = session.goal as Omit<Goal, "status"> & { status: string };
			if (
				session.parentSessionId ||
				typeof goal.id !== "string" ||
				typeof goal.objective !== "string" ||
				!goal.objective.trim() ||
				!["active", "paused", "blocked", "complete", "dropped", "budget-limited"].includes(goal.status) ||
				(goal.reason !== undefined && typeof goal.reason !== "string") ||
				typeof goal.createdAt !== "string" ||
				typeof goal.updatedAt !== "string"
			)
				throw new Error("Invalid session goal state");
			// Rebuild saved goals from supported fields; obsolete limits and usage must not reach runtime or API.
			const paused = goal.status === "budget-limited";
			session.goal = {
				id: goal.id,
				objective: goal.objective,
				status: paused ? "paused" : (goal.status as Goal["status"]),
				...(paused
					? { reason: "Saved goal requires explicit resume" }
					: goal.reason === undefined
						? {}
						: { reason: goal.reason }),
				createdAt: goal.createdAt,
				updatedAt: paused ? new Date().toISOString() : goal.updatedAt,
			};
		}
	}
	const memberSessions = new Set<string>();
	const workspaceTeams = new Set<string>();
	for (const team of state.teams) {
		const root = state.agents.find((agent) => agent.agentId === team.rootAgentId);
		if (
			typeof team.teamId !== "string" ||
			!ids.has(team.workspaceId) ||
			!root ||
			root.parentAgentId ||
			root.teamId !== team.teamId ||
			state.sessions.find((session) => session.sessionId === root.sessionId)?.workspaceId !== team.workspaceId ||
			(team.scope !== undefined && team.scope !== "workspace")
		)
			throw new Error("Invalid team state");
		if (team.scope === "workspace") {
			if (workspaceTeams.has(team.workspaceId)) throw new Error("Multiple persistent teams for one workspace");
			workspaceTeams.add(team.workspaceId);
		}
	}
	for (const agent of state.agents) {
		if (
			typeof agent.agentId !== "string" ||
			!teams.has(agent.teamId) ||
			!sessions.has(agent.sessionId) ||
			memberSessions.has(agent.sessionId) ||
			typeof agent.name !== "string" ||
			typeof agent.role !== "string" ||
			(agent.responsibility !== undefined &&
				(typeof agent.responsibility !== "string" ||
					!agent.responsibility.trim() ||
					agent.responsibility.length > 16384))
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
	const runById = new Map(state.runs.map((run) => [run.runId, run]));
	const agentById = new Map(state.agents.map((agent) => [agent.agentId, agent]));
	const runOrder = new Map(state.runs.map((run, index) => [run.runId, index]));
	for (const run of state.runs) {
		if (
			(run.requestedByAgentId !== undefined &&
				(!agentById.has(run.requestedByAgentId) ||
					agentById.get(run.requestedByAgentId)?.teamId !== agentById.get(run.agentId)?.teamId)) ||
			(run.replyToAgentIds !== undefined &&
				(!Array.isArray(run.replyToAgentIds) ||
					run.replyToAgentIds.some(
						(id) => !agentById.has(id) || agentById.get(id)?.teamId !== agentById.get(run.agentId)?.teamId,
					))) ||
			(run.swarmId !== undefined && (typeof run.swarmId !== "string" || !run.swarmId))
		)
			throw new Error("Invalid assignment ownership state");
		for (const [id, forward] of [
			[run.handoffToRunId, true],
			[run.handoffFromRunId, false],
		] as const) {
			if (id === undefined) continue;
			const other = runById.get(id);
			if (
				!other ||
				(forward ? other.handoffFromRunId : other.handoffToRunId) !== run.runId ||
				agentById.get(other.agentId)?.teamId !== agentById.get(run.agentId)?.teamId ||
				(forward ? runOrder.get(id)! <= runOrder.get(run.runId)! : runOrder.get(id)! >= runOrder.get(run.runId)!)
			)
				throw new Error("Invalid assignment handoff state");
		}
	}
	for (const session of state.sessions) {
		if (!session.swarm) continue;
		const root = state.agents.find((agent) => agent.sessionId === session.sessionId);
		const run = state.runs.find((entry) => entry.runId === session.swarm?.rootRunId);
		if (!root || root.parentAgentId || !run || run.agentId !== root.agentId)
			throw new Error("Invalid session swarm run state");
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
		let savedModes = false;
		try {
			parsed = JSON.parse(await readFile(this.statePath, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (parsed !== undefined) {
			validateState(parsed);
			Object.assign(this.state, parsed);
			savedModes = this.state.sessions.some(
				(descriptor) => descriptor.goal !== undefined || descriptor.swarm !== undefined,
			);
			for (const descriptor of this.state.sessions) {
				if (descriptor.goal?.status === "active") {
					descriptor.goal.status = "paused";
					descriptor.goal.reason = "Host restarted; resume explicitly to continue";
					descriptor.goal.updatedAt = new Date().toISOString();
				}
				if (descriptor.swarm?.status === "active") {
					descriptor.swarm.status = "paused";
					descriptor.swarm.reason = "Host restarted; start Hyakki-Yako explicitly to continue";
					descriptor.swarm.updatedAt = new Date().toISOString();
				}
			}
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
		if (savedModes) await this.persist();
	}
	private newManager(descriptor: SessionDescriptor): SessionManager {
		const parent = descriptor.parentSessionId ? this.descriptor(descriptor.parentSessionId) : undefined;
		return SessionManager.create(descriptor.cwd, join(this.options.agentDir, "web-harness", "sessions"), {
			id: descriptor.sessionId,
			parentSession: parent?.path,
		});
	}
	private addLive(descriptor: SessionDescriptor, manager: SessionManager): void {
		const imported = projectImport(manager, descriptor.sessionId);
		const entries = manager.getEntries();
		const boundary = imported.boundary ? entries.findIndex((entry) => entry.id === imported.boundary) : -1;
		const ownEntries = new Set(entries.slice(boundary + 1).map((entry) => entry.id));
		const context = manager
			.buildSessionProjection()
			.entries.filter((entry) => boundary < 0 || !imported.messages.length || ownEntries.has(entry.sourceEntry.id))
			.flatMap((entry) => entry.messages);
		const messages = [
			...imported.messages,
			...context
				.filter((message) => message.role !== "custom" || message.display)
				.map(
					(message): ProjectedMessage => ({
						messageId: randomUUID(),
						role: message.role,
						content: structuredClone("content" in message ? message.content : message),
						partial: false,
						...(message.role === "custom" && message.customType === SESSION_IMPORT_CONTEXT_TYPE
							? { importedContext: true }
							: {}),
						...(message.role === "custom" &&
						message.customType === CONTEXT_INJECTION_CUSTOM_TYPE &&
						isContextInjection(message.details)
							? { contextInjection: structuredClone(message.details) }
							: {}),
					}),
				),
		];
		const toolCalls: ProjectedTool[] = [...imported.toolCalls];
		const nativeCalls = new Map<string, ProjectedTool>();
		for (const message of context) {
			if (message.role === "assistant")
				for (const part of message.content) {
					if (part.type === "toolCall") {
						const tool: ProjectedTool = {
							key: `${descriptor.sessionId}/history/${part.id}`,
							sessionId: descriptor.sessionId,
							callId: part.id,
							name: part.name,
							input: structuredClone(part.arguments),
							status: "cancelled",
						};
						toolCalls.push(tool);
						nativeCalls.set(part.id, tool);
					}
				}
			if (message.role === "toolResult") {
				const tool = nativeCalls.get(message.toolCallId);
				if (tool) {
					tool.result = structuredClone(message);
					tool.status = message.isError ? "error" : "success";
				}
			}
		}
		this.live.set(descriptor.sessionId, {
			manager,
			usage: new SessionUsage(manager),
			projection: { ...descriptor, messages, toolCalls, activity: {}, pendingInput: [] },
			importAssets: imported.assets,
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
	importSession(
		workspaceId: string,
		source: ImportedTranscript,
		revision: string,
		model?: ModelSelection,
		thinkingLevel?: ThinkingLevel,
	): Promise<SessionDescriptor> {
		return this.mutate(async () => {
			if (!this.accepting) throw new HarnessError("Host is shutting down", 503);
			const cwd = this.getWorkspaceRoot(workspaceId);
			if (!(await sameWorkspace(source.cwd, cwd)))
				throw new HarnessError("このセッションは現在のワークスペースの履歴ではありません。");
			const existing = this.state.sessions.find(
				(entry) =>
					entry.workspaceId === workspaceId &&
					entry.importedFrom?.source === source.source &&
					entry.importedFrom.sourceSessionId === source.sourceSessionId &&
					entry.importedFrom.revision === revision &&
					entry.importedFrom.fidelityVersion === 1,
			);
			if (existing) return structuredClone(existing);
			if (!source.messages.length) throw new HarnessError("取り込める会話メッセージがありません。");
			if (model && this.options.modelRuntime && !this.options.modelRuntime.getModel(model.provider, model.id))
				throw new HarnessError("Model not found; select a model in the composer");
			const descriptor: SessionDescriptor = {
				sessionId: randomUUID(),
				workspaceId,
				cwd,
				title: source.title,
				materialized: true,
				availability: "ready",
				model: model ? { ...model } : undefined,
				thinkingLevel,
				importedFrom: {
					source: source.source,
					sourceSessionId: source.sourceSessionId,
					revision,
					importedAt: new Date().toISOString(),
					fidelityVersion: 1,
				},
			};
			const selected = model && this.options.modelRuntime?.getModel(model.provider, model.id);
			if (selected && thinkingLevel) descriptor.thinkingLevel = clampThinkingLevel(selected, thinkingLevel);
			const memory = SessionManager.inMemory(cwd, { id: descriptor.sessionId });
			memory.appendSessionInfo(source.title);
			memory.appendCustomEntry("harness-session-import", {
				...descriptor.importedFrom,
				cwd: source.cwd,
				warnings: source.warnings,
			});
			const assets = join(this.options.agentDir, "web-harness", "import-assets", descriptor.sessionId);
			const path = this.newManager(descriptor).getSessionFile();
			if (!path) throw new Error("Could not prepare imported session file");
			descriptor.path = path;
			let written = false;
			try {
				await storeImport(memory, source, assets);
				const importedFile = await open(path, "wx", 0o600);
				written = true;
				try {
					for (const entry of [memory.getHeader(), ...memory.getEntries()])
						await importedFile.writeFile(`${JSON.stringify(entry)}\n`);
				} finally {
					await importedFile.close();
				}
				const manager = SessionManager.open(path);
				this.state.sessions.push(descriptor);
				this.addLive(descriptor, manager);
				await this.persist();
			} catch (error) {
				this.state.sessions = this.state.sessions.filter((entry) => entry !== descriptor);
				this.live.delete(descriptor.sessionId);
				if (written) await unlink(path);
				await rm(assets, { recursive: true, force: true });
				throw error;
			}
			this.changed(descriptor.sessionId);
			return structuredClone(descriptor);
		});
	}
	importRecord(sessionId: string, recordId: string): Record<string, unknown> {
		this.descriptor(sessionId);
		const entry = this.live.get(sessionId)?.manager.getEntry(recordId);
		if (entry?.type !== "custom" || entry.customType !== SESSION_IMPORT_RECORD_TYPE || !importedRecord(entry.data))
			throw new HarnessError("元の記録が見つかりません。", 404);
		return entry.data.raw;
	}
	importRecords(sessionId: string): Iterable<Record<string, unknown>> {
		this.descriptor(sessionId);
		const entries = this.live.get(sessionId)?.manager.getEntries() ?? [];
		return (function* () {
			for (const entry of entries)
				if (
					entry.type === "custom" &&
					entry.customType === SESSION_IMPORT_RECORD_TYPE &&
					importedRecord(entry.data)
				)
					yield entry.data.raw;
		})();
	}
	importAsset(sessionId: string, assetId: string): ImportAsset & { path: string } {
		this.descriptor(sessionId);
		const asset = /^[a-f0-9]{64}$/.test(assetId) && this.live.get(sessionId)?.importAssets.get(assetId);
		if (!asset) throw new HarnessError("添付ファイルが見つかりません。", 404);
		return { ...asset, path: join(this.options.agentDir, "web-harness", "import-assets", sessionId, assetId) };
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
			sessionId: options.parentSessionId ? nextId("s", this.state.sessions, "sessionId") : randomUUID(),
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
	async renameSession(id: string, title: string): Promise<void> {
		await this.mutate(async () => {
			if (!this.accepting) throw new HarnessError("Host is shutting down", 503);
			const name = title.trim();
			if (!name || name.length > 200) throw new HarnessError("会話名は1〜200文字で入力してください。");
			const descriptor = this.descriptor(id);
			const previous = descriptor.title;
			descriptor.title = name;
			try {
				await this.persist();
			} catch (error) {
				descriptor.title = previous;
				throw error;
			}
			this.changed(id);
		});
	}
	/** Remove the app's conversation tree, retaining the underlying SDK history files. */
	async deleteSession(id: string): Promise<string[]> {
		return this.mutate(async () => {
			if (!this.accepting) throw new HarnessError("Host is shutting down", 503);
			const descriptor = this.descriptor(id);
			const root = this.state.agents.find((agent) => agent.sessionId === id);
			if (descriptor.parentSessionId || root?.parentAgentId)
				throw new HarnessError("子の会話は親の会話と一緒に削除してください。", 409);
			const ids = new Set([id]);
			if (root) for (const agent of this.state.agents) if (agent.teamId === root.teamId) ids.add(agent.sessionId);
			let changed = true;
			while (changed) {
				changed = false;
				for (const session of this.state.sessions)
					if (session.parentSessionId && ids.has(session.parentSessionId) && !ids.has(session.sessionId)) {
						ids.add(session.sessionId);
						changed = true;
					}
			}
			const agents = new Set(
				this.state.agents.filter((agent) => ids.has(agent.sessionId)).map((agent) => agent.agentId),
			);
			if (
				this.state.runs.some(
					(run) =>
						agents.has(run.agentId) && !["completed", "failed", "cancelled", "interrupted"].includes(run.status),
				) ||
				this.state.sessions.some(
					(session) =>
						ids.has(session.sessionId) &&
						(session.goal?.status === "active" ||
							session.swarm?.status === "active" ||
							this.live.get(session.sessionId)?.runId),
				)
			)
				throw new HarnessError("会話とチームの実行を停止してから削除してください。", 409);
			const previous = {
				sessions: this.state.sessions,
				teams: this.state.teams,
				agents: this.state.agents,
				runs: this.state.runs,
				pendingInput: this.state.pendingInput,
			};
			this.state.sessions = previous.sessions.filter((session) => !ids.has(session.sessionId));
			this.state.teams = previous.teams.filter((team) => !agents.has(team.rootAgentId));
			this.state.agents = previous.agents.filter((agent) => !agents.has(agent.agentId));
			this.state.runs = previous.runs.filter((run) => !agents.has(run.agentId));
			this.state.pendingInput = previous.pendingInput.filter((input) => !ids.has(input.sessionId));
			try {
				await this.persist();
			} catch (error) {
				Object.assign(this.state, previous);
				throw error;
			}
			for (const sessionId of ids) {
				const live = this.live.get(sessionId);
				live?.unsubscribe?.();
				live?.adapter?.dispose();
				this.live.delete(sessionId);
				this.emit({ type: "session_deleted", sessionId, workspaceId: descriptor.workspaceId });
			}
			this.emit({ type: "workspace_changed", workspaceId: descriptor.workspaceId });
			return [...ids];
		});
	}
	get(id: string): SessionSnapshot {
		return structuredClone(this.projection(id));
	}
	page(id: string, before?: string): SessionSnapshot & { history: HistoryPosition } {
		try {
			return structuredClone(historyPage(this.projection(id), before));
		} catch (error) {
			if (error instanceof HistoryCursorError) throw new HarnessError(error.message, 409);
			throw error;
		}
	}
	/** Transport reads immutable message/tool references; callers must not mutate this view. */
	projection(id: string): SessionSnapshot {
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
		const live = this.live.get(id);
		let contextUsage = live?.adapter?.getContextUsage?.();
		if (live && !live.adapter && descriptor.materialized && descriptor.model) {
			const modelKey = `${descriptor.model.provider}/${descriptor.model.id}`;
			const contextWindow = this.options.modelRuntime?.getModel(
				descriptor.model.provider,
				descriptor.model.id,
			)?.contextWindow;
			if (contextWindow && contextWindow > 0) {
				const tokens =
					live.idleContextUsage?.model === modelKey
						? live.idleContextUsage.value.tokens
						: estimateProjectedContextTokens(live.manager.buildSessionProjection(), live.manager.getBranch())
								.tokens;
				contextUsage = { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 };
				live.idleContextUsage = { model: modelKey, value: contextUsage };
			}
		}
		return {
			...projection,
			...descriptor,
			contextUsage,
			usage: this.live.get(id)?.usage.snapshot(),
			thinkingLevel: this.live.get(id)?.adapter?.getThinkingLevel?.() ?? descriptor.thinkingLevel,
			title: descriptor.title ?? runs[0]?.task,
			currentRun,
			latestRun: runs.at(-1),
			pendingInput: this.state.pendingInput
				.filter((input) => input.sessionId === id)
				.map((input) => this.projectPendingInput(input, currentRun)),
		};
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
					usage: this.live.get(descriptor.sessionId)?.usage.snapshot(),
					title: descriptor.title ?? runs[0]?.task,
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
	async assertModelReady(id: string): Promise<void> {
		const descriptor = this.descriptor(id);
		if (descriptor.availability !== "ready") throw new HarnessError("Conversation file is missing", 409);
		if (this.options.adapterFactory) return;
		if (!descriptor.model) throw new HarnessError("No model selected; choose a model in the composer");
		const runtime = this.options.modelRuntime;
		if (!runtime?.getModel(descriptor.model.provider, descriptor.model.id))
			throw new HarnessError("Configured model is unavailable; select a model in the composer");
		if (
			!runtime.hasConfiguredAuth(descriptor.model.provider) &&
			!(await runtime.checkAuth(descriptor.model.provider))
		)
			throw new HarnessError(`No authentication configured for ${descriptor.model.provider}`);
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
									event.systemPromptOptions.selectedTools.sort();
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
					// SDK `tools` is a registration allowlist, not merely the active loadout.
					// Coordination can become active when a conversation joins a workspace team.
					const reserved = descriptor.tools
						? ["team", ...(!descriptor.parentSessionId ? ["goal"] : [])].filter(
								(name) => !descriptor.tools!.includes(name),
							)
						: [];
					const { session } = await createAgentSession({
						cwd: descriptor.cwd,
						agentDir: this.options.agentDir,
						modelRuntime: runtime,
						model,
						sessionManager: live.manager,
						settingsManager,
						resourceLoader: loader,
						customTools: this.options.customTools?.(descriptor),
						tools: descriptor.tools ? [...descriptor.tools, ...reserved] : undefined,
					});
					if (descriptor.thinkingLevel) session.setThinkingLevel(descriptor.thinkingLevel);
					await session.bindExtensions({});
					const prepareRequest = session.agent.prepareRequest;
					session.agent.prepareRequest = async (request, signal) => {
						const prepared = (await prepareRequest?.(request, signal)) ?? undefined;
						await this.mutate(() => undefined);
						if (signal?.aborted) return prepared;
						const context = prepared?.context ?? request.context;
						const messages = appendRuntimeContext(live.manager, context.messages, descriptor, this.state);
						return messages === context.messages ? prepared : { ...prepared, context: { ...context, messages } };
					};
					if (reserved.length) session.setActiveToolsByName(descriptor.tools!);
					const managedSession = session as unknown as {
						queueManagedInput(text: string, mode: "steer" | "followUp", inputId: string): Promise<unknown>;
						hasQueuedInput(inputId: string): boolean;
						mutateQueuedInput(inputId: string, action: PendingInputAction): boolean;
						resumeContext(): Promise<void>;
					};
					const configureExecution = () => {
						const activeSwarm = descriptor.swarm?.status === "active";
						const agent = this.state.agents.find((entry) => entry.sessionId === id);
						const team = this.state.teams.find(
							(entry) => entry.teamId === agent?.teamId && entry.scope === "workspace",
						);
						const manager = team?.rootAgentId === agent?.agentId && !!team;
						const specialist = !!team && agent?.parentAgentId === team.rootAgentId;
						settingsManager.applyOverrides({
							retry: { enabled: descriptor.goal?.status === "active" || activeSwarm ? false : retryEnabled },
						});
						if (activeSwarm || manager) {
							live.delegatedTools ??= session.getActiveToolNames();
							session.setActiveToolsByName(
								[
									...live.delegatedTools.filter((name) =>
										["read", "grep", "glob", "web_search"].includes(name),
									),
									"team",
									...(descriptor.goal?.status === "active" ? ["goal"] : []),
								].sort(),
							);
						} else {
							if (live.delegatedTools) {
								session.setActiveToolsByName([...live.delegatedTools].sort());
								live.delegatedTools = undefined;
							}
							if (descriptor.goal?.status === "active" && !session.getActiveToolNames().includes("goal"))
								session.setActiveToolsByName([...session.getActiveToolNames(), "goal"].sort());
						}
						if (specialist && !session.getActiveToolNames().includes("team"))
							session.setActiveToolsByName([...session.getActiveToolNames(), "team"].sort());
					};
					// Disable SDK retries for autonomous modes; normal sessions retain their settings.
					const retryEnabled = settingsManager.getRetryEnabled();
					adapter = {
						subscribe: (listener) =>
							session.subscribe((event) => {
								listener(event);
								if (
									(descriptor.goal?.status === "active" || descriptor.swarm?.status === "active") &&
									event.type === "message_end" &&
									event.message.role === "assistant" &&
									["error", "aborted", "length"].includes(event.message.stopReason)
								)
									// A failed autonomous request must not trigger SDK overflow recovery or retry.
									void session.abort().catch(() => undefined);
							}),
						prompt: (text) => {
							configureExecution();
							return session.prompt(text, { expandPromptTemplates: false });
						},
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
						resumeContext: async () => {
							configureExecution();
							if (descriptor.goal?.status === "active")
								await session.sendCustomMessage(
									{
										customType: "harness-goal-continuation",
										content:
											"Continue the active goal from existing context. Handle queued user input and child results first.",
										display: false,
										details: { goalId: descriptor.goal.id },
									},
									{ triggerTurn: false },
								);
							if (descriptor.swarm?.status === "active")
								await session.sendCustomMessage(
									{
										customType: "harness-swarm-continuation",
										content:
											"Continue managing the unfinished objective. Handle queued user input and member results first. Reuse existing members for corrections and next assignments with team send; delegate all implementation and verification. Explicitly complete or block with the team tool.",
										display: false,
										details: { swarmId: descriptor.swarm.id },
									},
									{ triggerTurn: false },
								);
							await managedSession.resumeContext();
						},
						hasQueuedInput: (inputId) => managedSession.hasQueuedInput(inputId),
						mutateQueuedInput: (inputId, action) => managedSession.mutateQueuedInput(inputId, action),
						abort: () => session.abort(),
						waitForIdle: async () => {
							await session.waitForIdle();
							if (descriptor.swarm?.status !== "active" && live.delegatedTools) configureExecution();
						},
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
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "custom" &&
			!event.message.display
		) {
			for (const listener of this.executionListeners) listener(id, event);
			return;
		}
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
			const index = projection.toolCalls.findLastIndex(
				(entry) => entry.callId === event.toolCallId && entry.runId === live.runId,
			);
			if (index !== -1) {
				const tool = projection.toolCalls[index];
				projection.toolCalls[index] = {
					...tool,
					result: structuredClone(event.type === "tool_execution_end" ? event.result : event.partialResult),
					status: event.type === "tool_execution_end" ? (event.isError ? "error" : "success") : tool.status,
				};
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
			projection.toolCalls = projection.toolCalls.map((tool) =>
				tool.runId === live.runId && tool.status === "running" ? { ...tool, status: "cancelled" } : tool,
			);
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
	/** Inherit implementation grants plus workspace coordination, never the manager's restricted loadout. */
	delegationTools(id: string): string[] {
		const tools = this.live.get(id)?.delegatedTools ?? this.activeTools(id);
		const agent = this.state.agents.find((entry) => entry.sessionId === id);
		const team = this.state.teams.find((entry) => entry.teamId === agent?.teamId && entry.scope === "workspace");
		return team &&
			(agent?.agentId === team.rootAgentId || agent?.parentAgentId === team.rootAgentId) &&
			!tools.includes("team")
			? [...tools, "team"]
			: tools;
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
