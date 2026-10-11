import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { createHarnessSettings } from "./config.ts";

export const searchProviderSchema = Type.Union([
	Type.Literal("brave"),
	Type.Literal("tavily"),
	Type.Literal("exa"),
	Type.Literal("firecrawl"),
]);
export type SearchProviderId = Static<typeof searchProviderSchema>;
const modelSelectionSchema = Type.Object(
	{ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
export const settingsPatchSchema = Type.Object(
	{
		search: Type.Optional(
			Type.Object({ defaultProvider: Type.Optional(searchProviderSchema) }, { additionalProperties: false }),
		),
		teams: Type.Optional(
			Type.Object(
				{
					maxConcurrentAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
					maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
				},
				{ additionalProperties: false },
			),
		),
		llm: Type.Optional(
			Type.Object(
				{ defaultModel: Type.Optional(Type.Union([modelSelectionSchema, Type.Null()])) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type SettingsPatch = Static<typeof settingsPatchSchema>;
export interface HarnessSettings {
	search: { defaultProvider: SearchProviderId };
	teams: { maxConcurrentAgents: number; maxDepth: number };
	llm: { defaultModel?: { provider: string; id: string } };
}
export interface SettingsSnapshot extends HarnessSettings {
	search: HarnessSettings["search"] & { configured: Record<SearchProviderId, boolean> };
}
export interface ModelCatalog {
	providers: { id: string; name: string; configured: boolean; apiKey?: boolean; oauth?: { label: string } }[];
	models: { provider: string; id: string; name: string; contextWindow: number; input: string[] }[];
}
/** Deliberately exposes catalogue and process-only credentials, not Pi's auth storage. */
export type SettingsModelRuntime = Pick<
	ModelRuntime,
	"getProviders" | "getModels" | "getModel" | "getAvailableSnapshot" | "hasConfiguredAuth" | "setRuntimeApiKey"
>;

const settingsFileSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		search: Type.Object({ defaultProvider: searchProviderSchema }, { additionalProperties: false }),
		teams: Type.Object(
			{
				maxConcurrentAgents: Type.Integer({ minimum: 1, maximum: 32 }),
				maxDepth: Type.Integer({ minimum: 1, maximum: 8 }),
			},
			{ additionalProperties: false },
		),
		llm: Type.Object({ defaultModel: Type.Optional(modelSelectionSchema) }, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);
const credentialsSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		search: Type.Object(
			{
				brave: Type.Optional(Type.String({ minLength: 1 })),
				tavily: Type.Optional(Type.String({ minLength: 1 })),
				exa: Type.Optional(Type.String({ minLength: 1 })),
				firecrawl: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Cannot read ${path}; repair the file before starting the Web harness`);
	}
}

async function saveJson(path: string, data: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export class SettingsService {
	private readonly directory: string;
	private readonly agentDir: string;
	private readonly modelRuntime: SettingsModelRuntime;
	private settings: HarnessSettings;
	private credentials: Partial<Record<SearchProviderId, string>>;
	private queue: Promise<void> = Promise.resolve();

	private constructor(
		directory: string,
		agentDir: string,
		modelRuntime: SettingsModelRuntime,
		settings: HarnessSettings,
		credentials: Partial<Record<SearchProviderId, string>>,
	) {
		this.directory = directory;
		this.agentDir = agentDir;
		this.modelRuntime = modelRuntime;
		this.settings = settings;
		this.credentials = credentials;
	}

	static async open(agentDir: string, modelRuntime: SettingsModelRuntime): Promise<SettingsService> {
		const directory = join(agentDir, "web-harness");
		// Windows inherits the private application's directory ACL.
		await mkdir(directory, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") await chmod(directory, 0o700);
		const [savedSettings, savedCredentials] = await Promise.all([
			readJson(join(directory, "settings.json")),
			readJson(join(directory, "credentials.json")),
		]);
		if (savedSettings !== undefined && !Check(settingsFileSchema, savedSettings))
			throw new Error("Invalid Web harness settings.json; repair the file before starting");
		if (savedCredentials !== undefined && !Check(credentialsSchema, savedCredentials))
			throw new Error("Invalid Web harness credentials.json; repair the file before starting");
		const settings: HarnessSettings =
			savedSettings === undefined
				? { search: { defaultProvider: "brave" }, teams: { maxConcurrentAgents: 4, maxDepth: 3 }, llm: {} }
				: { search: savedSettings.search, teams: savedSettings.teams, llm: savedSettings.llm };
		if (savedCredentials !== undefined && process.platform !== "win32")
			await chmod(join(directory, "credentials.json"), 0o600);
		return new SettingsService(directory, agentDir, modelRuntime, settings, savedCredentials?.search ?? {});
	}

	get(cwd?: string): SettingsSnapshot {
		const defaultModel = cwd ? this.getEffectiveDefaultModel(cwd) : this.settings.llm.defaultModel;
		return {
			search: {
				...this.settings.search,
				configured: {
					brave: Boolean(this.credentials.brave),
					tavily: Boolean(this.credentials.tavily),
					exa: Boolean(this.credentials.exa),
					firecrawl: Boolean(this.credentials.firecrawl),
				},
			},
			teams: { ...this.settings.teams },
			llm: defaultModel ? { defaultModel: { ...defaultModel } } : {},
		};
	}

	/** Resolve a new conversation's model using only Hasilan Code settings. */
	getEffectiveDefaultModel(cwd: string): HarnessSettings["llm"]["defaultModel"] {
		if (this.settings.llm.defaultModel) return { ...this.settings.llm.defaultModel };
		const agentSettings = createHarnessSettings(cwd, this.agentDir);
		const provider = agentSettings.getDefaultProvider();
		const id = agentSettings.getDefaultModel();
		// Match Pi's initial-model policy: saved defaults require configured auth.
		if (provider && id && this.modelRuntime.getModel(provider, id) && this.modelRuntime.hasConfiguredAuth(provider))
			return { provider, id };
		// The SDK's available snapshot contains authenticated chat models, not the full catalogue.
		const available = this.modelRuntime
			.getAvailableSnapshot()
			.find((model) => this.modelRuntime.hasConfiguredAuth(model.provider));
		return available ? { provider: available.provider, id: available.id } : undefined;
	}

	patch(patch: unknown): Promise<SettingsSnapshot> {
		if (!Check(settingsPatchSchema, patch))
			return Promise.reject(new Error("Invalid settings; concurrency must be 1..32 and depth 1..8"));
		return this.enqueue(async () => {
			const selection = patch.llm?.defaultModel;
			if (selection && !this.modelRuntime.getModel(selection.provider, selection.id))
				throw new Error("Unknown model; select a model in the composer");
			const next: HarnessSettings = {
				search: { ...this.settings.search, ...patch.search },
				teams: { ...this.settings.teams, ...patch.teams },
				llm: selection === null ? {} : selection ? { defaultModel: { ...selection } } : { ...this.settings.llm },
			};
			await saveJson(join(this.directory, "settings.json"), { schemaVersion: 1, ...next });
			this.settings = next;
			return this.get();
		});
	}

	/** Host-only: never serialize this value into HTTP, WS, tool details, or logs. */
	getSearchKey(provider: SearchProviderId): string | undefined {
		return this.credentials[provider];
	}

	setSearchKey(provider: SearchProviderId, key: string): Promise<void> {
		if (provider !== "brave" && provider !== "tavily" && provider !== "exa" && provider !== "firecrawl")
			return Promise.reject(new Error("Unknown search provider"));
		if (typeof key !== "string" || !key.trim())
			return Promise.reject(new Error("API key must not be empty; use Delete to remove a saved key"));
		return this.enqueue(async () => {
			const next = { ...this.credentials, [provider]: key.trim() };
			await saveJson(join(this.directory, "credentials.json"), { schemaVersion: 1, search: next });
			this.credentials = next;
		});
	}

	deleteSearchKey(provider: SearchProviderId): Promise<void> {
		if (provider !== "brave" && provider !== "tavily" && provider !== "exa" && provider !== "firecrawl")
			return Promise.reject(new Error("Unknown search provider"));
		return this.enqueue(async () => {
			const next = { ...this.credentials };
			delete next[provider];
			await saveJson(join(this.directory, "credentials.json"), { schemaVersion: 1, search: next });
			this.credentials = next;
		});
	}

	getModels(): ModelCatalog {
		return {
			providers: this.modelRuntime.getProviders().map((provider) => ({
				id: provider.id,
				name: provider.name,
				configured: this.modelRuntime.hasConfiguredAuth(provider.id),
				apiKey: Boolean(provider.auth.apiKey),
				...(provider.auth.oauth
					? { oauth: { label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name } }
					: {}),
			})),
			models: this.modelRuntime.getModels().map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				thinkingLevels: getSupportedThinkingLevels(model),
				input: [...model.input],
			})),
		};
	}

	async setRuntimeApiKey(providerId: string, key: string): Promise<void> {
		if (!this.modelRuntime.getProviders().some((provider) => provider.id === providerId))
			throw new Error("Unknown model provider; select a provider from Settings");
		if (typeof key !== "string" || !key.trim()) throw new Error("Runtime API key must not be empty");
		try {
			await this.modelRuntime.setRuntimeApiKey(providerId, key.trim());
		} catch {
			// SDK credential synchronization errors can carry the credential itself.
			throw new Error("Runtime credential synchronization failed; check provider configuration in Settings");
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
