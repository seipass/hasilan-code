import path from "node:path";
import {
	type AgentToolResult,
	createReadToolDefinition,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CommitResult, type FileSnapshot, imageMime, type WorkspaceFiles } from "../../workspace-files.ts";
import { patchDiff, preparePatch } from "./applier.ts";
import { parsePatch } from "./parser.ts";
import { HASHLINE_EDIT_DESCRIPTION } from "./prompt.ts";
import { recoverPatch } from "./recovery.ts";
import { SnapshotStore, snapshotOf } from "./snapshots.ts";

export { preparePatch } from "./applier.ts";
export { resolveBlock } from "./blocks.ts";
export { parsePatch } from "./parser.ts";
export { SnapshotStore, snapshotOf } from "./snapshots.ts";
export interface HashlineReadDetails {
	path: string;
	tag?: string;
	revision?: string;
	nextOffset?: number;
	totalLines?: number;
	kind: "text" | "directory" | "image";
}
export interface HashlineEditDetails extends CommitResult {
	headers: string[];
	diff: string;
}
const readSchema = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Integer({ minimum: 1 })),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
});
const editSchema = Type.Object({ input: Type.String() });
const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });

/** A distinct instance per Pi session; viewer reads never enter this snapshot store. */
export class HashlineSession {
	readonly snapshots = new SnapshotStore();
	private registers = new Map<string, string[]>();
	private readonly files: WorkspaceFiles;
	private readonly workspaceId: string;
	private tail: Promise<void> = Promise.resolve();
	constructor(files: WorkspaceFiles, workspaceId: string) {
		this.files = files;
		this.workspaceId = workspaceId;
	}
	private async exclusive<T>(action: () => Promise<T>): Promise<T> {
		const prior = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await prior;
		try {
			return await action();
		} finally {
			release();
		}
	}
	async read(
		input: string,
		offset = 1,
		limit = 200,
		signal?: AbortSignal,
		context?: ExtensionToolContext,
	): Promise<AgentToolResult<HashlineReadDetails>> {
		return this.exclusive(async () => {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1)
				throw new Error("offset and limit must be positive integers");
			const relative = this.files.normalizePath(input);
			let file: FileSnapshot;
			try {
				file = await this.files.read(this.workspaceId, relative);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "Path is not a regular file") throw error;
				const entries = await this.files.list(this.workspaceId, relative);
				return {
					content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
					details: { path: relative, kind: "directory" },
				};
			}
			const mime = imageMime(file.bytes);
			if (mime) {
				if (!context) throw new Error("Image read requires the Pi execution context");
				const cwd = this.files.getWorkspaceRoot(this.workspaceId);
				const original = file;
				const delegate = createReadToolDefinition(cwd, {
					operations: {
						access: async (absolute) => {
							await this.files.read(this.workspaceId, path.relative(cwd, absolute));
						},
						readFile: async (absolute) => {
							const requested = this.files.normalizePath(path.relative(cwd, absolute));
							if (requested !== original.path) throw new Error("Image path changed during read");
							return original.bytes;
						},
						detectImageMimeType: async () => mime,
					},
				});
				const result = await delegate.execute("hashline-image", { path: relative }, signal, undefined, context);
				return { ...result, details: { path: relative, revision: file.revision, kind: "image" } };
			}
			const snapshot = this.snapshots.observe(file);
			if (offset > Math.max(snapshot.lines.length, 1)) throw new Error("Offset is beyond end of file");
			const rows = [`[${snapshot.path}#${snapshot.tag}]`];
			let size = Buffer.byteLength(rows[0], "utf8") + 1;
			let next = offset;
			for (let index = offset - 1; index < Math.min(snapshot.lines.length, offset - 1 + limit); index++) {
				const row = `${index + 1}:${snapshot.lines[index]}`;
				const rowBytes = Buffer.byteLength(row, "utf8") + 1;
				if (size + rowBytes > 63 * 1024) break;
				rows.push(row);
				size += rowBytes;
				next = index + 2;
			}
			const nextOffset = next <= snapshot.lines.length ? next : undefined;
			if (nextOffset !== undefined)
				rows.push(
					`[Continue with offset=${nextOffset}. Only complete displayed lines may be edited.${next === offset ? " Next line exceeds the 64KiB read limit." : ""}]`,
				);
			if (snapshot.mixedEol) rows.push("[Mixed line endings; normalize the file before editing]");
			if (signal?.aborted) throw new Error("Operation aborted");
			for (let line = offset; line < next; line++) snapshot.seenLines.add(line);
			return {
				content: [{ type: "text", text: rows.join("\n") }],
				details: {
					path: snapshot.path,
					tag: snapshot.tag,
					revision: snapshot.revision,
					nextOffset,
					totalLines: snapshot.lines.length,
					kind: "text",
				},
			};
		});
	}
	async edit(input: string, signal?: AbortSignal): Promise<AgentToolResult<HashlineEditDetails>> {
		return this.exclusive(async () => {
			if (signal?.aborted) throw new Error("Operation aborted");
			const patch = parsePatch(input);
			const nextRegisters = new Map(this.registers);
			const prepared = [];
			const paths = new Set<string>();
			for (const entry of patch) {
				const relative = this.files.normalizePath(entry.path);
				if (paths.has(relative)) throw new Error("Duplicate file header");
				paths.add(relative);
				const snapshot = this.snapshots.resolve(relative, entry.tag);
				const current = await this.files.read(this.workspaceId, relative);
				if (snapshot.revision === current.revision && snapshot.bytes.equals(current.bytes))
					prepared.push(preparePatch(entry, snapshot, nextRegisters));
				else {
					// Validate original coverage and overlap semantics before attempting a remap.
					preparePatch(entry, snapshot, new Map(nextRegisters));
					const normalized = snapshotOf(current);
					const observed = this.snapshots.get(relative);
					if (observed?.revision === current.revision && observed.bytes.equals(current.bytes))
						for (const line of observed.seenLines) normalized.seenLines.add(line);
					const recovered = recoverPatch(entry, snapshot, normalized);
					prepared.push(preparePatch(recovered, normalized, nextRegisters));
				}
			}
			if (signal?.aborted) throw new Error("Operation aborted");
			const commit = await this.files.commit(
				this.workspaceId,
				prepared.map((item) => item.change),
			);
			const headers: string[] = [];
			const diffs: string[] = [];
			const previews: string[] = [];
			for (let index = 0; index < commit.files.length; index++) {
				const result = commit.files[index];
				if (result.status !== "applied") continue;
				const item = prepared[index];
				if (result.operation !== "update" || result.error) this.snapshots.invalidate(item.snapshot.path);
				if (result.error) {
					headers.push(`[${result.path}: ${result.error}]`);
					continue;
				}
				if (result.operation === "delete") headers.push(`[${result.path} removed]`);
				else {
					const destination = result.moveDest ? this.files.normalizePath(result.moveDest) : result.path;
					if (result.moveDest) this.snapshots.invalidate(destination);
					const updated = this.snapshots.observe({
						path: destination,
						bytes: item.change.afterBytes,
						revision: result.revision!,
					});
					headers.push(`[${destination}#${updated.tag}]`);
					for (const line of item.seenLines) updated.seenLines.add(line);
					const rows = [`[${destination}#${updated.tag}]`, "[Edited lines; only complete numbered rows are seen]"];
					let size = Buffer.byteLength(rows.join("\n"));
					for (const line of item.previewLines) {
						const row = `${line}:${updated.lines[line - 1]}`;
						size += Buffer.byteLength(row) + 1;
						if (size > 60 * 1024) {
							rows.push("[Edited preview truncated; read omitted lines before editing them]");
							break;
						}
						rows.push(row);
						updated.seenLines.add(line);
					}
					if (item.previewLines.length) previews.push(rows.join("\n"));
				}
				diffs.push(patchDiff(result.path, item.snapshot.lines, result.operation === "delete" ? [] : item.lines));
			}
			// Keep captures only for a fully successful batch; never claim uncommitted CUTs.
			if (commit.files.every((item) => item.status === "applied" && !item.error)) this.registers = nextRegisters;
			const diff = diffs.join("\n\n");
			const errors = commit.files.filter((item) => item.error).map((item) => `${item.path}: ${item.error}`);
			return {
				content: [
					{
						type: "text",
						text: [
							...headers,
							diff,
							...previews,
							...errors,
							"Use the returned header for unchanged, unshifted previously read lines and complete numbered preview rows. Read other lines before editing.",
						]
							.filter(Boolean)
							.join("\n\n"),
					},
				],
				details: { ...commit, headers, diff },
			};
		});
	}
	async write(input: string, content: string, signal?: AbortSignal): Promise<AgentToolResult<HashlineReadDetails>> {
		return this.exclusive(async () => {
			if (signal?.aborted) throw new Error("Operation aborted");
			const file = await this.files.create(this.workspaceId, input, Buffer.from(content, "utf8"));
			const snapshot = this.snapshots.observe(file);
			return {
				content: [{ type: "text", text: `[${file.path}#${snapshot.tag}]\nCreated file. Read it before editing.` }],
				details: {
					path: file.path,
					revision: file.revision,
					tag: snapshot.tag,
					totalLines: snapshot.lines.length,
					kind: "text",
				},
			};
		});
	}
}

