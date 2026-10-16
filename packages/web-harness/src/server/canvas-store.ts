import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CANVAS_LIMITS, type CanvasDocument, emptyCanvasDocument, isCanvasDocument } from "../shared/canvas.ts";

export class CanvasStoreError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "CanvasStoreError";
		this.status = status;
	}
}

/** One host-owned instance; the callback must reject workspace IDs absent from the trusted registry. */
export class CanvasStore {
	private readonly directory: string;
	private readonly validateWorkspace: (workspaceId: string) => void | Promise<void>;
	private queue: Promise<void> = Promise.resolve();

	constructor(agentDir: string, validateWorkspace: (workspaceId: string) => void | Promise<void>) {
		this.directory = join(agentDir, "web-harness", "canvases");
		this.validateWorkspace = validateWorkspace;
	}

	get(workspaceId: string): Promise<CanvasDocument> {
		return this.enqueue(async () => {
			await this.validateWorkspace(workspaceId);
			return this.read(workspaceId);
		});
	}

	save(workspaceId: string, value: unknown): Promise<CanvasDocument> {
		// Snapshot before queuing so callers cannot mutate a pending write.
		if (!isCanvasDocument(value))
			return Promise.reject(
				new CanvasStoreError(400, "設計データが不正です。ID・接続先・文字数・座標の上限を確認してください。"),
			);
		const next = structuredClone(value);
		return this.enqueue(async () => {
			await this.validateWorkspace(workspaceId);
			const current = await this.read(workspaceId);
			if (next.revision !== current.revision)
				throw new CanvasStoreError(
					409,
					"別の画面で設計が更新されました。未保存の設計を JSON で書き出してから、保存済みを読み直してください。",
				);
			if (current.revision >= Number.MAX_SAFE_INTEGER - 1)
				throw new CanvasStoreError(409, "保存リビジョンの上限に達しました。");
			next.revision = current.revision + 1;
			const data = `${JSON.stringify(next)}\n`;
			if (Buffer.byteLength(data, "utf8") > CANVAS_LIMITS.bytes)
				throw new CanvasStoreError(400, "設計データのサイズが上限を超えています。");
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			const path = this.path(workspaceId);
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
				await rename(temporary, path);
			} finally {
				await rm(temporary, { force: true });
			}
			return next;
		});
	}

	private path(workspaceId: string): string {
		// Even trusted IDs are hashed: no request-provided path ever becomes a filename.
		return join(this.directory, `${createHash("sha256").update(workspaceId).digest("hex")}.json`);
	}

	private async read(workspaceId: string): Promise<CanvasDocument> {
		const path = this.path(workspaceId);
		let text: string;
		try {
			if ((await stat(path)).size > CANVAS_LIMITS.bytes)
				throw new CanvasStoreError(500, "保存済みの設計が大きすぎます。保存ファイルを確認してください。");
			text = await readFile(path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyCanvasDocument();
			throw error;
		}
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			throw new CanvasStoreError(
				500,
				"保存済みの設計 JSON が壊れています。ファイルを修復してから読み直してください。",
			);
		}
		if (!isCanvasDocument(data))
			throw new CanvasStoreError(500, "保存済みの設計が不正です。ファイルを修復してから読み直してください。");
		return data;
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
