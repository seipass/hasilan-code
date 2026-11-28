import { type Static, Type } from "typebox";
import { modelSchema, thinkingSchema } from "./contracts.ts";

export const SWARM_OBJECTIVE_MAX_LENGTH = 65536;
export const swarmStartSchema = Type.Object(
	{ objective: Type.String({ minLength: 1, maxLength: SWARM_OBJECTIVE_MAX_LENGTH }) },
	{ additionalProperties: false },
);
export type SwarmStart = Static<typeof swarmStartSchema>;

export const workspaceSwarmStartSchema = Type.Object(
	{
		...swarmStartSchema.properties,
		sessionId: Type.Optional(Type.String({ minLength: 1 })),
		model: Type.Optional(modelSchema),
		thinkingLevel: Type.Optional(thinkingSchema.properties.level),
	},
	{ additionalProperties: false },
);
export type WorkspaceSwarmStart = Static<typeof workspaceSwarmStartSchema>;

export type SwarmStatus = "active" | "paused" | "blocked" | "complete";

export type SwarmTaskStatus = "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
export type SwarmReviewVerdict = "approved" | "changes_requested";
export type SwarmNoteKind = "decision" | "finding" | "contract" | "blocker" | "handoff";
export type SwarmCheckStatus = "pending" | "passed" | "failed";
export type SwarmEventKind =
	| "started"
	| "paused"
	| "resumed"
	| "blocked"
	| "completed"
	| "plan"
	| "task"
	| "note"
	| "review"
	| "verify"
	| "worktree"
	| "handoff"
	| "message";

export const SWARM_TASK_STATUSES: readonly SwarmTaskStatus[] = [
	"todo",
	"in_progress",
	"in_review",
	"done",
	"blocked",
	"cancelled",
];
export const SWARM_REVIEW_VERDICTS: readonly SwarmReviewVerdict[] = ["approved", "changes_requested"];
export const SWARM_NOTE_KINDS: readonly SwarmNoteKind[] = ["decision", "finding", "contract", "blocker", "handoff"];
export const SWARM_CHECK_STATUSES: readonly SwarmCheckStatus[] = ["pending", "passed", "failed"];
export const SWARM_EVENT_KINDS: readonly SwarmEventKind[] = [
	"started",
	"paused",
	"resumed",
	"blocked",
	"completed",
	"plan",
	"task",
	"note",
	"review",
	"verify",
	"worktree",
	"handoff",
	"message",
];

export interface SwarmReview {
	id: string;
	reviewerAgentId: string;
	reviewerName: string;
	verdict: SwarmReviewVerdict;
	summary: string;
	createdAt: string;
}

export interface SwarmTask {
	id: string;
	title: string;
	description?: string;
	status: SwarmTaskStatus;
	ownerAgentId?: string;
	ownerName?: string;
	dependsOn?: string[];
	ownedPaths?: string[];
	acceptanceCriteria?: string[];
	needsReview?: boolean;
	reviews?: SwarmReview[];
	resultSummary?: string;
	updatedAt: string;
}

export interface SwarmBoardNote {
	id: string;
	kind: SwarmNoteKind;
	authorAgentId: string;
	authorName: string;
	title: string;
	body: string;
	paths?: string[];
	taskId?: string;
	createdAt: string;
}

export interface SwarmCheck {
	id: string;
	name: string;
	command: string;
	status: SwarmCheckStatus;
	exitCode?: number;
	summary?: string;
	runByAgentId?: string;
	runByName?: string;
	updatedAt: string;
}

export interface SwarmEvent {
	id: string;
	kind: SwarmEventKind;
	actorAgentId?: string;
	actorName?: string;
	summary: string;
	taskId?: string;
	createdAt: string;
}

export interface SwarmPathConflict {
	taskId: string;
	title: string;
	ownerName?: string;
	requestedPath: string;
	existingPath: string;
}

/** Durable objective lifecycle and shared coordination board; TeamManager remains the execution scheduler. */
export interface Swarm {
	id: string;
	objective: string;
	createdAt: string;
	updatedAt: string;
	status: SwarmStatus;
	reason?: string;
	rootRunId: string;
	tasks?: SwarmTask[];
	notes?: SwarmBoardNote[];
	checks?: SwarmCheck[];
	events?: SwarmEvent[];
}

/** Normalize a workspace-relative path or prefix used for task file-ownership boundaries. */
export function normalizeOwnedPath(raw: string): string {
	let value = raw.trim().replace(/\\/g, "/");
	value = value.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
	value = value.replace(/\/+/g, "/");
	// Strip trailing glob suffix (e.g. "src/api/**" or "src/api/*") to a directory prefix.
	value = value.replace(/(?:\/\*\*?|\/\*)+$/, "").replace(/\/+$/, "");
	if (!value || value === "." || value === "*" || value === "**") {
		throw new Error(`Invalid owned path: ${raw}`);
	}
	const segments = value.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error(`Invalid owned path: ${raw}`);
	}
	return value;
}

/** True when two normalized file/directory ownership boundaries overlap. */
export function ownedPathsOverlap(left: string, right: string): boolean {
	if (left === right) return true;
	return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function findOwnedPathConflicts(
	requestedPaths: readonly string[],
	others: readonly Pick<SwarmTask, "id" | "title" | "ownerName" | "ownedPaths">[],
): SwarmPathConflict[] {
	const conflicts: SwarmPathConflict[] = [];
	for (const requestedPath of requestedPaths) {
		for (const other of others) {
			for (const existingPath of other.ownedPaths ?? []) {
				if (ownedPathsOverlap(requestedPath, existingPath)) {
					conflicts.push({
						taskId: other.id,
						title: other.title,
						ownerName: other.ownerName,
						requestedPath,
						existingPath,
					});
				}
			}
		}
	}
	return conflicts;
}
