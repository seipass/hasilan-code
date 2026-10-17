import { createHash, randomUUID } from "node:crypto";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
} from "node:fs/promises";
import path from "node:path";

export interface Workspace {
	id: string;
	path: string;
}
export interface FileEntry {
	name: string;
	path: string;
	kind: "file" | "directory" | "symlink";
	size: number;
}
export interface FileSnapshot {
	path: string;
	bytes: Buffer;
	revision: string;
}
export interface FileChange {
	path: string;
	expectedRevision: string;
	beforeBytes: Buffer;
	afterBytes: Buffer;
	operation: "update" | "delete" | "move";
	moveDest?: string;
}
export interface FileCommitResult {
	path: string;
	operation: FileChange["operation"];
	status: "applied" | "not_applied";
	revision?: string;
	moveDest?: string;
	error?: string;
}
export interface CommitResult {
	files: FileCommitResult[];
}
export interface FilesChanged {
	type: "files_changed";
	workspaceId: string;
	paths: string[];
}
export interface WorkspaceFilesOptions {
	onChanged?: (event: FilesChanged) => void;
}

// One gate across all instances and overlapping roots, not a queue per workspace.
let mutationTail: Promise<void> = Promise.resolve();
async function mutate<T>(operation: () => Promise<T>): Promise<T> {
	const previous = mutationTail;
	let release!: () => void;
	mutationTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}