export function createHashlineTools(files: WorkspaceFiles, workspaceId: string): ToolDefinition[] {
	const session = new HashlineSession(files, workspaceId);
	const read: ToolDefinition<typeof readSchema, HashlineReadDetails> = {
		name: "read",
		label: "read",
		parameters: readSchema,
		executionMode: "sequential",
		description:
			"Read workspace-relative UTF-8 text as [PATH#TAG] and N:TEXT, directories, or images. offset is 1-based (default 1), limit defaults to 200; at most 64KiB, complete lines only. Read every line targeted by an edit. UI file viewing does not count as reading.",
		execute: async (_id, params, signal, _update, context) =>
			session.read(params.path, params.offset, params.limit, signal, context),
	};
	const edit: ToolDefinition<typeof editSchema, HashlineEditDetails> = {
		name: "edit",
		label: "edit",
		parameters: editSchema,
		executionMode: "sequential",
		description: HASHLINE_EDIT_DESCRIPTION,
		execute: async (_id, params, signal) => session.edit(params.input, signal),
	};
	const write: ToolDefinition<typeof writeSchema, HashlineReadDetails> = {
		name: "write",
		label: "write",
		parameters: writeSchema,
		executionMode: "sequential",
		description:
			"Exclusively create a new UTF-8 file in the workspace, creating contained parent directories. Existing files cannot be overwritten; use read then edit.",
		execute: async (_id, params, signal) => session.write(params.path, params.content, signal),
	};
	return [read, edit, write] as unknown as ToolDefinition[];
}
