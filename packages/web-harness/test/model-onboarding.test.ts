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
		await mkdir(join(cwd, ".pi"), { recursive: true });
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
			getDefaultModel: (workspaceCwd) => settings.getEffectiveDefaultModel(workspaceCwd),
		});
		await registry.initialize();
		workspaceId = (await registry.addWorkspace(cwd)).id;
	});

	afterEach(async () => {
		await registry.close();
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	});

	it("inherits the relevant Pi workspace default without persisting an incidental Web default", async () => {
		const globalModel = models[0];
		const projectModel = models[1];
		await writeFile(
			join(root, "settings.json"),
			JSON.stringify({ defaultProvider: globalModel.provider, defaultModel: globalModel.id }),
		);
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ defaultProvider: projectModel.provider, defaultModel: projectModel.id }),
		);
		const selected = { provider: projectModel.provider, id: projectModel.id };
		expect(settings.get(cwd).llm.defaultModel).toEqual(selected);
		expect((await registry.create({ workspaceId })).model).toEqual(selected);
		vi.mocked(runtime.getAvailableSnapshot).mockReturnValue([]);
		expect(settings.getEffectiveDefaultModel(cwd)).toEqual(selected);
		const otherCwd = join(root, "other-workspace");
		await mkdir(otherCwd);
		const other = await registry.addWorkspace(otherCwd);
		expect((await registry.create({ workspaceId: other.id })).model).toEqual({
			provider: globalModel.provider,
			id: globalModel.id,
		});
		await expect(readFile(join(root, "web-harness", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
		await settings.patch({ teams: { maxDepth: 2 } });
		expect(JSON.parse(await readFile(join(root, "web-harness", "settings.json"), "utf8")).llm).toEqual({});
	});

	it("honors explicit draft and Web defaults without changing previously created conversations", async () => {
		const first = await registry.create({ workspaceId });
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ defaultProvider: models[0].provider, defaultModel: models[0].id }),
		);
		const web = { provider: models[1].provider, id: models[1].id };
		const draft = { provider: models[2].provider, id: models[2].id };
		await settings.patch({ llm: { defaultModel: web } });
		expect(settings.get(cwd).llm.defaultModel).toEqual(web);
		expect((await registry.create({ workspaceId })).model).toEqual(web);
		const chosen = await registry.create({ workspaceId, model: draft });
		draft.id = "caller-mutated-id";
		expect(registry.get(chosen.sessionId).model).toEqual({ provider: models[2].provider, id: models[2].id });
		expect(registry.get(first.sessionId).model).toEqual(first.model);
		await settings.patch({ llm: { defaultModel: null } });
		expect(registry.get(chosen.sessionId).model).toEqual(chosen.model);
		const saved = JSON.parse(await readFile(join(root, "web-harness", "state.json"), "utf8"));
		expect(
			saved.sessions.find((session: { sessionId: string }) => session.sessionId === chosen.sessionId).model,
		).toEqual(chosen.model);
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

	it("skips unavailable Pi defaults and never chooses from the unauthenticated catalogue", async () => {
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ defaultProvider: "unknown", defaultModel: "missing" }),
		);
		expect(settings.get(cwd).llm.defaultModel).toEqual({ provider: models[0].provider, id: models[0].id });
		configured.clear();
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ defaultProvider: models[0].provider, defaultModel: models[0].id }),
		);
		expect(settings.get(cwd).llm.defaultModel).toBeUndefined();
		const session = await registry.create({ workspaceId });
		expect(session.model).toBeUndefined();
		const result = await registry.execute(session.sessionId, "test-run", "hello", new AbortController().signal);
		expect(result.error).toContain("No model selected");
		expect(registry.get(session.sessionId).messages).toEqual([]);
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ defaultProvider: "unknown", defaultModel: "missing" }),
		);
		configured.add(models[0].provider);
		vi.mocked(runtime.getAvailableSnapshot).mockReturnValue([]);
		expect(settings.get(cwd).llm.defaultModel).toBeUndefined();
	});

	it("reports live provider credential status as booleans without exposing credentials", async () => {
		const provider = models[0].provider;
		expect(settings.getModels().providers.find((item) => item.id === provider)?.configured).toBe(true);
		configured.clear();
		expect(settings.getModels().providers.find((item) => item.id === provider)?.configured).toBe(false);
		expect(settings.getModels().providers.every((item) => typeof item.configured === "boolean")).toBe(true);
		expect(Object.keys(settings.getModels().providers[0]).sort()).toEqual(["configured", "id", "name"]);
	});
});
