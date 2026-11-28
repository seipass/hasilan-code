import { randomBytes } from "node:crypto";
import { type AgentSessionEvent, type ToolDefinition, truncateMiddle } from "@hasilan-code/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type AgentCategory, type AgentModels, agentCategorySchema } from "../shared/agent-categories.ts";

import { attachmentPrompt, type PromptAttachment } from "../shared/attachments.ts";
import {
	CONTEXT_INJECTION_CUSTOM_TYPE,
	type ContextInjection,
	isContextInjection,
} from "../shared/context-injection.ts";
import type { PendingInputAction } from "../shared/contracts.ts";
import type { Goal, GoalAction, GoalStatus } from "../shared/goals.ts";
import { nextId } from "../shared/ids.ts";
import {
	findOwnedPathConflicts,
	normalizeOwnedPath,
	SWARM_OBJECTIVE_MAX_LENGTH,
	type Swarm,
	type SwarmBoardNote,
	type SwarmCheck,
	type SwarmEvent,
	type SwarmEventKind,
	type SwarmNoteKind,
	type SwarmReview,
	type SwarmReviewVerdict,
	type SwarmStart,
	type SwarmStatus,
	type SwarmTask,
	type SwarmTaskStatus,
	type WorkspaceSwarmStart,
} from "../shared/swarm.ts";
import type { WorkOverviewItem } from "../shared/work-overview.ts";
import type { AgentWorktrees } from "./agent-worktrees.ts";
import { HarnessError, type ModelSelection, type SessionRegistry } from "./session-registry.ts";
import { runSwarmVerification } from "./swarm-verify.ts";
import { loadTeamProfiles } from "./team-profiles.ts";
import { validateWorkflow, type WorkflowTask } from "./team-workflow.ts";

export type RunStatus =
	| "queued"
	| "running"
	| "waiting"
	| "cancelling"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";
export interface TeamRecord {
	teamId: string;
	rootAgentId: string;
	workspaceId: string;
	scope?: "workspace";
}
export interface AgentRecord {
	category?: AgentCategory;
	agentId: string;
	teamId: string;
	parentAgentId?: string;
	sessionId: string;
	name: string;
	role: string;
	responsibility?: string;
}
export interface RunRecord {
	runId: string;
	agentId: string;
	task: string;
	attachments?: PromptAttachment[];
	inputKind?: "prompt" | "context";
	requestedByAgentId?: string;
	replyToAgentIds?: string[];
	swarmId?: string;
	handoffFromRunId?: string;
	handoffToRunId?: string;
	status: RunStatus;
	result?: string;
	error?: string;
	waitingOnRunIds?: string[];
	startedAt?: string;
	settledAt?: string;
}
export interface PendingInput {
	inputId: string;
	sessionId: string;
	runId: string;
	text: string;
	attachments?: PromptAttachment[];
	mode: "steer" | "followUp";
	fromAgentId?: string;
	status: "pending" | "undelivered";
	delivered?: boolean;
	/** Child completion status for which this input is the authoritative notice. */
	completionRunId?: string;
	contextInjection?: ContextInjection;
}
export interface TeamOptions {
	agentWorktrees?: AgentWorktrees;
	getAgentModels?: () => AgentModels;
	getLimits?: () => { maxConcurrentAgents: number; maxDepth: number };
	agentDir?: string;
	onStopSession?: (sessionId: string) => Promise<void>;
}
export interface AdmissionResult {
	runId: string;
	disposition: "queued" | "started";
	inputId?: string;
}
export interface AgentSummary extends AgentRecord {
	currentRun?: RunRecord;
	latestRun?: RunRecord;
	worktree?: "active" | "adopted" | "discarded";
}
export interface TeamSnapshot {
	teams: TeamRecord[];
	agents: AgentSummary[];
	runs: RunRecord[];
}
export interface SpawnTask {
	category?: AgentCategory;
	name: string;
	task: string;
	responsibility?: string;
	context?: string;
	systemPrompt?: string;
	profile?: string;
	model?: ModelSelection;
	tools?: string[];
}
export interface WaitResult {
	runs: {
		agentId: string;
		ownerAgentId?: string;
		runId: string;
		status: RunStatus;
		result?: string;
		error?: string;
	}[];
	timedOut: boolean;
}

