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
