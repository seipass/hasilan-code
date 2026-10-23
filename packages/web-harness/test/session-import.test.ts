import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";
import { fauxAssistantMessage } from "@hasilan-code/pi-ai/compat";
import type { AgentSessionEvent, SessionManager } from "@hasilan-code/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpHost } from "../src/server/http-host.ts";
import { handleSessionImport } from "../src/server/session-import/routes.ts";
import { readSessionDatabase, SessionImportService, sessionImportPaths } from "../src/server/session-import/service.ts";
import { type ExecutionAdapter, SessionRegistry } from "../src/server/session-registry.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";
import type { SessionDiscovery, SessionImportPreview, SessionImportSource } from "../src/shared/session-import.ts";

const executeFile = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "hasilan-import-"));
	roots.push(home);
	const cwd = join(home, "workspace");
	await mkdir(cwd);
	const service = new SessionImportService({ home, env: {} });
	return { home, cwd, service };
}
async function jsonl(path: string, rows: unknown[], compressed = false) {
	await mkdir(dirname(path), { recursive: true });
	const bytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	await writeFile(
		path,
		compressed ? Buffer.concat(rows.map((row) => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`)))) : bytes,
	);
}
async function sources(home: string, cwd: string): Promise<Record<SessionImportSource, string>> {
	const paths = {
		codex: join(home, ".codex/sessions/2026/10/22/rollout-codex-example.jsonl.zst"),
		"claude-code": join(home, ".claude/projects/project/claude-example.jsonl"),
		"grok-build": join(home, ".grok/sessions/project/grok-example/summary.json"),
		opencode: join(home, ".local/share/opencode/opencode.db"),
		"oh-my-pi": join(home, ".omp/agent/sessions/project/omp-example.jsonl"),
		"deepseek-harness": join(home, ".dsh/sessions/project/deepseek-example/session.v4.jsonl.zstd"),
	};
	await jsonl(
		paths.codex,
		[
			{ type: "session_meta", payload: { id: "codex-example", cwd } },
			{
				type: "response_item",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex user" }] },
			},
			{
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex answer" }] },
			},
		],
		true,
	);
	await jsonl(paths["claude-code"], [
		{
			type: "user",
			uuid: "u",
			parentUuid: null,
			sessionId: "claude-example",
			cwd,
			message: { content: "Claude user" },
		},
		{
			type: "assistant",
			uuid: "a",
			parentUuid: "u",
			sessionId: "claude-example",
			message: { content: [{ type: "text", text: "Claude answer" }] },
		},
	]);
	await mkdir(dirname(paths["grok-build"]), { recursive: true });
	await writeFile(
		paths["grok-build"],
		JSON.stringify({ info: { id: "grok-example", cwd }, generated_title: "Grok example", chat_format_version: 1 }),
	);
	await jsonl(join(dirname(paths["grok-build"]), "updates.jsonl"), [
		{
			method: "session/update",
			params: {
				sessionId: "grok-example",
				update: {
					sessionUpdate: "user_message_chunk",
					content: { type: "text", text: "Grok user" },
					_meta: { promptIndex: 0 },
				},
			},
		},
		{
			method: "session/update",
			params: {
				sessionId: "grok-example",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Grok answer" } },
			},
		},
	]);
	await mkdir(dirname(paths.opencode), { recursive: true });
	await executeFile(process.execPath, [
		"--disable-warning=ExperimentalWarning",
		fileURLToPath(new URL("./session-import-sqlite-fixture.ts", import.meta.url)),
		paths.opencode,
		"modern",
		cwd,
	]);
	await jsonl(paths["oh-my-pi"], [
		{ type: "title", title: "OMP example", v: 1 },
		{ type: "session", id: "omp-example", version: 3, cwd },
		{ type: "message", id: "u", parentId: null, message: { role: "user", content: "OMP user" } },
		{
			type: "message",
			id: "a",
			parentId: "u",
			message: { role: "assistant", content: [{ type: "text", text: "OMP answer" }] },
		},
	]);
	await jsonl(
		paths["deepseek-harness"],
		[
			{ type: "session", id: "deepseek-example", version: 4, cwd },
			{
				type: "user/message",
				seq: 0,
				surfaceOp: "append",
				data: { role: "user", content: [{ type: "text", text: "DeepSeek user" }] },
			},
			{
				type: "assistant/message",
				seq: 1,
				surfaceOp: "append",
				data: { message: { role: "assistant", content: [{ type: "text", text: "DeepSeek answer" }] } },
			},
		],
		true,
	);
	return paths;
}

describe("session import discovery and persistence", () => {
	it("shows the saved Codex thread name and keeps injected setup out of user messages", async () => {
		const { home, cwd, service } = await fixture();
		await jsonl(join(home, ".codex/sessions/rollout-named-thread.jsonl"), [
			{ type: "session_meta", payload: { id: "named-thread", cwd } },
			{
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: "# AGENTS.md instructions for project\n<INSTRUCTIONS>Project rules</INSTRUCTIONS>",
				},
			},
			{
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: "<environment_context><cwd>project</cwd></environment_context>",
				},
			},
			{ type: "response_item", payload: { type: "message", role: "user", content: "Understand this project" } },
		]);
		await jsonl(join(home, ".codex/session_index.jsonl"), [
			{ id: "named-thread", thread_name: "Old name", updated_at: "2026-10-21T00:00:00Z" },
			{ id: "named-thread", thread_name: "Project architecture", updated_at: "2026-10-22T00:00:00Z" },
		]);
		const discovery = await service.discover({ source: "codex" });
		expect(discovery.candidates[0].title).toBe("Project architecture");
		const preview = await service.preview(discovery.candidates[0].candidateId);
		expect(preview.title).toBe("Project architecture");
		expect(preview.messageCount).toBe(3);
		expect(preview.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
			"Understand this project",
		]);
		const registry = new SessionRegistry({ agentDir: join(home, "target"), workspaceFiles: new WorkspaceFiles() });
		await registry.initialize();
		const workspace = await registry.addWorkspace(cwd);
		const { data, revision } = await service.read(preview.candidateId);
		const imported = await registry.importSession(workspace.id, data, revision);
		expect(registry.get(imported.sessionId).messages.map((message) => message.importedContext ?? false)).toEqual([
			true,
			true,
			false,
		]);
		await registry.close();
	});
	it("uses Codex database names when there is no JSONL title index without changing the database", async () => {
		const { home, cwd, service } = await fixture();
		await sources(home, cwd);
		const path = join(home, ".codex/state_5.sqlite");
		await executeFile(process.execPath, [
			"--disable-warning=ExperimentalWarning",
			fileURLToPath(new URL("./session-import-sqlite-fixture.ts", import.meta.url)),
			path,
			"codex",
			cwd,
		]);
		const before = await readFile(path);
		const discovery = await service.discover({ source: "codex" }, cwd);
		expect(discovery.candidates[0].title).toBe("Renamed Codex session");
		expect((await service.preview(discovery.candidates[0].candidateId)).title).toBe("Renamed Codex session");
		expect(await readFile(path)).toEqual(before);
	});
	it("refuses to put another workspace's session into the current workspace for every harness", async () => {
		const { home, cwd, service } = await fixture();
		const paths = await sources(home, cwd);
		const other = join(home, "other-project");
		await mkdir(other);
		const registry = new SessionRegistry({ agentDir: join(home, "target"), workspaceFiles: new WorkspaceFiles() });
		await registry.initialize();
		const workspace = await registry.addWorkspace(other);
		const original = await registry.addWorkspace(cwd);
		const host = createHttpHost({
			port: 0,
			handleApi: (request, response, url) =>
				handleSessionImport(request, response, url, service, registry, async () => {}),
		});
		const launch = await host.listen();
		try {
			const login = await fetch(launch.launchUrl, { redirect: "manual" });
			const cookie = login.headers.get("set-cookie")!.split(";")[0];
			for (const source of Object.keys(paths)) {
				const discovery = await service.discover({ source: source as SessionImportSource });
				const preview = await service.preview(discovery.candidates[0].candidateId);
				const originalScope = await service.discover({ source: source as SessionImportSource }, original.path);
				expect(originalScope.candidates, source).toHaveLength(1);
				const scoped = await fetch(`${launch.origin}/api/session-imports/discover`, {
					method: "POST",
					headers: { Cookie: cookie, Origin: launch.origin, "Content-Type": "application/json" },
					body: JSON.stringify({ source, workspaceId: workspace.id }),
				});
				expect(scoped.status, source).toBe(200);
				expect(((await scoped.json()) as SessionDiscovery).candidates, source).toEqual([]);
				const foreignPreview = await fetch(`${launch.origin}/api/session-imports/preview`, {
					method: "POST",
					headers: { Cookie: cookie, Origin: launch.origin, "Content-Type": "application/json" },
					body: JSON.stringify({ candidateId: preview.candidateId, workspaceId: workspace.id }),
				});
				expect(foreignPreview.status, source).toBe(400);
				const response = await fetch(`${launch.origin}/api/session-imports`, {
					method: "POST",
					headers: { Cookie: cookie, Origin: launch.origin, "Content-Type": "application/json" },
					body: JSON.stringify({
						candidateId: preview.candidateId,
						revision: preview.revision,
						workspaceId: workspace.id,
					}),
				});
				expect(response.status, source).toBe(400);
				const { data, revision } = await service.read(preview.candidateId);
				await expect(registry.importSession(workspace.id, data, revision), source).rejects.toThrow(
					"現在のワークスペース",
				);
				expect(registry.list()).toEqual([]);
			}
		} finally {
			await host.close();
			await registry.close();
		}
	});
	it("discovers and previews all six local formats including SQLite and compressed JSONL without modifying source bytes", async () => {
		const { home, cwd, service } = await fixture();
		const paths = await sources(home, cwd);
		for (const [source, path] of Object.entries(paths)) {
			const before = await readFile(path);
			const discovery = await service.discover({ source: source as SessionImportSource });
			expect(discovery.warnings, source).toEqual([]);
			expect(discovery.candidates, source).toHaveLength(1);
			const preview = await service.preview(discovery.candidates[0].candidateId);
			expect(preview.messageCount, source).toBe(2);
			expect(preview.cwd, source).toBe(cwd);
			expect(
				preview.messages.map((message) => message.role),
				source,
			).toEqual(["user", "assistant"]);
			expect(await readFile(path), source).toEqual(before);
		}
	});
	it("reads both legacy and modern OpenCode schemas through a read-only snapshot", async () => {
		const { home, cwd } = await fixture();
		for (const mode of ["legacy", "modern"]) {
			const path = join(home, `${mode}.db`);
			await executeFile(process.execPath, [
				"--disable-warning=ExperimentalWarning",
				fileURLToPath(new URL("./session-import-sqlite-fixture.ts", import.meta.url)),
				path,
				mode,
				cwd,
			]);
			const bytes = await readFile(path);
			const index = await readSessionDatabase(path, "opencode");
			expect(index).toHaveLength(1);
			const snapshot = await readSessionDatabase(path, "opencode", "oc-synthetic");
			expect(JSON.stringify(snapshot)).toContain("SQLite user");
			expect(JSON.stringify(snapshot)).toContain("SQLite answer");
			expect(await readFile(path)).toEqual(bytes);
			const customPath = join(home, `${mode}-custom-session-store`);
			await rename(path, customPath);
			const custom = new SessionImportService({ home, env: { OPENCODE_DB: customPath } });
			const discovered = await custom.discover({ source: "opencode" });
			expect(discovered.candidates).toHaveLength(1);
			expect((await custom.preview(discovered.candidates[0].candidateId)).messageCount).toBe(2);
		}
	});
	it("uses environment overrides without guessing project slugs or treating OpenCode config as its data root", async () => {
		const { home } = await fixture();
		expect(sessionImportPaths("codex", home, { CODEX_HOME: join(home, "codex-custom") })).toEqual([
			join(home, "codex-custom/sessions"),
			join(home, "codex-custom/archived_sessions"),
		]);
		expect(sessionImportPaths("claude-code", home, { CLAUDE_CONFIG_DIR: join(home, "claude-custom") })).toEqual([
			join(home, "claude-custom/projects"),
		]);
		expect(sessionImportPaths("oh-my-pi", home, { OMP_PROFILE: "work" })).toEqual([
			join(home, ".omp/profiles/work/agent/sessions"),
		]);
		expect(
			sessionImportPaths("opencode", home, {
				XDG_DATA_HOME: join(home, "data"),
				OPENCODE_DB: "custom.db",
				OPENCODE_CONFIG_DIR: "ignored",
			}),
		).toEqual([join(home, "data/opencode/custom.db")]);
		expect(sessionImportPaths("opencode", home, { OPENCODE_DB: ":memory:" })).toEqual([]);
	});
	it("rejects a source changed after preview", async () => {
		const { home, cwd, service } = await fixture();
		const paths = await sources(home, cwd);
		const discovery = await service.discover({ source: "claude-code" });
		const preview = await service.preview(discovery.candidates[0].candidateId);
		await writeFile(
			paths["claude-code"],
			`${(await readFile(paths["claude-code"], "utf8")).trim()}\n${JSON.stringify({ type: "user", uuid: "new", parentUuid: "a", sessionId: "claude-example", cwd, message: { content: "new user" } })}\n`,
		);
		await expect(service.read(preview.candidateId, preview.revision)).rejects.toThrow("更新されました");
	});
	it("rejects a corrupt trailing Zstandard frame instead of importing only its valid header", async () => {
		const { home, cwd, service } = await fixture();
		const paths = await sources(home, cwd);
		const discovery = await service.discover({ source: "codex" });
		await writeFile(
			paths.codex,
			Buffer.concat([
				zstdCompressSync(
					Buffer.from(`${JSON.stringify({ type: "session_meta", payload: { id: "codex-example", cwd } })}\n`),
				),
				Buffer.from("invalid-zstd-frame"),
			]),
		);
		await expect(service.preview(discovery.candidates[0].candidateId)).rejects.toThrow();
	});
	it("selects DeepSeek's highest generation and never falls back from an unknown future version", async () => {
		const { home, cwd, service } = await fixture();
		const paths = await sources(home, cwd);
		await jsonl(join(dirname(paths["deepseek-harness"]), "session.v99.jsonl"), [
			{ type: "session", id: "deepseek-example", version: 99, cwd },
		]);
		const discovery = await service.discover({ source: "deepseek-harness" });
		expect(discovery.candidates).toHaveLength(1);
		await expect(service.preview(discovery.candidates[0].candidateId)).rejects.toThrow("99");
	});
	it("prefers a plain Codex sibling and includes inherited parent rollouts before child messages", async () => {
		const { home, cwd, service } = await fixture();
		const root = join(home, ".codex/sessions");
		const parent = join(root, "rollout-parent-id.jsonl");
		await jsonl(parent, [
			{ type: "session_meta", ordinal: 0, payload: { id: "parent-id", cwd } },
			{ type: "response_item", ordinal: 1, payload: { type: "message", role: "user", content: "inherited" } },
		]);
		await jsonl(
			`${parent}.zst`,
			[
				{ type: "session_meta", payload: { id: "parent-id", cwd } },
				{ type: "response_item", payload: { type: "message", role: "user", content: "stale compressed sibling" } },
			],
			true,
		);
		await jsonl(join(root, "rollout-child-id.jsonl"), [
			{
				type: "session_meta",
				ordinal: 0,
				payload: { id: "child-id", cwd, history_base: { thread_id: "parent-id", end_ordinal_exclusive: 2 } },
			},
			{
				type: "response_item",
				ordinal: 2,
				payload: { type: "message", role: "assistant", content: "child answer" },
			},
		]);
		const discovery = await service.discover({ source: "codex" });
		expect(discovery.candidates).toHaveLength(2);
		const preview = await service.preview(
			discovery.candidates.find((candidate) => candidate.sourceSessionId === "child-id")!.candidateId,
		);
		expect(preview.messages.map((message) => message.text)).toEqual(["inherited", "child answer"]);
	});
	it("supports manually selected large OpenCode exports and rejects opaque IDs and relative paths", async () => {
		const { home, cwd, service } = await fixture();
		const path = join(home, "export.json");
		await writeFile(
			path,
			JSON.stringify({
				info: { id: "export", directory: cwd },
				messages: [{ type: "user", text: "x".repeat(300000) }],
			}),
		);
		const discovery = await service.discover({ source: "opencode", path });
		expect(discovery.candidates).toHaveLength(1);
		expect((await service.preview(discovery.candidates[0].candidateId)).messages[0].text).toHaveLength(4000);
		await expect(service.preview("arbitrary-path")).rejects.toThrow("有効期限");
		await expect(service.discover({ source: "codex", path: "relative" })).rejects.toThrow("絶対パス");
	});
	it("does not follow directory symlinks while discovering histories", async () => {
		const { home, cwd, service } = await fixture();
		const outside = join(home, "outside");
		await mkdir(outside);
		await jsonl(join(outside, "secret.jsonl"), [{ type: "session_meta", payload: { id: "outside", cwd } }]);
		const base = join(home, ".codex/sessions");
		await mkdir(base, { recursive: true });
		await symlink(outside, join(base, "external"), process.platform === "win32" ? "junction" : "dir");
		expect((await service.discover({ source: "codex" })).candidates).toEqual([]);
	});
	it("persists imported roles, title and provenance, survives restart, deduplicates retries, and continues only on explicit prompt", async () => {
		const { home, cwd, service } = await fixture();
		await sources(home, cwd);
		const discovery = await service.discover({ source: "codex" });
		const preview = await service.preview(discovery.candidates[0].candidateId);
		const { data, revision } = await service.read(preview.candidateId, preview.revision);
		const agentDir = join(home, "target");
		const files = new WorkspaceFiles();
		let loaded = 0;
		const registry = new SessionRegistry({
			agentDir,
			workspaceFiles: files,
			adapterFactory: async (_descriptor, manager) => {
				loaded++;
				return continuationAdapter(manager);
			},
		});
		await registry.initialize();
		const workspace = await registry.addWorkspace(cwd);
		const imported = await registry.importSession(workspace.id, data, revision, { provider: "fixture", id: "model" });
		expect(loaded).toBe(0);
		expect(registry.get(imported.sessionId).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(registry.get(imported.sessionId).usage).toEqual([]);
		expect(
			(
				await Promise.all([
					registry.importSession(workspace.id, data, revision),
					registry.importSession(workspace.id, data, revision),
				])
			).map((entry) => entry.sessionId),
		).toEqual([imported.sessionId, imported.sessionId]);
		expect(registry.list()).toHaveLength(1);
		await registry.close();
		const restored = new SessionRegistry({
			agentDir,
			workspaceFiles: new WorkspaceFiles(),
			adapterFactory: async (_descriptor, manager) => {
				loaded++;
				return continuationAdapter(manager);
			},
		});
		await restored.initialize();
		expect(restored.get(imported.sessionId).title).toBe("Codex user");
		expect(restored.get(imported.sessionId).importedFrom?.source).toBe("codex");
		expect(loaded).toBe(0);
		expect(restored.get(imported.sessionId).messages.at(-1)?.content).toEqual([
			{ type: "text", text: "Codex answer" },
		]);
		const result = await restored.execute(
			imported.sessionId,
			"explicit-run",
			"Continue",
			new AbortController().signal,
		);
		expect(result.result).toBe("Continued from imported history");
		expect(loaded).toBe(1);
		await restored.close();
		expect(
			(await readdir(join(agentDir, "web-harness/sessions"))).filter((name) => name.endsWith(".jsonl")),
		).toHaveLength(1);
	});
	it("exposes authenticated discover, preview and import routes with schema and revision enforcement", async () => {
		const { home, cwd, service } = await fixture();
		await sources(home, cwd);
		const registry = new SessionRegistry({ agentDir: join(home, "target"), workspaceFiles: new WorkspaceFiles() });
		await registry.initialize();
		const workspace = await registry.addWorkspace(cwd);
		let ensured = 0;
		const host = createHttpHost({
			port: 0,
			handleApi: (request, response, url) =>
				handleSessionImport(request, response, url, service, registry, async () => {
					ensured++;
				}),
		});
		const launch = await host.listen();
		try {
			expect((await fetch(`${launch.origin}/api/session-imports/sources`)).status).toBe(401);
			const login = await fetch(launch.launchUrl, { redirect: "manual" });
			const cookie = login.headers.get("set-cookie")!.split(";")[0];
			const post = (path: string, body: unknown) =>
				fetch(`${launch.origin}${path}`, {
					method: "POST",
					headers: { Cookie: cookie, Origin: launch.origin, "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
			expect((await post("/api/session-imports/discover", { source: "unknown" })).status).toBe(400);
			const discovery = (await (
				await post("/api/session-imports/discover", { source: "oh-my-pi", workspaceId: workspace.id })
			).json()) as SessionDiscovery;
			const preview = (await (
				await post("/api/session-imports/preview", {
					candidateId: discovery.candidates[0].candidateId,
					workspaceId: workspace.id,
				})
			).json()) as SessionImportPreview;
			expect(
				(
					await post("/api/session-imports", {
						candidateId: preview.candidateId,
						revision: "stale",
						workspaceId: workspace.id,
					})
				).status,
			).toBe(409);
			const response = await post("/api/session-imports", {
				candidateId: preview.candidateId,
				revision: preview.revision,
				workspaceId: workspace.id,
			});
			expect(response.status).toBe(201);
			expect(ensured).toBe(1);
			expect(registry.list()).toHaveLength(1);
			expect(registry.list()[0].currentRun).toBeUndefined();
		} finally {
			await host.close();
			await registry.close();
		}
	});
	it("removes a newly written import when state persistence fails and permits a clean retry", async () => {
		const { home, cwd, service } = await fixture();
		await sources(home, cwd);
		const discovery = await service.discover({ source: "oh-my-pi" });
		const { data, revision } = await service.read(discovery.candidates[0].candidateId);
		const agentDir = join(home, "target");
		const registry = new SessionRegistry({ agentDir, workspaceFiles: new WorkspaceFiles() });
		await registry.initialize();
		const workspace = await registry.addWorkspace(cwd);
		const statePath = join(agentDir, "web-harness/state.json");
		const backup = `${statePath}.fixture-backup`;
		await rename(statePath, backup);
		await mkdir(statePath);
		try {
			await expect(registry.importSession(workspace.id, data, revision)).rejects.toThrow();
			expect(registry.list()).toEqual([]);
			expect(await readdir(join(agentDir, "web-harness/sessions"))).toEqual([]);
		} finally {
			await rm(statePath, { recursive: true });
			await rename(backup, statePath);
		}
		await registry.importSession(workspace.id, data, revision);
		expect(registry.list()).toHaveLength(1);
		await registry.close();
	});
});

function continuationAdapter(manager: SessionManager): ExecutionAdapter {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	return {
		subscribe: (callback) => {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
		prompt: async (text) => {
			expect(
				manager
					.buildSessionContext()
					.messages.filter((message) => message.role === "user" || message.role === "assistant"),
			).toHaveLength(2);
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			const message = fauxAssistantMessage("Continued from imported history");
			manager.appendMessage(message);
			listener?.({ type: "message_end", message });
		},
		deliverInput: async () => {},
		injectContext: async () => false,
		resumeContext: async () => {},
		hasQueuedInput: () => false,
		mutateQueuedInput: () => false,
		abort: async () => {},
		waitForIdle: async () => {},
		clearQueue: () => {},
		getActiveToolNames: () => [],
		setModel: async () => {},
		dispose: () => {},
	};
}
