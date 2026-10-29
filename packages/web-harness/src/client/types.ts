import type { ThinkingLevel } from "@hasilan-code/pi-agent-core";
import type { PromptAttachment } from "../shared/attachments.ts";
import type { ComputerStatus } from "../shared/computer.ts";
import type { Goal } from "../shared/goals.ts";
import type { HistoryMessage, HistoryPosition, HistoryTool } from "../shared/session-history.ts";
import type { Swarm } from "../shared/swarm.ts";
import type { ModelUsage } from "../shared/usage.ts";
import type { JevStatus } from "../shared/workspace-routing.ts";

export interface Workspace {
	workspaceId: string;
	path: string;
}
export type RunStatus =
	| "queued"
	| "running"
	| "waiting"
	| "cancelling"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";
export interface Run {
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
export interface Model {
	provider: string;
	id: string;
	name?: string;
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
	completionRunId?: string;
	manageable: boolean;
}
export type PendingInputAction = { type: "edit"; text: string } | { type: "delete" } | { type: "sendNow" };
export interface SessionSummary {
	sessionId: string;
	title?: string;
	workspaceId: string;
	cwd: string;
	parentSessionId?: string;
	role?: string;
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	materialized: boolean;
	availability: "ready" | "missing";
	currentRun?: Run;
	latestRun?: Run;
	pendingInput: PendingInput[];
	goal?: Goal;
	swarm?: Swarm;
	usage?: ModelUsage[];
}
export type ChatMessage = HistoryMessage;
export type ToolCall = HistoryTool;
export interface SessionDetail extends SessionSummary {
	history?: HistoryPosition;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	messages: ChatMessage[];
	toolCalls: ToolCall[];
	activity: { queue?: { steering: string[]; followUp: string[] }; retry?: unknown; compaction?: unknown };
}
export interface TeamAgent {
	agentId: string;
	teamId: string;
	parentAgentId?: string;
	sessionId: string;
	name: string;
	role: string;
	responsibility?: string;
	currentRun?: Run;
	latestRun?: Run;
}
export interface TeamSnapshot {
	teams: { teamId: string; rootAgentId: string; workspaceId: string; scope?: "workspace" }[];
	agents: TeamAgent[];
	runs: Run[];
}
export interface WorkspaceProjection {
	sessions: SessionSummary[];
	teams: TeamSnapshot;
}
export interface Settings {
	jev?: JevStatus;
	jevComputer?: { textModel: Model };
	search: {
		defaultProvider: "brave" | "tavily" | "exa" | "firecrawl";
		configured: { brave: boolean; tavily: boolean; exa: boolean; firecrawl: boolean };
	};
	teams: { maxConcurrentAgents: number; maxDepth: number };
	browser?: { ready: boolean; error?: string };
	computer?: ComputerStatus;
}
export interface ModelCatalog {
	classifiers?: Model[];
	providers: { id: string; name: string; configured?: boolean; oauth?: { label: string }; apiKey?: boolean }[];
	models: (Model & { contextWindow: number; thinkingLevels?: ThinkingLevel[] })[];
}
