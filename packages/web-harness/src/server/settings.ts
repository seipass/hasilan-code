import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@hasilan-code/pi-ai";
import type { ModelRuntime } from "@hasilan-code/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { isJevModel, type JevSelection, type JevStatus, jevSelectionSchema } from "../shared/workspace-routing.ts";

export const searchProviderSchema = Type.Union([
	Type.Literal("brave"),
	Type.Literal("tavily"),
	Type.Literal("exa"),
	Type.Literal("firecrawl"),
]);
export type SearchProviderId = Static<typeof searchProviderSchema>;
export const settingsPatchSchema = Type.Object(
	{
		jev: Type.Optional(
			Type.Object({ model: Type.Union([jevSelectionSchema, Type.Null()]) }, { additionalProperties: false }),
		),
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
	},
	{ additionalProperties: false },
);
export type SettingsPatch = Static<typeof settingsPatchSchema>;
export interface HarnessSettings {
	jev?: { model?: JevSelection };
	search: { defaultProvider: SearchProviderId };
	teams: { maxConcurrentAgents: number; maxDepth: number };
}
export interface SettingsSnapshot extends HarnessSettings {
	search: HarnessSettings["search"] & { configured: Record<SearchProviderId, boolean> };
	jev: JevStatus;
}
export interface ModelCatalog {
	classifiers: { provider: string; id: string; name: string }[];
	providers: { id: string; name: string; configured: boolean; apiKey?: boolean; oauth?: { label: string } }[];
	models: { provider: string; id: string; name: string; contextWindow: number; input: string[] }[];
}
/** Exposes catalogue and credential writes without access to saved secrets. */
export type SettingsModelRuntime = Pick<
	ModelRuntime,
	"getProviders" | "getModels" | "getModelsOfType" | "hasConfiguredAuth" | "saveApiKey"
>;

const settingsFileSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		jev: Type.Optional(Type.Object({ model: jevSelectionSchema }, { additionalProperties: false })),
		search: Type.Object({ defaultProvider: searchProviderSchema }, { additionalProperties: false }),
		teams: Type.Object(
			{
				maxConcurrentAgents: Type.Integer({ minimum: 1, maximum: 32 }),
				maxDepth: Type.Integer({ minimum: 1, maximum: 8 }),
			},
			{ additionalProperties: false },
		),
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
	private readonly modelRuntime: SettingsModelRuntime;
	private settings: HarnessSettings;
	private credentials: Partial<Record<SearchProviderId, string>>;
	private queue: Promise<void> = Promise.resolve();

	private constructor(
		directory: string,
		modelRuntime: SettingsModelRuntime,
		settings: HarnessSettings,
		credentials: Partial<Record<SearchProviderId, string>>,
	) {
		this.directory = directory;
		this.modelRuntime = modelRuntime;
		this.settings = settings;
		this.credentials = credentials;
	}

	static async open(agentDir: string, modelRuntime: SettingsModelRuntime): Promise<SettingsService> {
		const directory = join(agentDir, "web-harness");
		// Windows inherits the private application's directory ACL.
		await mkdir(directory, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") await chmod(directory, 0o700);
		const [storedSettings, savedCredentials] = await Promise.all([
			readJson(join(directory, "settings.json")),
			readJson(join(directory, "credentials.json")),
		]);
		let savedSettings = storedSettings;
		if (savedSettings && typeof savedSettings === "object" && "llm" in savedSettings) {
			// Retire the saved model default without changing the remaining settings format.
			const currentSettings: Record<string, unknown> = { ...savedSettings };
			delete currentSettings.llm;
			savedSettings = currentSettings;
		}
		if (savedSettings !== undefined && !Check(settingsFileSchema, savedSettings))
			throw new Error("Invalid Web harness settings.json; repair the file before starting");
		if (savedCredentials !== undefined && !Check(credentialsSchema, savedCredentials))
			throw new Error("Invalid Web harness credentials.json; repair the file before starting");
		const settings: HarnessSettings =
			savedSettings === undefined
				? { search: { defaultProvider: "brave" }, teams: { maxConcurrentAgents: 4, maxDepth: 3 } }
				: {
						search: savedSettings.search,
						teams: savedSettings.teams,
						...(savedSettings.jev ? { jev: savedSettings.jev } : {}),
					};
		if (savedCredentials !== undefined && process.platform !== "win32")
			await chmod(join(directory, "credentials.json"), 0o600);
		if (savedSettings !== storedSettings)
			await saveJson(join(directory, "settings.json"), { schemaVersion: 1, ...settings });
		return new SettingsService(directory, modelRuntime, settings, savedCredentials?.search ?? {});
	}

	get(): SettingsSnapshot {
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
			jev: {
				...(this.settings.jev?.model ? { model: { ...this.settings.jev.model } } : {}),
				configured:
					!!this.settings.jev?.model && this.modelRuntime.hasConfiguredAuth(this.settings.jev.model.provider),
			},
		};
	}

	patch(patch: unknown): Promise<SettingsSnapshot> {
		if (!Check(settingsPatchSchema, patch))
			return Promise.reject(new Error("Invalid settings; concurrency must be 1..32 and depth 1..8"));
		return this.enqueue(async () => {
			if (
				patch.jev?.model &&
				!this.modelRuntime
					.getModelsOfType("classifier")
					.some(
						(model) =>
							isJevModel(model) &&
							model.provider === patch.jev?.model?.provider &&
							model.id === patch.jev?.model?.id,
					)
			)
				throw new Error("利用できるJevモデルを選択してください。");
			const next: HarnessSettings = {
				...(this.settings.jev ? { jev: this.settings.jev } : {}),
				search: { ...this.settings.search, ...patch.search },
				teams: { ...this.settings.teams, ...patch.teams },
			};
			if (patch.jev) {
				if (patch.jev.model) next.jev = { model: { ...patch.jev.model } };
				else delete next.jev;
			}
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
			classifiers: this.modelRuntime
				.getModelsOfType("classifier")
				.filter(isJevModel)
				.map(({ provider, id, name }) => ({ provider, id, name })),
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

	async saveApiKey(providerId: string, key: string): Promise<void> {
		if (!this.modelRuntime.getProviders().some((provider) => provider.id === providerId && provider.auth.apiKey))
			throw new Error("Select a model provider that supports API keys");
		if (typeof key !== "string" || !key.trim()) throw new Error("API key must not be empty");
		try {
			await this.modelRuntime.saveApiKey(providerId, key.trim());
		} catch {
			// SDK credential synchronization errors can carry the credential itself.
			throw new Error("API key could not be saved or activated; check provider configuration in Settings");
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
