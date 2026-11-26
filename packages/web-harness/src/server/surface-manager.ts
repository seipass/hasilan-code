import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AgentSessionEvent, SessionManager, ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { Type } from "typebox";
import type { PrLifecycleSurface } from "../shared/pr-lifecycle.ts";
import {
	type ActionPlanFileChange,
	type ActionPlanStep,
	type ActionPlanSurface,
	type ActionPlanTestCase,
	type ActionPlanTestSummary,
	type ActionPlanToolTrace,
	isSessionSurface,
	type SessionSurface,
	type SplitNoticeSurface,
	type SplitProposalSurface,
	SURFACE_CUSTOM_TYPE,
	type SurfaceAction,
} from "../shared/surfaces.ts";
import { HarnessError } from "./session-registry.ts";

interface PlanWaiter {
	resolve: (result: { approved: boolean; steps: { id: string; title: string }[]; reason?: string }) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function toolTraceTarget(name: string, args: unknown): { label: string; target?: string } {
	const input = asRecord(args);
	if (name === "read") {
		const path = typeof input?.path === "string" ? basename(input.path) : undefined;
		return { label: "Reading", target: path };
	}
	if (name === "edit") {
		const patch = typeof input?.input === "string" ? input.input : "";
		const first = /^\[([^\r\n#]+)#[A-F0-9]{4}\]$/m.exec(patch)?.[1];
		const path = first ? basename(first) : typeof input?.path === "string" ? basename(input.path) : undefined;
		return { label: "Editing", target: path };
	}
	if (name === "write") {
		const path = typeof input?.path === "string" ? basename(input.path) : undefined;
		return { label: "Writing", target: path };
	}
	if (name === "grep" || name === "glob" || name === "find" || name === "web_search") {
		const query =
			typeof input?.pattern === "string"
				? input.pattern
				: typeof input?.query === "string"
					? input.query
					: typeof input?.path === "string"
						? basename(input.path)
						: undefined;
		return { label: "Searching", target: query?.slice(0, 60) };
	}
	if (name === "bash" || name === "shell_process") {
		const cmd = typeof input?.command === "string" ? input.command.trim().split(/\r?\n/, 1)[0] : undefined;
		return { label: "Running", target: cmd?.slice(0, 72) };
	}
	return { label: name };
}

function settledToolLabel(name: string): string {
	switch (name) {
		case "read":
			return "Read";
		case "edit":
			return "Edited";
		case "write":
			return "Created";
		case "grep":
		case "glob":
		case "find":
		case "web_search":
			return "Searched";
		case "bash":
		case "shell_process":
			return "Ran";
		default:
			return name;
	}
}

export function extractStepFileChanges(toolName: string, args: unknown, result: unknown): ActionPlanFileChange[] {
	const input = asRecord(args);
	const res = asRecord(result);
	const details = (res ? asRecord(res.details) : undefined) ?? res;
	const changes: ActionPlanFileChange[] = [];

	const addPatch = (path: string, patch: string, isNew?: boolean) => {
		const added = (patch.match(/^\+(?!\+\+)/gm) ?? []).length;
		const removed = (patch.match(/^-(?!--)/gm) ?? []).length;
		changes.push({ path, added, removed, isNew, patch: patch.slice(0, 16_000) });
	};

	if (toolName === "edit" && typeof details?.diff === "string") {
		const chunks = details.diff.split(/(?=^--- .+\r?\n\+\+\+ .+\r?\n@@ )/m);
		for (const chunk of chunks) {
			const oldPath = /^--- (.+)\r?$/m.exec(chunk)?.[1];
			const newPath = /^\+\+\+ (.+)\r?$/m.exec(chunk)?.[1];
			if (!oldPath || !newPath) continue;
			const targetPath = newPath === "/dev/null" ? oldPath : newPath;
			addPatch(targetPath.replace(/^[ab]\//, ""), chunk.trimEnd(), oldPath === "/dev/null");
		}
	} else if (toolName === "write" && typeof details?.path === "string" && typeof input?.content === "string") {
		const lines = input.content ? input.content.replace(/\n$/, "").split("\n") : [];
		const patch = [
			"--- /dev/null",
			`+++ ${details.path}`,
			`@@ -0,0 +1,${lines.length} @@`,
			...lines.map((line) => `+${line}`),
		].join("\n");
		addPatch(details.path, patch, true);
	}
	return changes;
}

function flattenResultText(result: unknown): string {
	const res = asRecord(result);
	const structured = res ? asRecord(res.structuredContent) : undefined;
	if (typeof structured?.output === "string") return structured.output;
	const content = res && "content" in res ? res.content : result;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const rec = asRecord(part);
				return rec?.type === "text" && typeof rec.text === "string" ? rec.text : "";
			})
			.join("\n");
	}
	return "";
}

export function parseTestSummary(command: string | undefined, output: string): ActionPlanTestSummary | undefined {
	const looksLikeTest =
		(command && /\b(vitest|jest|playwright|pytest|mocha|ava|tap|test)\b/i.test(command)) ||
		/\bTests\s+\d+\s+passed/i.test(output) ||
		/\b\d+\s+passed\b.*\b\d+\s+failed\b/i.test(output);
	if (!looksLikeTest) return undefined;

	let passed = 0;
	let failed = 0;
	let matched = false;

	// Vitest / Jest summary line: "Tests  14 passed (14)" or "Tests: 2 failed, 12 passed, 14 total"
	const vitestLine = /Tests[:\s]+([^\r\n]+)/i.exec(output)?.[1];
	if (vitestLine) {
		const p = /(\d+)\s+passed/i.exec(vitestLine);
		const f = /(\d+)\s+failed/i.exec(vitestLine);
		if (p) {
			passed = Number(p[1]);
			matched = true;
		}
		if (f) {
			failed = Number(f[1]);
			matched = true;
		}
	}

	// Playwright / generic: "12 passed (3.2s)" / "1 failed"
	if (!matched) {
		const p = /\b(\d+)\s+passed\b/i.exec(output);
		const f = /\b(\d+)\s+failed\b/i.exec(output);
		if (p || f) {
			passed = p ? Number(p[1]) : 0;
			failed = f ? Number(f[1]) : 0;
			matched = true;
		}
	}

	// node:test TAP/spec summary: "# pass 10" / "# fail 1"
	if (!matched) {
		const p = /#\s*pass\s+(\d+)/i.exec(output);
		const f = /#\s*fail\s+(\d+)/i.exec(output);
		if (p || f) {
			passed = p ? Number(p[1]) : 0;
			failed = f ? Number(f[1]) : 0;
			matched = true;
		}
	}

	if (!matched || passed + failed === 0) return undefined;

	const cases: ActionPlanTestCase[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (cases.length >= 24) break;
		const passLine = /^\s*[✓✔]\s+(.+?)(?:\s+\((\d+)\s*ms\))?\s*$/.exec(line);
		if (passLine) {
			cases.push({
				name: passLine[1].trim(),
				status: "passed",
				...(passLine[2] ? { durationMs: Number(passLine[2]) } : {}),
			});
			continue;
		}
		const failLine = /^\s*[×✕✗]\s+(.+?)(?:\s+\((\d+)\s*ms\))?\s*$/.exec(line);
		if (failLine) {
			cases.push({
				name: failLine[1].trim(),
				status: "failed",
				...(failLine[2] ? { durationMs: Number(failLine[2]) } : {}),
			});
		}
	}

	return {
		passed,
		failed,
		total: passed + failed,
		...(cases.length > 0 ? { cases } : {}),
	};
}

const actionPlanParameters = Type.Union([
	Type.Object({
		action: Type.Literal("propose"),
		title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		estimatedFiles: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
		steps: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 30 }),
	}),
	Type.Object({
		action: Type.Literal("start_step"),
		surfaceId: Type.Optional(Type.String({ minLength: 1 })),
		stepId: Type.String({ minLength: 1 }),
	}),
	Type.Object({
		action: Type.Literal("complete_step"),
		surfaceId: Type.Optional(Type.String({ minLength: 1 })),
		stepId: Type.String({ minLength: 1 }),
		note: Type.Optional(Type.String({ maxLength: 400 })),
	}),
]);

export interface SurfaceManagerHooks {
	getManager: (sessionId: string) => SessionManager | undefined;
	getRunId: (sessionId: string) => string | undefined;
	onChanged: (sessionId: string) => void;
}

export class SurfaceManager {
	private readonly hooks: SurfaceManagerHooks;
	private readonly sessions = new Map<string, Map<string, SessionSurface>>();
	private readonly waiters = new Map<string, PlanWaiter>();
	private readonly toolArgs = new Map<string, { name: string; args: unknown }>();

