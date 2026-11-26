import { SessionManager } from "@hasilan-code/pi-coding-agent";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionPlanCard } from "../src/client/ActionPlanCard.tsx";
import { parseTestSummary, SurfaceManager } from "../src/server/surface-manager.ts";
import type { ActionPlanSurface } from "../src/shared/surfaces.ts";

describe("ActionPlan SurfaceManager and card", () => {
	it("waits for user-edited plan approval, attributes step-scoped file diffs & tests, and restores from JSONL", async () => {
		const manager = SessionManager.inMemory("/tmp/project");
		let changes = 0;
		const surfaces = new SurfaceManager({
			getManager: () => manager,
			getRunId: () => "run-1",
			onChanged: () => {
				changes++;
			},
		});
		const tool = surfaces.createActionPlanTool("s1");

		const proposePromise = tool.execute(
			"call-plan-1",
			{
				action: "propose",
				title: "Add rate limiting",
				estimatedFiles: 4,
				steps: ["Add token bucket", "Wire into middleware"],
			},
			new AbortController().signal,
			undefined,
			{} as never,
		);

		const [draft] = surfaces.list("s1");
		expect(draft.phase).toBe("draft");
		expect(draft.steps).toHaveLength(2);
		expect(draft.anchorCallId).toBe("call-plan-1");

		// User inserts a custom first step and reorders.
		surfaces.handleAction("s1", draft.surfaceId, {
			type: "approve_plan",
			steps: [
				{ id: "custom_1", title: "Say hello" },
				{ id: "step_1", title: "Add token bucket" },
				{ id: "step_2", title: "Cap at 100 req/min" },
			],
		});

		const approvedResult = await proposePromise;
		const approvedText = approvedResult.content[0].type === "text" ? approvedResult.content[0].text : "";
		expect(approvedText).toContain("Say hello");
		expect(approvedText).toContain("Cap at 100 req/min");

		// Step 2 creates rate-limit.ts (+3)
		await tool.execute("call-s2", { action: "start_step", stepId: "step_1" }, new AbortController().signal, undefined, {} as never);
		surfaces.onExecutionEvent("s1", {
			type: "tool_execution_start",
			toolCallId: "write-1",
			toolName: "write",
			args: { path: "src/rate-limit.ts", content: "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n" },
		});
		surfaces.onExecutionEvent("s1", {
			type: "tool_execution_end",
			toolCallId: "write-1",
			toolName: "write",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }], details: { path: "src/rate-limit.ts" } },
		});
		await tool.execute("call-c2", { action: "complete_step", stepId: "step_1" }, new AbortController().signal, undefined, {} as never);

		// Step 3 edits the SAME file rate-limit.ts (+1 -1) and runs tests
		await tool.execute("call-s3", { action: "start_step", stepId: "step_2" }, new AbortController().signal, undefined, {} as never);
		surfaces.onExecutionEvent("s1", {
			type: "tool_execution_start",
			toolCallId: "edit-1",
			toolName: "edit",
			args: { path: "src/rate-limit.ts" },
		});
		surfaces.onExecutionEvent("s1", {
			type: "tool_execution_end",
			toolCallId: "edit-1",
			toolName: "edit",
			isError: false,
			result: {
				content: [{ type: "text", text: "ok" }],
				details: {
					diff: "--- src/rate-limit.ts\n+++ src/rate-limit.ts\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 100;",
				},
			},
		});
		surfaces.onExecutionEvent("s1", {
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "npx vitest run rate-limit" },
		});
		surfaces.onExecutionEvent("s1", {
			type: "tool_execution_end",
			toolCallId: "bash-1",
			toolName: "bash",
			isError: false,
			result: {
				content: [{ type: "text", text: " ✓ bursts are capped (4ms)\nTests  14 passed (14)" }],
			},
		});
		await tool.execute("call-c3", { action: "complete_step", stepId: "step_2" }, new AbortController().signal, undefined, {} as never);
		await tool.execute("call-c1", { action: "complete_step", stepId: "custom_1", note: "Nothing to edit" }, new AbortController().signal, undefined, {} as never);

		const [completed] = surfaces.list("s1");
		expect(completed.phase).toBe("completed");
		expect(completed.steps[1].files[0]).toMatchObject({ path: "src/rate-limit.ts", added: 3, removed: 0, isNew: true });
		expect(completed.steps[2].files[0]).toMatchObject({ path: "src/rate-limit.ts", added: 1, removed: 1 });
		expect(completed.steps[2].tests).toMatchObject({ passed: 14, failed: 0, total: 14 });
		expect(changes).toBeGreaterThan(0);

		// Restores from persisted custom entries cleanly.
		const restored = new SurfaceManager({ getManager: () => manager, getRunId: () => undefined, onChanged: () => {} });
		restored.restore("s1", manager);
		expect(restored.list("s1")[0]).toMatchObject({ phase: "completed", surfaceId: draft.surfaceId });
	});

	it("parses vitest and playwright test summaries", () => {
		const summary = parseTestSummary("pnpm vitest run", " ✓ handles burst (5ms)\n × drops expired (9ms)\nTests  1 failed | 13 passed (14)");
		expect(summary).toMatchObject({ passed: 13, failed: 1, total: 14 });
		expect(summary?.cases).toHaveLength(2);
	});

	it("renders draft and completed ActionPlanCard states", () => {
		const base: ActionPlanSurface = {
			kind: "action_plan",
			surfaceId: "plan-1",
			sessionId: "s1",
			phase: "draft",
			estimatedFiles: 5,
			steps: [
				{ id: "s1", title: "Add token bucket", status: "pending", tools: [], files: [] },
				{ id: "s2", title: "Test bursts", status: "pending", tools: [], files: [] },
			],
			updatedAt: new Date().toISOString(),
		};
		const draftHtml = renderToStaticMarkup(<ActionPlanCard surface={base} onAction={async () => {}} onFile={() => {}} />);
		expect(draftHtml).toContain("プランを承認");
		expect(draftHtml).toContain("2 ステップ · 5 ファイル");

		const completedHtml = renderToStaticMarkup(
			<ActionPlanCard
				surface={{
					...base,
					phase: "completed",
					startedAt: "2026-10-01T00:00:00Z",
					completedAt: "2026-10-01T00:00:16Z",
					steps: [
						{
							id: "s1",
							title: "Add token bucket",
							status: "completed",
							tools: [],
							files: [{ path: "src/rate-limit.ts", added: 64, removed: 0, isNew: true, patch: "+export {}" }],
						},
						{
							id: "s2",
							title: "Test bursts",
							status: "completed",
							tools: [],
							files: [],
							tests: { passed: 14, failed: 0, total: 14 },
						},
					],
				}}
				onAction={async () => {}}
				onFile={() => {}}
			/>,
		);
		expect(completedHtml).toContain("rate-limit.ts");
		expect(completedHtml).toContain("+64");
		expect(completedHtml).toContain("Tests 14 passed (14)");
		expect(completedHtml).toContain("Worked for 16s");
	});
});
