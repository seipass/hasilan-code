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
	status: RunStatus;
	result?: string;
	error?: string;
	waitingOnRunIds?: string[];
	startedAt?: number;
	settledAt?: number;
}
export interface Model {
	provider: string;
	id: string;
	name?: string;
}
export interface PendingInput {
	inputId: string;
	text?: string;
	status?: string;
	mode?: string;
}
export interface SessionSummary {
	sessionId: string;
	workspaceId: string;
	cwd: string;
	parentSessionId?: string;
	role?: string;
	model?: Model;
	materialized: boolean;
	availability: "ready" | "missing";
	currentRun?: Run;
	latestRun?: Run;
	pendingInput: PendingInput[];
}
export interface ChatMessage {
	messageId: string;
	role: string;
	content: unknown;
	partial: boolean;
	runId?: string;
}
export interface ToolCall {
	key: string;
	sessionId: string;
	runId?: string;
	callId: string;
	name: string;
	input: unknown;
	result?: unknown;
	status: "running" | "success" | "error" | "cancelled";
}
export interface SessionDetail extends SessionSummary {
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
	currentRun?: Run;
	latestRun?: Run;
}
export interface TeamSnapshot {
	teams: { teamId: string; rootAgentId: string; workspaceId: string }[];
	agents: TeamAgent[];
	runs: Run[];
}
export interface WorkspaceProjection {
	sessions: SessionSummary[];
	teams: TeamSnapshot;
}
export interface Settings {
	search: { defaultProvider: "brave" | "tavily"; configured: { brave: boolean; tavily: boolean } };
	teams: { maxConcurrentAgents: number; maxDepth: number };
	llm: { defaultModel?: Model };
	browser?: { ready: boolean; error?: string };
}
export interface ModelCatalog {
	providers: { id: string; name: string; configured?: boolean }[];
	models: Model[];
}