	constructor(hooks: SurfaceManagerHooks) {
		this.hooks = hooks;
	}

	restore(sessionId: string, manager: SessionManager): void {
		const map = new Map<string, SessionSurface>();
		for (const entry of manager.getEntries()) {
			if (entry.type === "custom" && entry.customType === SURFACE_CUSTOM_TYPE && isSessionSurface(entry.data)) {
				map.set(entry.data.surfaceId, structuredClone(entry.data));
			}
		}
		if (map.size > 0) this.sessions.set(sessionId, map);
	}

	list(sessionId: string): SessionSurface[] {
		const map = this.sessions.get(sessionId);
		return map ? [...map.values()].map((surface) => structuredClone(surface)) : [];
	}

	get(sessionId: string, surfaceId: string): SessionSurface | undefined {
		return this.sessions.get(sessionId)?.get(surfaceId);
	}

	private upsert(sessionId: string, surface: SessionSurface, persist: boolean): void {
		let map = this.sessions.get(sessionId);
		if (!map) {
			map = new Map();
			this.sessions.set(sessionId, map);
		}
		surface.updatedAt = new Date().toISOString();
		map.set(surface.surfaceId, surface);
		if (persist) {
			const manager = this.hooks.getManager(sessionId);
			manager?.appendCustomEntry(SURFACE_CUSTOM_TYPE, structuredClone(surface));
		}
		this.hooks.onChanged(sessionId);
	}

