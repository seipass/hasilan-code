import type { AgentMessage } from "@hasilan-code/pi-agent-core";
import type { SessionManager } from "@hasilan-code/pi-coding-agent";

const CONTEXT_TYPE = "harness-runtime-context";

/** Runs after SDK request preparation, so compaction and restored branches are already reflected. */
export function appendRuntimeContext(
	manager: SessionManager,
	messages: AgentMessage[],
	sections: readonly string[],
): AgentMessage[] {
	const previous = messages.findLast((message) => message.role === "custom" && message.customType === CONTEXT_TYPE);
	if (sections.length === 0 && !previous) return messages;
	const content = [
		"Current runtime context. This snapshot supersedes all earlier runtime-context snapshots.",
		sections.length
			? sections.join("\n\n")
			: "No Goal or Hyakki-Yako mode is enabled. Earlier mode instructions no longer apply.",
	].join("\n\n");
	if (previous && "content" in previous && previous.content === content) return messages;
	const entryId = manager.appendCustomMessageEntry(CONTEXT_TYPE, content, false);
	const entry = manager.getEntry(entryId);
	if (!entry) throw new Error("Runtime context was not persisted");
	return [
		...messages,
		{ role: "custom", customType: CONTEXT_TYPE, content, display: false, timestamp: Date.parse(entry.timestamp) },
	];
}
