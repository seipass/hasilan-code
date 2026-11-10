import type { ToolCall } from "./types.ts";

export interface FileChangeSummary {
	path: string;
	patches: string[];
	added: number;
	removed: number;
	truncated: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect only recorded successful file-tool results; shell commands have no reliable per-turn diff. */
export function fileChanges(tools: ToolCall[], runId: string): FileChangeSummary[] {
	const files = new Map<string, FileChangeSummary>();
	const add = (path: string, patch: string) => {
		const file = files.get(path) ?? { path, patches: [], added: 0, removed: 0, truncated: false };
		file.patches.push(patch);
		file.added += (patch.match(/^\+(?!\+\+)/gm) ?? []).length;
		file.removed += (patch.match(/^-(?!--)/gm) ?? []).length;
		file.truncated ||= patch.includes("[Diff truncated]");
		files.set(path, file);
	};
	for (const tool of tools) {
		if (tool.runId !== runId || tool.status !== "success") continue;
		const result = object(tool.result) ? tool.result : undefined;
		const details = result && object(result.details) ? result.details : result;
		const input = object(tool.input) ? tool.input : undefined;
		if (tool.name === "edit" && typeof details?.diff === "string") {
			const chunks = details.diff.split(/(?=^--- .+\r?\n\+\+\+ .+\r?\n@@ )/m);
			for (const chunk of chunks) {
				const path = /^--- (.+)\r?$/m.exec(chunk)?.[1];
				if (path && /^\+\+\+ .+\r?$/m.test(chunk)) add(path, chunk.trimEnd());
			}
		} else if (tool.name === "write" && typeof details?.path === "string" && typeof input?.content === "string") {
			const lines = input.content ? input.content.replace(/\n$/, "").split("\n") : [];
			add(
				details.path,
				[
					`--- /dev/null`,
					`+++ ${details.path}`,
					`@@ -0,0 +1,${lines.length} @@`,
					...lines.map((line) => `+${line}`),
				].join("\n"),
			);
		}
	}
	return [...files.values()];
}
