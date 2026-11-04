import type { ReactNode } from "react";
import { Content, record } from "../Content.tsx";
import type { ToolCall } from "../types.ts";

export interface ToolDetails {
	input?: Record<string, unknown>;
	details?: Record<string, unknown>;
	result?: Record<string, unknown>;
	/** Plain result text, already flattened from content parts. */
	text: string;
	/** The raw result content, for tools that show it verbatim. */
	content: unknown;
	status: ToolCall["status"];
	onFile: (path: string, line?: number) => void;
}

/** What one tool renders above and inside its body. Tools only supply their own two slots. */
export interface ToolView {
	/** Short facts shown as chips: exit code, line counts, tab, monitor. */
	meta?: ReactNode;
	/** The main payload: diff, output, screenshots, result rows. */
	body?: ReactNode;
	/** Extra collapsible blocks that belong after the body. */
	extra?: ReactNode;
	/** Replace the default result rendering entirely (for tools that render their own). */
	handlesResult?: boolean;
}

export function flattenContent(content: unknown): string {
	if (Array.isArray(content))
		return content
			.map((part: unknown) => (record(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
			.join("\n");
	return typeof content === "string" ? content : "";
}

export function MetaChips({ items }: { items: (string | number | undefined | false)[] }) {
	const shown = items.filter((item): item is string | number => item !== undefined && item !== false && item !== "");
	if (!shown.length) return null;
	return <div className="tool-meta">{shown.map((item, index) => <span key={index}>{item}</span>)}</div>;
}

export function PlainResult({ value, onFile }: { value: unknown; onFile: (path: string, line?: number) => void }) {
	return <div className="tool-plain-result"><Content value={value} onFile={onFile} /></div>;
}
