import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SettingsModelRuntime, SettingsService } from "../src/server/settings.ts";

describe("Web harness settings", () => {
	let directory: string;
	let runtime: SettingsModelRuntime;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-web-settings-"));
		const catalog = await ModelRuntime.create({
			refreshOnCreate: false,
			modelsPath: null,
			authPath: join(directory, "auth.json"),
		});
		runtime = {
			getProviders: catalog.getProviders.bind(catalog),
			getModels: catalog.getModels.bind(catalog),
			getModel: catalog.getModel.bind(catalog),
			getAvailableSnapshot: () => [],
			hasConfiguredAuth: () => false,
			setRuntimeApiKey: vi.fn(async () => undefined),
		};
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("persists independent keys and settings without exposing credentials", async () => {
		const settings = await SettingsService.open(directory, runtime);
		expect(settings.get().teams).toEqual({ maxConcurrentAgents: 4, maxDepth: 3 });
		await Promise.all([
			settings.setSearchKey("brave", "private-brave"),
			settings.setSearchKey("tavily", "private-tavily"),
		]);
		await settings.patch({ search: { defaultProvider: "tavily" }, teams: { maxConcurrentAgents: 1 } });
		const restored = await SettingsService.open(directory, runtime);
		expect(restored.get().search).toEqual({ defaultProvider: "tavily", configured: { brave: true, tavily: true } });
		expect(restored.get().teams).toEqual({ maxConcurrentAgents: 1, maxDepth: 3 });
		expect(restored.getSearchKey("tavily")).toBe("private-tavily");
		expect(JSON.stringify(restored.get())).not.toContain("private-");
		expect(await readFile(join(directory, "web-harness", "settings.json"), "utf8")).not.toContain("private-");
		if (process.platform !== "win32")
			expect((await stat(join(directory, "web-harness", "credentials.json"))).mode & 0o777).toBe(0o600);
		await expect(restored.setSearchKey("tavily", " ")).rejects.toThrow("must not be empty");
		expect(restored.getSearchKey("tavily")).toBe("private-tavily");
		await restored.deleteSearchKey("brave");
		expect((await SettingsService.open(directory, runtime)).get().search.configured).toEqual({
			brave: false,
			tavily: true,
		});
	});

	it("validates limits and model defaults and returns independent snapshots", async () => {
		const settings = await SettingsService.open(directory, runtime);
		await expect(settings.patch({ teams: { maxDepth: 9 } })).rejects.toThrow("Invalid settings");
		await expect(settings.patch({ llm: { defaultModel: { provider: "missing", id: "none" } } })).rejects.toThrow(
			"Unknown model",
		);
		const model = settings.getModels().models[0];
		expect(model).toBeDefined();
		await settings.patch({ llm: { defaultModel: { provider: model.provider, id: model.id } } });
		const snapshot = settings.get();
		snapshot.teams.maxConcurrentAgents = 31;
		expect(settings.get().teams.maxConcurrentAgents).toBe(4);
		expect((await SettingsService.open(directory, runtime)).get().llm.defaultModel).toEqual({
			provider: model.provider,
			id: model.id,
		});
		await settings.patch({ llm: { defaultModel: null } });
		expect(settings.get().llm.defaultModel).toBeUndefined();
	});

	it("does not replace malformed saved state", async () => {
		await SettingsService.open(directory, runtime);
		const path = join(directory, "web-harness", "settings.json");
		await writeFile(path, "broken-secret-json", "utf8");
		await expect(SettingsService.open(directory, runtime)).rejects.toThrow("repair the file");
		expect(await readFile(path, "utf8")).toBe("broken-secret-json");
	});

	it("uses process-only SDK keys and redacts credential-bearing failures", async () => {
		const settings = await SettingsService.open(directory, runtime);
		const provider = settings.getModels().providers[0].id;
		await settings.setRuntimeApiKey(provider, "temporary-key");
		expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith(provider, "temporary-key");
		expect(JSON.stringify(settings.getModels())).not.toContain("temporary-key");
		vi.mocked(runtime.setRuntimeApiKey).mockRejectedValueOnce(
			Object.assign(new Error("secret-credential"), { credential: { key: "secret-credential" } }),
		);
		let failure: unknown;
		try {
			await settings.setRuntimeApiKey(provider, "secret-credential");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain("secret-credential");
		expect(failure).not.toHaveProperty("cause");
		expect(failure).not.toHaveProperty("credential");
	});
});