	private activePlan(sessionId: string, surfaceId?: string): ActionPlanSurface | undefined {
		const map = this.sessions.get(sessionId);
		if (!map) return undefined;
		if (surfaceId) {
			const exact = map.get(surfaceId);
			return exact?.kind === "action_plan" ? exact : undefined;
		}
		const plans = [...map.values()].filter((entry): entry is ActionPlanSurface => entry.kind === "action_plan");
		return plans.findLast((plan) => plan.phase === "executing") ?? plans.at(-1);
	}

	createSplitProposal(
		sessionId: string,
		options: { promptText: string; suggestedTitle: string; branchName: string; explanation: string },
	): SplitProposalSurface {
		const now = new Date().toISOString();
		const surface: SplitProposalSurface = {
			kind: "split_proposal",
			surfaceId: `split-${randomUUID()}`,
			sessionId,
			promptText: options.promptText,
			suggestedTitle: options.suggestedTitle,
			branchName: options.branchName,
			explanation: options.explanation,
			status: "pending",
			createdAt: now,
			updatedAt: now,
		};
		this.upsert(sessionId, surface, true);
		return structuredClone(surface);
	}

	resolveSplitProposal(
		sessionId: string,
		surfaceId: string,
		status: "split" | "kept",
		childSessionId?: string,
	): SplitProposalSurface {
		const existing = this.sessions.get(sessionId)?.get(surfaceId);
		if (!existing || existing.kind !== "split_proposal")
			throw new HarnessError("対象の分割提案が見つかりません。", 404);
		if (existing.status !== "pending") throw new HarnessError("この分割提案はすでに処理されています。", 409);
		existing.status = status;
		if (childSessionId) existing.childSessionId = childSessionId;
		this.upsert(sessionId, existing, true);
		return structuredClone(existing);
	}

