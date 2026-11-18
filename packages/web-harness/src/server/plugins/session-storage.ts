import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessState } from "../session-registry.ts";

/** The session index is replaceable. Pi transcripts keep their native JSONL format. */
export interface SessionStorage {
	readonly sessionsDirectory: string;
	readonly importAssetsDirectory: string;
	readState(): Promise<unknown>;
	writeState(snapshot: string): Promise<void>;
}

export interface SessionPersistence {
	readonly storage: SessionStorage;
	readonly restoredState: HarnessState | undefined;
}

export function fileSessionStorage(agentDir: string): SessionStorage {
	const directory = join(agentDir, "web-harness");
	const path = join(directory, "state.json");
	return {
		sessionsDirectory: join(directory, "sessions"),
		importAssetsDirectory: join(directory, "import-assets"),
		async readState() {
			try {
				return JSON.parse(await readFile(path, "utf8")) as unknown;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return undefined;
			}
		},
		async writeState(snapshot) {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, snapshot, { mode: 0o600 });
				await rename(temporary, path);
			} finally {
				await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
		},
	};
}
