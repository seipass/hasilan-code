export interface WorkspaceOpenPr {
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft?: boolean;
}

export interface WorkspaceGitSummary {
	isGitRepo: boolean;
	branch?: string;
	baseBranch?: string;
	headSha?: string;
	headSubject?: string;
	filesChanged: number;
	additions: number;
	deletions: number;
	aheadCommits: number;
	hasRemote: boolean;
	openPr?: WorkspaceOpenPr;
}

export interface PrCommitNode {
	sha: string;
	shortSha: string;
	parents: string[];
	lane: 0 | 1 | 2;
	branchRefs: string[];
	author: string;
	relativeTime: string;
	subject: string;
	isMerge?: boolean;
	isProjectedMerge?: boolean;
	isUncommitted?: boolean;
	conflictCount?: number;
	conflictsResolved?: boolean;
}

export interface PrConflictEntry {
	id: string;
	file: string;
	line?: number;
	theirsAuthor?: string;
	theirsCommitSha?: string;
	theirsText: string;
	oursText: string;
	resolved: boolean;
}

export interface PrCiCheckFailure {
	file?: string;
	line?: number;
	testTitle?: string;
	expected?: string;
	received?: string;
	excerpt?: string;
}

export type PrCiCheckStatus = "queued" | "in_progress" | "completed";
export type PrCiCheckConclusion =
	| "success"
	| "failure"
	| "neutral"
	| "cancelled"
	| "skipped"
	| "timed_out"
	| "action_required";

export interface PrCiCheck {
	id: string;
	name: string;
	status: PrCiCheckStatus;
	conclusion?: PrCiCheckConclusion;
	startedAt?: string;
	completedAt?: string;
	durationSec?: number;
	detail?: string;
	url?: string;
	failure?: PrCiCheckFailure;
}

export type PrLifecyclePhase =
	| "committing"
	| "pushing"
	| "opening"
	| "fetching"
	| "checking"
	| "conflicts"
	| "resolving"
	| "checks_running"
	| "check_failed"
	| "fixing"
	| "ready"
	| "merging"
	| "merged"
	| "error";

export type PrViewMode = "inline" | "docked_collapsed" | "docked_expanded";

export interface PrLifecycleSurface {
	kind: "pr_lifecycle";
	surfaceId: string;
	sessionId: string;
	viewMode: PrViewMode;
	phase: PrLifecyclePhase;
	title: string;
	headBranch: string;
	baseBranch: string;
	headSha?: string;
	headSubject?: string;
	prNumber?: number;
	prUrl?: string;
	statusNote?: string;
	error?: string;
	fixingCheckName?: string;
	filesChanged: number;
	additions: number;
	deletions: number;
	commits: PrCommitNode[];
	conflicts: PrConflictEntry[];
	checks: PrCiCheck[];
	checksStartedAt?: string;
	mergedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export function isFailedCheck(check: PrCiCheck): boolean {
	return (
		check.status === "completed" &&
		(check.conclusion === "failure" || check.conclusion === "timed_out" || check.conclusion === "action_required")
	);
}

export function isPassedCheck(check: PrCiCheck): boolean {
	return (
		check.status === "completed" &&
		(check.conclusion === "success" || check.conclusion === "neutral" || check.conclusion === "skipped")
	);
}
