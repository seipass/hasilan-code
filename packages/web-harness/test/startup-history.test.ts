import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@hasilan-code/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { SessionRegistry } from "../src/server/session-registry.ts";

it("starts without loading every conversation and opens history on demand", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-startup-history-"));
	const workspace = { id: "w", path: root };
	const workspaceFiles = {
		register: async () => workspace,
		getWorkspaces: () => [workspace],
		getWorkspaceRoot: () => root,
	};
	let registry = new SessionRegistry({ agentDir: root, workspaceFiles });
	try {
		await registry.initialize();
		await registry.addWorkspace(root);
		const session = await registry.importSession(
			"w",
			{
				source: "codex",
				sourceSessionId: "original",
				title: "Saved conversation",
				cwd: root,
				warnings: [],
				messages: [{ role: "user", text: "Saved message" }],
			},
			"revision",
		);
		const second = await registry.importSession(
			"w",
			{
				source: "codex",
				sourceSessionId: "second",
				title: "Another conversation",
				cwd: root,
				warnings: [],
				messages: [{ role: "user", text: "Another message" }],
			},
			"revision",
		);
		await registry.close();
		const open = vi.spyOn(SessionManager, "open");
		try {
			registry = new SessionRegistry({ agentDir: root, workspaceFiles });
			await registry.initialize();
			expect(open).not.toHaveBeenCalled();
			expect(registry.list("w")[0].title).toBe("Saved conversation");
			expect(registry.page(session.sessionId).messages[0].content).toEqual([
				{ type: "text", text: "Saved message" },
			]);
			expect(open).toHaveBeenCalledTimes(1);
			registry.startHistoryHydration();
			await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2), { timeout: 5_000, interval: 50 });
			expect(registry.page(second.sessionId).messages[0].content).toEqual([
				{ type: "text", text: "Another message" },
			]);
		} finally {
			open.mockRestore();
		}
	} finally {
		await registry.close();
		await rm(root, { recursive: true, force: true });
	}
});
