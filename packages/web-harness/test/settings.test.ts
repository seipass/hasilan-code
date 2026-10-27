import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@hasilan-code/pi-ai";
import { ModelRuntime } from "@hasilan-code/pi-coding-agent";
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
			getModelsOfType: catalog.getModelsOfType.bind(catalog),
			hasConfiguredAuth: () => false,
			saveApiKey: vi.fn(async () => undefined),
		};
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("persists the Jev provider and model independently from credentials and other settings", async () => {
		const settings = await SettingsService.open(directory, runtime);
		expect(settings.get().jev).toEqual({ configured: false });
		const model = { provider: "commandcode", id: "typesafe/jev" };
		await settings.patch({ jev: { model } });
		await settings.setSearchKey("tavily", "private-tavily");
		await settings.patch({ teams: { maxDepth: 5 } });
		const restored = await SettingsService.open(directory, runtime);
		expect(restored.get().jev).toEqual({ configured: false, model });
		runtime.hasConfiguredAuth = (provider) => provider === "commandcode";
		expect(restored.get().jev.configured).toBe(true);
		expect(JSON.stringify(restored.get())).not.toContain("private-");
		expect(await readFile(join(directory, "web-harness", "credentials.json"), "utf8")).not.toContain("jev");
		await restored.patch({ jev: { model: null } });
		const deleted = await SettingsService.open(directory, runtime);
		expect(deleted.get().jev.model).toBeUndefined();
		expect(deleted.get().teams.maxDepth).toBe(5);
		expect(deleted.getSearchKey("tavily")).toBe("private-tavily");
	});

	it("lists Jev across providers and rejects non-Jev or nonexistent selections", async () => {
		const settings = await SettingsService.open(directory, runtime);
		const classifiers = settings.getModels().classifiers;
		for (const provider of [
			"commandcode",
			"openrouter",
			"opencode",
			"typesafe",
			"vercel-ai-gateway",
			"cloudflare-workers-ai",
		])
			expect(classifiers.some((model) => model.provider === provider)).toBe(true);
		expect(classifiers.every((model) => model.id.includes("jev"))).toBe(true);
		expect(
			classifiers.some((classifier) =>
				settings
					.getModels()
					.models.some((model) => model.provider === classifier.provider && model.id === classifier.id),
			),
		).toBe(false);
		await expect(settings.patch({ jev: { model: { provider: "commandcode", id: "gpt-6.1-sol" } } })).rejects.toThrow(
			"Jevモデル",
		);
		await expect(settings.patch({ jev: { model: { provider: "missing", id: "jev" } } })).rejects.toThrow("Jevモデル");
		expect(settings.get().jev.model).toBeUndefined();
	});

	it("persists independent keys and settings without exposing credentials", async () => {
		const settings = await SettingsService.open(directory, runtime);
		expect(settings.get().teams).toEqual({ maxConcurrentAgents: 4, maxDepth: 3 });
		await Promise.all([
			settings.setSearchKey("brave", "private-brave"),
			settings.setSearchKey("tavily", "private-tavily"),
			settings.setSearchKey("exa", "private-exa"),
			settings.setSearchKey("firecrawl", "private-firecrawl"),
		]);
		await settings.patch({ search: { defaultProvider: "firecrawl" }, teams: { maxConcurrentAgents: 1 } });
		const restored = await SettingsService.open(directory, runtime);
		expect(restored.get().search).toEqual({
			defaultProvider: "firecrawl",
			configured: { brave: true, tavily: true, exa: true, firecrawl: true },
		});
		expect(restored.get().teams).toEqual({ maxConcurrentAgents: 1, maxDepth: 3 });
		expect(restored.getSearchKey("firecrawl")).toBe("private-firecrawl");
		expect(JSON.stringify(restored.get())).not.toContain("private-");
		expect(await readFile(join(directory, "web-harness", "settings.json"), "utf8")).not.toContain("private-");
		if (process.platform !== "win32")
			expect((await stat(join(directory, "web-harness", "credentials.json"))).mode & 0o777).toBe(0o600);
		await expect(restored.setSearchKey("tavily", " ")).rejects.toThrow("must not be empty");
		expect(restored.getSearchKey("tavily")).toBe("private-tavily");
		await restored.deleteSearchKey("exa");
		expect((await SettingsService.open(directory, runtime)).get().search.configured).toEqual({
			brave: true,
			tavily: true,
			exa: false,
			firecrawl: true,
		});
	});

	it("validates limits, rejects removed model settings, and returns independent snapshots", async () => {
		const settings = await SettingsService.open(directory, runtime);
		await expect(settings.patch({ teams: { maxDepth: 9 } })).rejects.toThrow("Invalid settings");
		await expect(settings.patch({ llm: { defaultModel: { provider: "missing", id: "none" } } })).rejects.toThrow(
			"Invalid settings",
		);
		await settings.patch({ teams: { maxDepth: 2 } });
		const snapshot = settings.get();
		snapshot.teams.maxConcurrentAgents = 31;
		snapshot.search.defaultProvider = "exa";
		snapshot.search.configured.brave = true;
		expect(settings.get().teams).toEqual({ maxConcurrentAgents: 4, maxDepth: 2 });
		expect(settings.get().search.defaultProvider).toBe("brave");
		expect(settings.get().search.configured.brave).toBe(false);
		expect((await SettingsService.open(directory, runtime)).get()).not.toHaveProperty("llm");
		expect(JSON.parse(await readFile(join(directory, "web-harness", "settings.json"), "utf8"))).toEqual({
			schemaVersion: 1,
			search: { defaultProvider: "brave" },
			teams: { maxConcurrentAgents: 4, maxDepth: 2 },
		});
	});

	it.each([{}, { defaultModel: { provider: "retired-provider", id: "retired-model" } }])(
		"removes saved legacy model settings while preserving search and team settings: %j",
		async (llm) => {
			await SettingsService.open(directory, runtime);
			const path = join(directory, "web-harness", "settings.json");
			const retained = {
				schemaVersion: 1,
				search: { defaultProvider: "tavily" },
				teams: { maxConcurrentAgents: 7, maxDepth: 5 },
			};
			await writeFile(path, JSON.stringify({ ...retained, llm }));
			const settings = await SettingsService.open(directory, runtime);
			expect(settings.get()).not.toHaveProperty("llm");
			expect(settings.get().search.defaultProvider).toBe("tavily");
			expect(settings.get().teams).toEqual(retained.teams);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual(retained);
			expect((await SettingsService.open(directory, runtime)).get()).toEqual(settings.get());
		},
	);

	it("does not migrate legacy model settings when the remaining settings are invalid", async () => {
		await SettingsService.open(directory, runtime);
		const path = join(directory, "web-harness", "settings.json");
		const saved = JSON.stringify({
			schemaVersion: 1,
			search: { defaultProvider: "brave" },
			teams: { maxConcurrentAgents: 0, maxDepth: 3 },
			llm: { defaultModel: { provider: "retired-provider", id: "retired-model" } },
		});
		await writeFile(path, saved);
		await expect(SettingsService.open(directory, runtime)).rejects.toThrow("Invalid Web harness settings.json");
		expect(await readFile(path, "utf8")).toBe(saved);
	});

	it("does not replace malformed saved state", async () => {
		await SettingsService.open(directory, runtime);
		const path = join(directory, "web-harness", "settings.json");
		await writeFile(path, "broken-secret-json", "utf8");
		await expect(SettingsService.open(directory, runtime)).rejects.toThrow("repair the file");
		expect(await readFile(path, "utf8")).toBe("broken-secret-json");
	});

	it("saves SDK keys and redacts credential-bearing failures", async () => {
		const settings = await SettingsService.open(directory, runtime);
		const provider = "commandcode";
		await settings.saveApiKey(provider, " saved-key ");
		expect(runtime.saveApiKey).toHaveBeenCalledWith(provider, "saved-key");
		expect(JSON.stringify(settings.getModels())).not.toContain("saved-key");
		await expect(settings.saveApiKey(provider, " ")).rejects.toThrow("must not be empty");
		await expect(settings.saveApiKey("missing", "saved-key")).rejects.toThrow("supports API keys");
		vi.mocked(runtime.saveApiKey).mockRejectedValueOnce(
			Object.assign(new Error("secret-credential"), { credential: { key: "secret-credential" } }),
		);
		let failure: unknown;
		try {
			await settings.saveApiKey(provider, "secret-credential");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain("secret-credential");
		expect(failure).not.toHaveProperty("cause");
		expect(failure).not.toHaveProperty("credential");
	});

	it("retains keys after recreating the runtime, preserving provider metadata and unrelated credentials", async () => {
		const authPath = join(directory, "auth.json");
		const providerEnv = { CLOUDFLARE_ACCOUNT_ID: "account-id" };
		const other = { type: "api_key", key: "private-other-key" };
		await writeFile(
			authPath,
			JSON.stringify({ commandcode: { type: "api_key", key: "old-key", env: providerEnv }, anthropic: other }),
		);
		const persistent = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
		await persistent.setRuntimeApiKey("commandcode", "old-runtime-key");
		const settings = await SettingsService.open(directory, persistent);
		await settings.patch({ jev: { model: { provider: "commandcode", id: "typesafe/jev" } } });
		await settings.saveApiKey("commandcode", "private-persisted-key");
		expect((await persistent.getAuth("commandcode"))?.auth.apiKey).toBe("private-persisted-key");
		expect(persistent.getProviderAuthStatus("commandcode").source).toBe("stored");
		const stored = JSON.parse(await readFile(authPath, "utf8"));
		expect(stored.commandcode).toEqual({ type: "api_key", key: "private-persisted-key", env: providerEnv });
		expect(stored.anthropic).toEqual(other);
		const restarted = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
		await restarted.refresh({ providers: ["commandcode"], allowNetwork: false });
		const restored = await SettingsService.open(directory, restarted);
		expect((await restarted.getAuth("commandcode"))?.auth.apiKey).toBe("private-persisted-key");
		expect(restored.getModels().providers.find((provider) => provider.id === "commandcode")?.configured).toBe(true);
		expect(restored.get().jev.configured).toBe(true);
		expect(JSON.stringify({ settings: restored.get(), models: restored.getModels() })).not.toContain("private-");
		expect(await readFile(join(directory, "web-harness", "settings.json"), "utf8")).not.toContain("private-");
		if (process.platform !== "win32") expect((await stat(authPath)).mode & 0o777).toBe(0o600);
	});

	it("keeps the active and saved keys when a credential write fails", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("commandcode", async () => ({ type: "api_key", key: "previous-key" }));
		const persistent = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		await persistent.setRuntimeApiKey("commandcode", "active-runtime-key");
		const settings = await SettingsService.open(directory, persistent);
		vi.spyOn(credentials, "modify").mockRejectedValueOnce(new Error("private-write-failure"));
		await expect(settings.saveApiKey("commandcode", "new-key")).rejects.toThrow("could not be saved");
		expect((await persistent.getAuth("commandcode"))?.auth.apiKey).toBe("active-runtime-key");
		expect(await credentials.read("commandcode")).toEqual({ type: "api_key", key: "previous-key" });
	});

	it("reports account and API-key capabilities independently without resolving stored secrets", async () => {
		const template = runtime.getProviders()[0];
		const loadSecret = vi.fn(async () => {
			throw new Error("private-provider-secret");
		});
		runtime.getProviders = () => [
			{
				...template,
				id: "account-only",
				auth: {
					oauth: {
						name: "Account subscription",
						loginLabel: "Sign in with account",
						login: loadSecret,
						refresh: loadSecret,
						toAuth: loadSecret,
					},
				},
			},
			{
				...template,
				id: "key-only",
				auth: { apiKey: { name: "API key", login: loadSecret, resolve: loadSecret } },
			},
			{
				...template,
				id: "both",
				auth: {
					apiKey: { name: "API key", resolve: loadSecret },
					oauth: { name: "Subscription account", login: loadSecret, refresh: loadSecret, toAuth: loadSecret },
				},
			},
		];
		runtime.hasConfiguredAuth = (provider) => provider === "account-only";
		const settings = await SettingsService.open(directory, runtime);
		const providers = settings.getModels().providers;
		const account = providers.find((provider) => provider.id === "account-only");
		expect(account?.apiKey).toBe(false);
		expect(account?.oauth?.label).toBe("Sign in with account");
		expect(account?.configured).toBe(true);
		const key = providers.find((provider) => provider.id === "key-only");
		expect(key?.apiKey).toBe(true);
		expect(key?.oauth).toBeUndefined();
		expect(key?.configured).toBe(false);
		const both = providers.find((provider) => provider.id === "both");
		expect(both?.apiKey).toBe(true);
		expect(both?.oauth?.label).toBe("Subscription account");
		expect(both?.configured).toBe(false);
		expect(loadSecret).not.toHaveBeenCalled();
		expect(JSON.stringify(providers)).not.toContain("private-");
	});
});
