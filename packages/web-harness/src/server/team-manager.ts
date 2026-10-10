import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { HarnessError, type ModelSelection, type SessionRegistry } from "./session-registry.ts";

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
}
export interface AgentRecord {
	agentId: string;
	teamId: string;
	parentAgentId?: string;
	sessionId: string;
	name: string;
	role: string;
}
export interface RunRecord {
	runId: string;
	agentId: string;
	task: string;
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
	mode: "steer" | "followUp";
	fromAgentId?: string;
	status: "pending" | "undelivered";
	delivered?: boolean;
}
export interface TeamOptions {
	getLimits?: () => { maxConcurrentAgents: number; maxDepth: number };
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
	context?: string;
	systemPrompt?: string;
	model?: ModelSelection;
	tools?: string[];
}
export interface WaitResult {
	runs: { agentId: string; runId: string; status: RunStatus; result?: string; error?: string }[];
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
}
interface Waiter {
	callerRunId: string;
	targets: string[];
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
const teamParameters = Type.Union([
	Type.Object({
		action: Type.Literal("spawn"),
		tasks: Type.Array(
			Type.Object({
				name: Type.String({ minLength: 1 }),
				task: Type.String({ minLength: 1 }),
				context: Type.Optional(Type.String()),
				systemPrompt: Type.Optional(Type.String()),
				model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
				tools: Type.Optional(Type.Array(Type.String())),
			}),
			{ minItems: 1, maxItems: 32 },
		),
	}),
	Type.Object({ action: Type.Literal("list") }),
	Type.Object({ action: Type.Literal("send"), agentId: Type.String(), message: Type.String({ minLength: 1 }) }),
	Type.Object({
		action: Type.Literal("wait"),
		agentIds: Type.Array(Type.String(), { minItems: 1 }),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300000 })),
	}),
	Type.Object({ action: Type.Literal("stop"), agentId: Type.String() }),
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
			await this.registry.persist();
		});
	}
	private addRoot(sessionId: string): AgentRecord {
		const descriptor = this.registry.descriptor(sessionId);
		const agent: AgentRecord = { agentId: randomUUID(), teamId: randomUUID(), sessionId, name: "Root", role: "root" };
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
	private newRun(agent: AgentRecord, task: string): RunRecord {
		if (this.current(agent)) throw new HarnessError("Session is busy", 409);
		const run: RunRecord = { runId: randomUUID(), agentId: agent.agentId, task, status: "queued" };
		this.registry.state.runs.push(run);
		let resolveDone: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		this.runtime.set(run.runId, { controller: new AbortController(), done, resolveDone, executing: false });
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
			const outcome = await this.registry.execute(agent.sessionId, runId, run.task, runtime.controller.signal);
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
			for (const input of this.registry.state.pendingInput) if (input.runId === runId) input.status = "undelivered";
			await this.registry.persist();
			const agent = this.agentById(run.agentId);
			this.changed(agent);
			for (const waiter of [...this.waiters])
				if (waiter.targets.every((id) => terminalStatus[this.runById(id).status])) waiter.finish(false);
			this.runtime.get(runId)?.resolveDone();
			this.runtime.delete(runId);
			this.pump(agent.teamId);
		});
	}
	async prompt(
		sessionId: string,
		input: { text: string; mode: "prompt" | "steer" | "followUp" },
	): Promise<AdmissionResult> {
		if (!input.text.trim()) throw new HarnessError("Prompt must not be empty");
		await this.ensureRoot(sessionId);
		return this.registry.mutate(async () => {
			const agent = this.agentForSession(sessionId);
			this.assertOpen(agent);
			const current = this.current(agent);
			if (current && input.mode === "prompt") throw new HarnessError("Session is busy; use steer or followUp", 409);
			if (current)
				return this.acceptInput(agent, current, input.text, input.mode === "steer" ? "steer" : "followUp");
			const run = this.newRun(agent, input.text);
			await this.registry.persist();
			this.enqueue(agent.teamId, { runId: run.runId });
			this.pump(agent.teamId);
			this.changed(agent);
			return { runId: run.runId, disposition: run.status === "running" ? "started" : "queued" };
		});
	}
	private async acceptInput(
		agent: AgentRecord,
		run: RunRecord,
		text: string,
		mode: "steer" | "followUp",
		fromAgentId?: string,
		inputId = randomUUID(),
	): Promise<AdmissionResult> {
		const pending: PendingInput = {
			inputId,
			sessionId: agent.sessionId,
			runId: run.runId,
			text,
			mode,
			fromAgentId,
			status: "pending",
			delivered: false,
		};
		this.registry.state.pendingInput.push(pending);
		await this.registry.persist();
		if (this.started.has(run.runId) && run.status !== "queued") {
			await this.registry.deliver(agent.sessionId, text, mode);
			pending.delivered = true;
			await this.registry.persist();
		}
		this.changed(agent);
		return { inputId, runId: run.runId, disposition: run.status === "queued" ? "queued" : "started" };
	}
	async spawn(
		sessionId: string,
		tasks: SpawnTask[],
	): Promise<{ agents: { agentId: string; sessionId: string; runId: string; name: string; status: RunStatus }[] }> {
		if (tasks.length === 0 || tasks.length > 32) throw new HarnessError("Spawn requires 1..32 tasks");
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
			const tools = this.registry.activeTools(sessionId);
			for (const task of tasks) {
				if (!task.name.trim() || !task.task.trim()) throw new HarnessError("Agent name and task must not be empty");
				if (task.tools?.some((tool) => !tools.includes(tool)))
					throw new HarnessError("Child tools must be a subset of the parent's active tools");
			}
			const created: { agent: AgentRecord; run: RunRecord }[] = [];
			for (const task of tasks) {
				const child = await this.registry.createWithinMutation({
					workspaceId: descriptor.workspaceId,
					parentSessionId: sessionId,
					role: task.name,
					systemPrompt: task.systemPrompt,
					model: task.model ?? descriptor.model,
					tools: task.tools ?? tools,
				});
				const agent: AgentRecord = {
					agentId: randomUUID(),
					teamId: parent.teamId,
					parentAgentId: parent.agentId,
					sessionId: child.sessionId,
					name: task.name,
					role: task.name,
				};
				this.registry.state.agents.push(agent);
				const run = this.newRun(agent, task.context ? `${task.task}\n\nContext:\n${task.context}` : task.task);
				created.push({ agent, run });
			}
			await this.registry.persist();
			for (const { run } of created) this.enqueue(parent.teamId, { runId: run.runId });
			this.pump(parent.teamId);
			this.changed(parent);
			return {
				agents: created.map(({ agent, run }) => ({
					agentId: agent.agentId,
					sessionId: agent.sessionId,
					runId: run.runId,
					name: agent.name,
					status: run.status,
				})),
			};
		});
	}
	async send(sessionId: string, agentId: string, message: string): Promise<AdmissionResult> {
		if (!message.trim()) throw new HarnessError("Message must not be empty");
		return this.registry.mutate(async () => {
			const caller = this.agentForSession(sessionId);
			const recipient = this.agentById(agentId);
			this.assertOpen(caller);
			this.assertOpen(recipient);
			this.assertTarget(caller, recipient);
			const inputId = randomUUID();
			const text = `[Team message inputId=${inputId} from=${caller.agentId}]\n${message}`;
			const current = this.current(recipient);
			if (current) return this.acceptInput(recipient, current, text, "followUp", caller.agentId, inputId);
			const run = this.newRun(recipient, text);
			this.registry.state.pendingInput.push({
				inputId,
				sessionId: recipient.sessionId,
				runId: run.runId,
				text,
				mode: "followUp",
				fromAgentId: caller.agentId,
				status: "pending",
				delivered: true,
			});
			await this.registry.persist();
			this.enqueue(recipient.teamId, { runId: run.runId });
			this.pump(recipient.teamId);
			this.changed(recipient);
			return { inputId, runId: run.runId, disposition: run.status === "running" ? "started" : "queued" };
		});
	}
	async wait(sessionId: string, agentIds: string[], timeoutMs = 30000, signal?: AbortSignal): Promise<WaitResult> {
		if (agentIds.length === 0 || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000)
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
			if (pinned.some((run) => reaches(run.runId, callerRun.runId))) throw new HarnessError("Wait dependency cycle");
			if (pinned.every((run) => terminalStatus[run.status])) return;
			callerRun.status = "waiting";
			callerRun.waitingOnRunIds = pinned.map((run) => run.runId);
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
		} finally {
			removeAbortListener();
		}
		return {
			runs: pinned.map((run) => ({
				agentId: run.agentId,
				runId: run.runId,
				status: run.status,
				result: run.result,
				error: run.error,
			})),
			timedOut,
		};
	}
	private onEvent(sessionId: string, event: AgentSessionEvent): void {
		if (event.type !== "agent_start" && !(event.type === "message_end" && event.message.role === "user")) return;
		void this.registry
			.mutate(async () => {
				const agent = this.agentForSession(sessionId);
				const run = this.current(agent);
				if (!run) return;
				if (event.type === "agent_start") {
					this.started.add(run.runId);
					if (this.fenced.has(agent.agentId)) return;
					for (const input of this.registry.state.pendingInput)
						if (input.runId === run.runId && input.status === "pending" && !input.delivered) {
							await this.registry.deliver(sessionId, input.text, input.mode);
							input.delivered = true;
						}
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
					const isInitial = !this.initialConsumed.has(run.runId);
					this.initialConsumed.add(run.runId);
					const index = this.registry.state.pendingInput.findIndex(
						(input) =>
							input.runId === run.runId &&
							input.status === "pending" &&
							(marker
								? input.inputId === marker[1]
								: !isInitial && !input.fromAgentId && input.delivered && input.text === text),
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
				if (waiter.targets.every((id) => terminalStatus[this.runById(id).status])) waiter.finish(false);
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
				"Spawn independent child agents sharing this workspace, list agents, send a message, wait on pinned runs, or stop a child subtree. Waiting releases your team's admission permit until dependencies settle or timeout. Cannot wait on or stop yourself or ancestors.",
			promptSnippet: "Coordinate independent agents and wait for their results.",
			executionMode: "sequential",
			parameters: teamParameters,
			execute: async (_callId, params: Static<typeof teamParameters>, signal) => {
				let result: unknown;
				switch (params.action) {
					case "spawn":
						result = await this.spawn(sessionId, params.tasks);
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
					case "wait":
						result = await this.wait(sessionId, params.agentIds, params.timeoutMs, signal);
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