	addSplitNotice(
		sessionId: string,
		options: {
			childSessionId: string;
			childTitle: string;
			branchName?: string;
			changedFiles: number;
			status: "completed" | "failed";
		},
	): SplitNoticeSurface {
		const map = this.sessions.get(sessionId);
		const existing = map
			? [...map.values()].find(
					(entry): entry is SplitNoticeSurface =>
						entry.kind === "split_notice" && entry.childSessionId === options.childSessionId,
				)
			: undefined;
		const now = new Date().toISOString();
		const surface: SplitNoticeSurface = existing
			? {
					...existing,
					childTitle: options.childTitle,
					branchName: options.branchName,
					changedFiles: options.changedFiles,
					status: options.status,
					updatedAt: now,
				}
			: {
					kind: "split_notice",
					surfaceId: `notice-${randomUUID()}`,
					sessionId,
					childSessionId: options.childSessionId,
					childTitle: options.childTitle,
					branchName: options.branchName,
					changedFiles: options.changedFiles,
					status: options.status,
					createdAt: now,
					updatedAt: now,
				};
		this.upsert(sessionId, surface, true);
		return structuredClone(surface);
	}

	upsertPrSurface(sessionId: string, surface: PrLifecycleSurface, persist = true): PrLifecycleSurface {
		const copy = structuredClone(surface);
		this.upsert(sessionId, copy, persist);
		return structuredClone(copy);
	}

	getPrSurface(sessionId: string, surfaceId?: string): PrLifecycleSurface | undefined {
		const map = this.sessions.get(sessionId);
		if (!map) return undefined;
		if (surfaceId) {
			const exact = map.get(surfaceId);
			return exact?.kind === "pr_lifecycle" ? structuredClone(exact) : undefined;
		}
		const prSurfaces = [...map.values()].filter(
			(entry): entry is PrLifecycleSurface => entry.kind === "pr_lifecycle",
		);
		const latest = prSurfaces.findLast((entry) => entry.phase !== "merged") ?? prSurfaces.at(-1);
		return latest ? structuredClone(latest) : undefined;
	}

	handleAction(sessionId: string, surfaceId: string, action: SurfaceAction): SessionSurface {
		const existing = this.sessions.get(sessionId)?.get(surfaceId);
		if (!existing) throw new HarnessError("対象のカードが見つかりません。", 404);
		if (existing.kind !== "action_plan") throw new HarnessError("この操作には対応していません。", 400);
		if (action.type !== "approve_plan" && action.type !== "cancel_plan")
			throw new HarnessError("この操作には対応していません。", 400);
		if (existing.phase !== "draft") throw new HarnessError("このプランはすでに確定しています。", 409);

		const waiterKey = `${sessionId}:${surfaceId}`;
		const waiter = this.waiters.get(waiterKey);

		if (action.type === "cancel_plan") {
			existing.phase = "cancelled";
			existing.completedAt = new Date().toISOString();
			this.upsert(sessionId, existing, true);
			if (waiter) {
				this.waiters.delete(waiterKey);
				waiter.resolve({ approved: false, steps: [], reason: action.reason });
			}
			return structuredClone(existing);
		}

		const steps: ActionPlanStep[] = action.steps.map((item, index) => ({
			id: item.id.trim() || `step_${index + 1}`,
			title: item.title.trim(),
			status: "pending",
			tools: [],
			files: [],
		}));
		existing.steps = steps;
		existing.phase = "executing";
		existing.startedAt = new Date().toISOString();
		this.upsert(sessionId, existing, true);
		if (waiter) {
			this.waiters.delete(waiterKey);
			waiter.resolve({
				approved: true,
				steps: steps.map((step) => ({ id: step.id, title: step.title })),
			});
		}
		return structuredClone(existing);
	}

