import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/server/session-registry.ts";
import {
	applyHistoryPatch,
	HistoryCursorError,
	type HistorySource,
	historyBaseline,
	historyPage,
	historyPatch,
	prependHistory,
	reconcileHistory,
} from "../src/shared/session-history.ts";

function transcript(count = 125): HistorySource {
	return {
		sessionId: "session",
		toolCalls: [],
		messages: Array.from({ length: count }, (_, index) => ({
			messageId: `m${index}`,
			role: "assistant",
			content: `Message ${index}`,
			partial: false,
		})),
	};
}

describe("session history pages and streaming", () => {
	it("keeps every stored message while paging the actual registry from the newest end", async () => {
		const root = await mkdtemp(join(tmpdir(), "hasilan-history-"));
		const workspace = { id: "w", path: root };
		const registry = new SessionRegistry({
			agentDir: root,
			workspaceFiles: {
				register: async () => workspace,
				getWorkspaces: () => [workspace],
				getWorkspaceRoot: () => root,
			},
		});
		try {
			await registry.initialize();
			await registry.addWorkspace(root);
			const imported = await registry.importSession(
				"w",
				{
					source: "codex",
					sourceSessionId: "original",
					title: "Large conversation",
					cwd: root,
					warnings: [],
					messages: Array.from({ length: 125 }, (_, index) => ({ role: "user", text: `Message ${index}` })),
				},
				"revision",
			);
			let page = registry.page(imported.sessionId);
			expect(page.messages).toHaveLength(50);
			expect(page.history).toMatchObject({ start: 75, total: 125 });
			const collected = [...page.messages];
			while (page.history.before) {
				page = registry.page(imported.sessionId, page.history.before);
				collected.unshift(...page.messages);
			}
			expect(collected.map((message) => message.content)).toEqual(
				Array.from({ length: 125 }, (_, index) => [{ type: "text", text: `Message ${index}` }]),
			);
			expect(new Set(collected.map((message) => message.messageId)).size).toBe(125);
			expect(registry.get(imported.sessionId).messages).toHaveLength(125);
			expect(() => registry.page(imported.sessionId, "obsolete-cursor")).toThrow("履歴が更新されました");
			page.messages[0].content = "Do not mutate storage";
			expect(registry.get(imported.sessionId).messages[0].content).toEqual([{ type: "text", text: "Message 0" }]);
		} finally {
			await registry.close();
			await rm(root, { recursive: true, force: true });
		}
	});
	it("includes a paged message's tools and skips separate tool-result rows", () => {
		const source = transcript();
		source.messages[100].content = [{ type: "toolCall", id: "call", name: "read" }];
		source.messages.splice(101, 0, { messageId: "result", role: "toolResult", content: "result", partial: false });
		source.toolCalls.push({
			key: "tool",
			sessionId: "session",
			callId: "call",
			name: "read",
			input: {},
			result: "full result",
			status: "success",
		});
		const page = historyPage(source);
		expect(page.messages).toHaveLength(50);
		expect(page.history.total).toBe(125);
		expect(page.toolCalls[0].result).toBe("full result");
		expect(() => historyPage(source, "missing")).toThrow(HistoryCursorError);
	});
	it("merges an older page racing with multiple streamed messages without replacing current data", () => {
		const source = transcript();
		const current = historyPage(source);
		const older = historyPage(source, current.history.before);
		const baseline = historyBaseline(source);
		source.messages[124] = { ...source.messages[124], content: "streamed final text" };
		source.messages.push({ messageId: "m125", role: "user", content: "Next turn", partial: false });
		const patch = historyPatch(baseline, source);
		if (!patch) throw new Error("Unexpected reset");
		const streamed = applyHistoryPatch(current, patch);
		const prepended = prependHistory(streamed, older);
		expect(prepended.messages).toHaveLength(101);
		expect(prepended.messages.at(-2)?.content).toBe("streamed final text");
		expect(prepended.messages.at(-1)?.messageId).toBe("m125");
		expect(prepended.history).toMatchObject({ start: 25, total: 126 });
		expect(prepended.messages[50]).toBe(current.messages[0]);
		expect(prependHistory(prepended, older)).toBe(prepended);
	});
	it("retains unchanged row references and clears optional metadata when a run settles", () => {
		const source = { ...transcript(), currentRun: { status: "running" } as { status: string } | undefined };
		const current = historyPage(source);
		const baseline = historyBaseline(source);
		source.currentRun = undefined;
		const patch = historyPatch(baseline, source);
		if (!patch) throw new Error("Unexpected reset");
		const received = JSON.parse(JSON.stringify(patch)) as typeof patch;
		const updated = applyHistoryPatch(current, received);
		expect(updated.messages).toBe(current.messages);
		expect(updated.toolCalls).toBe(current.toolCalls);
		expect(updated.currentRun).toBeUndefined();
		source.messages.reverse();
		expect(historyPatch(baseline, source)).toBeUndefined();
	});
	it("updates tool results and removes cancelled references without retransmitting unchanged rows", () => {
		const source = transcript();
		source.messages[124].content = [{ type: "toolCall", id: "call", name: "read" }];
		source.toolCalls = [
			{ key: "tool", sessionId: "session", callId: "call", name: "read", input: {}, status: "running" },
		];
		const current = historyPage(source);
		const baseline = historyBaseline(source);
		source.toolCalls[0] = { ...source.toolCalls[0], result: "finished", status: "success" };
		const patch = historyPatch(baseline, source);
		if (!patch) throw new Error("Unexpected reset");
		expect(patch.messages).toEqual([]);
		const updated = applyHistoryPatch(current, patch);
		expect(updated.messages).toBe(current.messages);
		expect(updated.toolCalls[0]).toMatchObject({ result: "finished", status: "success" });
		const nextBaseline = historyBaseline(source);
		source.toolCalls = [];
		const removed = historyPatch(nextBaseline, source);
		if (!removed) throw new Error("Unexpected reset");
		expect(applyHistoryPatch(updated, removed).toolCalls).toEqual([]);
	});
	it("keeps loaded pages across reconnects, and discards them when identities change or a gap opens", () => {
		const source = transcript();
		const tail = historyPage(source);
		const loaded = prependHistory(tail, historyPage(source, tail.history.before));
		source.messages.push({ messageId: "m125", role: "assistant", content: "New reply", partial: false });
		const restored = reconcileHistory(loaded, historyPage(source));
		expect(restored.messages).toHaveLength(101);
		expect(restored.messages[0]).toBe(loaded.messages[0]);
		expect(restored.history).toMatchObject({ start: 25, total: 126 });
		const restarted = historyPage({
			...source,
			messages: source.messages.map((message) => ({ ...message, messageId: `new-${message.messageId}` })),
		});
		expect(reconcileHistory(loaded, restarted)).toBe(restarted);
		source.messages.push(
			...transcript(100).messages.map((message) => ({ ...message, messageId: `later-${message.messageId}` })),
		);
		const gap = historyPage(source);
		expect(reconcileHistory(loaded, gap)).toBe(gap);
	});
});
