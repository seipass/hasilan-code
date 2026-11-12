import type { AgentCategory } from "./agent-categories.ts";

export interface WorkOverviewItem {
	sessionId: string;
	workspaceId: string;
	workspacePath: string;
	parentSessionId?: string;
	name: string;
	task?: string;
	category?: AgentCategory;
	status:
		| "idle"
		| "queued"
		| "running"
		| "waiting"
		| "cancelling"
		| "completed"
		| "failed"
		| "cancelled"
		| "interrupted";
	worktree?: "active" | "adopted" | "discarded";
	updatedAt?: string;
}

export interface WorkDiff {
	diff: string;
	truncated: boolean;
	changed: boolean;
}
