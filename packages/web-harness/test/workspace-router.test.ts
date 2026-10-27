import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@hasilan-code/pi-ai";
import { ModelRuntime } from "@hasilan-code/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRegistry } from "../src/server/session-registry.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";
import { WorkspaceRouter } from "../src/server/workspace-router.ts";
import type { JevSelection } from "../src/shared/workspace-routing.ts";

function decision(choice: string, confidence: number, probabilities: Record<string, number>): Response {
	return Response.json({
		model: "jev-1.14.0",
		answers: { destination: { type: "choice", choice, confidence, probabilities } },
	});
}

type SavedSession = ReturnType<SessionRegistry["list"]>[number];
const savedSession: SavedSession = {
	sessionId: "music-session",
	workspaceId: "folder-2",
	cwd: "/projects/music",
	title: "音楽プレイヤーの音量調節",
	materialized: true,
	availability: "ready",
	model: { provider: "faux", id: "existing-model" },
	pendingInput: [],
	latestRun: {
		runId: "music-run",
		agentId: "music-agent",
		task: "音楽プレイヤーに音量調節を追加して",
		result: "スライダーを追加しました。次はミュート操作を実装します。",
		status: "completed",
		startedAt: "2026-10-26T09:00:00.000Z",
		settledAt: "2026-10-26T09:05:00.000Z",
	},
};

