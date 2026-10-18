import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type Usage } from "@hasilan-code/pi-ai";
import { SessionManager } from "@hasilan-code/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { buildSystemPrompt } from "../../coding-agent/src/core/system-prompt.ts";
import { appendRuntimeContext } from "../src/server/runtime-context.ts";
import type { SessionDescriptor } from "../src/server/session-registry.ts";
import { SessionUsage } from "../src/server/session-usage.ts";
import { aggregateUsage, cacheReadPercent } from "../src/shared/usage.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const descriptor: SessionDescriptor = {
	sessionId: "s1",
	workspaceId: "w1",
	cwd: process.cwd(),
	materialized: false,
	availability: "ready",
	goal: { id: "g1", objective: "Verify files", status: "active", createdAt: "start", updatedAt: "start" },
};

it("shares the entire common prompt prefix between different agent roles", () => {
	const common = {
		cwd: "/workspace",
		includeDocumentation: false,
		selectedTools: ["read"],
		contextFiles: [{ path: "/workspace/project-rules.md", content: "Shared project rules" }],
	};
	const shared = buildSystemPrompt(common);
	const researcher = buildSystemPrompt({ ...common, appendSystemPrompt: "Agent role: researcher" });
	const writer = buildSystemPrompt({ ...common, appendSystemPrompt: "Agent role: writer" });
	expect(researcher.startsWith(shared)).toBe(true);
	expect(writer.startsWith(shared)).toBe(true);
	expect(researcher.slice(shared.length)).toContain("Agent role: researcher");
	expect(writer.slice(shared.length)).toContain("Agent role: writer");
});

it("retains unchanged runtime context across responses and restart, and appends changed or cleared state", () => {
	const directory = mkdtempSync(join(tmpdir(), "hasilan-cache-context-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "task", timestamp: 0 });
	const initial = appendRuntimeContext(manager, manager.buildSessionContext().messages, descriptor);
	manager.appendMessage(fauxAssistantMessage("Saved response"));
	const restored = SessionManager.open(manager.getSessionFile()!);
	const messages = restored.buildSessionContext().messages;
	const unchanged = appendRuntimeContext(restored, messages, {
		...descriptor,
		goal: { ...descriptor.goal!, updatedAt: "later" },
	});
	expect(unchanged).toBe(messages);
	expect(unchanged.slice(0, initial.length)).toEqual(initial);
	const paused = appendRuntimeContext(restored, unchanged, {
		...descriptor,
		goal: { ...descriptor.goal!, status: "paused" },
	});
	expect(paused.slice(0, unchanged.length)).toEqual(unchanged);
	expect(paused.at(-1)).toMatchObject({
		role: "custom",
		display: false,
		content: expect.stringContaining('"status":"paused"'),
	});
	const cleared = appendRuntimeContext(restored, paused, { ...descriptor, goal: undefined });
	expect(cleared.at(-1)).toMatchObject({
		content: expect.stringContaining("Earlier mode instructions no longer apply"),
	});
	expect(appendRuntimeContext(restored, cleared, { ...descriptor, goal: undefined })).toBe(cleared);
});

it("restores active context after compaction removes it and does not retain active swarm authority after completion", () => {
	const manager = SessionManager.inMemory();
	const state: SessionDescriptor = {
		...descriptor,
		goal: undefined,
		swarm: {
			id: "h1",
			objective: "Delegate work",
			rootRunId: "r1",
			status: "active",
			createdAt: "start",
			updatedAt: "start",
		},
	};
	appendRuntimeContext(manager, [], state);
	manager.appendCompaction("Previous work", null, 100);
	const compacted = manager.buildSessionContext().messages;
	const restored = appendRuntimeContext(manager, compacted, state);
	expect(restored.slice(0, compacted.length)).toEqual(compacted);
	expect(restored.at(-1)).toMatchObject({ content: expect.stringContaining('"status":"active"') });
	const complete = appendRuntimeContext(manager, restored, {
		...state,
		swarm: { ...state.swarm!, status: "complete" },
	});
	expect(complete.at(-1)).toMatchObject({ content: expect.stringContaining('"status":"complete"') });
	expect(complete.at(-1)).toMatchObject({ content: expect.stringContaining("Only while this swarm is active") });
});

function usage(input: number, cacheRead: number, cacheWrite: number, cost: number): Usage {
	return {
		input,
		output: 5,
		cacheRead,
		cacheWrite,
		totalTokens: input + cacheRead + cacheWrite + 5,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

it("accounts for each billed response once across reads, compaction, model changes and ledger restoration", () => {
	const manager = SessionManager.inMemory();
	const ledger = new SessionUsage(manager);
	manager.appendMessage({
		...fauxAssistantMessage("one"),
		provider: "provider",
		model: "first",
		usage: usage(10, 90, 0, 0.01),
	});
	const first = ledger.snapshot();
	expect(ledger.snapshot()).toBe(first);
	manager.appendMessage({
		...fauxAssistantMessage("error", { stopReason: "error" }),
		provider: "provider",
		model: "second",
		usage: usage(900, 0, 100, 0.2),
	});
	manager.appendCompaction("summary", null, 1000, undefined, undefined, usage(20, 0, 0, 0.03));
	manager.appendUsage("cache_warm", "provider", "first", usage(0, 100, 0, 0.005));
	const totals = ledger.snapshot();
	expect(totals.find((row) => row.model === "first")).toMatchObject({
		input: 10,
		cacheRead: 190,
		responses: 1,
		auxiliary: 1,
		cost: 0.015,
	});
	expect(totals.find((row) => row.model === "second")).toMatchObject({
		input: 900,
		cacheWrite: 100,
		responses: 1,
		failures: 1,
	});
	expect(totals.find((row) => row.provider === "")).toMatchObject({ input: 20, cost: 0.03, auxiliary: 1 });
	expect(new SessionUsage(manager).snapshot()).toEqual(totals);
	const combined = aggregateUsage([first, [{ ...first[0], input: 900, cacheRead: 0, cacheWrite: 100 }]])[0];
	expect(cacheReadPercent(combined)).toBeCloseTo((90 / 1100) * 100);
	expect(cacheReadPercent({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
});
