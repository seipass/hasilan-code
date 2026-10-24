export interface ContextInjection {
	injectionId: string;
	content: string;
	source:
		| {
				type: "subagent_completion";
				agentId: string;
				agentName: string;
				runId: string;
				status: "completed" | "failed" | "cancelled";
				result?: string;
				error?: string;
		  }
		| {
				type: "team_message";
				agentId: string;
				agentName: string;
				runId?: string;
				status?: never;
				result?: never;
				error?: never;
		  };
}

export const CONTEXT_INJECTION_CUSTOM_TYPE = "context-injection";

export function isContextInjection(value: unknown): value is ContextInjection {
	if (
		!value ||
		typeof value !== "object" ||
		!("injectionId" in value) ||
		typeof value.injectionId !== "string" ||
		!("content" in value) ||
		typeof value.content !== "string" ||
		!("source" in value)
	)
		return false;
	const source = value.source;
	return (
		!!source &&
		typeof source === "object" &&
		"type" in source &&
		(source.type === "subagent_completion" || source.type === "team_message") &&
		"agentId" in source &&
		typeof source.agentId === "string" &&
		"agentName" in source &&
		typeof source.agentName === "string" &&
		(source.type === "team_message"
			? (!("runId" in source) || source.runId === undefined || typeof source.runId === "string") &&
				!("status" in source) &&
				!("result" in source) &&
				!("error" in source)
			: "runId" in source &&
				typeof source.runId === "string" &&
				"status" in source &&
				(source.status === "completed" || source.status === "failed" || source.status === "cancelled")) &&
		(!("result" in source) || source.result === undefined || typeof source.result === "string") &&
		(!("error" in source) || source.error === undefined || typeof source.error === "string")
	);
}
