import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { ATTACHMENT_LIMITS } from "../shared/attachments.ts";
import {
	type UiPreferencesPatch,
	type UiPreferencesSnapshot,
	uiPreferenceLimit,
	uiPreferencesPatchSchema,
	validUiPreference,
} from "../shared/ui-preferences.ts";
import { HttpError, readJson, sendJson } from "./http-host.ts";

/** One atomic file per key: typing a note never rewrites background images or attachment data. */
export class UiPreferencesStore {
	private readonly directory: string;
	private readonly values = new Map<string, string | null>();
	private readonly attachmentVersions = new Map<string, string>();
	private readonly epoch = randomUUID();
	private sequence = 0;
	private readonly versions = new Map<string, number>();
	private revision = `${this.epoch}:0`;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(directory: string) {
		this.directory = directory;
	}

	static async open(agentDir: string): Promise<UiPreferencesStore> {
		const store = new UiPreferencesStore(join(agentDir, "web-harness", "ui-preferences"));
		await mkdir(store.directory, { recursive: true, mode: 0o700 });
		for (const file of await readdir(store.directory)) {
			if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
			const entry: unknown = JSON.parse(await readFile(join(store.directory, file), "utf8"));
			if (
				!entry ||
				typeof entry !== "object" ||
				!("key" in entry) ||
				typeof entry.key !== "string" ||
				!("value" in entry) ||
				!validUiPreference(entry.key, entry.value)
			)
				throw new Error(`Invalid UI preference file: ${file}`);
			if (file !== `${createHash("sha256").update(entry.key).digest("hex")}.json`)
				throw new Error(`Invalid UI preference filename: ${file}`);
			store.values.set(entry.key, entry.value);
			if (entry.key.startsWith("pi-web-attachments:")) store.attachmentVersions.set(entry.key, randomUUID());
		}
		return store;
	}

	snapshot(since?: string | null): UiPreferencesSnapshot {
		const sequence = since?.startsWith(`${this.epoch}:`) ? Number(since.slice(this.epoch.length + 1)) : -1;
		const after = Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= this.sequence ? sequence : -1;
		return {
			revision: this.revision,
			values: Object.fromEntries(
				[...this.values].filter(
					([key]) => !key.startsWith("pi-web-attachments:") && (this.versions.get(key) ?? 0) > after,
				),
			),
			attachments: Object.fromEntries(this.attachmentVersions),
		};
	}

	get(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
		if (url.pathname !== "/api/ui-preferences") return false;
		if (request.method === "GET") {
			const key = url.searchParams.get("key");
			if (key !== null) {
				if (uiPreferenceLimit(key) === undefined) throw new HttpError(400, "Invalid UI preference key");
				sendJson(response, 200, { value: this.get(key) });
			} else {
				const snapshot = this.snapshot(url.searchParams.get("since"));
				sendJson(response, 200, url.searchParams.get("since") === snapshot.revision ? null : snapshot);
			}
		} else if (request.method === "PATCH") {
			await this.patch(await readJson(request, uiPreferencesPatchSchema, ATTACHMENT_LIMITS.requestBytes));
			sendJson(response, 200, { saved: true });
		} else throw new HttpError(405, "Method is not allowed");
		return true;
	}

	patch(patch: UiPreferencesPatch): Promise<void> {
		const operation = this.queue.then(async () => {
			for (const { key, value } of patch.entries)
				if (!validUiPreference(key, value)) throw new HttpError(400, "Invalid UI preference");
			for (const { key, value, onlyIfMissing } of patch.entries) {
				if ((onlyIfMissing && this.values.has(key)) || this.values.get(key) === value) continue;
				const file = join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`);
				const temporary = `${file}.${randomUUID()}.tmp`;
				try {
					await writeFile(temporary, JSON.stringify({ key, value }), { flag: "wx", mode: 0o600 });
					await rename(temporary, file);
				} finally {
					await rm(temporary, { force: true });
				}
				// Keep deletion tombstones so another browser's legacy data cannot resurrect removed values.
				this.values.set(key, value);
				this.sequence++;
				this.versions.set(key, this.sequence);
				this.revision = `${this.epoch}:${this.sequence}`;
				if (key.startsWith("pi-web-attachments:")) this.attachmentVersions.set(key, this.revision);
			}
		});
		this.queue = operation.catch(() => undefined);
		return operation;
	}

	async close(): Promise<void> {
		await this.queue;
	}
}