function resultPreview(result: string | undefined): string | undefined {
	return result === undefined ? undefined : truncateMiddle(result, 1_500).content;
}
interface ScheduledEntry {
	runId: string;
	resume?: () => void;
}
interface RuntimeRun {
	controller: AbortController;
	done: Promise<void>;
	resolveDone: () => void;
	executing: boolean;
	goalId?: string;
	swarmId?: string;
}
interface Waiter {
	callerRunId: string;
	targets: string[];
	mode: "all" | "any";
	finish: (timedOut: boolean) => void;
}
const terminalStatus: Record<RunStatus, boolean> = {
	queued: false,
	running: false,
	waiting: false,
	cancelling: false,
	completed: true,
	failed: true,
	cancelled: true,
	interrupted: true,
};
const MANAGER_RESPONSIBILITY = "目標・優先順位・担当範囲を調整し、成果の受け入れと最終判断を担当する。";
const taskSchema = Type.Object({
	category: Type.Optional(agentCategorySchema),
	name: Type.String({
		minLength: 1,
		description:
			"Stable specialist name. A workspace manager's repeated name reuses its idle direct report across objectives.",
	}),
	task: Type.String({ minLength: 1 }),
	responsibility: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 16384,
			description:
				"Continuing ownership, separate from this assignment. Required when creating a workspace specialist.",
		}),
	),
	context: Type.Optional(Type.String()),
	systemPrompt: Type.Optional(Type.String()),
	profile: Type.Optional(Type.String({ minLength: 1 })),
	model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
	tools: Type.Optional(Type.Array(Type.String())),
});
const swarmTaskStatusSchema = Type.Union([
	Type.Literal("todo"),
	Type.Literal("in_progress"),
	Type.Literal("in_review"),
	Type.Literal("done"),
	Type.Literal("blocked"),
	Type.Literal("cancelled"),
]);
const swarmNoteKindSchema = Type.Union([
	Type.Literal("decision"),
	Type.Literal("finding"),
	Type.Literal("contract"),
	Type.Literal("blocker"),
	Type.Literal("handoff"),
]);
const swarmTaskPlanSchema = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	title: Type.String({ minLength: 1, maxLength: 240 }),
	description: Type.Optional(Type.String({ maxLength: 8192 })),
	dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })),
	ownedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 })),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32 })),
	needsReview: Type.Optional(Type.Boolean()),
});
const swarmCheckPlanSchema = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	name: Type.String({ minLength: 1, maxLength: 160 }),
	command: Type.String({ minLength: 1, maxLength: 4096 }),
});
const teamCommonParameters = [
	Type.Object({ action: Type.Literal("spawn"), tasks: Type.Array(taskSchema, { minItems: 1, maxItems: 32 }) }),
	Type.Object({
		action: Type.Literal("workflow"),
		tasks: Type.Array(
			Type.Object({ ...taskSchema.properties, dependsOn: Type.Optional(Type.Array(Type.String())) }),
			{ minItems: 1, maxItems: 32 },
		),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300000 })),
	}),
	Type.Object({ action: Type.Literal("profiles") }),
	Type.Object({ action: Type.Literal("list") }),
	Type.Object({
		action: Type.Literal("result"),
		runId: Type.String(),
		view: Type.Optional(Type.Union([Type.Literal("report"), Type.Literal("logs"), Type.Literal("log")])),
		logIndex: Type.Optional(Type.Integer({ minimum: 0 })),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
	}),
	Type.Object({
		action: Type.Literal("work"),
		agentId: Type.String(),
		op: Type.Union([
			Type.Literal("diff"),
			Type.Literal("adopt"),
			Type.Literal("discard"),
			Type.Literal("restore"),
			Type.Literal("sync"),
		]),
	}),
	Type.Object({ action: Type.Literal("send"), agentId: Type.String(), message: Type.String({ minLength: 1 }) }),
	Type.Object({
		action: Type.Literal("describe"),
		agentId: Type.String(),
		responsibility: Type.String({ minLength: 1, maxLength: 16384 }),
	}),
	Type.Object({ action: Type.Literal("handoff"), agentId: Type.String(), task: Type.String({ minLength: 1 }) }),
	Type.Object({
		action: Type.Literal("wait"),
		agentIds: Type.Array(Type.String(), { minItems: 1 }),
		mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")])),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300000 })),
	}),
	Type.Object({ action: Type.Literal("stop"), agentId: Type.String() }),
] as const;
const teamParameters = Type.Union([
	...teamCommonParameters,
	Type.Object(
		{
			action: Type.Literal("swarm"),
			op: Type.Union([Type.Literal("complete"), Type.Literal("block")]),
			reason: Type.String({ minLength: 1, maxLength: 16384 }),
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("board"), op: Type.Literal("read") }, { additionalProperties: false }),
	Type.Object(
		{
			action: Type.Literal("board"),
			op: Type.Literal("plan"),
			tasks: Type.Optional(Type.Array(swarmTaskPlanSchema, { maxItems: 64 })),
			checks: Type.Optional(Type.Array(swarmCheckPlanSchema, { maxItems: 32 })),
			replace: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("board"),
			op: Type.Literal("task"),
			taskId: Type.String({ minLength: 1, maxLength: 64 }),
			status: Type.Optional(swarmTaskStatusSchema),
			ownerAgentId: Type.Optional(Type.String({ minLength: 1 })),
			ownedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 })),
			resultSummary: Type.Optional(Type.String({ maxLength: 4096 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("board"),
			op: Type.Literal("post"),
			kind: swarmNoteKindSchema,
			title: Type.String({ minLength: 1, maxLength: 200 }),
			body: Type.String({ minLength: 1, maxLength: 8192 }),
			paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 })),
			taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("board"),
			op: Type.Literal("review"),
			taskId: Type.String({ minLength: 1, maxLength: 64 }),
			verdict: Type.Union([Type.Literal("approved"), Type.Literal("changes_requested")]),
			summary: Type.String({ minLength: 1, maxLength: 4096 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("board"),
			op: Type.Literal("verify"),
			checkId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
			name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
			command: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000 })),
		},
		{ additionalProperties: false },
	),
]);
const teamParametersWithoutSwarm = Type.Union([...teamCommonParameters]);
const goalParameters = Type.Union([
	Type.Object({ op: Type.Literal("get") }, { additionalProperties: false }),
	Type.Object(
		{ op: Type.Literal("complete"), reason: Type.String({ minLength: 1, maxLength: 16384 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ op: Type.Literal("block"), reason: Type.String({ minLength: 1, maxLength: 16384 }) },
		{ additionalProperties: false },
	),
]);

/** Single authority for team run admission, permits, pinned waits, and cancellation. */
export class TeamManager {
	private readonly registry: SessionRegistry;
	private readonly options: TeamOptions;
	private readonly queues = new Map<string, ScheduledEntry[]>();
	private readonly permits = new Set<string>();
	private readonly runtime = new Map<string, RuntimeRun>();
	private readonly waiters = new Set<Waiter>();
	private readonly fenced = new Map<string, number>();
	private readonly started = new Set<string>();
	private readonly initialConsumed = new Set<string>();
	private readonly goalTimers = new Map<string, NodeJS.Timeout>();
	private readonly autonomousRuns = new Set<string>();
	private readonly goalFingerprints = new Map<string, string>();
	private readonly swarmTimers = new Map<string, NodeJS.Timeout>();
	private readonly swarmFingerprints = new Map<string, string>();
	private readonly listeners = new Set<(event: { type: "team_changed"; workspaceId: string }) => void>();
	private readonly unsubscribe: () => void;
	private accepting = true;
	constructor(registry: SessionRegistry, options: TeamOptions = {}) {
		this.registry = registry;
		this.options = options;
		this.unsubscribe = registry.onExecutionEvent((id, event) => this.onEvent(id, event));
	}
	async initialize(): Promise<void> {
		await this.registry.mutate(async () => {
			for (const run of this.registry.state.runs)
				if (!terminalStatus[run.status]) {
					run.status = "interrupted";
					run.error = "Host stopped before this run settled; it was not automatically restarted";
					run.settledAt = new Date().toISOString();
					delete run.waitingOnRunIds;
				}
			for (const input of this.registry.state.pendingInput) {
				input.status = "undelivered";
				input.delivered = false;
			}
			for (const session of this.registry.state.sessions)
				if (
					!session.parentSessionId &&
					!this.registry.state.agents.some((agent) => agent.sessionId === session.sessionId)
				)
					this.addRoot(session.sessionId);
			// Adopt the latest historical objective without deleting other conversations.
			const adopted = new Set(
				this.registry.state.teams.filter((team) => team.scope === "workspace").map((team) => team.workspaceId),
			);
			for (const session of this.registry.state.sessions
				.filter((entry) => this.registry.runtimeSwarm(entry))
				.sort((a, b) => b.swarm!.createdAt.localeCompare(a.swarm!.createdAt))) {
				if (adopted.has(session.workspaceId)) continue;
				const agent = this.agentForSession(session.sessionId);
				this.registry.state.teams.find((team) => team.teamId === agent.teamId)!.scope = "workspace";
				adopted.add(session.workspaceId);
			}
			for (const team of this.registry.state.teams.filter((entry) => entry.scope === "workspace")) {
				this.agentById(team.rootAgentId).responsibility = MANAGER_RESPONSIBILITY;
				for (const agent of this.registry.state.agents)
					if (agent.parentAgentId === team.rootAgentId) agent.responsibility ??= agent.role;
			}
			await this.registry.persist();
		});
	}
	private addRoot(sessionId: string): AgentRecord {
		const descriptor = this.registry.descriptor(sessionId);
		const agent: AgentRecord = {
			agentId: nextId("a", this.registry.state.agents, "agentId"),
			teamId: nextId("t", this.registry.state.teams, "teamId"),
			sessionId,
			name: "Root",
			role: "root",
		};
		this.registry.state.teams.push({
			teamId: agent.teamId,
			rootAgentId: agent.agentId,
			workspaceId: descriptor.workspaceId,
		});
		this.registry.state.agents.push(agent);
		return agent;
	}
	async ensureRoot(sessionId: string): Promise<AgentRecord> {
		return this.registry.mutate(async () => {
			const existing = this.registry.state.agents.find((agent) => agent.sessionId === sessionId);
			if (existing) return structuredClone(existing);
			if (this.registry.descriptor(sessionId).parentSessionId)
				throw new HarnessError("Child session has no team membership", 409);
			const agent = this.addRoot(sessionId);
			await this.registry.persist();
			this.changed(agent);
			return structuredClone(agent);
		});
	}
	agentIdForSession(sessionId: string): string {
		return this.agentForSession(sessionId).agentId;
	}
	private agentForSession(id: string): AgentRecord {
		const agent = this.registry.state.agents.find((entry) => entry.sessionId === id);
		if (!agent) throw new HarnessError("Session has no team", 404);
		return agent;
	}
	private agentById(id: string): AgentRecord {
		const agent = this.registry.state.agents.find((entry) => entry.agentId === id);
		if (!agent) throw new HarnessError("Agent not found", 404);
		return agent;
	}
	private runById(id: string): RunRecord {
		const run = this.registry.state.runs.find((entry) => entry.runId === id);
		if (!run) throw new HarnessError("Run not found", 404);
		return run;
	}
	private assignmentOwner(run: RunRecord): RunRecord {
		while (run.handoffToRunId) run = this.runById(run.handoffToRunId);
		return run;
	}
	private objectiveActive(run: RunRecord): boolean {
		if (!this.registry.swarmEnabled || !run.swarmId) return true;
		const agent = this.agentById(run.agentId);
		const team = this.registry.state.teams.find((entry) => entry.teamId === agent.teamId)!;
		const objective = this.registry.runtimeSwarm(
			this.registry.descriptor(this.agentById(team.rootAgentId).sessionId),
		);
		return objective?.id === run.swarmId && objective.status === "active";
	}
	private current(agent: AgentRecord): RunRecord | undefined {
		return this.registry.state.runs.find((run) => run.agentId === agent.agentId && !terminalStatus[run.status]);
	}
	private latest(agent: AgentRecord): RunRecord | undefined {
		return this.registry.state.runs.findLast((run) => run.agentId === agent.agentId);
	}
	private limits(): { maxConcurrentAgents: number; maxDepth: number } {
		const limits = this.options.getLimits?.() ?? { maxConcurrentAgents: 4, maxDepth: 3 };
		if (
			!Number.isInteger(limits.maxConcurrentAgents) ||
			limits.maxConcurrentAgents < 1 ||
			limits.maxConcurrentAgents > 32 ||
			!Number.isInteger(limits.maxDepth) ||
			limits.maxDepth < 1 ||
			limits.maxDepth > 8
		)
			throw new HarnessError("Invalid team limits");
		return limits;
	}
	private assertOpen(agent: AgentRecord): void {
		if (!this.accepting || this.fenced.has(agent.agentId))
			throw new HarnessError("Agent is stopping; input is not accepted", 409);
		const descriptor = this.registry.descriptor(agent.sessionId);
		if (descriptor.worktree && descriptor.availability !== "ready")
			throw new HarnessError("The isolated agent workspace is unavailable", 409);
		if (descriptor.worktree?.status === "discarded")
			throw new HarnessError("Restore the discarded worktree before running this agent", 409);
	}
	private assertTarget(caller: AgentRecord, target: AgentRecord): void {
		if (caller.teamId !== target.teamId) throw new HarnessError("Agent belongs to another team", 403);
	}
	private ancestor(ancestorId: string, descendant: AgentRecord): boolean {
		let cursor: AgentRecord | undefined = descendant;
		const visited = new Set<string>();
		while (cursor?.parentAgentId) {
			if (visited.has(cursor.agentId)) throw new HarnessError("Invalid persisted team ancestry");
			visited.add(cursor.agentId);
			if (cursor.parentAgentId === ancestorId) return true;
			cursor = this.agentById(cursor.parentAgentId);
		}
		return false;
	}
	private newRun(agent: AgentRecord, task: string, inputKind?: "context", requestedByAgentId?: string): RunRecord {
		if (this.current(agent)) throw new HarnessError("Session is busy", 409);
		const worktree = this.registry.descriptor(agent.sessionId).worktree;
		if (worktree?.status === "adopted") worktree.status = "active";
		const run: RunRecord = {
			runId: nextId("r", this.registry.state.runs, "runId"),
			agentId: agent.agentId,
			task,
			status: "queued",
			...(inputKind ? { inputKind } : {}),
			...(requestedByAgentId ? { requestedByAgentId } : {}),
		};
		const team = this.registry.state.teams.find((entry) => entry.teamId === agent.teamId);
		const objective =
			team?.scope === "workspace"
				? this.registry.runtimeSwarm(this.registry.descriptor(this.agentById(team.rootAgentId).sessionId))
				: undefined;
		if (objective?.status === "active") run.swarmId = objective.id;
		this.registry.state.runs.push(run);
		let resolveDone: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const goal = this.registry.runtimeGoal(this.registry.descriptor(agent.sessionId));
		const swarm = this.registry.runtimeSwarm(this.registry.descriptor(agent.sessionId));
		this.runtime.set(run.runId, {
			controller: new AbortController(),
			done,
			resolveDone,
			executing: false,
			goalId: goal?.status === "active" ? goal.id : undefined,
			swarmId: swarm?.status === "active" ? swarm.id : undefined,
		});
		return run;
	}
	private enqueue(teamId: string, entry: ScheduledEntry): void {
		const queue = this.queues.get(teamId) ?? [];
		queue.push(entry);
		this.queues.set(teamId, queue);
	}
	private pump(teamId: string): void {
		if (!this.accepting) return;
		const queue = this.queues.get(teamId);
		if (!queue) return;
		let used = [...this.permits].filter((id) => this.agentById(this.runById(id).agentId).teamId === teamId).length;
		while (used < this.limits().maxConcurrentAgents && queue.length > 0) {
			const entry = queue.shift();
			if (!entry) break;
			const run = this.runById(entry.runId);
			const agent = this.agentById(run.agentId);
			if (terminalStatus[run.status] || run.status === "cancelling" || this.fenced.has(agent.agentId)) continue;
			this.permits.add(run.runId);
			used++;
			run.status = "running";
			run.startedAt ??= new Date().toISOString();
			if (entry.resume) {
				void this.registry
					.persist()
					.then(() => {
						this.changed(agent);
						entry.resume?.();
					})
					.catch((error: unknown) => this.failAdmission(run.runId, error));
			} else {
				const runtime = this.runtime.get(run.runId);
				if (runtime) runtime.executing = true;
				void this.execute(run.runId);
			}
		}
	}
	private async execute(runId: string): Promise<void> {
		const run = this.runById(runId);
		const agent = this.agentById(run.agentId);
		const runtime = this.runtime.get(runId);
		if (!runtime) return;
		try {
			await this.registry.persist();
			this.changed(agent);
			if (runtime.controller.signal.aborted) {
				await this.settle(runId, "cancelled");
				return;
			}
			const outcome = await this.registry.execute(
				agent.sessionId,
				runId,
				run.task,
				runtime.controller.signal,
				run.inputKind,
				run.attachments,
			);
			await this.settle(
				runId,
				outcome.aborted || run.status === "cancelling" ? "cancelled" : outcome.error ? "failed" : "completed",
				outcome.result,
				outcome.error,
			);
		} catch (error) {
			await this.failAdmission(runId, error);
		}
	}
	private async failAdmission(runId: string, error: unknown): Promise<void> {
		await this.settle(
			runId,
			this.runtime.get(runId)?.controller.signal.aborted ? "cancelled" : "failed",
			undefined,
			error instanceof Error ? error.message : String(error),
		);
	}
	private updateGoal(sessionId: string, status: GoalStatus, reason?: string): void {
		const goal = this.registry.runtimeGoal(this.registry.descriptor(sessionId));
		if (!goal) return;
		goal.status = status;
		goal.reason = reason;
		goal.updatedAt = new Date().toISOString();
		if (status !== "active") {
			clearTimeout(this.goalTimers.get(sessionId));
			this.goalTimers.delete(sessionId);
		}
	}
	private scheduleGoal(agent: AgentRecord): void {
		const goal = this.registry.runtimeGoal(this.registry.descriptor(agent.sessionId));
		if (!goal || goal.status !== "active" || !this.accepting || this.fenced.has(agent.agentId)) return;
		if (this.goalTimers.has(agent.sessionId)) return;
		const goalId = goal.id;
		// A separate event-loop stage lets pause/stop and queued user commands win.
		this.goalTimers.set(
			agent.sessionId,
			setTimeout(() => {
				this.goalTimers.delete(agent.sessionId);
				void this.registry
					.mutate(async () => {
						const currentGoal = this.registry.runtimeGoal(this.registry.descriptor(agent.sessionId));
						if (
							!this.accepting ||
							this.fenced.has(agent.agentId) ||
							currentGoal?.id !== goalId ||
							currentGoal.status !== "active" ||
							this.current(agent)
						)
							return;
						const previous = this.latest(agent);
						const run = this.newRun(agent, `Goal: ${currentGoal.objective}`, "context");
						for (const input of this.registry.state.pendingInput)
							if (input.runId === previous?.runId && input.status === "undelivered") {
								input.runId = run.runId;
								input.status = "pending";
								input.delivered = false;
							}
						this.autonomousRuns.add(run.runId);
						await this.registry.persist();
						this.enqueue(agent.teamId, { runId: run.runId });
						this.pump(agent.teamId);
						this.changed(agent);
					})
					.catch((error: unknown) => {
						void this.registry.mutate(async () => {
							if (this.registry.runtimeGoal(this.registry.descriptor(agent.sessionId))?.status === "active") {
								this.updateGoal(
									agent.sessionId,
									"paused",
									error instanceof Error ? error.message : String(error),
								);
								await this.registry.persist();
								this.changed(agent);
							}
						});
					});
			}, 0),
		);
	}
	private workspaceSwarm(agent: AgentRecord): { manager: AgentRecord; swarm: Swarm } | undefined {
		if (!this.registry.swarmEnabled) return undefined;
		const team = this.registry.state.teams.find((entry) => entry.teamId === agent.teamId);
		if (!team) return undefined;
		const manager = this.agentById(team.rootAgentId);
		const swarm = this.registry.runtimeSwarm(this.registry.descriptor(manager.sessionId));
		return swarm ? { manager, swarm } : undefined;
	}
	private recordSwarmEvent(
		swarm: Swarm,
		kind: SwarmEventKind,
		summary: string,
		actor?: AgentRecord,
		taskId?: string,
	): void {
		const trimmed = summary.trim().slice(0, 320);
		if (!trimmed) return;
		const now = new Date().toISOString();
		const event: SwarmEvent = {
			id: randomBytes(6).toString("hex"),
			kind,
			...(actor ? { actorAgentId: actor.agentId, actorName: actor.name } : {}),
			summary: trimmed,
			...(taskId ? { taskId } : {}),
			createdAt: now,
		};
		swarm.events ??= [];
		swarm.events.push(event);
		if (swarm.events.length > 120) swarm.events.splice(0, swarm.events.length - 120);
		swarm.updatedAt = now;
	}
	private assertSwarmTaskDag(tasks: readonly SwarmTask[]): void {
		const byId = new Map(tasks.map((task) => [task.id, task]));
		for (const task of tasks) {
			for (const dep of task.dependsOn ?? []) {
				if (dep === task.id) throw new HarnessError(`Task ${task.id} cannot depend on itself`, 400);
				if (!byId.has(dep)) throw new HarnessError(`Task ${task.id} depends on unknown task ${dep}`, 400);
			}
		}
		const state = new Map<string, 1 | 2>();
		const visit = (id: string) => {
			if (state.get(id) === 2) return;
			if (state.get(id) === 1) throw new HarnessError(`Dependency cycle detected involving task ${id}`, 400);
			state.set(id, 1);
			for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
			state.set(id, 2);
		};
		for (const task of tasks) visit(task.id);
	}
	private async syncWorktreeIfClean(agent: AgentRecord, parentSessionId: string): Promise<void> {
		const service = this.options.agentWorktrees;
		if (!service) return;
		const descriptor = this.registry.descriptor(agent.sessionId);
		const worktree = descriptor.worktree;
		if (!worktree || worktree.status === "discarded" || descriptor.availability !== "ready") return;
		const parentDescriptor = this.registry.descriptor(parentSessionId);
		if (parentDescriptor.availability !== "ready" || parentDescriptor.worktree?.status === "discarded") return;
		try {
			const synced = await service.sync(worktree, parentDescriptor.cwd, { onlyIfClean: true });
			if (synced.updated) {
				worktree.baseline = synced.baseline;
				const active = this.workspaceSwarm(agent);
				if (active?.swarm.status === "active") {
					this.recordSwarmEvent(
						active.swarm,
						"worktree",
						`${agent.name} の作業ツリーを最新ワークスペースへ自動同期`,
						agent,
					);
				}
			}
		} catch {
			// Best-effort auto-sync must not block dispatching work if repository state is unusual.
		}
	}
	private updateSwarm(sessionId: string, status: SwarmStatus, reason?: string): void {
		const swarm = this.registry.runtimeSwarm(this.registry.descriptor(sessionId));
		if (!swarm) return;
		const previous = swarm.status;
		swarm.status = status;
		swarm.reason = reason;
		swarm.updatedAt = new Date().toISOString();
		if (status !== previous) {
			const kind: SwarmEventKind =
				status === "complete"
					? "completed"
					: status === "blocked"
						? "blocked"
						: status === "paused"
							? "paused"
							: "resumed";
			const label =
				status === "complete"
					? `完了: ${reason ?? ""}`
					: status === "blocked"
						? `判断待ち: ${reason ?? ""}`
						: status === "paused"
							? `一時停止${reason ? `: ${reason}` : ""}`
							: "スウォームを再開";
			this.recordSwarmEvent(swarm, kind, label.trim());
		}
		if (status !== "active") {
			clearTimeout(this.swarmTimers.get(sessionId));
			this.swarmTimers.delete(sessionId);
			this.swarmFingerprints.delete(swarm.id);
		}
	}
	private scheduleSwarm(agent: AgentRecord): void {
		const swarm = this.registry.runtimeSwarm(this.registry.descriptor(agent.sessionId));
		if (
			swarm?.status !== "active" ||
			!this.accepting ||
			this.fenced.has(agent.agentId) ||
			this.swarmTimers.has(agent.sessionId) ||
			this.registry.state.agents.some((child) => this.ancestor(agent.agentId, child) && this.current(child))
		)
			return;
		const swarmId = swarm.id;
		// As with Goal, user input and stop commands win before the next autonomous admission.
		this.swarmTimers.set(
			agent.sessionId,
			setTimeout(() => {
				this.swarmTimers.delete(agent.sessionId);
				void this.registry
					.mutate(async () => {
						const currentSwarm = this.registry.runtimeSwarm(this.registry.descriptor(agent.sessionId));
						if (
							!this.accepting ||
							this.fenced.has(agent.agentId) ||
							currentSwarm?.id !== swarmId ||
							currentSwarm.status !== "active" ||
							this.current(agent) ||
							this.registry.state.agents.some(
								(child) => this.ancestor(agent.agentId, child) && this.current(child),
							)
						)
							return;
						const previous = this.latest(agent);
						const run = this.newRun(agent, `Hyakki-Yako: ${currentSwarm.objective}`, "context");
						for (const input of this.registry.state.pendingInput)
							if (input.runId === previous?.runId && input.status === "undelivered") {
								input.runId = run.runId;
								input.status = "pending";
								input.delivered = false;
							}
						await this.registry.persist();
						this.enqueue(agent.teamId, { runId: run.runId });
						this.pump(agent.teamId);
						this.changed(agent);
					})
					.catch((error: unknown) => {
						void this.registry.mutate(async () => {
							if (this.registry.runtimeSwarm(this.registry.descriptor(agent.sessionId))?.id !== swarmId) return;
							this.updateSwarm(
								agent.sessionId,
								"paused",
								error instanceof Error ? error.message : String(error),
							);
							await this.registry.persist();
							this.changed(agent);
						});
					});
			}, 0),
		);
	}
	async startWorkspaceSwarm(
		workspaceId: string,
		input: WorkspaceSwarmStart,
	): Promise<AdmissionResult & { swarm: Swarm; sessionId: string }> {
		if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
		if (!input.objective.trim() || input.objective.trim().length > SWARM_OBJECTIVE_MAX_LENGTH)
			throw new HarnessError(`Swarm objective must contain 1..${SWARM_OBJECTIVE_MAX_LENGTH} characters`);
		const sessionId = await this.registry.mutate(async () => {
			this.registry.getWorkspaceRoot(workspaceId);
			const team = this.registry.state.teams.find(
				(entry) => entry.workspaceId === workspaceId && entry.scope === "workspace",
			);
			if (team) return this.agentById(team.rootAgentId).sessionId;
			const session = input.sessionId
				? this.registry.descriptor(input.sessionId)
				: await this.registry.createWithinMutation({
						workspaceId,
						model: input.model,
						thinkingLevel: input.thinkingLevel,
					});
			if (session.workspaceId !== workspaceId || session.parentSessionId)
				throw new HarnessError("A workspace manager must be a root conversation in this workspace", 409);
			const root =
				this.registry.state.agents.find((agent) => agent.sessionId === session.sessionId) ??
				this.addRoot(session.sessionId);
			if (
				this.registry.runtimeGoal(session)?.status === "active" ||
				this.registry.runtimeSwarm(session)?.status === "active" ||
				this.registry.state.agents.some(
					(agent) => (agent.agentId === root.agentId || this.ancestor(root.agentId, agent)) && this.current(agent),
				)
			)
				throw new HarnessError(
					"Start a workspace team only while the conversation and its subtree are idle and Goal is inactive",
					409,
				);
			await this.registry.assertModelReady(root.sessionId);
			this.registry.state.teams.find((entry) => entry.teamId === root.teamId)!.scope = "workspace";
			root.responsibility = MANAGER_RESPONSIBILITY;
			await this.registry.persist();
			this.changed(root);
			return root.sessionId;
		});
		return { ...(await this.startSwarm(sessionId, { objective: input.objective })), sessionId };
	}
	async startSwarm(sessionId: string, input: SwarmStart): Promise<AdmissionResult & { swarm: Swarm }> {
		if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
		const objective = input.objective.trim();
		if (!objective || objective.length > SWARM_OBJECTIVE_MAX_LENGTH)
			throw new HarnessError(`Swarm objective must contain 1..${SWARM_OBJECTIVE_MAX_LENGTH} characters`);
		await this.ensureRoot(sessionId);
		return this.registry.mutate(async () => {
			const agent = this.agentForSession(sessionId);
			this.assertOpen(agent);
			const descriptor = this.registry.descriptor(sessionId);
			if (agent.parentAgentId || descriptor.parentSessionId)
				throw new HarnessError("Swarm mode requires a root session", 409);
			if (this.registry.runtimeSwarm(descriptor)?.status === "active")
				throw new HarnessError("Stop the active Hyakki-Yako swarm before starting another", 409);
			if (this.registry.runtimeGoal(descriptor)?.status === "active")
				throw new HarnessError("Pause or drop the active Goal before starting a swarm", 409);
			if (
				this.registry.state.agents.some(
					(entry) =>
						(entry.agentId === agent.agentId || this.ancestor(agent.agentId, entry)) && this.current(entry),
				)
			)
				throw new HarnessError("Start a swarm only while its entire subtree is idle", 409);
			await this.registry.assertModelReady(sessionId);
			const team = this.registry.state.teams.find((entry) => entry.teamId === agent.teamId)!;
			if (
				this.registry.state.teams.some(
					(entry) => entry.workspaceId === descriptor.workspaceId && entry.scope === "workspace" && entry !== team,
				)
			)
				throw new HarnessError(
					"This workspace already has a manager; start the objective through its workspace team",
					409,
				);
			team.scope = "workspace";
			agent.responsibility = MANAGER_RESPONSIBILITY;
			for (const member of this.registry.state.agents)
				if (member.parentAgentId === agent.agentId) member.responsibility ??= member.role;
			const run = this.newRun(agent, objective);
			const now = new Date().toISOString();
			descriptor.swarm = {
				id: randomBytes(8).toString("hex"),
				objective,
				createdAt: now,
				rootRunId: run.runId,
				updatedAt: now,
				status: "active",
			};
			this.recordSwarmEvent(descriptor.swarm, "started", `スウォーム開始: ${objective.slice(0, 140)}`, agent);
			this.runtime.get(run.runId)!.swarmId = descriptor.swarm.id;
			run.swarmId = descriptor.swarm.id;
			await this.registry.persist();
			this.enqueue(agent.teamId, { runId: run.runId });
			this.pump(agent.teamId);
			this.changed(agent);
			return {
				runId: run.runId,
				disposition: run.status === "running" ? "started" : "queued",
				swarm: structuredClone(descriptor.swarm),
			};
		});
	}
	async continueSwarm(sessionId: string): Promise<AdmissionResult & { swarm: Swarm }> {
		if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
		return this.registry.mutate(async () => {
			const agent = this.agentForSession(sessionId);
			this.assertOpen(agent);
			const descriptor = this.registry.descriptor(sessionId);
			const swarm = descriptor.swarm;
			if (
				agent.parentAgentId ||
				descriptor.parentSessionId ||
				!swarm ||
				!["paused", "blocked"].includes(swarm.status)
			)
				throw new HarnessError("Only a paused or blocked Hyakki-Yako swarm can continue", 409);
			if (this.registry.runtimeGoal(descriptor)?.status === "active")
				throw new HarnessError("Pause the active Goal before continuing a swarm", 409);
			if (
				this.registry.state.agents.some(
					(entry) =>
						(entry.agentId === agent.agentId || this.ancestor(agent.agentId, entry)) && this.current(entry),
				)
			)
				throw new HarnessError("Continue a swarm only while its entire subtree is idle", 409);
			await this.registry.assertModelReady(sessionId);
			this.updateSwarm(sessionId, "active");
			const run = this.newRun(agent, `Hyakki-Yako: ${swarm.objective}`, "context");
			for (const input of this.registry.state.pendingInput)
				if (input.sessionId === sessionId && input.status === "undelivered" && input.contextInjection) {
					input.runId = run.runId;
					input.status = "pending";
					input.delivered = false;
				}
			await this.registry.persist();
			this.enqueue(agent.teamId, { runId: run.runId });
			this.pump(agent.teamId);
			this.changed(agent);
			return {
				runId: run.runId,
				disposition: run.status === "running" ? "started" : "queued",
				swarm: structuredClone(swarm),
			};
		});
	}
	async pauseSwarm(sessionId: string): Promise<Swarm> {
		if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
		await this.registry.mutate(() => {
			const agent = this.agentForSession(sessionId);
			const descriptor = this.registry.descriptor(sessionId);
			const swarm = this.registry.runtimeSwarm(descriptor);
			if (agent.parentAgentId || descriptor.parentSessionId || swarm?.status !== "active")
				throw new HarnessError("No active Hyakki-Yako swarm to pause", 409);
		});
		await this.stopSubtree(sessionId, undefined, undefined, "Paused by user");
		return structuredClone(this.registry.descriptor(sessionId).swarm!);
	}
	async boardRead(sessionId: string) {
		if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
		return this.registry.mutate(() => {
			const caller = this.agentForSession(sessionId);
			const active = this.workspaceSwarm(caller);
			if (!active) throw new HarnessError("No Hyakki-Yako swarm exists for this team", 409);
			const { swarm } = active;
			return structuredClone({
				swarmId: swarm.id,
				objective: swarm.objective,
				status: swarm.status,
				...(swarm.reason ? { reason: swarm.reason } : {}),
				tasks: swarm.tasks ?? [],
				checks: swarm.checks ?? [],
				notes: swarm.notes ?? [],
				events: (swarm.events ?? []).slice(-25),
			});
		});
	}
	async boardPlan(
		sessionId: string,
		input: {
			tasks?: {
				id?: string;
				title: string;
				description?: string;
				dependsOn?: string[];
				ownedPaths?: string[];
				acceptanceCriteria?: string[];
				needsReview?: boolean;
			}[];
			checks?: { id?: string; name: string; command: string }[];
			replace?: boolean;
		},
	) {
		if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
		return this.registry.mutate(async () => {
			const caller = this.agentForSession(sessionId);
			const active = this.workspaceSwarm(caller);
			if (!active || active.swarm.status !== "active") throw new HarnessError("No active Hyakki-Yako swarm", 409);
			if (caller.agentId !== active.manager.agentId)
				throw new HarnessError("Only the workspace manager can plan swarm tasks and checks", 403);
			if (!input.tasks?.length && !input.checks?.length)
				throw new HarnessError("Board plan requires at least one task or check", 400);
			const { manager, swarm } = active;
			const now = new Date().toISOString();
			const existingTasks = input.replace
				? (swarm.tasks ?? []).filter((task) => task.status !== "todo")
				: [...(swarm.tasks ?? [])];
			const tasksById = new Map(existingTasks.map((task) => [task.id, { ...task }]));
			const nextTaskId = () => {
				let n = 1;
				while (tasksById.has(`t${n}`)) n++;
				return `t${n}`;
			};
			if (input.tasks) {
				for (const item of input.tasks) {
					const title = item.title.trim();
					if (!title) throw new HarnessError("Task title must not be empty", 400);
					let normalizedPaths: string[] | undefined;
					if (item.ownedPaths !== undefined) {
						try {
							normalizedPaths = [...new Set(item.ownedPaths.map((entry) => normalizeOwnedPath(entry)))];
						} catch (error) {
							throw new HarnessError(error instanceof Error ? error.message : String(error), 400);
						}
					}
					const id = item.id?.trim() || nextTaskId();
					const existing = tasksById.get(id);
					const updated: SwarmTask = existing
						? {
								...existing,
								title,
								...(item.description !== undefined
									? { description: item.description.trim() || undefined }
									: {}),
								...(item.dependsOn !== undefined ? { dependsOn: [...new Set(item.dependsOn)] } : {}),
								...(normalizedPaths !== undefined ? { ownedPaths: normalizedPaths } : {}),
								...(item.acceptanceCriteria !== undefined
									? {
											acceptanceCriteria: item.acceptanceCriteria
												.map((entry) => entry.trim())
												.filter(Boolean),
										}
									: {}),
								...(item.needsReview !== undefined ? { needsReview: item.needsReview } : {}),
								updatedAt: now,
							}
						: {
								id,
								title,
								...(item.description?.trim() ? { description: item.description.trim() } : {}),
								status: "todo",
								...(item.dependsOn?.length ? { dependsOn: [...new Set(item.dependsOn)] } : {}),
								...(normalizedPaths?.length ? { ownedPaths: normalizedPaths } : {}),
								...(item.acceptanceCriteria?.length
									? {
											acceptanceCriteria: item.acceptanceCriteria
												.map((entry) => entry.trim())
												.filter(Boolean),
										}
									: {}),
								needsReview: item.needsReview ?? true,
								updatedAt: now,
							};
					tasksById.set(id, updated);
				}
			}
			const nextTasks = [...tasksById.values()];
			this.assertSwarmTaskDag(nextTasks);
			const activeInProgress = nextTasks.filter((task) => task.status === "in_progress");
			for (let i = 0; i < activeInProgress.length; i++) {
				const currentTask = activeInProgress[i]!;
				const conflicts = findOwnedPathConflicts(currentTask.ownedPaths ?? [], activeInProgress.slice(i + 1));
				if (conflicts.length > 0) {
					const first = conflicts[0]!;
					throw new HarnessError(
						`Owned path conflict between active tasks ${currentTask.id} (${first.requestedPath}) and ${first.taskId} (${first.existingPath})`,
						409,
					);
				}
			}
			const dependsReachable = (fromId: string, targetId: string, visited = new Set<string>()): boolean => {
				if (fromId === targetId) return true;
				if (visited.has(fromId)) return false;
				visited.add(fromId);
				return (tasksById.get(fromId)?.dependsOn ?? []).some((dep) => dependsReachable(dep, targetId, visited));
			};
			const overlapWarnings: { taskA: string; taskB: string; pathA: string; pathB: string }[] = [];
			const openTasks = nextTasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
			for (let i = 0; i < openTasks.length; i++) {
				const taskA = openTasks[i]!;
				if (!taskA.ownedPaths?.length) continue;
				for (let j = i + 1; j < openTasks.length; j++) {
					const taskB = openTasks[j]!;
					if (!taskB.ownedPaths?.length) continue;
					if (dependsReachable(taskA.id, taskB.id) || dependsReachable(taskB.id, taskA.id)) continue;
					for (const conflict of findOwnedPathConflicts(taskA.ownedPaths, [taskB])) {
						overlapWarnings.push({
							taskA: taskA.id,
							taskB: taskB.id,
							pathA: conflict.requestedPath,
							pathB: conflict.existingPath,
						});
					}
				}
			}
			const existingChecks = [...(swarm.checks ?? [])];
			const checksById = new Map(existingChecks.map((check) => [check.id, { ...check }]));
			const nextCheckId = () => {
				let n = 1;
				while (checksById.has(`c${n}`)) n++;
				return `c${n}`;
			};
			if (input.checks) {
				for (const item of input.checks) {
					const name = item.name.trim();
					const command = item.command.trim();
					if (!name || !command) throw new HarnessError("Check name and command must not be empty", 400);
					const matchedByName = [...checksById.values()].find(
						(entry) => entry.name.toLowerCase() === name.toLowerCase(),
					);
					const id = item.id?.trim() || matchedByName?.id || nextCheckId();
					const existing = checksById.get(id);
					checksById.set(
						id,
						existing
							? {
									...existing,
									name,
									command,
									...(existing.command !== command
										? { status: "pending", exitCode: undefined, summary: undefined }
										: {}),
									updatedAt: now,
								}
							: { id, name, command, status: "pending", updatedAt: now },
					);
				}
			}
			swarm.tasks = nextTasks;
			swarm.checks = [...checksById.values()];
			this.recordSwarmEvent(
				swarm,
				"plan",
				`ボード計画を更新（タスク ${swarm.tasks.length}件・検証 ${swarm.checks.length}件）`,
				caller,
			);
			await this.registry.persist();
			this.changed(manager);
			return structuredClone({
				tasks: swarm.tasks,
				checks: swarm.checks,
				...(overlapWarnings.length ? { overlapWarnings } : {}),
			});
		});
	}
	async boardUpdateTask(
		sessionId: string,
		input: {
			taskId: string;
			status?: SwarmTaskStatus;
			ownerAgentId?: string;
			ownedPaths?: string[];
			resultSummary?: string;
		},
	): Promise<SwarmTask> {
		if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
		return this.registry.mutate(async () => {
			const caller = this.agentForSession(sessionId);
			const active = this.workspaceSwarm(caller);
			if (!active || active.swarm.status !== "active") throw new HarnessError("No active Hyakki-Yako swarm", 409);
			const { manager, swarm } = active;
			const task = (swarm.tasks ?? []).find((entry) => entry.id === input.taskId);
			if (!task) throw new HarnessError(`Board task not found: ${input.taskId}`, 404);
			const isManager = caller.agentId === manager.agentId;
			if (!isManager) {
				if (input.ownedPaths !== undefined)
					throw new HarnessError("Only the workspace manager can modify ownedPaths", 403);
				if (input.ownerAgentId !== undefined) {
					if (input.ownerAgentId !== caller.agentId || (task.ownerAgentId && task.ownerAgentId !== caller.agentId))
						throw new HarnessError("Specialists can only claim an unassigned task for themselves", 403);
				}
				if (task.ownerAgentId && task.ownerAgentId !== caller.agentId)
					throw new HarnessError("Only the task owner or manager can update this task", 403);
			}
			let nextOwnerAgentId = task.ownerAgentId;
			let nextOwnerName = task.ownerName;
			if (input.ownerAgentId !== undefined) {
				const owner = this.agentById(input.ownerAgentId);
				this.assertTarget(caller, owner);
				nextOwnerAgentId = owner.agentId;
				nextOwnerName = owner.name;
			}
			let nextOwnedPaths = task.ownedPaths;
			if (input.ownedPaths !== undefined) {
				try {
					nextOwnedPaths = [...new Set(input.ownedPaths.map((entry) => normalizeOwnedPath(entry)))];
				} catch (error) {
					throw new HarnessError(error instanceof Error ? error.message : String(error), 400);
				}
			}
			const nextStatus = input.status ?? task.status;
			if (nextStatus === "in_progress") {
				const unfinishedDeps = (task.dependsOn ?? []).filter((depId) => {
					const dep = (swarm.tasks ?? []).find((entry) => entry.id === depId);
					return dep && dep.status !== "done";
				});
				if (unfinishedDeps.length > 0)
					throw new HarnessError(
						`Task ${task.id} cannot start until dependencies finish: ${unfinishedDeps.join(", ")}`,
						409,
					);
				const otherActive = (swarm.tasks ?? []).filter(
					(entry) => entry.id !== task.id && entry.status === "in_progress",
				);
				const conflicts = findOwnedPathConflicts(nextOwnedPaths ?? [], otherActive);
				if (conflicts.length > 0) {
					const first = conflicts[0]!;
					throw new HarnessError(
						`Owned path conflict: ${first.requestedPath} overlaps active task ${first.taskId} (${first.existingPath}${first.ownerName ? `, owned by ${first.ownerName}` : ""})`,
						409,
					);
				}
			}
			if (nextStatus === "done" && task.needsReview) {
				const approved = (task.reviews ?? []).some(
					(review) => review.verdict === "approved" && review.reviewerAgentId !== nextOwnerAgentId,
				);
				if (!approved)
					throw new HarnessError(
						`Task ${task.id} requires independent approval via team action=board op=review before marking done`,
						409,
					);
			}
			task.ownerAgentId = nextOwnerAgentId;
			task.ownerName = nextOwnerName;
			task.ownedPaths = nextOwnedPaths;
			task.status = nextStatus;
			if (input.resultSummary !== undefined) task.resultSummary = input.resultSummary.trim() || undefined;
			task.updatedAt = new Date().toISOString();
			this.recordSwarmEvent(
				swarm,
				"task",
				`${task.id} (${task.title}) → ${task.status}${task.ownerName ? ` [${task.ownerName}]` : ""}`,
				caller,
				task.id,
			);
			await this.registry.persist();
			this.changed(manager);
			return structuredClone(task);
		});
	}
	async boardPostNote(
		sessionId: string,
		input: { kind: SwarmNoteKind; title: string; body: string; paths?: string[]; taskId?: string },
	): Promise<SwarmBoardNote> {
		if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
		return this.registry.mutate(async () => {
			const caller = this.agentForSession(sessionId);
			const active = this.workspaceSwarm(caller);
			if (!active || active.swarm.status !== "active") throw new HarnessError("No active Hyakki-Yako swarm", 409);
			const { manager, swarm } = active;
			const title = input.title.trim();
			const body = input.body.trim();
			if (!title || !body) throw new HarnessError("Board note requires non-empty title and body", 400);
			if (input.taskId && !(swarm.tasks ?? []).some((entry) => entry.id === input.taskId))
				throw new HarnessError(`Board task not found: ${input.taskId}`, 404);
			const paths = input.paths?.map((entry) => entry.trim()).filter(Boolean);
			const note: SwarmBoardNote = {
				id: `n${(swarm.notes?.length ?? 0) + 1}-${randomBytes(3).toString("hex")}`,
				kind: input.kind,
				authorAgentId: caller.agentId,
				authorName: caller.name,
				title,
				body,
				...(paths?.length ? { paths: [...new Set(paths)] } : {}),
				...(input.taskId ? { taskId: input.taskId } : {}),
				createdAt: new Date().toISOString(),
			};
			swarm.notes ??= [];
			swarm.notes.push(note);
			if (swarm.notes.length > 100) swarm.notes.splice(0, swarm.notes.length - 100);
			this.recordSwarmEvent(swarm, "note", `[${note.kind}] ${note.title}`, caller, note.taskId);
			await this.registry.persist();
			this.changed(manager);
			return structuredClone(note);
		});
	}
	async boardReviewTask(
		sessionId: string,
		input: { taskId: string; verdict: SwarmReviewVerdict; summary: string },
	): Promise<{ task: SwarmTask; review: SwarmReview }> {
		if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
		return this.registry.mutate(async () => {
			const caller = this.agentForSession(sessionId);
			const active = this.workspaceSwarm(caller);
			if (!active || active.swarm.status !== "active") throw new HarnessError("No active Hyakki-Yako swarm", 409);
			const { manager, swarm } = active;
			const task = (swarm.tasks ?? []).find((entry) => entry.id === input.taskId);
			if (!task) throw new HarnessError(`Board task not found: ${input.taskId}`, 404);
			if (task.ownerAgentId && task.ownerAgentId === caller.agentId)
				throw new HarnessError(
					"An agent cannot review or approve its own task; assign a different specialist or have the manager review it",
					403,
				);
			const summary = input.summary.trim();
			if (!summary) throw new HarnessError("Review requires a concrete summary", 400);
			const now = new Date().toISOString();
			const review: SwarmReview = {
				id: randomBytes(6).toString("hex"),
				reviewerAgentId: caller.agentId,
				reviewerName: caller.name,
				verdict: input.verdict,
				summary,
				createdAt: now,
			};
			task.reviews ??= [];
			task.reviews.push(review);
			task.status = input.verdict === "approved" ? "done" : "in_progress";
			task.updatedAt = now;
			this.recordSwarmEvent(
				swarm,
				"review",
				`${caller.name} が ${task.id} を${input.verdict === "approved" ? "承認" : "修正依頼"}: ${summary.slice(0, 120)}`,
				caller,
				task.id,
			);
			await this.registry.persist();
			this.changed(manager);
			return structuredClone({ task, review });
		});
	}
	async boardVerify(
		sessionId: string,
		input: { checkId?: string; name?: string; command?: string; timeoutMs?: number },
		signal?: AbortSignal,
	): Promise<{ check: SwarmCheck; output: string; truncated: boolean; timedOut: boolean }> {
		if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
		if (!this.registry.activeTools(sessionId).includes("bash"))
			throw new HarnessError("Verification command execution requires bash tool permission", 403);
		const prepared = await this.registry.mutate(async () => {
			const caller = this.agentForSession(sessionId);
			const active = this.workspaceSwarm(caller);
			if (!active || active.swarm.status !== "active") throw new HarnessError("No active Hyakki-Yako swarm", 409);
			const { manager, swarm } = active;
			swarm.checks ??= [];
			let check = input.checkId ? swarm.checks.find((entry) => entry.id === input.checkId) : undefined;
			if (input.checkId && !check) throw new HarnessError(`Verification check not found: ${input.checkId}`, 404);
			if (!check) {
				const name = input.name?.trim();
				const command = input.command?.trim();
				if (!name || !command) throw new HarnessError("Provide an existing checkId or both name and command", 400);
				check = swarm.checks.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
				const now = new Date().toISOString();
				if (check) {
					check.command = command;
					check.updatedAt = now;
				} else {
					let n = 1;
					while (swarm.checks.some((entry) => entry.id === `c${n}`)) n++;
					check = { id: `c${n}`, name, command, status: "pending", updatedAt: now };
					swarm.checks.push(check);
				}
				await this.registry.persist();
				this.changed(manager);
			}
			return {
				swarmId: swarm.id,
				managerSessionId: manager.sessionId,
				callerAgentId: caller.agentId,
				callerName: caller.name,
				cwd: this.registry.descriptor(sessionId).cwd,
				checkId: check.id,
				checkName: check.name,
				command: check.command,
			};
		});
		const outcome = await runSwarmVerification(prepared.command, prepared.cwd, {
			agentDir: this.options.agentDir,
			timeoutMs: input.timeoutMs ?? 120_000,
			signal,
		});
		return this.registry.mutate(async () => {
			const manager = this.agentForSession(prepared.managerSessionId);
			const swarm = this.registry.runtimeSwarm(this.registry.descriptor(manager.sessionId));
			const check =
				swarm?.id === prepared.swarmId ? swarm.checks?.find((entry) => entry.id === prepared.checkId) : undefined;
			const now = new Date().toISOString();
			const status = outcome.exitCode === 0 && !outcome.timedOut ? "passed" : "failed";
			const rawSummary = outcome.output.length > 2000 ? outcome.output.slice(-2000) : outcome.output;
			const summary =
				`${outcome.timedOut ? "[Timed out] " : ""}${rawSummary}`.trim() ||
				(status === "passed" ? "OK" : `exit ${outcome.exitCode}`);
			if (swarm && check) {
				check.status = status;
				check.exitCode = outcome.exitCode;
				check.summary = summary;
				check.runByAgentId = prepared.callerAgentId;
				check.runByName = prepared.callerName;
				check.updatedAt = now;
				this.recordSwarmEvent(
					swarm,
					"verify",
					`検証 ${check.name}: ${status === "passed" ? "合格" : `失敗 (exit ${outcome.exitCode})`}`,
					this.registry.state.agents.find((entry) => entry.agentId === prepared.callerAgentId),
				);
				await this.registry.persist();
				this.changed(manager);
			}
			return {
				check: structuredClone(
					check ?? {
						id: prepared.checkId,
						name: prepared.checkName,
						command: prepared.command,
						status,
						exitCode: outcome.exitCode,
						summary,
						runByAgentId: prepared.callerAgentId,
						runByName: prepared.callerName,
						updatedAt: now,
					},
				),
				output: outcome.output,
				truncated: outcome.truncated,
				timedOut: outcome.timedOut,
			};
		});
	}
	async goal(sessionId: string, action: GoalAction): Promise<Goal | null> {
		if (!this.registry.goalEnabled) throw new HarnessError("Goal plugin is disabled", 404);
		if (action.op === "get") return structuredClone(this.registry.descriptor(sessionId).goal ?? null);
		await this.ensureRoot(sessionId);
		if (action.op === "pause" || action.op === "drop") {
			await this.stopSubtree(sessionId, undefined, action.op);
			return structuredClone(this.registry.descriptor(sessionId).goal ?? null);
		}
		return this.registry.mutate(async () => {
			const agent = this.agentForSession(sessionId);
			this.assertOpen(agent);
			const descriptor = this.registry.descriptor(sessionId);
			if (agent.parentAgentId || descriptor.parentSessionId)
				throw new HarnessError("Goal mode requires a root session", 409);
			if (this.registry.runtimeSwarm(descriptor)?.status === "active")
				throw new HarnessError("Stop the active Hyakki-Yako swarm before starting a Goal", 409);
			if (
				this.registry.state.agents.some(
					(entry) =>
						(entry.agentId === agent.agentId || this.ancestor(agent.agentId, entry)) && this.current(entry),
				)
			)
				throw new HarnessError("Start or resume a goal only while its subtree is idle", 409);
			const current = descriptor.goal;
			if (action.op === "create") {
				if (!action.objective.trim()) throw new HarnessError("Goal objective must not be empty");
				if (current && !["complete", "dropped"].includes(current.status))
					throw new HarnessError("Drop the existing goal before creating another", 409);
			} else {
				if (!current || !["paused", "blocked"].includes(current.status))
					throw new HarnessError("Only paused or blocked goals can resume", 409);
			}
			await this.registry.assertModelReady(sessionId);
			if (action.op === "create") {
				const now = new Date().toISOString();
				descriptor.goal = {
					id: randomBytes(8).toString("hex"),
					objective: action.objective.trim(),
					status: "active",
					createdAt: now,
					updatedAt: now,
				};
			} else {
				this.updateGoal(sessionId, "active");
			}
			const goal = descriptor.goal!;
			this.goalFingerprints.delete(goal.id);
			const run = this.newRun(
				agent,
				action.op === "create" ? goal.objective : `Goal: ${goal.objective}`,
				action.op === "resume" ? "context" : undefined,
			);
			if (action.op === "resume")
				for (const input of this.registry.state.pendingInput)
					if (input.sessionId === sessionId && input.status === "undelivered" && input.contextInjection) {
						input.runId = run.runId;
						input.status = "pending";
						input.delivered = false;
					}
			await this.registry.persist();
			this.enqueue(agent.teamId, { runId: run.runId });
			this.pump(agent.teamId);
			this.changed(agent);
			return structuredClone(goal);
		});
	}
	createGoalTool(sessionId: string): ToolDefinition<typeof goalParameters> {
		return {
			name: "goal",
			label: "Goal",
			description:
				"Read the current goal, explicitly complete its objective, or block it when external input is required. Complete and block require a concrete reason and an active root goal. This tool cannot resume or create goals.",
			promptSnippet:
				"Use goal complete only when the objective is achieved; use goal block when progress requires user input. Ordinary assistant text does not end Goal mode.",
			executionMode: "sequential",
			parameters: goalParameters,
			execute: async (_callId, params: Static<typeof goalParameters>) => {
				const result = await this.registry.mutate(async () => {
					const goal = this.registry.runtimeGoal(this.registry.descriptor(sessionId));
					if (params.op === "get") return structuredClone(goal ?? null);
					if (!goal || goal.status !== "active") throw new HarnessError("No active goal", 409);
					if (!params.reason.trim()) throw new HarnessError("Goal completion or block requires a reason");
					this.updateGoal(sessionId, params.op === "complete" ? "complete" : "blocked", params.reason.trim());
					await this.registry.persist();
					this.changed(this.agentForSession(sessionId));
					return structuredClone(goal);
				});
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		};
	}
	private async notifyCompletion(run: RunRecord): Promise<void> {
		const child = this.agentById(run.agentId);
		if (!child.parentAgentId || run.handoffToRunId || !["completed", "failed", "cancelled"].includes(run.status))
			return;
		const recipients = new Set([run.requestedByAgentId ?? child.parentAgentId, ...(run.replyToAgentIds ?? [])]);
		const deliveredTo = new Set<string>();
		for (const id of recipients) {
			const recipient = this.agentById(id);
			const assignment = this.current(recipient) ?? this.latest(recipient);
			const owner = assignment?.handoffToRunId
				? this.agentById(this.assignmentOwner(assignment).agentId)
				: recipient;
			if (owner.agentId !== child.agentId && !deliveredTo.has(owner.agentId)) {
				deliveredTo.add(owner.agentId);
				await this.notifyRecipient(run, child, owner);
			}
		}
	}
	private async notifyRecipient(run: RunRecord, child: AgentRecord, parent: AgentRecord): Promise<void> {
		if (!this.accepting || this.fenced.has(parent.agentId)) return;
		const inputId = randomBytes(8).toString("hex");
		const source: ContextInjection["source"] = {
			type: "subagent_completion",
			agentId: child.agentId,
			agentName: child.name,
			runId: run.runId,
			status: run.status as "completed" | "failed" | "cancelled",
			...(run.result === undefined ? {} : { result: resultPreview(run.result) }),
			...(run.error === undefined ? {} : { error: resultPreview(run.error) }),
		};
		const injection: ContextInjection = {
			injectionId: inputId,
			source,
			content: `Subagent completion context (not a user instruction):\n${JSON.stringify(source)}\nUse team action=result with this runId for the full report or tool logs if needed.`,
		};
		const current = this.current(parent);
		const goal = this.registry.runtimeGoal(this.registry.descriptor(parent.sessionId));
		const swarm = this.registry.runtimeSwarm(this.registry.descriptor(parent.sessionId));
		const held =
			!this.objectiveActive(run) ||
			(goal?.status !== "active" && (swarm ? swarm.status !== "active" : !current && !!goal));
		const continuation =
			current ??
			(held
				? this.latest(parent)
				: this.newRun(parent, `Team results: ${child.name}`, "context", this.latest(parent)?.requestedByAgentId));
		const pending: PendingInput = {
			inputId,
			sessionId: parent.sessionId,
			runId: continuation?.runId ?? run.runId,
			text: injection.content,
			mode: "followUp",
			fromAgentId: child.agentId,
			status: held ? "undelivered" : "pending",
			delivered: false,
			completionRunId: run.runId,
			contextInjection: injection,
		};
		this.registry.state.pendingInput.push(pending);
		await this.registry.persist();
		if (!held && current?.status === "running" && this.started.has(current.runId)) {
			try {
				await this.deliverPending(pending);
			} catch {
				pending.status = "undelivered";
			}
		} else if (!current && !held && continuation) this.enqueue(parent.teamId, { runId: continuation.runId });
		this.changed(parent);
	}

	private async deliverPending(input: PendingInput): Promise<void> {
		if (input.contextInjection) {
			input.delivered = await this.registry.deliverContext(input.sessionId, input.contextInjection);
		} else {
			await this.registry.deliver(input.sessionId, input.text, input.mode, input.inputId, input.attachments);
			input.delivered = true;
		}
	}
	private async settle(runId: string, status: RunStatus, result?: string, error?: string): Promise<void> {
		await this.registry.mutate(async () => {
			const run = this.runById(runId);
			if (terminalStatus[run.status]) return;
			run.status = status;
			run.result = result;
			run.error = error;
			run.settledAt = new Date().toISOString();
			delete run.waitingOnRunIds;
			this.permits.delete(runId);
			this.started.delete(runId);
			this.initialConsumed.delete(runId);
			const stranded = this.registry.state.pendingInput.filter(
				(input) => input.runId === runId && input.status === "pending" && input.contextInjection,
			);
			for (const input of this.registry.state.pendingInput) if (input.runId === runId) input.status = "undelivered";
			const agent = this.agentById(run.agentId);
			const goal = this.registry.runtimeGoal(this.registry.descriptor(agent.sessionId));
			if (goal?.status === "active") {
				if (status !== "completed") {
					this.updateGoal(
						agent.sessionId,
						"paused",
						error ?? (status === "cancelled" ? "Run was aborted" : "Run did not complete"),
					);
				} else if (this.autonomousRuns.has(runId)) {
					const calls = this.registry
						.get(agent.sessionId)
						.toolCalls.filter((tool) => tool.runId === runId && tool.name !== "goal");
					const fingerprint = JSON.stringify(
						calls.map(({ name, input, result, status: toolStatus }) => ({
							name,
							input,
							result,
							status: toolStatus,
						})),
					);
					if (calls.length === 0)
						this.updateGoal(
							agent.sessionId,
							"paused",
							"Autonomous continuation made no tool progress; resume explicitly to continue",
						);
					else if (this.goalFingerprints.get(goal.id) === fingerprint)
						this.updateGoal(
							agent.sessionId,
							"paused",
							"Autonomous continuation repeated the same tool calls and results",
						);
					else this.goalFingerprints.set(goal.id, fingerprint);
				}
			}
			const swarm = this.registry.runtimeSwarm(this.registry.descriptor(agent.sessionId));
			if (swarm?.status === "active" && this.runtime.get(runId)?.swarmId === swarm.id) {
				if (status !== "completed")
					this.updateSwarm(agent.sessionId, "paused", error ?? "Run was aborted or did not complete");
				else if (
					stranded.length === 0 &&
					!this.registry.state.agents.some((child) => this.ancestor(agent.agentId, child) && this.current(child))
				) {
					const calls = this.registry.get(agent.sessionId).toolCalls.filter((tool) => {
						if (tool.runId !== runId || tool.status !== "success") return false;
						if (tool.name !== "team") return true;
						const input = tool.input;
						if (
							input === null ||
							typeof input !== "object" ||
							!("action" in input) ||
							typeof input.action !== "string"
						)
							return false;
						if (["spawn", "workflow", "send", "profiles", "work"].includes(input.action)) return true;
						return (
							input.action === "board" &&
							"op" in input &&
							typeof input.op === "string" &&
							["plan", "task", "post", "review", "verify"].includes(input.op)
						);
					});
					const rootIndex = this.registry.state.runs.indexOf(run);
					const delegatedResults = this.registry.state.runs
						.filter(
							(childRun, index) =>
								index > rootIndex &&
								terminalStatus[childRun.status] &&
								this.ancestor(agent.agentId, this.agentById(childRun.agentId)),
						)
						.map(({ task, status: childStatus, result: childResult, error: childError }) => ({
							task,
							status: childStatus,
							result: childResult,
							error: childError,
						}));
					// Ignore generated run/session IDs, but keep real work outcomes and inspection results.
					const fingerprint = JSON.stringify({
						calls: calls.map(({ name, input, result: toolResult }) => ({
							name,
							input,
							result: name === "team" ? undefined : toolResult,
						})),
						delegatedResults,
					});
					if (calls.length === 0)
						this.updateSwarm(
							agent.sessionId,
							"paused",
							"Orchestration made no tool progress; start Hyakki-Yako explicitly to continue",
						);
					else if (this.swarmFingerprints.get(swarm.id) === fingerprint)
						this.updateSwarm(agent.sessionId, "paused", "Orchestration repeated the same tool calls and results");
					else this.swarmFingerprints.set(swarm.id, fingerprint);
				}
			}
			this.autonomousRuns.delete(runId);
			if (
				status === "completed" &&
				!run.handoffToRunId &&
				this.objectiveActive(run) &&
				stranded.length > 0 &&
				(goal?.status === "active" || (swarm ? swarm.status === "active" : !goal)) &&
				this.accepting &&
				!this.fenced.has(agent.agentId)
			) {
				const continuation = this.newRun(agent, "Team results", "context", run.requestedByAgentId);
				for (const input of stranded) {
					input.runId = continuation.runId;
					input.status = "pending";
					// Persisted injections are already in model history; undelivered ones are injected on execution.
				}
				this.enqueue(agent.teamId, { runId: continuation.runId });
			}
			if (status !== "interrupted") await this.notifyCompletion(run);
			await this.registry.persist();
			this.changed(agent);
			for (const waiter of [...this.waiters])
				if (
					(waiter.mode === "any" &&
						waiter.targets.some((id) => terminalStatus[this.assignmentOwner(this.runById(id)).status])) ||
					waiter.targets.every((id) => terminalStatus[this.assignmentOwner(this.runById(id)).status])
				)
					waiter.finish(false);
			this.runtime.get(runId)?.resolveDone();
			this.runtime.delete(runId);
			this.pump(agent.teamId);
			if (status === "completed") {
				this.scheduleGoal(agent);
				this.scheduleSwarm(agent);
			}
		});
	}
	async prompt(
		sessionId: string,
		input: { text: string; mode: "prompt" | "steer" | "followUp"; attachments?: PromptAttachment[] },
	): Promise<AdmissionResult> {
		if (!input.text.trim() && !input.attachments?.length) throw new HarnessError("Prompt must not be empty");
		const text = input.text.trim() ? input.text : "添付ファイルを確認してください。";
		await this.ensureRoot(sessionId);
		return this.registry.mutate(async () => {
			const agent = this.agentForSession(sessionId);
			this.assertOpen(agent);
			const current = this.current(agent);
			if (current && input.mode === "prompt") throw new HarnessError("Session is busy; use steer or followUp", 409);
			if (current)
				return this.acceptInput(
					agent,
					current,
					text,
					input.mode === "steer" ? "steer" : "followUp",
					input.attachments,
				);
			const run = this.newRun(agent, text);
			if (input.attachments?.length) run.attachments = structuredClone(input.attachments);
			await this.registry.persist();
			this.enqueue(agent.teamId, { runId: run.runId });
			this.pump(agent.teamId);
			this.changed(agent);
			return { runId: run.runId, disposition: run.status === "running" ? "started" : "queued" };
		});
	}

	async updatePendingInput(sessionId: string, inputId: string, action: PendingInputAction): Promise<void> {
		await this.registry.mutate(async () => {
			const agent = this.agentForSession(sessionId);
			this.assertOpen(agent);
			const inputs = this.registry.state.pendingInput;
			const index = inputs.findIndex((input) => input.sessionId === sessionId && input.inputId === inputId);
			if (index === -1) throw new HarnessError("Pending input not found", 404);
			const input = inputs[index];
			if (!input || input.fromAgentId || input.completionRunId)
				throw new HarnessError("Team messages cannot be changed", 403);
			const current = this.current(agent);
			const undelivered = input.status === "undelivered";
			const currentInput = input.status === "pending" && current?.runId === input.runId;
			if (!undelivered && !currentInput) throw new HarnessError("Pending input is no longer available", 409);
			const queued = currentInput && input.delivered === true;
			if (queued && !this.registry.hasQueuedInput(sessionId, inputId))
				throw new HarnessError("Pending input has already started", 409);

			if (action.type === "edit") {
				if (!action.text.trim()) throw new HarnessError("Pending input must not be empty");
				const previousText = input.text;
				input.text = action.text;
				if (queued && !this.registry.mutateQueuedInput(sessionId, inputId, action)) {
					input.text = previousText;
					throw new HarnessError("Pending input has already started", 409);
				}
			} else if (action.type === "delete") {
				inputs.splice(index, 1);
				if (queued && !this.registry.mutateQueuedInput(sessionId, inputId, action)) {
					inputs.splice(index, 0, input);
					throw new HarnessError("Pending input has already started", 409);
				}
			} else if (input.mode !== "followUp") {
				throw new HarnessError("Only follow-up inputs can be sent immediately", 409);
			} else if (current) {
				const previous = {
					runId: input.runId,
					mode: input.mode,
					status: input.status,
					delivered: input.delivered,
				};
				input.runId = current.runId;
				input.mode = "steer";
				input.status = "pending";
				if (queued) {
					if (!this.registry.mutateQueuedInput(sessionId, inputId, action)) {
						Object.assign(input, previous);
						throw new HarnessError("Pending input has already started", 409);
					}
				} else {
					input.delivered = false;
					if (current.status === "running" && this.started.has(current.runId)) {
						try {
							await this.registry.deliver(sessionId, input.text, "steer", inputId, input.attachments);
							input.delivered = true;
						} catch (error) {
							Object.assign(input, previous);
							throw error;
						}
					}
				}
			} else {
				inputs.splice(index, 1);
				const run = this.newRun(agent, input.text);
				if (input.attachments?.length) run.attachments = structuredClone(input.attachments);
				await this.registry.persist();
				this.enqueue(agent.teamId, { runId: run.runId });
				this.pump(agent.teamId);
				this.changed(agent);
				return;
			}
			await this.registry.persist();
			this.changed(agent);
		});
	}

	private async acceptInput(
		agent: AgentRecord,
		run: RunRecord,
		text: string,
		mode: "steer" | "followUp",
		attachments?: PromptAttachment[],
		fromAgentId?: string,
		inputId = randomBytes(8).toString("hex"),
	): Promise<AdmissionResult> {
		const pending: PendingInput = {
			inputId,
			sessionId: agent.sessionId,
			runId: run.runId,
			text,
			...(attachments?.length ? { attachments: structuredClone(attachments) } : {}),
			mode,
			fromAgentId,
			status: "pending",
			delivered: false,
		};
		this.registry.state.pendingInput.push(pending);
		await this.registry.persist();
		if (this.started.has(run.runId) && run.status === "running") {
			await this.registry.deliver(agent.sessionId, text, mode, inputId, pending.attachments);
			pending.delivered = true;
			await this.registry.persist();
		}
		this.changed(agent);
		return { inputId, runId: run.runId, disposition: run.status === "queued" ? "queued" : "started" };
	}
	private async profiles(sessionId: string) {
		if (!this.options.agentDir) return [];
		const workspace = this.registry.descriptor(sessionId).workspaceId;
		try {
			return await loadTeamProfiles(this.registry.getWorkspaceRoot(workspace), this.options.agentDir);
		} catch (error) {
			throw new HarnessError(error instanceof Error ? error.message : String(error), 400);
		}
	}
	private async resolveTasks(sessionId: string, tasks: SpawnTask[]): Promise<SpawnTask[]> {
		const profiles = tasks.some((task) => task.profile) ? await this.profiles(sessionId) : [];
		return tasks.map((task) => {
			if (!task.profile) return task;
			const profile = profiles.find((entry) => entry.name === task.profile);
			if (!profile)
				throw new HarnessError(
					profiles.length
						? `Unknown agent profile: ${task.profile} (available: ${profiles.map((entry) => entry.name).join(", ")})`
						: 'No agent profiles are configured; omit "profile"',
					400,
				);
			if (task.tools && profile.tools && task.tools.some((tool) => !profile.tools?.includes(tool)))
				throw new HarnessError(`Child tools must be a subset of profile ${profile.name}`, 400);
			return {
				...task,
				responsibility: task.responsibility ?? profile.description,
				systemPrompt: [profile.systemPrompt, task.systemPrompt].filter(Boolean).join("\n\n"),
				model: task.model ?? profile.model,
				tools: task.tools ?? profile.tools,
			};
		});
	}
	async spawn(
		sessionId: string,
		tasks: SpawnTask[],
	): Promise<{ agents: { agentId: string; sessionId: string; runId: string; name: string; status: RunStatus }[] }> {
		if (tasks.length === 0 || tasks.length > 32) throw new HarnessError("Spawn requires 1..32 tasks");
		const resolved = await this.resolveTasks(sessionId, tasks);
		return this.registry.mutate(async () => {
			const parent = this.agentForSession(sessionId);
			this.assertOpen(parent);
			let depth = 0;
			let cursor = parent;
			while (cursor.parentAgentId) {
				depth++;
				cursor = this.agentById(cursor.parentAgentId);
			}
			if (depth >= this.limits().maxDepth) throw new HarnessError("Team maximum depth reached");
			const descriptor = this.registry.descriptor(sessionId);
			const tools = this.registry.delegationTools(sessionId);
			const team = this.registry.state.teams.find((entry) => entry.teamId === parent.teamId)!;
			const continuingTeam = team.scope === "workspace" && parent.agentId === team.rootAgentId;
			const agentModels = this.options.getAgentModels?.() ?? {};
			const names = new Set<string>();
			const assignments = resolved.map((task) => {
				if (!continuingTeam) return { task, agent: undefined };
				const name = task.name.trim();
				if (names.has(name)) throw new HarnessError(`Duplicate specialist name in one batch: ${name}`, 400);
				names.add(name);
				const matches = this.registry.state.agents.filter(
					(agent) => agent.parentAgentId === parent.agentId && agent.name.trim() === name,
				);
				if (matches.length > 1)
					throw new HarnessError(`Multiple members named ${name}; use team send with the intended agentId`, 409);
				const agent = matches[0];
				if (agent) {
					this.assertOpen(agent);
					if (this.current(agent))
						throw new HarnessError(`${name} is busy; use team send with agentId ${agent.agentId}`, 409);
					const member = this.registry.descriptor(agent.sessionId);
					if (
						(!agentModels[task.category ?? agent.category ?? "other"] &&
							task.model &&
							(task.model.provider !== member.model?.provider || task.model.id !== member.model?.id)) ||
						(task.responsibility !== undefined && task.responsibility.trim() !== agent.responsibility) ||
						(task.systemPrompt !== undefined && task.systemPrompt !== (member.systemPrompt ?? "")) ||
						(task.tools &&
							(task.tools.some((tool) => !member.tools?.includes(tool)) ||
								member.tools?.some((tool) => !task.tools?.includes(tool))))
					)
						throw new HarnessError(
							`Cannot replace ${name}'s model, tools, or instructions through reassignment; use team send or choose a distinct specialist`,
							409,
						);
				}
				return { task, agent };
			});
			for (const { task, agent } of assignments) {
				if (!task.name.trim() || !task.task.trim()) throw new HarnessError("Agent name and task must not be empty");
				if (task.tools?.some((tool) => !tools.includes(tool)))
					throw new HarnessError("Child tools must be a subset of the parent's active tools");
				if (
					task.responsibility !== undefined &&
					(!task.responsibility.trim() || task.responsibility.length > 16384)
				)
					throw new HarnessError("Responsibility must contain 1..16384 characters");
				if (continuingTeam && !agent && !task.responsibility?.trim())
					throw new HarnessError(
						"A new workspace specialist needs a continuing responsibility separate from its current task",
					);
			}
			const admitted: { agent: AgentRecord; run: RunRecord }[] = [];
			for (const assignment of assignments) {
				const { task } = assignment;
				let agent = assignment.agent;
				const category = task.category ?? agent?.category ?? "other";
				const configured = agentModels[category];
				const model = configured
					? { provider: configured.provider, id: configured.id }
					: (task.model ?? descriptor.model);
				if (!agent) {
					const child = await this.registry.createWithinMutation({
						workspaceId: descriptor.workspaceId,
						parentSessionId: sessionId,
						role: task.name,
						systemPrompt: task.systemPrompt,
						model,
						thinkingLevel: configured?.thinkingLevel,
						tools: task.tools ?? tools,
					});
					agent = {
						agentId: nextId("a", this.registry.state.agents, "agentId"),
						teamId: parent.teamId,
						parentAgentId: parent.agentId,
						sessionId: child.sessionId,
						name: task.name,
						role: task.name,
						...(task.responsibility ? { responsibility: task.responsibility.trim() } : {}),
					};
					this.registry.state.agents.push(agent);
				} else {
					if (configured && model) {
						await this.registry.setModelWithinMutation(agent.sessionId, model, configured.thinkingLevel);
					}
					await this.syncWorktreeIfClean(agent, sessionId);
				}
				agent.category = category;
				const run = this.newRun(
					agent,
					task.context ? `${task.task}\n\nContext:\n${task.context}` : task.task,
					undefined,
					parent.agentId,
				);
				admitted.push({ agent, run });
			}
			const activeSwarm = this.workspaceSwarm(parent);
			if (activeSwarm?.swarm.status === "active") {
				this.recordSwarmEvent(
					activeSwarm.swarm,
					"task",
					`作業を割り当て: ${admitted.map(({ agent }) => agent.name).join(", ")}`,
					parent,
				);
			}
			await this.registry.persist();
			for (const { run } of admitted) this.enqueue(parent.teamId, { runId: run.runId });
			this.pump(parent.teamId);
			this.changed(parent);
			return {
				agents: admitted.map(({ agent, run }) => ({
					agentId: agent.agentId,
					sessionId: agent.sessionId,
					runId: run.runId,
					name: agent.name,
					status: run.status,
				})),
			};
		});
	}
	async workflow(sessionId: string, tasks: WorkflowTask[], timeoutMs = 300000, signal?: AbortSignal) {
		try {
			validateWorkflow(tasks);
		} catch (error) {
			throw new HarnessError(error instanceof Error ? error.message : String(error), 400);
		}
		if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000)
			throw new HarnessError("Invalid workflow timeout", 400);
		// Reject invalid profiles and tool grants before admitting any workflow child.
		const resolved = await this.resolveTasks(sessionId, tasks);
		const allowed = this.registry.delegationTools(sessionId);
		const caller = this.agentForSession(sessionId);
		const team = this.registry.state.teams.find((entry) => entry.teamId === caller.teamId)!;
		for (const task of resolved) {
			if (task.tools?.some((tool) => !allowed.includes(tool)))
				throw new HarnessError("Child tools must be a subset of the parent's active tools", 400);
			if (
				team.scope === "workspace" &&
				team.rootAgentId === caller.agentId &&
				!this.registry.state.agents.some(
					(agent) => agent.parentAgentId === caller.agentId && agent.name.trim() === task.name.trim(),
				) &&
				!task.responsibility?.trim()
			)
				throw new HarnessError(
					"A new workspace specialist needs a continuing responsibility separate from its current task",
				);
		}
		const records = new Map(
			tasks.map((task) => [
				task.name,
				{
					name: task.name,
					status: "pending" as RunStatus | "pending" | "skipped",
					agentId: undefined as string | undefined,
					runId: undefined as string | undefined,
					result: undefined as string | undefined,
					error: undefined as string | undefined,
				},
			]),
		);
		const deadline = Date.now() + timeoutMs;
		if (signal?.aborted) throw new HarnessError("Workflow cancelled");
		while (true) {
			const ready: SpawnTask[] = [];
			for (const task of tasks) {
				const record = records.get(task.name);
				if (!record || record.status !== "pending") continue;
				const dependencies = (task.dependsOn ?? []).map((name) => records.get(name));
				if (
					dependencies.some(
						(entry) =>
							entry?.status === "skipped" ||
							entry?.status === "failed" ||
							entry?.status === "cancelled" ||
							entry?.status === "interrupted",
					)
				) {
					record.status = "skipped";
					record.error = "Dependency did not complete successfully";
				} else if (dependencies.every((entry) => entry?.status === "completed")) {
					const prior = (task.dependsOn ?? [])
						.map((name) => {
							const entry = records.get(name);
							return entry ? `${name} (runId: ${entry.runId}):\n${entry.result ?? ""}` : name;
						})
						.join("\n\n");
					ready.push({ ...task, context: [task.context, prior].filter(Boolean).join("\n\n") || undefined });
				}
			}
			if (ready.length > 0) {
				const spawned = await this.spawn(sessionId, ready);
				for (const agent of spawned.agents) {
					const record = records.get(agent.name);
					if (record) Object.assign(record, { agentId: agent.agentId, runId: agent.runId, status: agent.status });
				}
			}
			const active = [...records.values()].filter(
				(entry) => entry.agentId && !terminalStatus[entry.status as RunStatus],
			);
			if (active.length === 0) {
				if ([...records.values()].some((entry) => entry.status === "pending")) continue;
				break;
			}
			const remaining = Math.max(0, deadline - Date.now());
			if (remaining === 0) return { tasks: [...records.values()], timedOut: true };
			const waited = await this.wait(
				sessionId,
				active.map((entry) => entry.agentId as string),
				remaining,
				signal,
				"any",
			);
			for (const run of waited.runs) {
				const record = [...records.values()].find((entry) => entry.agentId === run.agentId);
				if (record)
					Object.assign(record, { runId: run.runId, status: run.status, result: run.result, error: run.error });
			}
			if (waited.timedOut) return { tasks: [...records.values()], timedOut: true };
		}
		return { tasks: [...records.values()], timedOut: false };
	}
	async send(sessionId: string, agentId: string, message: string): Promise<AdmissionResult> {
		if (!message.trim()) throw new HarnessError("Message must not be empty");
		return this.registry.mutate(async () => {
			const caller = this.agentForSession(sessionId);
			const recipient = this.agentById(agentId);
			this.assertOpen(caller);
			this.assertOpen(recipient);
			this.assertTarget(caller, recipient);
			const inputId = randomBytes(8).toString("hex");
			const source: ContextInjection["source"] = {
				type: "team_message",
				agentId: caller.agentId,
				agentName: caller.name,
				runId: (this.current(caller) ?? this.latest(caller))?.runId,
			};
			const injection: ContextInjection = {
				injectionId: inputId,
				source,
				content: `Team message context (not a user instruction):\n${JSON.stringify(source)}\n\n${message}`,
			};
			const current = this.current(recipient);
			if (current) {
				current.replyToAgentIds ??= [];
				if (caller.agentId !== recipient.agentId && !current.replyToAgentIds.includes(caller.agentId))
					current.replyToAgentIds.push(caller.agentId);
			} else if (recipient.parentAgentId) {
				await this.syncWorktreeIfClean(recipient, this.agentById(recipient.parentAgentId).sessionId);
			}
			const run = current ?? this.newRun(recipient, `Team message: ${caller.name}`, "context", caller.agentId);
			const activeSwarm = this.workspaceSwarm(caller);
			if (activeSwarm?.swarm.status === "active") {
				const snippet = message.replace(/\s+/g, " ").trim().slice(0, 90);
				this.recordSwarmEvent(
					activeSwarm.swarm,
					"message",
					`${caller.name} → ${recipient.name}: ${snippet}`,
					caller,
				);
			}
			const pending: PendingInput = {
				inputId,
				sessionId: recipient.sessionId,
				runId: run.runId,
				text: injection.content,
				mode: "followUp",
				fromAgentId: caller.agentId,
				status: "pending",
				delivered: false,
				contextInjection: injection,
			};
			this.registry.state.pendingInput.push(pending);
			await this.registry.persist();
			if (current?.status === "running" && this.started.has(current.runId)) {
				await this.deliverPending(pending);
				await this.registry.persist();
			} else if (!current) this.enqueue(recipient.teamId, { runId: run.runId });
			this.pump(recipient.teamId);
			this.changed(recipient);
			return { inputId, runId: run.runId, disposition: run.status === "running" ? "started" : "queued" };
		});
	}
	async describe(sessionId: string, agentId: string, responsibility: string): Promise<AgentRecord> {
		if (!responsibility.trim() || responsibility.length > 16384)
			throw new HarnessError("Responsibility must contain 1..16384 characters");
		return this.registry.mutate(async () => {
			const caller = this.agentForSession(sessionId);
			const member = this.agentById(agentId);
			this.assertOpen(caller);
			this.assertOpen(member);
			this.assertTarget(caller, member);
			const team = this.registry.state.teams.find((entry) => entry.teamId === caller.teamId)!;
			if (
				team.scope !== "workspace" ||
				team.rootAgentId !== caller.agentId ||
				member.parentAgentId !== caller.agentId
			)
				throw new HarnessError("Only the workspace manager can change a specialist's responsibility", 403);
			if (this.current(member))
				throw new HarnessError("Change responsibility only while the specialist is idle", 409);
			member.responsibility = responsibility.trim();
			await this.registry.persist();
			this.changed(member);
			return structuredClone(member);
		});
	}
	async handoff(sessionId: string, agentId: string, task: string): Promise<AdmissionResult> {
		if (!task.trim())
			throw new HarnessError("Handoff requires the deliverable, relevant context, and acceptance criteria");
		return this.registry.mutate(async () => {
			const caller = this.agentForSession(sessionId);
			const target = this.agentById(agentId);
			this.assertOpen(caller);
			this.assertOpen(target);
			this.assertTarget(caller, target);
			const team = this.registry.state.teams.find((entry) => entry.teamId === caller.teamId)!;
			const source = this.current(caller);
			if (
				team.scope !== "workspace" ||
				caller.parentAgentId !== team.rootAgentId ||
				target.parentAgentId !== team.rootAgentId ||
				caller === target
			)
				throw new HarnessError("Ownership can transfer only between distinct workspace specialists", 403);
			if (!source || source.status !== "running" || source.handoffToRunId)
				throw new HarnessError("Handoff requires a running assignment that still belongs to you", 409);
			if (this.current(target))
				throw new HarnessError("Handoff target is busy; use send to coordinate readiness first", 409);
			if (target.parentAgentId) {
				await this.syncWorktreeIfClean(target, this.agentById(target.parentAgentId).sessionId);
			}
			const run = this.newRun(
				target,
				`[Team handoff from=${caller.agentId} run=${source.runId}]\n${task.trim()}`,
				undefined,
				source.requestedByAgentId ?? caller.parentAgentId,
			);
			if (source.replyToAgentIds) run.replyToAgentIds = [...source.replyToAgentIds];
			run.handoffFromRunId = source.runId;
			source.handoffToRunId = run.runId;
			const activeSwarm = this.workspaceSwarm(caller);
			if (activeSwarm?.swarm.status === "active") {
				this.recordSwarmEvent(activeSwarm.swarm, "handoff", `${caller.name} が ${target.name} へ引き継ぎ`, caller);
			}
			for (const waiter of this.waiters)
				this.runById(waiter.callerRunId).waitingOnRunIds = waiter.targets.map(
					(id) => this.assignmentOwner(this.runById(id)).runId,
				);
			await this.registry.persist();
			this.enqueue(target.teamId, { runId: run.runId });
			this.pump(target.teamId);
			this.changed(caller);
			this.changed(target);
			return { runId: run.runId, disposition: run.status === "running" ? "started" : "queued" };
		});
	}
	async wait(
		sessionId: string,
		agentIds: string[],
		timeoutMs = 30000,
		signal?: AbortSignal,
		mode: "all" | "any" = "all",
	): Promise<WaitResult> {
		if (
			agentIds.length === 0 ||
			!Number.isInteger(timeoutMs) ||
			timeoutMs < 0 ||
			timeoutMs > 300000 ||
			(mode !== "all" && mode !== "any")
		)
			throw new HarnessError("Invalid wait targets or timeout");
		let completion: Promise<boolean> | undefined;
		let removeAbortListener = () => {};
		let pinned: RunRecord[] = [];
		await this.registry.mutate(async () => {
			const caller = this.agentForSession(sessionId);
			this.assertOpen(caller);
			const callerRun = this.current(caller);
			if (!callerRun || callerRun.status !== "running" || !this.permits.has(callerRun.runId))
				throw new HarnessError("Wait requires an admitted running caller");
			const runtimeSignal = this.runtime.get(callerRun.runId)?.controller.signal;
			const waitSignal = runtimeSignal
				? signal
					? AbortSignal.any([signal, runtimeSignal])
					: runtimeSignal
				: signal;
			if (waitSignal?.aborted) throw new HarnessError("Wait cancelled");
			pinned = [...new Set(agentIds)].map((id) => {
				const target = this.agentById(id);
				this.assertTarget(caller, target);
				if (target.agentId === caller.agentId || this.ancestor(target.agentId, caller))
					throw new HarnessError("Cannot wait on self or an ancestor");
				const run = this.current(target) ?? this.latest(target);
				if (!run) throw new HarnessError("Target agent has no run");
				return run;
			});
			const reaches = (id: string, goal: string, visited = new Set<string>()): boolean => {
				if (id === goal) return true;
				if (visited.has(id)) return false;
				visited.add(id);
				return (this.runById(id).waitingOnRunIds ?? []).some((next) => reaches(next, goal, visited));
			};
			if (pinned.some((run) => reaches(this.assignmentOwner(run).runId, callerRun.runId)))
				throw new HarnessError("Wait dependency cycle");
			if (pinned.some((run) => terminalStatus[this.assignmentOwner(run).status]) && mode === "any") return;
			if (pinned.every((run) => terminalStatus[this.assignmentOwner(run).status])) return;
			callerRun.status = "waiting";
			callerRun.waitingOnRunIds = pinned.map((run) => this.assignmentOwner(run).runId);
			this.permits.delete(callerRun.runId);
			completion = new Promise<boolean>((resolve, reject) => {
				let finished = false;
				let timer: NodeJS.Timeout | undefined;
				const cleanup = () => {
					clearTimeout(timer);
					this.waiters.delete(waiter);
				};
				const abort = () => {
					finished = true;
					cleanup();
					void this.registry.mutate(async () => {
						delete callerRun.waitingOnRunIds;
						await this.registry.persist();
					});
					reject(new HarnessError("Wait cancelled"));
				};
				const waiter: Waiter = {
					callerRunId: callerRun.runId,
					targets: pinned.map((run) => run.runId),
					mode,
					finish: (timedOut) => {
						if (finished) return;
						finished = true;
						cleanup();
						void this.registry
							.mutate(async () => {
								delete callerRun.waitingOnRunIds;
								if (
									waitSignal?.aborted ||
									callerRun.status === "cancelling" ||
									terminalStatus[callerRun.status]
								) {
									reject(new HarnessError("Wait cancelled"));
									return;
								}
								callerRun.status = "queued";
								await this.registry.persist();
								this.enqueue(caller.teamId, {
									runId: callerRun.runId,
									resume: () => {
										if (waitSignal?.aborted) reject(new HarnessError("Wait cancelled"));
										else resolve(timedOut);
									},
								});
								this.pump(caller.teamId);
								this.changed(caller);
							})
							.catch(reject);
					},
				};
				this.waiters.add(waiter);
				waitSignal?.addEventListener("abort", abort, { once: true });
				removeAbortListener = () => waitSignal?.removeEventListener("abort", abort);
				timer = setTimeout(() => waiter.finish(true), timeoutMs);
			});
			void completion.catch(() => undefined);
			await this.registry.persist();
			this.changed(caller);
			this.pump(caller.teamId);
		});
		let timedOut = false;
		try {
			timedOut = completion ? await completion : false;
			if (completion) {
				await this.registry.mutate(async () => {
					const caller = this.agentForSession(sessionId);
					const current = this.current(caller);
					if (!current || current.status !== "running") return;
					for (const input of this.registry.state.pendingInput)
						if (input.runId === current.runId && input.status === "pending" && !input.delivered) {
							await this.deliverPending(input);
						}
					await this.registry.persist();
					this.changed(caller);
				});
			}
		} finally {
			removeAbortListener();
		}
		return {
			runs: pinned.map((run) => {
				const owner = this.assignmentOwner(run);
				return {
					agentId: run.agentId,
					...(owner === run ? {} : { ownerAgentId: owner.agentId }),
					runId: owner.runId,
					status: owner.status,
					result: resultPreview(owner.result),
					error: resultPreview(owner.error),
				};
			}),
			timedOut,
		};
	}
	private onEvent(sessionId: string, event: AgentSessionEvent): void {
		if (
			event.type !== "agent_start" &&
			!(
				event.type === "message_end" &&
				(event.message.role === "user" || event.message.role === "custom" || event.message.role === "assistant")
			)
		)
			return;
		void this.registry
			.mutate(async () => {
				const agent = this.agentForSession(sessionId);
				const run = this.current(agent);
				if (!run) return;
				if (event.type === "message_end" && event.message.role === "assistant") {
					const goal = this.registry.runtimeGoal(this.registry.descriptor(sessionId));
					if (goal && this.runtime.get(run.runId)?.goalId === goal.id && goal.status === "active") {
						if (event.message.stopReason === "error" || event.message.stopReason === "aborted")
							this.updateGoal(
								sessionId,
								"paused",
								event.message.errorMessage ?? "Model request failed or was aborted",
							);
						else if (event.message.stopReason === "length")
							this.updateGoal(sessionId, "paused", "Model output limit reached; resume explicitly to continue");
						await this.registry.persist();
						this.changed(agent);
					}
					const swarm = this.registry.runtimeSwarm(this.registry.descriptor(sessionId));
					if (swarm?.status === "active" && this.runtime.get(run.runId)?.swarmId === swarm.id) {
						if (["error", "aborted", "length"].includes(event.message.stopReason)) {
							this.updateSwarm(
								sessionId,
								"paused",
								event.message.errorMessage ??
									(event.message.stopReason === "length"
										? "Model output limit reached; start Hyakki-Yako explicitly to continue"
										: "Model request failed or was aborted"),
							);
							await this.registry.persist();
							this.changed(agent);
						}
					}
					return;
				}
				if (event.type === "agent_start") {
					if (run.status !== "running") return;
					this.started.add(run.runId);
					for (const input of this.registry.state.pendingInput)
						if (input.runId === run.runId && input.status === "pending" && !input.delivered) {
							await this.deliverPending(input);
						}
				} else if (event.type === "message_end" && event.message.role === "custom") {
					if (
						event.message.customType !== CONTEXT_INJECTION_CUSTOM_TYPE ||
						!isContextInjection(event.message.details)
					)
						return;
					const injectionId = event.message.details.injectionId;
					const index = this.registry.state.pendingInput.findIndex(
						(input) =>
							input.sessionId === sessionId &&
							input.contextInjection?.injectionId === injectionId &&
							input.status === "pending",
					);
					if (index !== -1) this.registry.state.pendingInput.splice(index, 1);
				} else if (event.type === "message_end" && event.message.role === "user") {
					const content = event.message.content;
					const text =
						typeof content === "string"
							? content
							: content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n");
					const marker = /^\[Team message inputId=([^\s\]]+) from=[^\]]+\]/.exec(text);
					const isInitial = run.inputKind !== "context" && !this.initialConsumed.has(run.runId);
					this.initialConsumed.add(run.runId);
					const index = this.registry.state.pendingInput.findIndex(
						(input) =>
							input.runId === run.runId &&
							input.status === "pending" &&
							(marker
								? input.inputId === marker[1]
								: !isInitial &&
									!input.fromAgentId &&
									input.delivered &&
									attachmentPrompt(input.text, input.attachments) === text),
					);
					if (index !== -1) this.registry.state.pendingInput.splice(index, 1);
				}
				await this.registry.persist();
				this.changed(agent);
			})
			.catch((error: unknown) => {
				const agent = this.registry.state.agents.find((entry) => entry.sessionId === sessionId);
				const run = agent && this.current(agent);
				if (run) {
					const runtime = this.runtime.get(run.runId);
					runtime?.controller.abort();
					void this.failAdmission(run.runId, error);
				}
			});
	}
	async stop(sessionId: string, callerSessionId?: string): Promise<{ status: "cancelled" }> {
		return this.stopSubtree(sessionId, callerSessionId);
	}
	private async stopSubtree(
		sessionId: string,
		callerSessionId?: string,
		goalAction?: "pause" | "drop",
		swarmReason = "Stopped by user",
	): Promise<{ status: "cancelled" }> {
		let affected: AgentRecord[] = [];
		const idle: Promise<void>[] = [];
		await this.registry.mutate(async () => {
			const target = this.agentForSession(sessionId);
			if (callerSessionId) {
				const caller = this.agentForSession(callerSessionId);
				this.assertTarget(caller, target);
				if (caller.agentId === target.agentId || this.ancestor(target.agentId, caller))
					throw new HarnessError("Cannot stop self or an ancestor");
			}
			const goal = this.registry.runtimeGoal(this.registry.descriptor(sessionId));
			if (goalAction) {
				if (
					target.parentAgentId ||
					!goal ||
					["complete", "dropped"].includes(goal.status) ||
					(goalAction === "pause" && goal.status !== "active")
				)
					throw new HarnessError("Illegal goal transition", 409);
				this.updateGoal(
					sessionId,
					goalAction === "drop" ? "dropped" : "paused",
					goalAction === "drop" ? "Dropped by user" : "Paused by user",
				);
			} else if (goal?.status === "active") this.updateGoal(sessionId, "paused", "Stopped by user");
			const swarm = this.registry.runtimeSwarm(this.registry.descriptor(sessionId));
			if (swarm?.status === "active") this.updateSwarm(sessionId, "paused", swarmReason);
			// Persist lifecycle transitions before aborting: settlement must never requeue them.
			if (goal || swarm) await this.registry.persist();
			affected = this.registry.state.agents.filter(
				(agent) => agent.agentId === target.agentId || this.ancestor(target.agentId, agent),
			);
			for (const agent of affected) this.fenced.set(agent.agentId, (this.fenced.get(agent.agentId) ?? 0) + 1);
			for (const agent of affected) {
				const run = this.current(agent);
				if (!run) continue;
				const runtime = this.runtime.get(run.runId);
				if (run.status === "queued" && !runtime?.executing) {
					run.status = "cancelled";
					run.settledAt = new Date().toISOString();
					this.permits.delete(run.runId);
					runtime?.resolveDone();
					this.runtime.delete(run.runId);
					await this.notifyCompletion(run);
				} else {
					run.status = "cancelling";
					runtime?.controller.abort();
					if (runtime) idle.push(runtime.done);
				}
				delete run.waitingOnRunIds;
			}
			const ids = new Set(affected.map((agent) => agent.sessionId));
			this.registry.state.pendingInput = this.registry.state.pendingInput.filter(
				(input) => !ids.has(input.sessionId),
			);
			for (const agent of affected) this.registry.clearQueue(agent.sessionId);
			await this.registry.persist();
			for (const waiter of [...this.waiters])
				if (
					(waiter.mode === "any" &&
						waiter.targets.some((id) => terminalStatus[this.assignmentOwner(this.runById(id)).status])) ||
					waiter.targets.every((id) => terminalStatus[this.assignmentOwner(this.runById(id)).status])
				)
					waiter.finish(false);
			for (const agent of affected) this.changed(agent);
			this.pump(target.teamId);
		});
		await Promise.all(idle);
		await Promise.all(affected.map((agent) => this.options.onStopSession?.(agent.sessionId)));
		await this.registry.mutate(async () => {
			for (const agent of affected) {
				const count = (this.fenced.get(agent.agentId) ?? 1) - 1;
				if (count === 0) this.fenced.delete(agent.agentId);
				else this.fenced.set(agent.agentId, count);
			}
			await this.registry.persist();
		});
		return { status: "cancelled" };
	}
	snapshot(workspaceId: string): TeamSnapshot {
		const teams = this.registry.state.teams.filter((team) => team.workspaceId === workspaceId);
		const ids = new Set(teams.map((team) => team.teamId));
		const agents = this.registry.state.agents.filter((agent) => ids.has(agent.teamId));
		const agentIds = new Set(agents.map((agent) => agent.agentId));
		return structuredClone({
			teams,
			agents: agents.map((agent) => {
				const worktree = this.registry.descriptor(agent.sessionId).worktree?.status;
				return {
					...agent,
					currentRun: this.current(agent),
					latestRun: this.latest(agent),
					...(worktree ? { worktree } : {}),
				};
			}),
			runs: this.registry.state.runs.filter((run) => agentIds.has(run.agentId)),
		});
	}
	subscribe(listener: (event: { type: "team_changed"; workspaceId: string }) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private changed(agent: AgentRecord): void {
		this.registry.changed(agent.sessionId);
		const workspaceId = this.registry.descriptor(agent.sessionId).workspaceId;
		for (const listener of this.listeners) listener({ type: "team_changed", workspaceId });
	}
	workOverview(): WorkOverviewItem[] {
		const { agents, runs, sessions, workspaces } = this.registry.state;
		const workspacePaths = new Map(workspaces.map((workspace) => [workspace.id, workspace.path]));
		const sessionAgents = new Map(agents.map((agent) => [agent.sessionId, agent]));
		const latestRuns = new Map(runs.map((run) => [run.agentId, run]));
		const currentRuns = new Map(runs.filter((run) => !terminalStatus[run.status]).map((run) => [run.agentId, run]));
		return sessions
			.map((session): WorkOverviewItem => {
				const agent = sessionAgents.get(session.sessionId);
				const run = agent && (currentRuns.get(agent.agentId) ?? latestRuns.get(agent.agentId));
				return {
					sessionId: session.sessionId,
					workspaceId: session.workspaceId,
					workspacePath: workspacePaths.get(session.workspaceId) ?? "",
					parentSessionId: session.parentSessionId,
					name: session.parentSessionId
						? (agent?.name ?? session.role ?? "担当AI")
						: (session.title ?? run?.task.slice(0, 140) ?? "新しい会話"),
					task: run?.task.slice(0, 220),
					category: agent?.category,
					status: run?.status ?? "idle",
					worktree: session.worktree?.status,
					updatedAt: run?.settledAt ?? run?.startedAt,
				};
			})
			.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
	}

	async agentWork(sessionId: string, op: "diff" | "adopt" | "discard" | "restore" | "sync", callerSessionId?: string) {
		return this.registry.mutate(async () => {
			const target = this.agentForSession(sessionId);
			const caller = callerSessionId ? this.agentForSession(callerSessionId) : undefined;
			if (caller ? target.parentAgentId !== caller.agentId : op !== "diff")
				throw new HarnessError("Only the assigning agent can manage this worktree", 403);
			const descriptor = this.registry.descriptor(sessionId);
			const worktree = descriptor.worktree;
			const service = this.options.agentWorktrees;
			if (!worktree || !service) throw new HarnessError("This agent has no isolated Git worktree", 409);
			if (
				this.current(target) ||
				(op !== "diff" &&
					this.registry.state.agents.some((child) => this.ancestor(target.agentId, child) && this.current(child)))
			)
				throw new HarnessError("Wait for the agent and its delegated work to settle", 409);
			if (op === "diff") {
				const { diff, truncated, changed } = await service.changes(worktree);
				return { status: worktree.status, diff, truncated, changed };
			}
			if (op === "discard" || op === "restore") {
				if (op === "restore" && worktree.status !== "discarded")
					throw new HarnessError("Only discarded work can be restored", 409);
				const previous = worktree.status;
				worktree.status = op === "discard" ? "discarded" : "active";
				const activeSwarm = caller ? this.workspaceSwarm(caller) : undefined;
				if (activeSwarm?.swarm.status === "active") {
					this.recordSwarmEvent(
						activeSwarm.swarm,
						"worktree",
						`${target.name} の変更を${op === "discard" ? "破棄" : "復元"}`,
						caller,
					);
				}
				try {
					await this.registry.persist();
				} catch (error) {
					worktree.status = previous;
					throw error;
				}
				this.changed(target);
				if (activeSwarm?.swarm.status === "active") this.changed(activeSwarm.manager);
				return { status: worktree.status };
			}
			if (op === "sync") {
				if (worktree.status === "discarded")
					throw new HarnessError("Restore discarded work before syncing it", 409);
				if (!caller) throw new HarnessError("Only the assigning agent can sync this worktree", 403);
				const receiving = this.registry.descriptor(caller.sessionId);
				if (receiving.availability !== "ready" || receiving.worktree?.status === "discarded")
					throw new HarnessError("The source workspace is unavailable", 409);
				let synced: Awaited<ReturnType<AgentWorktrees["sync"]>>;
				try {
					synced = await service.sync(worktree, receiving.cwd);
				} catch (error) {
					throw new HarnessError(
						`Could not sync the worktree: ${error instanceof Error ? error.message : String(error)}`,
						409,
					);
				}
				worktree.baseline = synced.baseline;
				if (synced.hadLocalChanges) worktree.status = "active";
				const activeSwarm = this.workspaceSwarm(caller);
				if (synced.updated && activeSwarm?.swarm.status === "active") {
					this.recordSwarmEvent(activeSwarm.swarm, "worktree", `${target.name} の作業ツリーを最新へ同期`, caller);
				}
				await this.registry.persist();
				this.changed(target);
				if (activeSwarm?.swarm.status === "active") this.changed(activeSwarm.manager);
				return { status: worktree.status, updated: synced.updated, hadLocalChanges: synced.hadLocalChanges };
			}
			if (worktree.status === "discarded") throw new HarnessError("Restore discarded work before adopting it", 409);
			if (!caller) throw new HarnessError("Only the assigning agent can adopt this worktree", 403);
			const receiving = this.registry.descriptor(caller.sessionId);
			if (receiving.availability !== "ready" || receiving.worktree?.status === "discarded")
				throw new HarnessError("The receiving workspace is unavailable", 409);
			let result: Awaited<ReturnType<AgentWorktrees["changes"]>>;
			try {
				result = await service.changes(worktree, receiving.cwd);
			} catch (error) {
				throw new HarnessError(
					`Could not adopt the diff: ${error instanceof Error ? error.message : String(error)}`,
					409,
				);
			}
			worktree.baseline = result.baseline;
			worktree.status = "adopted";
			const activeSwarm = this.workspaceSwarm(caller);
			if (result.changed && activeSwarm?.swarm.status === "active") {
				const now = new Date().toISOString();
				for (const check of activeSwarm.swarm.checks ?? []) {
					if (check.status === "passed") {
						check.status = "pending";
						check.summary = "新たな変更を採用したため再検証が必要です";
						check.updatedAt = now;
					}
				}
				this.recordSwarmEvent(activeSwarm.swarm, "worktree", `${target.name} の変更をワークスペースへ採用`, caller);
			}
			const staleAgents = result.changed
				? this.registry.state.agents
						.filter((entry) => {
							if (entry.agentId === target.agentId || entry.parentAgentId !== caller.agentId) return false;
							const entryWorktree = this.registry.descriptor(entry.sessionId).worktree;
							return !!entryWorktree && entryWorktree.status !== "discarded";
						})
						.map((entry) => ({
							agentId: entry.agentId,
							name: entry.name,
							worktree: this.registry.descriptor(entry.sessionId).worktree?.status,
						}))
				: [];
			await this.registry.persist();
			this.changed(target);
			if (activeSwarm?.swarm.status === "active") this.changed(activeSwarm.manager);
			return {
				status: worktree.status,
				changed: result.changed,
				...(staleAgents.length ? { staleAgents } : {}),
			};
		});
	}
	createTool(sessionId: string): ToolDefinition<typeof teamParameters | typeof teamParametersWithoutSwarm> {
		return {
			name: "team",
			label: "Agent team",
			description: `Manage workspace specialists and bounded helpers. Spawn/workflow reuse a manager's existing idle specialist by name across objectives. New specialists require a continuing responsibility separate from task; profiles supply their description. Send consults or assigns work to an existing member and returns results to requesters, including queued senders. Handoff transfers a specialist's current assignment to an idle peer, preserving the original requester; waits follow the new owner. Describe deliberately changes an idle specialist's responsibility as manager. Workflow passes successful prerequisite results and skips dependents of failure. Worktree ops include diff, adopt, discard, restore, and sync. Cannot wait on or stop self or ancestors.${
				this.registry.swarmEnabled
					? " In Hyakki-Yako, use action=board (plan, read, task, post, review, verify) to manage shared tasks with ownedPaths conflict guards, blackboard notes, independent reviews, and real command verification. Complete requires settled worktrees, completed/reviewed board tasks, and passing verification checks."
					: ""
			}`,
			promptSnippet:
				"Manage a durable workspace roster, not task-shaped agents. New specialists need a responsibility describing continuing ownership, separate from task. Inspect list before creating anyone; send work or questions directly to existing members. Specialists choose their own execution and may spawn bounded helpers. Use action=board in Hyakki-Yako to plan tasks with non-overlapping ownedPaths, post shared notes/contracts, record independent reviews, and execute verification checks. Use handoff to transfer your current assignment to an idle specialist. Wait follows ownership transfers.",
			executionMode: "sequential",
			parameters: this.registry.swarmEnabled ? teamParameters : teamParametersWithoutSwarm,
			promptGuidelines: [
				"Completion notices, wait, and workflow give short previews. Use team action result with the runId to read a report, list tool logs (view logs), or read a log by logIndex (view log). Follow nextOffset to read more only when needed.",
				"Each newly spawned agent in a Git workspace works in its own checkout. After it settles, inspect its patch with team action work, op diff, and the agentId. Use op adopt to apply accepted changes to your checkout, op sync to bring another specialist's checkout up to date with adopted changes, discard to park rejected changes, or restore to reconsider a parked patch. Decide and perform these operations yourself. Never ask the user to click a review button for routine acceptance. Adopt prerequisite code before assigning work that must build on it.",
				"In Hyakki-Yako, use action=board op=plan to declare tasks (with ownedPaths, dependsOn, acceptanceCriteria, needsReview) and verification checks, op=task to assign/update progress, op=post to share decisions/contracts/findings, op=review for independent non-author sign-off, and op=verify to execute real verification commands.",
				"Set each spawn/workflow task's category according to its work: orchestration, coding, design, writing, research, strategy, advisor, or other. The category selects the user's configured model and thinking level.",
			],
			execute: async (_callId, params: Static<typeof teamParameters>, signal) => {
				let result: unknown;
				switch (params.action) {
					case "board":
						if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
						switch (params.op) {
							case "read":
								result = await this.boardRead(sessionId);
								break;
							case "plan":
								result = await this.boardPlan(sessionId, {
									tasks: params.tasks,
									checks: params.checks,
									replace: params.replace,
								});
								break;
							case "task":
								result = await this.boardUpdateTask(sessionId, {
									taskId: params.taskId,
									status: params.status,
									ownerAgentId: params.ownerAgentId,
									ownedPaths: params.ownedPaths,
									resultSummary: params.resultSummary,
								});
								break;
							case "post":
								result = await this.boardPostNote(sessionId, {
									kind: params.kind,
									title: params.title,
									body: params.body,
									paths: params.paths,
									taskId: params.taskId,
								});
								break;
							case "review":
								result = await this.boardReviewTask(sessionId, {
									taskId: params.taskId,
									verdict: params.verdict,
									summary: params.summary,
								});
								break;
							case "verify":
								result = await this.boardVerify(
									sessionId,
									{
										checkId: params.checkId,
										name: params.name,
										command: params.command,
										timeoutMs: params.timeoutMs,
									},
									signal,
								);
								break;
						}
						break;
					case "swarm":
						if (!this.registry.swarmEnabled) throw new HarnessError("Hyakki-Yako plugin is disabled", 404);
						result = await this.registry.mutate(async () => {
							const swarm = this.registry.runtimeSwarm(this.registry.descriptor(sessionId));
							const agent = this.agentForSession(sessionId);
							const current = this.current(agent);
							if (agent.parentAgentId || !swarm || !current)
								throw new HarnessError("No active Hyakki-Yako root run", 409);
							if (!params.reason.trim()) throw new HarnessError("Swarm completion or block requires a reason");
							// A plain user prompt to the root is not tagged with the swarm id but still speaks
							// for it. Blocking an already blocked swarm is a no-op rather than an error.
							if (swarm.status !== "active") {
								if (params.op === "block" && swarm.status === "blocked") return structuredClone(swarm);
								throw new HarnessError("Hyakki-Yako is not active", 409);
							}
							if (params.op === "complete") {
								const descendants = this.registry.state.agents.filter((child) =>
									this.ancestor(agent.agentId, child),
								);
								if (descendants.some((child) => this.current(child)))
									throw new HarnessError("Await all delegated work before completing Hyakki-Yako", 409);
								for (const child of descendants) {
									if (child.parentAgentId !== agent.agentId) continue;
									const worktree = this.registry.descriptor(child.sessionId).worktree;
									if (
										worktree?.status === "active" &&
										(await this.options.agentWorktrees?.changes(worktree))?.changed
									)
										throw new HarnessError(
											`Review and adopt or discard ${child.name}'s isolated changes before completing Hyakki-Yako`,
											409,
										);
								}
								const initial = this.registry.state.runs.findIndex((run) => run.runId === swarm.rootRunId);
								if (
									!this.registry.state.runs.some(
										(run, index) =>
											index > initial &&
											run.status === "completed" &&
											!run.handoffToRunId &&
											descendants.some((child) => child.agentId === run.agentId),
									)
								)
									throw new HarnessError("Hyakki-Yako completion requires successful delegated work", 409);
								const tasks = swarm.tasks ?? [];
								if (tasks.length > 0) {
									const unfinished = tasks.filter(
										(task) => task.status !== "done" && task.status !== "cancelled",
									);
									if (unfinished.length > 0)
										throw new HarnessError(
											`Complete or cancel all board tasks before completing Hyakki-Yako: ${unfinished.map((task) => `${task.id} (${task.status})`).join(", ")}`,
											409,
										);
									const unreviewed = tasks.filter(
										(task) =>
											task.status === "done" &&
											task.needsReview &&
											!(task.reviews ?? []).some(
												(review) =>
													review.verdict === "approved" && review.reviewerAgentId !== task.ownerAgentId,
											),
									);
									if (unreviewed.length > 0)
										throw new HarnessError(
											`Tasks require independent approval before completing Hyakki-Yako: ${unreviewed.map((task) => task.id).join(", ")}`,
											409,
										);
								}
								const checks = swarm.checks ?? [];
								if (checks.length > 0) {
									const unpassed = checks.filter((check) => check.status !== "passed");
									if (unpassed.length > 0)
										throw new HarnessError(
											`Run and pass all verification checks before completing Hyakki-Yako: ${unpassed.map((check) => `${check.name} (${check.status})`).join(", ")}`,
											409,
										);
								}
							}
							this.updateSwarm(
								sessionId,
								params.op === "complete" ? "complete" : "blocked",
								params.reason.trim(),
							);
							await this.registry.persist();
							this.changed(agent);
							return structuredClone(swarm);
						});
						break;
					case "spawn":
						result = await this.spawn(sessionId, params.tasks);
						break;
					case "workflow":
						result = await this.workflow(sessionId, params.tasks, params.timeoutMs, signal);
						break;
					case "profiles":
						result = (await this.profiles(sessionId)).map(({ name, description, model, tools }) => ({
							name,
							description,
							model,
							tools,
						}));
						break;
					case "work":
						result = await this.agentWork(this.agentById(params.agentId).sessionId, params.op, sessionId);
						break;
					case "list": {
						const agent = this.agentForSession(sessionId);
						result = {
							agents: this.snapshot(this.registry.descriptor(sessionId).workspaceId)
								.agents.filter((entry) => entry.teamId === agent.teamId)
								.map((entry) => ({
									...entry,
									currentRun: entry.currentRun && {
										...entry.currentRun,
										result: resultPreview(entry.currentRun.result),
										error: resultPreview(entry.currentRun.error),
									},
									latestRun: entry.latestRun && {
										...entry.latestRun,
										result: resultPreview(entry.latestRun.result),
										error: resultPreview(entry.latestRun.error),
									},
									worktree: this.registry.descriptor(entry.sessionId).worktree?.status,
								})),
						};
						break;
					}
					case "result": {
						const caller = this.agentForSession(sessionId);
						const run = this.runById(params.runId);
						const target = this.agentById(run.agentId);
						this.assertTarget(caller, target);
						const offset = params.offset ?? 0;
						if (params.view === "logs") {
							const logs = this.registry.teamRunLogs(target.sessionId, run);
							const page = logs.slice(offset, offset + 20);
							result = {
								runId: run.runId,
								logs: page.map((log, index) => ({
									logIndex: offset + index,
									tool: log.toolName,
									isError: log.isError,
								})),
								nextOffset: offset + page.length < logs.length ? offset + page.length : undefined,
							};
							break;
						}
						let text = [run.result, run.error].filter(Boolean).join("\n\n");
						if (params.view === "log") {
							const log = this.registry.teamRunLogs(target.sessionId, run)[params.logIndex ?? -1];
							if (!log) throw new HarnessError("Tool log not found", 404);
							text = log.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
						}
						let end = Math.min(offset + 2_000, text.length);
						// Keep offsets on UTF-16 character boundaries.
						if (end < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end--;
						result = {
							runId: run.runId,
							status: run.status,
							text: text.slice(offset, end),
							nextOffset: end < text.length ? end : undefined,
						};
						break;
					}
					case "send":
						result = await this.send(sessionId, params.agentId, params.message);
						break;
					case "describe":
						result = await this.describe(sessionId, params.agentId, params.responsibility);
						break;
					case "handoff":
						result = await this.handoff(sessionId, params.agentId, params.task);
						break;
					case "wait":
						result = await this.wait(sessionId, params.agentIds, params.timeoutMs, signal, params.mode);
						break;
					case "stop":
						result = await this.stop(this.agentById(params.agentId).sessionId, sessionId);
						break;
				}
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		};
	}
	async close(): Promise<void> {
		this.accepting = false;
		const roots = this.registry.state.teams.map((team) => this.agentById(team.rootAgentId).sessionId);
		await Promise.all(roots.map((id) => this.stop(id)));
		this.unsubscribe();
	}
}