	onExecutionEvent(sessionId: string, event: AgentSessionEvent): void {
		const plan = this.activePlan(sessionId);
		if (!plan || plan.phase !== "executing") {
			if (event.type === "agent_settled") this.settleDraftsOnAbort(sessionId);
			return;
		}

		if (event.type === "tool_execution_start") {
			if (event.toolName === "action_plan") return;
			this.toolArgs.set(`${sessionId}:${event.toolCallId}`, { name: event.toolName, args: event.args });
			const step =
				plan.steps.find((entry) => entry.id === plan.activeStepId) ??
				plan.steps.find((entry) => entry.status === "pending");
			if (!step) return;
			if (step.status === "pending") {
				step.status = "active";
				plan.activeStepId = step.id;
			}
			const { label, target } = toolTraceTarget(event.toolName, event.args);
			const trace: ActionPlanToolTrace = {
				callId: event.toolCallId,
				name: event.toolName,
				label,
				target,
				status: "running",
			};
			step.tools.push(trace);
			this.upsert(sessionId, plan, false);
			return;
		}

		if (event.type === "tool_execution_end") {
			if (event.toolName === "action_plan") return;
			const recorded = this.toolArgs.get(`${sessionId}:${event.toolCallId}`);
			this.toolArgs.delete(`${sessionId}:${event.toolCallId}`);
			const step =
				plan.steps.find((entry) => entry.tools.some((tool) => tool.callId === event.toolCallId)) ??
				plan.steps.find((entry) => entry.id === plan.activeStepId);
			if (!step) return;
			const trace = step.tools.find((tool) => tool.callId === event.toolCallId);
			if (trace) {
				trace.status = event.isError ? "error" : "success";
				trace.label = settledToolLabel(event.toolName);
			}
			if (!event.isError) {
				const changes = extractStepFileChanges(event.toolName, recorded?.args, event.result);
				let totalAdded = 0;
				let totalRemoved = 0;
				for (const change of changes) {
					totalAdded += change.added;
					totalRemoved += change.removed;
					const existingFile = step.files.find((entry) => entry.path === change.path);
					if (existingFile) {
						existingFile.added += change.added;
						existingFile.removed += change.removed;
						existingFile.patch = `${existingFile.patch}\n${change.patch}`.slice(0, 24_000);
					} else {
						step.files.push(change);
					}
				}
				if (trace && (totalAdded > 0 || totalRemoved > 0)) {
					trace.added = totalAdded;
					trace.removed = totalRemoved;
				}
				if (event.toolName === "bash" || event.toolName === "shell_process") {
					const argsRecord = asRecord(recorded?.args);
					const cmd = typeof argsRecord?.command === "string" ? argsRecord.command : undefined;
					const summary = parseTestSummary(cmd, flattenResultText(event.result));
					if (summary) step.tests = summary;
				}
			}
			this.upsert(sessionId, plan, false);
			return;
		}

		if (event.type === "agent_settled") {
			for (const step of plan.steps) {
				for (const trace of step.tools) {
					if (trace.status === "running") trace.status = event.aborted ? "error" : "success";
				}
				if (step.status === "active") {
					step.status = event.aborted ? "pending" : "completed";
				}
			}
			if (!event.aborted) {
				const allDone = plan.steps.every((step) => step.status === "completed" || step.status === "skipped");
				if (allDone) {
					plan.phase = "completed";
					plan.completedAt = new Date().toISOString();
					plan.activeStepId = undefined;
				}
			}
			this.upsert(sessionId, plan, true);
		}
	}

	private settleDraftsOnAbort(sessionId: string): void {
		const map = this.sessions.get(sessionId);
		if (!map) return;
		for (const surface of map.values()) {
			if (surface.kind === "action_plan" && surface.phase === "draft") {
				const key = `${sessionId}:${surface.surfaceId}`;
				const waiter = this.waiters.get(key);
				if (waiter) {
					this.waiters.delete(key);
					surface.phase = "cancelled";
					surface.completedAt = new Date().toISOString();
					this.upsert(sessionId, surface, true);
					waiter.resolve({ approved: false, steps: [], reason: "Execution stopped" });
				}
			}
		}
	}

