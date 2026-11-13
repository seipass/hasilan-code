import { type ExtensionFactory, truncateMiddle } from "@hasilan-code/pi-coding-agent";

const TOOL_TEXT_BYTES = 12 * 1024;

/** Shorten the model's copy after the original tool result has been persisted. */
export const limitToolContext: ExtensionFactory = (pi) => {
	pi.on("turn_end", (event) => {
		if (event.toolResultEntryIds.length === 0) return;
		const targets = new Set(event.toolResultEntryIds);
		const entries = event.context.contextEntries.flatMap(({ sourceEntry, messages }) => {
			if (!targets.has(sourceEntry.id)) return [];
			const message = messages[0];
			if (message?.role !== "toolResult") return [];
			const total = message.content.reduce(
				(bytes, block) => bytes + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
				0,
			);
			if (total <= TOOL_TEXT_BYTES) return [];
			const content = message.content.map((block) =>
				block.type === "text"
					? {
							...block,
							text: truncateMiddle(
								block.text,
								Math.floor((Buffer.byteLength(block.text) * TOOL_TEXT_BYTES) / total),
							).content,
						}
					: block,
			);
			return [{ type: "context_edit" as const, targetId: sourceEntry.id, replacement: { content } }];
		});
		if (entries.length > 0) return { entries };
	});
};