describe("Jev workspace and conversation selection", () => {
	let directory: string;
	let files: WorkspaceFiles;
	let request: ReturnType<typeof vi.fn<typeof fetch>>;
	let router: WorkspaceRouter;
	let paths: string[];
	let runtime: ModelRuntime;
	let selection: JevSelection | undefined;
	let sessions: SavedSession[];
	beforeEach(async () => {
		vi.stubEnv("CMD_API_KEY", "");
		directory = await mkdtemp(join(tmpdir(), "pi-workspace-router-"));
		paths = [join(directory, "web", "app"), join(directory, "mobile", "app")];
		files = new WorkspaceFiles();
		for (const [index, path] of paths.entries()) {
			await mkdir(path, { recursive: true });
			await writeFile(join(path, "README.md"), index === 0 ? "Web dashboard" : "Mobile music player");
			await writeFile(
				join(path, "package.json"),
				JSON.stringify({ name: index === 0 ? "dashboard" : "music-player", description: "Project summary" }),
			);
			await files.register(path, `folder-${index + 1}`);
		}
		request = vi.fn<typeof fetch>();
		runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		await runtime.setRuntimeApiKey("commandcode", "private-jev-key");
		selection = { provider: "commandcode", id: "typesafe/jev" };
		sessions = [];
		router = new WorkspaceRouter(
			files,
			{
				getModelOfType: runtime.getModelOfType.bind(runtime),
				hasConfiguredAuth: runtime.hasConfiguredAuth.bind(runtime),
				classify: (model, context, options) => runtime.classify(model, context, { ...options, fetch: request }),
			},
			() => selection,
			{ list: () => sessions },
		);
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("selects a clear winner using the Choice API and bounded, read-only workspace descriptions", async () => {
		request.mockResolvedValue(
			decision("workspace_2", 0.92, { workspace_1: 0.03, workspace_2: 0.94, undetermined: 0.03 }),
		);
		const result = await router.select({
			text: "音楽プレイヤーの再生画面を直して",
			attachments: [{ name: "player.png", mimeType: "image/png" }],
		});
		expect(result).toEqual({
			kind: "selected",
			destination: { kind: "new", workspaceId: "folder-2", path: paths[1], name: "app", probability: 0.94 },
		});
		expect(request).toHaveBeenCalledTimes(1);
		const [url, init] = request.mock.calls[0];
		expect(String(url)).toBe("https://api.commandcode.ai/provider/v1/systemone");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-jev-key");
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe("typesafe/jev");
		expect(body.state.attachments).toEqual([{ name: "player.png", mimeType: "image/png" }]);
		expect(body.questions.destination.type).toBe("choice");
		expect(JSON.parse(body.questions.destination.criteria.workspace_1)).toMatchObject({
			kind: "new",
			directory: paths[0],
			name: "dashboard",
			readme: "Web dashboard",
		});
		expect(JSON.parse(body.questions.destination.criteria.workspace_2)).toMatchObject({
			directory: paths[1],
			name: "music-player",
			readme: "Mobile music player",
		});
		expect((await readdir(paths[1])).sort()).toEqual(["README.md", "package.json"]);
		expect(await readFile(join(paths[1], "README.md"), "utf8")).toBe("Mobile music player");
	});

	it("continues a clear follow-up using a session's title, recent request and result in the same Choice call", async () => {
		sessions = [structuredClone(savedSession)];
		request.mockResolvedValue(
			decision("session_1", 0.95, { workspace_1: 0.01, workspace_2: 0.02, session_1: 0.96, undetermined: 0.01 }),
		);
		expect(await router.select({ text: "音楽プレイヤーの音量調節の続きをお願い。ミュートも追加して" })).toEqual({
			kind: "selected",
			destination: {
				kind: "session",
				workspaceId: "folder-2",
				path: paths[1],
				name: "app",
				probability: 0.96,
				sessionId: savedSession.sessionId,
				title: savedSession.title,
				updatedAt: savedSession.latestRun?.settledAt,
			},
		});
		expect(request).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String(request.mock.calls[0][1]?.body));
		expect(JSON.parse(body.questions.destination.criteria.session_1)).toMatchObject({
			kind: "continue",
			workspace: "workspace_2",
			title: savedSession.title,
			lastRequest: savedSession.latestRun?.task,
			lastResult: savedSession.latestRun?.result,
		});
		expect(body.questions.destination.instructions).toContain("Prefer a NEW conversation for an independent request");
		expect(sessions).toEqual([savedSession]);
	});

	it("can start a new conversation even when an existing conversation shares its topic", async () => {
		sessions = [structuredClone(savedSession)];
		request.mockResolvedValue(
			decision("workspace_2", 0.95, { workspace_1: 0.01, workspace_2: 0.96, session_1: 0.02, undetermined: 0.01 }),
		);
		expect(await router.select({ text: "音楽プレイヤーで新しい曲検索画面を作って" })).toMatchObject({
			kind: "selected",
			destination: { kind: "new", workspaceId: "folder-2" },
		});
	});

	it("offers existing conversations and new conversations when intent is ambiguous, including within one workspace", async () => {
		sessions = [
			structuredClone(savedSession),
			{ ...savedSession, sessionId: "other-music-session", title: "音楽プレイヤーの再生画面" },
		];
		request.mockResolvedValue(
			decision("session_1", 0.7, {
				workspace_1: 0.03,
				workspace_2: 0.1,
				session_1: 0.43,
				session_2: 0.42,
				undetermined: 0.02,
			}),
		);
		const result = await router.select({ text: "プレイヤーの続きをお願い" });
		expect(result.kind).toBe("candidates");
		if (result.kind !== "candidates") throw new Error("Expected candidates");
		expect(
			result.candidates.map((entry) => (entry.kind === "session" ? entry.sessionId : `new:${entry.workspaceId}`)),
		).toEqual(["music-session", "other-music-session", "new:folder-2", "new:folder-1"]);
		request.mockResolvedValue(
			decision("session_2", 0.99, {
				workspace_1: 0.01,
				workspace_2: 0.01,
				session_1: 0.9,
				session_2: 0.07,
				undetermined: 0.01,
			}),
		);
		expect((await router.select({ text: "続きをお願い" })).kind).toBe("candidates");
	});

	it.each<Partial<SavedSession>>([
		{ parentSessionId: "root" },
		{ materialized: false },
		{ availability: "missing" },
		{ model: undefined },
		{ workspaceId: "removed" },
		{ currentRun: { ...savedSession.latestRun!, status: "running" } },
		{
			pendingInput: [
				{
					inputId: "input",
					sessionId: "music-session",
					runId: "music-run",
					mode: "followUp",
					text: "pending",
					status: "undelivered",
					manageable: true,
				},
			],
		},
		{ goal: { id: "goal", objective: "unfinished", status: "active", createdAt: "now", updatedAt: "now" } },
		{
			swarm: {
				id: "swarm",
				objective: "unfinished",
				status: "active",
				rootRunId: "root",
				createdAt: "now",
				updatedAt: "now",
			},
		},
	])("does not route to unavailable or active conversations: %j", async (overrides) => {
		sessions = [{ ...structuredClone(savedSession), ...overrides }];
		request.mockResolvedValue(
			decision("workspace_2", 0.92, { workspace_1: 0.03, workspace_2: 0.94, undetermined: 0.03 }),
		);
		expect((await router.select({ text: "音楽プレイヤー" })).kind).toBe("selected");
		expect(Object.keys(JSON.parse(String(request.mock.calls[0][1]?.body)).questions.destination.criteria)).toEqual([
			"workspace_1",
			"workspace_2",
			"undetermined",
		]);
	});

	it("bounds session excerpts and candidate counts and prioritizes recent conversations", async () => {
		sessions = Array.from({ length: 65 }, (_, index) => ({
			...savedSession,
			sessionId: `session-${index}`,
			latestRun: {
				...savedSession.latestRun!,
				task: "request".repeat(1000),
				result: "result".repeat(1000),
				settledAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
			},
		}));
		request.mockImplementation(async (_url, init) => {
			const criteria = JSON.parse(String(init?.body)).questions.destination.criteria;
			expect(Object.keys(criteria)).toHaveLength(63);
			expect(JSON.parse(criteria.session_1).updatedAt).toBe(sessions[64].latestRun?.settledAt);
			expect(JSON.parse(criteria.session_1).lastRequest.length).toBeLessThan(100);
			expect(JSON.parse(criteria.session_1).lastResult.length).toBeLessThan(100);
			return decision(
				"undetermined",
				0.99,
				Object.fromEntries(Object.keys(criteria).map((choice) => [choice, choice === "undetermined" ? 1 : 0])),
			);
		});
		const result = await router.select({ text: "続きをお願い" });
		if (result.kind !== "candidates") throw new Error("Expected candidates");
		expect(result.candidates.filter((candidate) => candidate.kind === "session")).toHaveLength(6);
		expect(result.candidates.filter((candidate) => candidate.kind === "new")).toHaveLength(2);
	});

	it.each([
		["workspace_2", 0.7, { workspace_1: 0.4, workspace_2: 0.5, undetermined: 0.1 }],
		["workspace_2", 0.99, { workspace_1: 0.44, workspace_2: 0.5, undetermined: 0.06 }],
		["undetermined", 0.99, { workspace_1: 0.15, workspace_2: 0.25, undetermined: 0.6 }],
	])(
		"returns registered folders in ranked order when ambiguous: %s, %s",
		async (choice, confidence, probabilities) => {
			request.mockResolvedValue(decision(choice, confidence, probabilities));
			const result = await router.select({ text: "画面を改善して" });
			expect(result.kind).toBe("candidates");
			if (result.kind !== "candidates") throw new Error("Expected candidates");
			expect(result.candidates.map((candidate) => candidate.workspaceId)).toEqual(["folder-2", "folder-1"]);
			expect(result.candidates.map((candidate) => candidate.path)).toEqual([paths[1], paths[0]]);
		},
	);

	it("requires an explicit Jev selection, provider auth and content before requesting anything", async () => {
		selection = undefined;
		await expect(router.select({ text: "Fix music" })).rejects.toThrow("モデルを選択");
		selection = { provider: "commandcode", id: "gpt-6.1-sol" };
		await expect(router.select({ text: "Fix music" })).rejects.toThrow("利用できるJev");
		selection = { provider: "commandcode", id: "typesafe/jev" };
		await runtime.removeRuntimeApiKey("commandcode");
		await expect(router.select({ text: "Fix music" })).rejects.toThrow("認証");
		await expect(router.select({ text: " " })).rejects.toThrow("作業内容");
		expect(request).not.toHaveBeenCalled();
	});

	it.each([
		["unregistered", { workspace_1: 0.1, workspace_2: 0.9, undetermined: 0 }],
		["workspace_2", { workspace_2: 1 }],
		["workspace_2", { workspace_1: 0, workspace_2: 1, undetermined: 0, unregistered: 1 }],
	])("rejects results outside the offered options: %s", async (choice, probabilities) => {
		request.mockResolvedValue(decision(choice, 0.99, probabilities));
		await expect(router.select({ text: "Fix music" })).rejects.toThrow("Jev");
	});

	it.each([401, 403, 429, 500])("does not expose reflected credentials or retry HTTP %s", async (status) => {
		request.mockResolvedValue(Response.json({ error: "private-jev-key" }, { status }));
		const failure = await router.select({ text: "Fix music" }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain("private-");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("handles network and malformed responses without exposing their contents", async () => {
		request.mockRejectedValueOnce(new Error("private-jev-key"));
		await expect(router.select({ text: "Fix music" })).rejects.toThrow("選択に失敗");
		request.mockResolvedValueOnce(Response.json({ answers: "private-jev-key" }));
		await expect(router.select({ text: "Fix music" })).rejects.toThrow("選択に失敗");
		request.mockResolvedValueOnce(new Response("private-jev-key"));
		await expect(router.select({ text: "Fix music" })).rejects.toThrow("選択に失敗");
	});

	it.each([
		["typesafe", "jev-latest", "https://api.typesafe.ai/v1/systemone"],
		["openrouter", "typesafe/jev-1.14", "https://openrouter.ai/api/v1/systemone"],
		["vercel-ai-gateway", "typesafe-ai/jev", "https://ai-gateway.vercel.sh/typesafe/v1/systemone"],
		["opencode", "jev-1.13", "https://opencode.ai/inference/v1/systemone"],
	])("uses the chosen %s model and its existing runtime credentials", async (provider, id, endpoint) => {
		selection = { provider, id };
		await runtime.setRuntimeApiKey(provider, "provider-specific-key");
		request.mockResolvedValue(
			decision("workspace_2", 0.92, { workspace_1: 0.03, workspace_2: 0.94, undetermined: 0.03 }),
		);
		expect((await router.select({ text: "Fix music" })).kind).toBe("selected");
		expect(String(request.mock.calls[0][0])).toBe(endpoint);
		expect(new Headers(request.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer provider-specific-key");
		expect(JSON.parse(String(request.mock.calls[0][1]?.body)).model).toBe(id);
	});
});
