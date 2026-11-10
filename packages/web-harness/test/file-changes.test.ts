import { describe, expect, it } from "vitest";
import { fileChanges } from "../src/client/file-changes.ts";
import type { ToolCall } from "../src/client/types.ts";

const tool = (values: Partial<ToolCall>): ToolCall => ({
	key: "k",
	sessionId: "s",
	runId: "r",
	callId: "c",
	name: "edit",
	input: {},
	status: "success",
	...values,
});

describe("file change summaries", () => {
	it("collects multiple files, repeated edits and creations for the requested run", () => {
		const changes = fileChanges(
			[
				tool({
					result: {
						details: {
							diff: "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n\n--- b.ts\n+++ b.ts\n@@ -1,0 +1,1 @@\n+hello",
						},
					},
				}),
				tool({ result: { details: { diff: "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-new\n+newer" } } }),
				tool({
					name: "write",
					input: { path: "c.ts", content: "one\ntwo\n" },
					result: { details: { path: "c.ts" } },
				}),
				tool({ runId: "other", result: { details: { diff: "--- other\n+++ other\n@@ -0,0 +1,1 @@\n+bad" } } }),
				tool({ status: "error", result: { details: { diff: "--- failed\n+++ failed\n@@ -0,0 +1,1 @@\n+bad" } } }),
			],
			"r",
		);
		expect(
			changes.map(({ path, added, removed, patches }) => ({ path, added, removed, patches: patches.length })),
		).toEqual([
			{ path: "a.ts", added: 2, removed: 2, patches: 2 },
			{ path: "b.ts", added: 1, removed: 0, patches: 1 },
			{ path: "c.ts", added: 2, removed: 0, patches: 1 },
		]);
	});
	it("marks truncated diffs and ignores commands without structured file changes", () => {
		const changes = fileChanges(
			[
				tool({ result: { details: { diff: "--- a\n+++ a\n@@ -1,1 +1,1 @@\n-x\n+y\n[Diff truncated]" } } }),
				tool({ name: "bash", input: { command: "echo x > b" } }),
			],
			"r",
		);
		expect(changes).toHaveLength(1);
		expect(changes[0].truncated).toBe(true);
	});
});
