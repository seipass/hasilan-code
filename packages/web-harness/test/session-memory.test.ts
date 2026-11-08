import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hasilan-code/pi-ai";
import { SessionManager } from "@hasilan-code/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { type SessionDescriptor, SessionRegistry } from "../src/server/session-registry.ts";

it("hydrates billing without retaining every saved transcript, and keeps history searchable", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-session-memory-"));
	const workspace = { id: "w", path: root };
	const sessions: SessionDescriptor[] = [];
	const registry = new SessionRegistry({
		agentDir: root,
		workspaceFiles: {
			register: async () => workspace,
			getWorkspaces: () => [workspace],
			getWorkspaceRoot: () => root,
		},
	});
	try {
		const directory = join(root, "web-harness", "sessions");
		await mkdir(directory, { recursive: true });
		for (let index = 0; index < 24; index++) {
			const manager = SessionManager.create(root, directory);
			manager.appendMessage({ role: "user", content: `needle-${index} ${"x".repeat(256 * 1024)}`, timestamp: 0 });
			manager.appendMessage(fauxAssistantMessage(`answer-${index}`));
			sessions.push({
				sessionId: manager.getSessionId(),
				workspaceId: "w",
				cwd: root,
				path: manager.getSessionFile(),
				materialized: true,
				availability: "ready",
			});
		}
		await writeFile(
			join(root, "web-harness", "state.json"),
			JSON.stringify({
				schemaVersion: 1,
				workspaces: [workspace],
				sessions,
				teams: [],
				agents: [],
				runs: [],
				pendingInput: [],
			}),
		);
		await registry.initialize();
		vi.useFakeTimers();
		registry.startHistoryHydration();
		await vi.advanceTimersByTimeAsync(4000);
		// Inspect retained ownership, rather than flaky operating-system working-set measurements.
		const loaded = Reflect.get(registry, "live") as Map<string, unknown>;
		console.log(`Hydration retained ${loaded.size} of ${sessions.length} transcript managers`);
		expect(loaded.size).toBeLessThanOrEqual(4);
		expect(registry.list().every((session) => session.usage?.[0]?.responses === 1)).toBe(true);
		expect(registry.searchText("needle-0")).toHaveLength(1);
		expect(loaded.size).toBeLessThanOrEqual(4);
		expect(JSON.stringify(registry.page(sessions[0].sessionId).messages)).toContain("needle-0");
		const release = registry.retainHistory(sessions[0].sessionId);
		const first = registry.page(sessions[0].sessionId);
		for (const session of sessions.slice(1)) registry.page(session.sessionId);
		expect(registry.page(sessions[0].sessionId).messages[0].messageId).toBe(first.messages[0].messageId);
		expect(loaded.size).toBeLessThanOrEqual(4);
		release();
	} finally {
		vi.useRealTimers();
		await registry.close();
		await rm(root, { recursive: true, force: true });
	}
});
