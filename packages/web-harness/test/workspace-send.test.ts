import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../src/client/types.ts";
import { sendWorkspacePrompt } from "../src/client/workspace-send.ts";

const workspaces = [
	{ workspaceId: "current", path: "/projects/web" },
	{ workspaceId: "chosen", path: "/projects/music" },
];
const candidate = { ...workspaces[1], kind: "new" as const, name: "music", probability: 0.9 };
const existing: SessionDetail = {
	sessionId: "existing-session",
	title: "音楽プレイヤーの音量調節",
	workspaceId: "chosen",
	cwd: workspaces[1].path,
	model: { provider: "other-provider", id: "existing-model" },
	thinkingLevel: "high",
	materialized: true,
	availability: "ready",
	pendingInput: [],
	messages: [],
	toolCalls: [],
	activity: {},
};
const sessionCandidate = {
	...candidate,
	kind: "session" as const,
	sessionId: existing.sessionId,
	title: existing.title,
};
const attachments = [{ name: "player.png", mimeType: "image/png", data: "cHJpdmF0ZS1pbWFnZS1ieXRlcw==" }];
const beforeStart = vi.fn();
const input = {
	text: "音楽の画面を直して",
	attachments,
	workspaces,
	model: { provider: "faux", id: "test" },
	thinkingLevel: "low" as const,
	beforeStart,
};
let request: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
	request = vi.fn<typeof fetch>();
	vi.stubGlobal("fetch", request);
	beforeStart.mockReset();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("workspace selection before sending", () => {
	it("returns candidates without creating a session, changing workspaces, or uploading attachments", async () => {
		request.mockResolvedValueOnce(Response.json({ kind: "candidates", candidates: [candidate] }));
		expect(await sendWorkspacePrompt({ ...input, destination: { kind: "auto" } })).toEqual({
			kind: "candidates",
			candidates: [candidate],
		});
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0]).toBe("/api/workspaces/route");
		expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
			text: input.text,
			attachments: [{ name: "player.png", mimeType: "image/png" }],
		});
		expect(beforeStart).not.toHaveBeenCalled();
		expect(input.attachments).toEqual(attachments);
	});

	it("creates in the selected folder and sends the original text and files to that session", async () => {
		request
			.mockResolvedValueOnce(Response.json({ kind: "selected", destination: candidate }))
			.mockResolvedValueOnce(Response.json({ sessionId: "new-session" }))
			.mockResolvedValueOnce(Response.json({ disposition: "started" }));
		const result = await sendWorkspacePrompt({ ...input, destination: { kind: "auto" } });
		expect(result).toEqual({
			kind: "sent",
			workspace: workspaces[1],
			sessionId: "new-session",
			disposition: "started",
			continued: false,
		});
		expect(beforeStart).toHaveBeenCalledWith(workspaces[1], candidate);
		expect(request.mock.calls.map(([path]) => path)).toEqual([
			"/api/workspaces/route",
			"/api/sessions",
			"/api/sessions/new-session/prompt",
		]);
		expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({
			workspaceId: "chosen",
			model: input.model,
			thinkingLevel: "low",
		});
		expect(JSON.parse(String(request.mock.calls[2][1]?.body))).toEqual({
			text: input.text,
			attachments,
			mode: "prompt",
		});
	});

	it("uses a chosen candidate directly without another Jev call", async () => {
		request
			.mockResolvedValueOnce(Response.json({ sessionId: "manual" }))
			.mockResolvedValueOnce(Response.json({ disposition: "started" }));
		await sendWorkspacePrompt({ ...input, destination: { kind: "new", workspaceId: "chosen" } });
		expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/sessions", "/api/sessions/manual/prompt"]);
	});

	it("stops on routing or prompt errors without a fallback or mutating the draft", async () => {
		request.mockResolvedValueOnce(Response.json({ error: "Jev unavailable" }, { status: 503 }));
		await expect(sendWorkspacePrompt({ ...input, destination: { kind: "auto" } })).rejects.toThrow("Jev unavailable");
		expect(request).toHaveBeenCalledTimes(1);
		expect(beforeStart).not.toHaveBeenCalled();
		request.mockClear();
		request
			.mockResolvedValueOnce(Response.json({ sessionId: "failed" }))
			.mockResolvedValueOnce(Response.json({ error: "Prompt failed" }, { status: 500 }));
		await expect(
			sendWorkspacePrompt({ ...input, destination: { kind: "new", workspaceId: "chosen" } }),
		).rejects.toThrow("Prompt failed");
		expect(request).toHaveBeenCalledTimes(2);
		expect(input.text).toBe("音楽の画面を直して");
		expect(input.attachments[0].data).toBe("cHJpdmF0ZS1pbWFnZS1ieXRlcw==");
	});

	it("rejects a stale candidate or cancelled workspace change before creating anything", async () => {
		await expect(
			sendWorkspacePrompt({ ...input, destination: { kind: "new", workspaceId: "removed" } }),
		).rejects.toThrow("見つかりません");
		beforeStart.mockImplementationOnce(() => {
			throw new Error("Cancelled");
		});
		await expect(
			sendWorkspacePrompt({ ...input, destination: { kind: "new", workspaceId: "chosen" } }),
		).rejects.toThrow("Cancelled");
		expect(request).not.toHaveBeenCalled();
	});

	it("continues an existing session without creating one or changing its model, thinking level or history", async () => {
		request
			.mockResolvedValueOnce(Response.json({ kind: "selected", destination: sessionCandidate }))
			.mockResolvedValueOnce(Response.json(existing))
			.mockResolvedValueOnce(Response.json({ disposition: "started" }));
		expect(await sendWorkspacePrompt({ ...input, model: undefined, destination: { kind: "auto" } })).toEqual({
			kind: "sent",
			workspace: workspaces[1],
			sessionId: existing.sessionId,
			disposition: "started",
			continued: true,
			title: existing.title,
		});
		expect(request.mock.calls.map(([path]) => path)).toEqual([
			"/api/workspaces/route",
			"/api/sessions/existing-session",
			"/api/sessions/existing-session/prompt",
		]);
		expect(request.mock.calls[1][1]?.method).toBeUndefined();
		expect(JSON.parse(String(request.mock.calls[2][1]?.body))).toEqual({
			text: input.text,
			attachments,
			mode: "prompt",
		});
		expect(existing.model).toEqual({ provider: "other-provider", id: "existing-model" });
		expect(existing.thinkingLevel).toBe("high");
	});

	it("uses an existing candidate directly and leaves it untouched when a concurrent run prevents the prompt", async () => {
		request
			.mockResolvedValueOnce(Response.json(existing))
			.mockResolvedValueOnce(Response.json({ error: "Session is busy" }, { status: 409 }));
		await expect(sendWorkspacePrompt({ ...input, destination: sessionCandidate })).rejects.toThrow("Session is busy");
		expect(request.mock.calls.map(([path]) => path)).toEqual([
			"/api/sessions/existing-session",
			"/api/sessions/existing-session/prompt",
		]);
		expect(input.attachments).toEqual(attachments);
	});

	it.each<Partial<SessionDetail>>([
		{ workspaceId: "current" },
		{ sessionId: "different-session" },
		{ materialized: false },
		{ availability: "missing" },
		{ parentSessionId: "parent" },
		{ model: undefined },
		{ currentRun: { runId: "busy", agentId: "agent", task: "busy", status: "running" } },
		{
			pendingInput: [
				{
					inputId: "pending",
					sessionId: "existing-session",
					runId: "busy",
					text: "queued",
					mode: "followUp",
					status: "undelivered",
					manageable: true,
				},
			],
		},
		{ goal: { id: "goal", objective: "busy", status: "active", createdAt: "now", updatedAt: "now" } },
		{
			swarm: {
				id: "swarm",
				objective: "busy",
				status: "active",
				rootRunId: "root",
				createdAt: "now",
				updatedAt: "now",
			},
		},
	])("rechecks the selected session before sending and never falls back: %j", async (overrides) => {
		request.mockResolvedValueOnce(Response.json({ ...existing, ...overrides }));
		await expect(sendWorkspacePrompt({ ...input, destination: sessionCandidate })).rejects.toThrow("選択した会話");
		expect(request).toHaveBeenCalledTimes(1);
		expect(input.text).toBe("音楽の画面を直して");
	});

	it("does not recreate a deleted candidate or create a new session without a model", async () => {
		request.mockResolvedValueOnce(Response.json({ error: "Session not found" }, { status: 404 }));
		await expect(sendWorkspacePrompt({ ...input, destination: sessionCandidate })).rejects.toThrow(
			"Session not found",
		);
		expect(request).toHaveBeenCalledTimes(1);
		request.mockClear();
		await expect(
			sendWorkspacePrompt({ ...input, model: undefined, destination: { kind: "new", workspaceId: "chosen" } }),
		).rejects.toThrow("モデルを選択");
		expect(request).not.toHaveBeenCalled();
	});
});
