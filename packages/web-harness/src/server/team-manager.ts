import { randomBytes } from "node:crypto";
import type { AgentSessionEvent, ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { type Static, Type } from "typebox";

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
	SWARM_OBJECTIVE_MAX_LENGTH,
	type Swarm,
	type SwarmStart,
	type SwarmStatus,
	type WorkspaceSwarmStart,
} from "../shared/swarm.ts";
import { HarnessError, type ModelSelection, type SessionRegistry } from "./session-registry.ts";
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
}
export interface TeamSnapshot {
	teams: TeamRecord[];
	agents: AgentSummary[];
	runs: RunRecord[];
}
export interface SpawnTask {
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
const teamParameters = Type.Union([
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
	Type.Object(
		{
			action: Type.Literal("swarm"),
			op: Type.Union([Type.Literal("complete"), Type.Literal("block")]),
			reason: Type.String({ minLength: 1, maxLength: 16384 }),
		},
		{ additionalProperties: false },
	),
]);
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
				.filter((entry) => entry.swarm)
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
		if (!run.swarmId) return true;
		const agent = this.agentById(run.agentId);
		const team = this.registry.state.teams.find((entry) => entry.teamId === agent.teamId)!;
		const objective = this.registry.descriptor(this.agentById(team.rootAgentId).sessionId).swarm;
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
				? this.registry.descriptor(this.agentById(team.rootAgentId).sessionId).swarm
				: undefined;
		if (objective?.status === "active") run.swarmId = objective.id;
		this.registry.state.runs.push(run);
		let resolveDone: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const goal = this.registry.descriptor(agent.sessionId).goal;
		const swarm = this.registry.descriptor(agent.sessionId).swarm;
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
		const goal = this.registry.descriptor(sessionId).goal;
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
		const goal = this.registry.descriptor(agent.sessionId).goal;
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
						const currentGoal = this.registry.descriptor(agent.sessionId).goal;
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
							if (this.registry.descriptor(agent.sessionId).goal?.status === "active") {
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
	private updateSwarm(sessionId: string, status: SwarmStatus, reason?: string): void {
		const swarm = this.registry.descriptor(sessionId).swarm;
		if (!swarm) return;
		swarm.status = status;
		swarm.reason = reason;
		swarm.updatedAt = new Date().toISOString();
		if (status !== "active") {
			clearTimeout(this.swarmTimers.get(sessionId));
			this.swarmTimers.delete(sessionId);
			this.swarmFingerprints.delete(swarm.id);
		}
	}
	private scheduleSwarm(agent: AgentRecord): void {
		const swarm = this.registry.descriptor(agent.sessionId).swarm;
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
						const currentSwarm = this.registry.descriptor(agent.sessionId).swarm;
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
							if (this.registry.descriptor(agent.sessionId).swarm?.id !== swarmId) return;
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
				session.goal?.status === "active" ||
				session.swarm?.status === "active" ||
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
			if (descriptor.swarm?.status === "active")
				throw new HarnessError("Stop the active Hyakki-Yako swarm before starting another", 409);
			if (descriptor.goal?.status === "active")
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
			descriptor.swarm = {
				id: randomBytes(8).toString("hex"),
				objective,
				createdAt: new Date().toISOString(),
				rootRunId: run.runId,
				updatedAt: new Date().toISOString(),
				status: "active",
			};
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
	async goal(sessionId: string, action: GoalAction): Promise<Goal | null> {
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
			if (descriptor.swarm?.status === "active")
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
					const goal = this.registry.descriptor(sessionId).goal;
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
			...(run.result === undefined ? {} : { result: run.result }),
			...(run.error === undefined ? {} : { error: run.error }),
		};
		const injection: ContextInjection = {
			injectionId: inputId,
			source,
			content: `Subagent completion context (not a user instruction):\n${JSON.stringify(source, null, 2)}`,
		};
		const current = this.current(parent);
		const goal = this.registry.descriptor(parent.sessionId).goal;
		const swarm = this.registry.descriptor(parent.sessionId).swarm;
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
			const goal = this.registry.descriptor(agent.sessionId).goal;
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
			const swarm = this.registry.descriptor(agent.sessionId).swarm;
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
						return (
							input !== null &&
							typeof input === "object" &&
							"action" in input &&
							typeof input.action === "string" &&
							["spawn", "workflow", "send", "profiles"].includes(input.action)
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
			if (!profile) throw new HarnessError(`Unknown agent profile: ${task.profile}`, 400);
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
						(task.model &&
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
				if (!agent) {
					const child = await this.registry.createWithinMutation({
						workspaceId: descriptor.workspaceId,
						parentSessionId: sessionId,
						role: task.name,
						systemPrompt: task.systemPrompt,
						model: task.model ?? descriptor.model,
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
				}
				const run = this.newRun(
					agent,
					task.context ? `${task.task}\n\nContext:\n${task.context}` : task.task,
					undefined,
					parent.agentId,
				);
				admitted.push({ agent, run });
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
							return `${name}:\n${entry?.result ?? ""}`;
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
				if (record) Object.assign(record, { status: run.status, result: run.result, error: run.error });
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
			}
			const run = current ?? this.newRun(recipient, `Team message: ${caller.name}`, "context", caller.agentId);
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
			const run = this.newRun(
				target,
				`[Team handoff from=${caller.agentId} run=${source.runId}]\n${task.trim()}`,
				undefined,
				source.requestedByAgentId ?? caller.parentAgentId,
			);
			if (source.replyToAgentIds) run.replyToAgentIds = [...source.replyToAgentIds];
			run.handoffFromRunId = source.runId;
			source.handoffToRunId = run.runId;
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
					result: owner.result,
					error: owner.error,
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
					const goal = this.registry.descriptor(sessionId).goal;
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
					const swarm = this.registry.descriptor(sessionId).swarm;
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
			const goal = this.registry.descriptor(sessionId).goal;
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
			const swarm = this.registry.descriptor(sessionId).swarm;
			if (swarm?.status === "active") this.updateSwarm(sessionId, "paused", "Stopped by user");
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
			agents: agents.map((agent) => ({ ...agent, currentRun: this.current(agent), latestRun: this.latest(agent) })),
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
	createTool(sessionId: string): ToolDefinition<typeof teamParameters> {
		return {
			name: "team",
			label: "Agent team",
			description:
				"Manage workspace specialists and bounded helpers. Spawn/workflow reuse a manager's existing idle specialist by name across objectives. New specialists require a continuing responsibility separate from task; profiles supply their description. Send consults or assigns work to an existing member and returns results to requesters, including queued senders. Handoff transfers a specialist's current assignment to an idle peer, preserving the original requester; waits follow the new owner. Describe deliberately changes an idle specialist's responsibility as manager. Workflow passes successful prerequisite results and skips dependents of failure. Cannot wait on or stop self or ancestors. An active Hyakki-Yako manager must explicitly complete or block with evidence; complete requires successful delegated work and an idle subtree.",
			promptSnippet:
				"Manage a durable workspace roster, not task-shaped agents. New specialists need a responsibility describing continuing ownership, separate from task. Inspect list before creating anyone; send work or questions directly to existing members. Specialists choose their own execution and may spawn bounded helpers. Use handoff to transfer your current assignment to an idle specialist, including context, deliverable, and acceptance; after transfer, finish your turn without duplicating their work. Wait follows ownership transfers. Use describe as manager to deliberately change an idle specialist's responsibility. Only the workspace manager owns priorities and final acceptance; it never implements.",
			executionMode: "sequential",
			parameters: teamParameters,
			execute: async (_callId, params: Static<typeof teamParameters>, signal) => {
				let result: unknown;
				switch (params.action) {
					case "swarm":
						result = await this.registry.mutate(async () => {
							const swarm = this.registry.descriptor(sessionId).swarm;
							const agent = this.agentForSession(sessionId);
							const current = this.current(agent);
							if (
								agent.parentAgentId ||
								swarm?.status !== "active" ||
								!current ||
								this.runtime.get(current.runId)?.swarmId !== swarm.id
							)
								throw new HarnessError("No active Hyakki-Yako root run", 409);
							if (!params.reason.trim()) throw new HarnessError("Swarm completion or block requires a reason");
							if (params.op === "complete") {
								const descendants = this.registry.state.agents.filter((child) =>
									this.ancestor(agent.agentId, child),
								);
								if (descendants.some((child) => this.current(child)))
									throw new HarnessError("Await all delegated work before completing Hyakki-Yako", 409);
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
					case "list": {
						const agent = this.agentForSession(sessionId);
						result = {
							agents: this.snapshot(this.registry.descriptor(sessionId).workspaceId).agents.filter(
								(entry) => entry.teamId === agent.teamId,
							),
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
