export interface McpContextEntry {
	name: string;
	tokens: number;
}

export interface ContextBreakdown {
	contextWindow: number;
	autoCompactThreshold: number;
	totalTokens: number;
	percent: number;
	systemTokens: number;
	mcpTokens: number;
	mcpServers: McpContextEntry[];
	mcpInstructionsTokens: number;
	skillsTokens: number;
	skillsCount: number;
	messagesTokens: number;
	messageCount: number;
	/** Proportional token weights of messages/tool-results (capped at 36 buckets for compaction visuals). */
	messageSegments: number[];
	reservedTokens: number;
	freeTokens: number;
	untilAutoCompact: number;
}

export interface CompactionSummaryResponse {
	tokensBefore: number;
	tokensAfter: number;
	freedTokens: number;
	summary: string;
}
