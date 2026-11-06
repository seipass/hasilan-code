import { lstat, open, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ArchivedSession } from "../shared/session-archive.ts";

export function transcriptPathKey(path: string): string {
	const absolute = resolve(path);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export async function readArchivedSession(directory: string, file: string): Promise<ArchivedSession | undefined> {
	if (basename(file) !== file || !/^[\w.-]+\.jsonl$/.test(file)) return undefined;
	const path = join(directory, file);
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!info?.isFile()) return undefined;
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(32 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
		if (bytesRead < info.size) lines.pop();
		const header: unknown = JSON.parse(lines.shift() ?? "");
		if (
			typeof header !== "object" ||
			header === null ||
			!("type" in header) ||
			header.type !== "session" ||
			!("id" in header) ||
			typeof header.id !== "string" ||
			!("cwd" in header) ||
			typeof header.cwd !== "string"
		)
			return undefined;
		let title: string | undefined;
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry?.type === "session_info" && typeof entry.name === "string") title = entry.name;
				if (title || entry?.type !== "message" || entry.message?.role !== "user") continue;
				const content = entry.message.content;
				if (typeof content === "string") title = content;
				else if (Array.isArray(content)) {
					for (const part of content) {
						if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
							title = part.text;
							break;
						}
					}
				}
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
			}
		}
		return {
			file,
			sessionId: header.id,
			cwd: header.cwd,
			title: title?.replace(/\s+/g, " ").trim().slice(0, 200),
			modifiedAt: info.mtimeMs,
			bytes: info.size,
		};
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	} finally {
		await handle.close();
	}
}

export async function listArchivedSessions(directory: string, activePaths: string[]): Promise<ArchivedSession[]> {
	const active = new Set(activePaths.map(transcriptPathKey));
	const names = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const result: ArchivedSession[] = [];
	for (const entry of names) {
		if (!entry.isFile() || active.has(transcriptPathKey(join(directory, entry.name)))) continue;
		const session = await readArchivedSession(directory, entry.name);
		if (session) result.push(session);
	}
	return result.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
