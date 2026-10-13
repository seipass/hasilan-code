import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../src/server/session-registry.ts";
import { SettingsService } from "../src/server/settings.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";
import { sessionCreateSchema } from "../src/shared/contracts.ts";

describe("model onboarding", () => {
	let root: string;
	let cwd: string;
	let runtime: ModelRuntime;
	let settings: SettingsService;
	let registry: SessionRegistry;
	let workspaceId: string;
	let configured: Set<string>;
	let models: readonly Model<Api>[];

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-web-onboarding-"));
		cwd = join(root, "workspace");
		await mkdir(join(cwd, ".hasilan-code"), { recursive: true });
		runtime = await ModelRuntime.create({
			refreshOnCreate: false,
			modelsPath: null,
			authPath: join(root, "auth.json"),
		});
		models = runtime.getModels().slice(0, 3);
		configured = new Set(models.map((model) => model.provider));
		vi.spyOn(runtime, "hasConfiguredAuth").mockImplementation((provider) => configured.has(provider));
		vi.spyOn(runtime, "getAvailableSnapshot").mockImplementation(() => models);
		settings = await SettingsService.open(root, runtime);
		registry = new SessionRegistry({
			agentDir: root,
			modelRuntime: runtime,
			workspaceFiles: new WorkspaceFiles(),
		});
		await registry.initialize();
		workspaceId = (await registry.addWorkspace(cwd)).id;
	});

	afterEach(async () => {
		await registry.close();
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	});

	it("leaves new conversations unselected despite saved Web, global, and workspace defaults", async () => {
		await writeFile(
			join(root, "settings.json"),
			JSON.stringify({ defaultProvider: models[0].provider, defaultModel: models[0].id }),
		);
		await writeFile(
			join(cwd, ".hasilan-code", "settings.json"),
			JSON.stringify({ defaultProvider: models[1].provider, defaultModel: models[1].id }),
		);
		await writeFile(
			join(root, "web-harness", "settings.json"),
			JSON.stringify({
				schemaVersion: 1,
				search: { defaultProvider: "brave" },
				teams: { maxConcurrentAgents: 4, maxDepth: 3 },
				llm: { defaultModel: { provider: models[2].provider, id: models[2].id } },
			}),
		);
		settings = await SettingsService.open(root, runtime);
		expect(settings.get()).not.toHaveProperty("llm");
		expect((await registry.create({ workspaceId })).model).toBeUndefined();
		const otherCwd = join(root, "other-workspace");
		await mkdir(otherCwd);
		const other = await registry.addWorkspace(otherCwd);
		expect((await registry.create({ workspaceId: other.id })).model).toBeUndefined();
		expect(runtime.getAvailableSnapshot).not.toHaveBeenCalled();
	});

	it("persists explicit draft and session selections independently across restart", async () => {
		const first = await registry.create({ workspaceId });
		const draft = { provider: models[1].provider, id: models[1].id };
		const chosen = await registry.create({ workspaceId, model: draft });
		draft.id = "caller-mutated-id";
		expect(registry.get(chosen.sessionId).model).toEqual({ provider: models[1].provider, id: models[1].id });
		expect(registry.get(first.sessionId).model).toBeUndefined();
		const selection = { provider: models[2].provider, id: models[2].id };
		await registry.setModel(first.sessionId, selection);
		selection.id = "caller-mutated-id";
		expect(registry.get(first.sessionId).model).toEqual({ provider: models[2].provider, id: models[2].id });
		expect(registry.get(chosen.sessionId).model).toEqual(chosen.model);
		const unselected = await registry.create({ workspaceId });
		const saved = JSON.parse(await readFile(join(root, "web-harness", "state.json"), "utf8"));
		expect(
			saved.sessions.find((session: { sessionId: string }) => session.sessionId === chosen.sessionId).model,
		).toEqual(chosen.model);
		await registry.close();
		registry = new SessionRegistry({
			agentDir: root,
			modelRuntime: runtime,
			workspaceFiles: new WorkspaceFiles(),
		});
		await registry.initialize();
		expect(registry.get(first.sessionId).model).toEqual({ provider: models[2].provider, id: models[2].id });
		expect(registry.get(chosen.sessionId).model).toEqual(chosen.model);
		expect(registry.get(unselected.sessionId).model).toBeUndefined();
	});

	it("rejects an unknown draft model before creating or persisting a conversation", async () => {
		const before = await readFile(join(root, "web-harness", "state.json"), "utf8");
		await expect(registry.create({ workspaceId, model: { provider: "unknown", id: "missing" } })).rejects.toThrow(
			"Model not found",
		);
		expect(registry.list()).toEqual([]);
		expect(await readFile(join(root, "web-harness", "state.json"), "utf8")).toBe(before);
		expect(Check(sessionCreateSchema, { model: { provider: models[0].provider, id: models[0].id } })).toBe(false);
		expect(Check(sessionCreateSchema, { workspaceId, model: { provider: models[0].provider } })).toBe(false);
		expect(
			Check(sessionCreateSchema, { workspaceId, model: { provider: models[0].provider, id: models[0].id } }),
		).toBe(true);
	});

	it("requires an explicit selection before execution even when authenticated models are available", async () => {
		const session = await registry.create({ workspaceId });
		expect(session.model).toBeUndefined();
		const result = await registry.execute(session.sessionId, "test-run", "hello", new AbortController().signal);
		expect(result.error).toContain("No model selected");
		expect(registry.get(session.sessionId).messages).toEqual([]);
		expect(registry.get(session.sessionId).materialized).toBe(false);
		expect(runtime.getAvailableSnapshot).not.toHaveBeenCalled();
	});

	it("reports live provider credential status as booleans without exposing credentials", async () => {
		const provider = models[0].provider;
		expect(settings.getModels().providers.find((item) => item.id === provider)?.configured).toBe(true);
		configured.clear();
		expect(settings.getModels().providers.find((item) => item.id === provider)?.configured).toBe(false);
		expect(settings.getModels().providers.every((item) => typeof item.configured === "boolean")).toBe(true);
	});
});
