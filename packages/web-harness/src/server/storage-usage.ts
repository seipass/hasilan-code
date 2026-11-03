import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface StorageUsage {
	/** Bytes used by Pi session transcripts. */
	sessions: number;
	sessionFiles: number;
	/** Bytes used by on-demand preference files (backgrounds, drafts, attachments). */
	preferences: number;
	/** Bytes used by imported session assets. */
	imports: number;
	/** Session files whose conversation no longer exists in the app state. */
	orphans: number;
	orphanBytes: number;
}

async function directoryUsage(path: string): Promise<{ bytes: number; files: number }> {
	let bytes = 0;
	let files = 0;
	let entries: Dirent[];
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		return { bytes, files };
	}
	for (const entry of entries) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) {
			const nested = await directoryUsage(full);
			bytes += nested.bytes;
			files += nested.files;
		} else if (entry.isFile()) {
			const info = await stat(full).catch(() => undefined);
			if (info) {
				bytes += info.size;
				files++;
			}
		}
	}
	return { bytes, files };
}

/** Reports where the agent profile spends disk and how many session files are unreferenced. */
export async function readStorageUsage(agentDir: string, referencedPaths: Set<string>): Promise<StorageUsage> {
	const root = join(agentDir, "web-harness");
	const sessions = await directoryUsage(join(root, "sessions"));
	const preferences = await directoryUsage(join(root, "ui-preferences"));
	const imports = await directoryUsage(join(root, "import-assets"));
	let orphans = 0;
	let orphanBytes = 0;
	for (const name of await readdir(join(root, "sessions")).catch(() => [] as string[])) {
		if (!name.endsWith(".jsonl")) continue;
		const full = join(root, "sessions", name);
		if (referencedPaths.has(full)) continue;
		const info = await stat(full).catch(() => undefined);
		if (!info) continue;
		orphans++;
		orphanBytes += info.size;
	}
	return {
		sessions: sessions.bytes,
		sessionFiles: sessions.files,
		preferences: preferences.bytes,
		imports: imports.bytes,
		orphans,
		orphanBytes,
	};
}