	createActionPlanTool(sessionId: string): ToolDefinition {
		return {
			name: "action_plan",
			label: "Action Plan",
			description:
				"Propose an interactive editable action plan for user approval before editing files, then mark each approved step as started and completed while executing.",
			parameters: actionPlanParameters,
			execute: async (toolCallId, rawParams, signal) => {
				const params = rawParams as
					| { action: "propose"; title?: string; estimatedFiles?: number; steps: string[] }
					| { action: "start_step"; surfaceId?: string; stepId: string }
					| { action: "complete_step"; surfaceId?: string; stepId: string; note?: string };

				if (params.action === "propose") {
					const surfaceId = `plan-${randomUUID()}`;
					const surface: ActionPlanSurface = {
						kind: "action_plan",
						surfaceId,
						sessionId,
						runId: this.hooks.getRunId(sessionId),
						anchorCallId: toolCallId,
						phase: "draft",
						title: params.title?.trim() || undefined,
						estimatedFiles: params.estimatedFiles ?? 0,
						steps: params.steps.map((title, index) => ({
							id: `step_${index + 1}`,
							title: title.trim(),
							status: "pending",
							tools: [],
							files: [],
						})),
						updatedAt: new Date().toISOString(),
					};
					this.upsert(sessionId, surface, true);

					const key = `${sessionId}:${surfaceId}`;
					const decision = await new Promise<{
						approved: boolean;
						steps: { id: string; title: string }[];
						reason?: string;
					}>((resolve) => {
						const onAbort = () => {
							if (!this.waiters.has(key)) return;
							this.waiters.delete(key);
							surface.phase = "cancelled";
							surface.completedAt = new Date().toISOString();
							this.upsert(sessionId, surface, true);
							resolve({ approved: false, steps: [], reason: "Aborted" });
						};
						if (signal?.aborted) {
							onAbort();
							return;
						}
						signal?.addEventListener("abort", onAbort, { once: true });
						this.waiters.set(key, {
							resolve: (value) => {
								signal?.removeEventListener("abort", onAbort);
								resolve(value);
							},
						});
					});

					if (!decision.approved) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										status: "cancelled",
										surfaceId,
										reason: decision.reason ?? "User cancelled the plan",
									}),
								},
							],
							details: { surfaceId, status: "cancelled" },
						};
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									status: "approved",
									surfaceId,
									steps: decision.steps,
									instruction:
										"Execute the approved steps strictly in order (including any steps added or edited by the user). Call action_plan start_step before each step and action_plan complete_step after each step.",
								}),
							},
						],
						details: { surfaceId, status: "approved", steps: decision.steps },
					};
				}

				const plan = this.activePlan(sessionId, params.surfaceId);
				if (!plan) {
					return {
						content: [{ type: "text", text: "No active action plan found in this session." }],
						details: { error: "not_found" },
					};
				}
				const step = plan.steps.find((entry) => entry.id === params.stepId);
				if (!step) {
					return {
						content: [{ type: "text", text: `Step ${params.stepId} not found in plan ${plan.surfaceId}.` }],
						details: { error: "step_not_found" },
					};
				}

				if (params.action === "start_step") {
					for (const candidate of plan.steps) {
						if (candidate.status === "active" && candidate.id !== step.id) {
							candidate.status = "completed";
						}
					}
					step.status = "active";
					plan.activeStepId = step.id;
					this.upsert(sessionId, plan, true);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ status: "started", surfaceId: plan.surfaceId, stepId: step.id }),
							},
						],
						details: { surfaceId: plan.surfaceId, stepId: step.id, status: "active" },
					};
				}

				step.status = "completed";
				if (params.note?.trim()) step.note = params.note.trim();
				if (plan.activeStepId === step.id) plan.activeStepId = undefined;
				if (plan.steps.every((entry) => entry.status === "completed" || entry.status === "skipped")) {
					plan.phase = "completed";
					plan.completedAt = new Date().toISOString();
				}
				this.upsert(sessionId, plan, true);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								status: "completed",
								surfaceId: plan.surfaceId,
								stepId: step.id,
								planCompleted: plan.phase === "completed",
							}),
						},
					],
					details: { surfaceId: plan.surfaceId, stepId: step.id, planCompleted: plan.phase === "completed" },
				};
			},
		};
	}

	closeSession(sessionId: string): void {
		this.settleDraftsOnAbort(sessionId);
		this.sessions.delete(sessionId);
	}

	close(): void {
		for (const sessionId of [...this.sessions.keys()]) this.closeSession(sessionId);
	}
}
