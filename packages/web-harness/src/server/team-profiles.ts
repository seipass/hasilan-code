import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface AgentProfile {
	name: string;
	description: string;
	systemPrompt: string;
	model?: { provider: string; id: string };
	tools?: string[];
}

const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_PROFILE_FILES = 128;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(path: string, reason: string): never {
	throw new Error(`Invalid agent profile ${path}: ${reason}`);
}

function object(value: unknown, path: string, label: string, fields: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, `${label} must be an object`);
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!fields.includes(key)) invalid(path, `unknown ${label} field ${key}`);
	}
	return record;
}

function nonempty(value: unknown, path: string, label: string): string {
	if (typeof value !== "string" || !value.trim()) invalid(path, `${label} must be a nonempty string`);
	return value;
}

function parseProfile(source: string, stem: string, path: string): AgentProfile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		invalid(path, "malformed JSON");
	}
	const value = object(parsed, path, "profile", ["name", "description", "systemPrompt", "model", "tools"]);
	const name = nonempty(value.name, path, "name");
	if (name !== stem) invalid(path, `name must match filename (${stem})`);
	const profile: AgentProfile = {
		name,
		description: nonempty(value.description, path, "description"),
		systemPrompt: nonempty(value.systemPrompt, path, "systemPrompt"),
	};
	if (value.model !== undefined) {
		const model = object(value.model, path, "model", ["provider", "id"]);
		profile.model = {
			provider: nonempty(model.provider, path, "model.provider"),
			id: nonempty(model.id, path, "model.id"),
		};
	}
	if (value.tools !== undefined) {
		if (!Array.isArray(value.tools)) invalid(path, "tools must be an array");
		profile.tools = [...new Set(value.tools.map((tool: unknown) => nonempty(tool, path, "tools entry")))];
	}
	return profile;
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error(`Agent profile directory must not be a symlink: ${path}`);
		if (!info.isDirectory()) throw new Error(`Agent profile directory is not a directory: ${path}`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function readProfile(path: string): Promise<string> {
	// lstat rejects links even on platforms that do not support O_NOFOLLOW.
	const entry = await lstat(path);
	if (!entry.isFile() || entry.isSymbolicLink()) invalid(path, "must be a regular file, not a symlink");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino)
			invalid(path, "file changed while loading");
		if (info.size > MAX_PROFILE_BYTES) invalid(path, `exceeds ${MAX_PROFILE_BYTES} bytes`);
		const bytes = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > info.size) invalid(path, "file changed while loading");
		try {
			return utf8Decoder.decode(bytes.subarray(0, length));
		} catch {
			invalid(path, "must be UTF-8 text");
		}
	} finally {
		await handle.close();
	}
}

/** Project definitions take precedence, but every JSON definition is validated. */
export async function loadTeamProfiles(workspaceRoot: string, agentDir: string): Promise<AgentProfile[]> {
	const profiles = new Map<string, AgentProfile>();
	const project = resolve(workspaceRoot);
	const global = resolve(agentDir);
	const projectConfig = join(project, ".hasilan-code");
	const locations = [
		[project, projectConfig, join(projectConfig, "agents")],
		[global, join(global, "agents")],
	];
	let count = 0;
	for (const parts of locations) {
		let present = true;
		for (const part of parts) {
			if (!(await directoryExists(part))) {
				present = false;
				break;
			}
		}
		if (!present) continue;
		const directory = parts[parts.length - 1];
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.name.endsWith(".json")) continue;
			const path = join(directory, entry.name);
			if (++count > MAX_PROFILE_FILES) invalid(path, `more than ${MAX_PROFILE_FILES} profile files`);
			if (!entry.isFile() || entry.isSymbolicLink()) invalid(path, "must be a regular file, not a symlink");
			const profile = parseProfile(await readProfile(path), entry.name.slice(0, -5), path);
			if (!profiles.has(profile.name)) profiles.set(profile.name, profile);
		}
	}
	return [...profiles.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