export function fileRevision(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function comparable(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}
function contained(root: string, target: string): boolean {
	const relative = path.relative(comparable(root), comparable(target));
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
export function imageMime(bytes: Buffer): string | undefined {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
		return "image/png";
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "image/webp";
	if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
	return undefined;
}

export class WorkspaceFiles {
	private readonly workspaces = new Map<string, Workspace>();
	private readonly onChanged: WorkspaceFilesOptions["onChanged"];
	constructor(options: WorkspaceFilesOptions = {}) {
		this.onChanged = options.onChanged;
	}
	async register(root: string, preferredId?: string): Promise<Workspace> {
		if (!path.isAbsolute(root)) throw new Error("Workspace path must be absolute");
		const canonical = await realpath(root);
		if (!(await stat(canonical)).isDirectory()) throw new Error("Workspace must be a directory");
		const existing = [...this.workspaces.values()].find((item) => comparable(item.path) === comparable(canonical));
		if (existing) return { ...existing };
		const id = preferredId ?? randomUUID();
		if (this.workspaces.has(id)) throw new Error("Workspace ID already registered");
		const workspace = { id, path: canonical };
		this.workspaces.set(id, workspace);
		return { ...workspace };
	}
	getWorkspaces(): Workspace[] {
		return [...this.workspaces.values()].map((item) => ({ ...item }));
	}
	getWorkspaceRoot(id: string): string {
		const workspace = this.workspaces.get(id);
		if (!workspace) throw new Error("Unknown workspace");
		return workspace.path;
	}
	normalizePath(input: string): string {
		if (input.includes("\0") || input.includes(":") || /^[\\/]/.test(input))
			throw new Error("Invalid workspace-relative path");
		const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
		if (normalized === ".." || normalized.startsWith("../")) throw new Error("Path escapes workspace");
		return normalized === "." ? "" : normalized.replace(/\/$/, "");
	}
	private async resolve(
		id: string,
		input: string,
		allowMissing = false,
	): Promise<{ relative: string; absolute: string }> {
		const root = this.getWorkspaceRoot(id);
		const relative = this.normalizePath(input);
		const absolute = path.resolve(root, relative);
		if (!contained(root, absolute)) throw new Error("Path escapes workspace");
		let ancestor = absolute;
		while (true) {
			try {
				const canonical = await realpath(ancestor);
				if (!contained(root, canonical)) throw new Error("Symlink escapes workspace");
				return { relative, absolute: path.join(canonical, path.relative(ancestor, absolute)) };
			} catch (error) {
				if (!allowMissing || !missing(error)) throw error;
				// A dangling symlink must not be mistaken for an absent path.
				try {
					if ((await lstat(ancestor)).isSymbolicLink()) throw new Error("Dangling symlink is not writable");
				} catch (entryError) {
					if (!missing(entryError)) throw entryError;
				}
				const parent = path.dirname(ancestor);
				if (parent === ancestor) throw error;
				ancestor = parent;
			}
		}
	}
	async list(id: string, input = ""): Promise<FileEntry[]> {
		const resolved = await this.resolve(id, input);
		const entries = await readdir(resolved.absolute, { withFileTypes: true });
		const results = await Promise.all(
			entries.map(async (entry): Promise<FileEntry> => {
				const info = await lstat(path.join(resolved.absolute, entry.name));
				return {
					name: entry.name,
					path: path.posix.join(resolved.relative, entry.name),
					kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file",
					size: info.size,
				};
			}),
		);
		return results.sort(
			(a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name),
		);
	}
	async read(id: string, input: string): Promise<FileSnapshot> {
		const resolved = await this.resolve(id, input);
		if (!(await stat(resolved.absolute)).isFile()) throw new Error("Path is not a regular file");
		const bytes = await readFile(resolved.absolute);
		return { path: resolved.relative, bytes, revision: fileRevision(bytes) };
	}
	/** Caller owns the handle; resolving here preserves the workspace/symlink boundary for streaming. */
	async openRead(id: string, input: string): Promise<{ path: string; handle: FileHandle }> {
		const resolved = await this.resolve(id, input);
		const handle = await open(resolved.absolute, "r");
		try {
			if (!(await handle.stat()).isFile()) throw new Error("Path is not a regular file");
			return { path: resolved.relative, handle };
		} catch (error) {
			await handle.close();
			throw error;
		}
	}
	private notify(id: string, paths: string[]): void {
		if (paths.length) this.onChanged?.({ type: "files_changed", workspaceId: id, paths: [...new Set(paths)] });
	}
	async create(id: string, input: string, bytes: Buffer): Promise<FileSnapshot> {
		return mutate(async () => {
			const resolved = await this.resolve(id, input, true);
			if (!resolved.relative) throw new Error("Cannot create workspace root");
			await mkdir(path.dirname(resolved.absolute), { recursive: true });
			await this.resolve(id, input, true);
			let handle: FileHandle;
			try {
				handle = await open(resolved.absolute, "wx");
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST")
					throw new Error("File exists; use read and edit");
				throw error;
			}
			try {
				await handle.writeFile(bytes);
			} finally {
				await handle.close();
			}
			this.notify(id, [resolved.relative]);
			return { path: resolved.relative, bytes: Buffer.from(bytes), revision: fileRevision(bytes) };
		});
	}
	async commit(id: string, changes: FileChange[]): Promise<CommitResult> {
		return mutate(async () => {
			if (!changes.length) throw new Error("Empty commit");
			const occupied = new Set<string>();
			const prepared: { change: FileChange; absolute: string; destination?: string; staged?: string }[] = [];
			const validateSource = async (change: FileChange): Promise<string> => {
				const resolved = await this.resolve(id, change.path);
				if (!resolved.relative) throw new Error("Cannot delete or move workspace root");
				const current = await this.read(id, change.path);
				if (current.revision !== change.expectedRevision || !current.bytes.equals(change.beforeBytes))
					throw new Error("Stale snapshot; read the file again");
				return resolved.absolute;
			};
			try {
				for (const change of changes) {
					const absolute = await validateSource(change);
					const key = comparable(absolute);
					if (occupied.has(key)) throw new Error("Conflicting source or destination paths");
					occupied.add(key);
					let destination: string | undefined;
					if (change.operation === "move") {
						if (!change.moveDest) throw new Error("Move requires a destination");
						const target = await this.resolve(id, change.moveDest, true);
						if (!target.relative) throw new Error("Cannot move to workspace root");
						destination = target.absolute;
						if (occupied.has(comparable(destination))) throw new Error("Conflicting source or destination paths");
						occupied.add(comparable(destination));
						try {
							await lstat(destination);
							throw new Error("Move destination exists");
						} catch (error) {
							if (!missing(error)) throw error;
						}
					}
					prepared.push({ change, absolute, destination });
				}
				for (const item of prepared) {
					if (item.change.operation === "delete") continue;
					const target = item.destination ?? item.absolute;
					if (item.destination) {
						await mkdir(path.dirname(target), { recursive: true });
						await this.resolve(id, item.change.moveDest!, true);
					}
					item.staged = path.join(path.dirname(target), `.pi-web-${randomUUID()}.tmp`);
					const handle = await open(item.staged, "wx", (await stat(item.absolute)).mode & 0o777);
					try {
						await handle.writeFile(item.change.afterBytes);
					} finally {
						await handle.close();
					}
				}
				// Validate every preimage once more after staging, before any mutation.
				for (const item of prepared) {
					if ((await validateSource(item.change)) !== item.absolute)
						throw new Error("Stale snapshot; read the file again");
				}
				const files: FileCommitResult[] = [];
				const changed: string[] = [];
				let failed = false;
				for (const item of prepared) {
					const result: FileCommitResult = {
						path: item.change.path,
						operation: item.change.operation,
						status: "not_applied",
						moveDest: item.change.moveDest,
					};
					files.push(result);
					if (failed) {
						result.error = "Not applied after earlier I/O failure";
						continue;
					}
					try {
						if ((await validateSource(item.change)) !== item.absolute)
							throw new Error("Stale snapshot; read the file again");
						if (item.destination) {
							await this.resolve(id, item.change.moveDest!, true);
							// Exclusive destination reservation prevents overwriting a concurrent external create.
							const reservation = await open(item.destination, "wx");
							await reservation.close();
							try {
								await rename(item.staged!, item.destination);
							} catch (error) {
								await unlink(item.destination);
								throw error;
							}
							// If source deletion fails, destination is rolled back; report partial failure only if rollback fails.
							try {
								await unlink(item.absolute);
							} catch (error) {
								try {
									await unlink(item.destination);
								} catch {
									result.status = "applied";
									result.error = "Move destination written but source removal and rollback failed";
									changed.push(item.change.moveDest!);
								}
								throw error;
							}
						} else if (item.change.operation === "delete") await unlink(item.absolute);
						else await rename(item.staged!, item.absolute);
						result.status = "applied";
						if (item.change.operation !== "delete") result.revision = fileRevision(item.change.afterBytes);
						changed.push(item.change.path, ...(item.change.moveDest ? [item.change.moveDest] : []));
					} catch (error) {
						failed = true;
						result.error ??= error instanceof Error ? error.message : "Filesystem operation failed";
					}
				}
				this.notify(id, changed);
				return { files };
			} finally {
				await Promise.all(prepared.filter((item) => item.staged).map((item) => rm(item.staged!, { force: true })));
			}
		});
	}
}
