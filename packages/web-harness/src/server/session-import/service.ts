import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import type {
	ImportedTranscript,
	SessionDiscovery,
	SessionDiscoveryRequest,
	SessionImportCandidate,
	SessionImportPreview,
	SessionImportSource,
} from "../../shared/session-import.ts";
import { HarnessError } from "../session-registry.ts";
import { type JsonRecord, jsonLines, record, string, timestamp } from "./common.ts";
import { parseClaude, parseCodex, parseDeepSeek, parseOhMyPi } from "./jsonl-formats.ts";
import { activeGrokUpdates, parseGrok, parseOpenCode } from "./other-formats.ts";

const MAX_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 256 * 1024;
const MAX_CANDIDATES = 500;
const decompress = promisify(zstdDecompress);
interface CandidateFile {
	path: string;
	modified: number;
}
interface Candidate extends SessionImportCandidate {
	path: string;
	files: CandidateFile[];
	expires: number;
	database?: boolean;
}
export interface SessionImportOptions {
	home?: string;
	env?: NodeJS.ProcessEnv;
}

export function sessionImportPaths(
	source: SessionImportSource,
	home = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	switch (source) {
		case "codex": {
			const root = env.CODEX_HOME || join(home, ".codex");
			return [join(root, "sessions"), join(root, "archived_sessions")];
		}
		case "claude-code":
			return [join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects")];
		case "grok-build":
			return [join(env.GROK_HOME || join(home, ".grok"), "sessions")];
		case "deepseek-harness":
			return [join(env.DSH_HOME || join(home, ".dsh"), "sessions")];
		case "opencode": {
			const root = join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
			return env.OPENCODE_DB === ":memory:" ? [] : env.OPENCODE_DB ? [resolve(root, env.OPENCODE_DB)] : [root];
		}
		case "oh-my-pi": {
			const profile = (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim();
			if (profile && !/^[a-zA-Z0-9_-]+$/.test(profile))
				throw new HarnessError("oh my pi のプロファイル名が不正です。");
			const config = resolve(home, env.PI_CONFIG_DIR || ".omp");
			const agent = profile
				? join(config, "profiles", profile, "agent")
				: env.PI_CODING_AGENT_DIR || join(config, "agent");
			const roots = [join(agent, "sessions")];
			if (env.XDG_DATA_HOME && !env.PI_CODING_AGENT_DIR)
				roots.push(join(env.XDG_DATA_HOME, "omp", ...(profile ? ["profiles", profile] : []), "sessions"));
			return roots;
		}
	}
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function within(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

/** Reject replaced symlinks and bound both compressed input and decompressed output. */
async function readTranscript(path: string, head = false): Promise<string> {
	if ((await realpath(path)) !== path || (await lstat(path)).isSymbolicLink())
		throw new HarnessError("履歴の保存先が変更されました。再読み込みしてください。", 409);
	const file = await open(path, "r");
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > MAX_BYTES)
			throw new HarnessError("履歴が64 MiBを超えています。必要な会話を書き出して指定してください。", 413);
		if (/\.(zst|zstd)$/.test(path)) {
			const source = await file.readFile();
			if (source.length > MAX_BYTES) throw new HarnessError("圧縮履歴が64 MiBを超えています。", 413);
			const chunks: Buffer[] = [];
			let offset = 0;
			let length = 0;
			while (offset < source.length) {
				// Node currently decodes one frame. `info` reports exactly how many input bytes it consumed.
				// Node's declarations omit the info-result overload, so validate its runtime shape here.
				const raw: unknown = await decompress(source.subarray(offset), {
					info: true,
					maxOutputLength: Math.max(1, MAX_BYTES - length),
				});
				const decoded = record(raw);
				const consumed = record(decoded.engine).bytesWritten;
				if (
					!Buffer.isBuffer(decoded.buffer) ||
					!Number.isSafeInteger(consumed) ||
					Number(consumed) <= 0 ||
					Number(consumed) > source.length - offset
				)
					throw new HarnessError("圧縮履歴のフレームを読み込めません。");
				length += decoded.buffer.length;
				offset += Number(consumed);
				chunks.push(decoded.buffer);
				if (length > MAX_BYTES) throw new HarnessError("展開後の履歴が64 MiBを超えています。", 413);
				if (head && (length >= HEADER_BYTES || chunks.length >= 8)) break;
			}
			return Buffer.concat(chunks)
				.subarray(0, head ? HEADER_BYTES : length)
				.toString("utf8");
		}
		const stream = file.createReadStream({ autoClose: false });
		const chunks: Buffer[] = [];
		let length = 0;
		try {
			for await (const raw of stream) {
				const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
				length += chunk.length;
				if (!head && length > MAX_BYTES) throw new HarnessError("展開後の履歴が64 MiBを超えています。", 413);
				chunks.push(chunk);
				if (head && length >= HEADER_BYTES) break;
			}
		} finally {
			stream.destroy();
		}
		return Buffer.concat(chunks)
			.subarray(0, head ? HEADER_BYTES : length)
			.toString("utf8");
	} finally {
		await file.close();
	}
}

export function readOpenCodeDatabase(path: string, sessionId?: string): Promise<unknown> {
	return new Promise((resolveRead, reject) => {
		let received = false;
		const worker = new URL(
			import.meta.url.endsWith(".ts") ? "./sqlite-reader.ts" : "./sqlite-reader.js",
			import.meta.url,
		);
		const child = fork(fileURLToPath(worker), {
			execArgv: ["--disable-warning=ExperimentalWarning"],
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new HarnessError("OpenCode のデータベース読み込みがタイムアウトしました。", 408));
		}, 15000);
		child.once("message", (raw: unknown) => {
			received = true;
			const reply = record(raw);
			clearTimeout(timer);
			if (string(reply.error)) reject(new HarnessError(String(reply.error)));
			else resolveRead(reply.result);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (!received || code !== 0) reject(new HarnessError("OpenCode のデータベースを読み込めませんでした。"));
		});
		child.send({ path, op: sessionId ? "read" : "list", sessionId });
	});
}

export class SessionImportService {
	private readonly options: SessionImportOptions;
	private readonly candidates = new Map<string, Candidate>();
	constructor(options: SessionImportOptions = {}) {
		this.options = options;
	}
	paths(source: SessionImportSource): string[] {
		return sessionImportPaths(source, this.options.home, this.options.env);
	}
	async discover(request: SessionDiscoveryRequest): Promise<SessionDiscovery> {
		const paths = request.path
			? [
					request.path.startsWith("~/") || request.path.startsWith("~\\")
						? join(this.options.home ?? homedir(), request.path.slice(2))
						: request.path,
				]
			: this.paths(request.source);
		if (paths.some((path) => !isAbsolute(path)))
			throw new HarnessError("保存先にはサーバー上の絶対パスを指定してください。");
		for (const [id, candidate] of this.candidates) if (candidate.expires < Date.now()) this.candidates.delete(id);
		const warnings: string[] = [];
		const files: CandidateFile[] = [];
		let visited = 0;
		const scan = async (path: string, depth: number): Promise<void> => {
			if (++visited > 20000 || depth > 6) {
				warnings.push("探索範囲を制限しました。見つからない会話は保存先を絞って再検索してください。");
				return;
			}
			let info: Stats;
			try {
				info = await lstat(path);
			} catch (error) {
				if (missing(error) && !request.path) return;
				throw error;
			}
			if (info.isSymbolicLink()) return;
			if (info.isDirectory()) {
				for (const entry of await readdir(path, { withFileTypes: true })) {
					if (
						["node_modules", ".git", "subagents", "compaction_checkpoints", "artifacts"].includes(entry.name) ||
						entry.isSymbolicLink()
					)
						continue;
					await scan(join(path, entry.name), depth + 1);
					if (visited >= 20000) break;
				}
			} else if (info.isFile()) {
				const name = basename(path);
				const accept =
					request.source === "grok-build"
						? name === "summary.json" || name === "chat_history.jsonl" || name === "updates.jsonl"
						: request.source === "opencode"
							? /\.(db|sqlite|sqlite3|json)$/i.test(name) ||
								paths.some((root) => resolve(root) === resolve(path))
							: request.source === "deepseek-harness"
								? /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name)
								: /\.jsonl(?:\.zst)?$/.test(name);
				if (accept) files.push({ path: await realpath(path), modified: info.mtimeMs });
			}
		};
		for (const path of paths) {
			try {
				await scan(resolve(path), 0);
			} catch (error) {
				if (request.path)
					throw new HarnessError(
						`保存先を読み込めません: ${error instanceof Error ? error.message : String(error)}`,
					);
				warnings.push(`保存先を読み込めません: ${path}`);
			}
		}
		const grouped = new Map<string, CandidateFile>();
		for (const file of files) {
			const key =
				request.source === "grok-build"
					? dirname(file.path)
					: request.source === "deepseek-harness"
						? dirname(file.path)
						: file.path.replace(/\.zst$/, "");
			const previous = grouped.get(key);
			if (!previous) {
				grouped.set(key, file);
				continue;
			}
			if (request.source === "grok-build") {
				const rank = (path: string) =>
					basename(path) === "summary.json" ? 3 : basename(path) === "updates.jsonl" ? 2 : 1;
				if (rank(file.path) > rank(previous.path)) grouped.set(key, file);
			} else if (request.source === "deepseek-harness") {
				const version = (path: string) => Number(/session\.v(\d+)/.exec(path)?.[1] ?? 0);
				if (
					version(file.path) > version(previous.path) ||
					(version(file.path) === version(previous.path) && !file.path.endsWith(".zstd"))
				)
					grouped.set(key, file);
			} else if (!file.path.endsWith(".zst")) grouped.set(key, file);
		}
		const sorted = [...grouped.values()].sort((a, b) => b.modified - a.modified);
		if (sorted.length > MAX_CANDIDATES)
			warnings.push("最新500ファイルを表示しています。古い会話は保存先を絞って再検索してください。");
		const summaries: SessionImportCandidate[] = [];
		for (const file of sorted.slice(0, MAX_CANDIDATES)) {
			try {
				let database = false;
				if (request.source === "opencode") {
					const handle = await open(file.path, "r");
					try {
						const signature = Buffer.alloc(16);
						await handle.read(signature, 0, 16, 0);
						database = signature.equals(Buffer.from("SQLite format 3\0"));
					} finally {
						await handle.close();
					}
				}
				if (database) {
					const rows = await readOpenCodeDatabase(file.path);
					if (!Array.isArray(rows)) throw new Error("Invalid OpenCode session index");
					if (rows.length > MAX_CANDIDATES)
						warnings.push("OpenCode の最新500件を表示しています。古い会話はJSONに書き出して指定してください。");
					for (const raw of rows.slice(0, MAX_CANDIDATES)) {
						const row = record(raw);
						this.remember(
							summaries,
							request.source,
							file,
							sorted,
							string(row.id) ?? "",
							row.title,
							row.directory,
							row.time_updated,
							true,
						);
					}
					continue;
				}
				const head = await readTranscript(file.path, !file.path.endsWith(".json"));
				let meta: JsonRecord = {};
				let title: unknown;
				let cwd: unknown;
				let externalId: unknown;
				if (file.path.endsWith(".json")) {
					const value = record(JSON.parse(head));
					meta = record(value.info);
					externalId = meta.id;
					title = value.generated_title ?? value.session_summary ?? meta.title;
					cwd = record(meta.location).directory ?? meta.directory ?? meta.cwd;
				} else {
					const rows = jsonLines(head, [], true);
					if (request.source === "codex")
						meta = record(rows.find((entry) => entry.type === "session_meta")?.payload);
					else if (request.source === "oh-my-pi" || request.source === "deepseek-harness")
						meta = record(rows.find((entry) => entry.type === "session"));
					else if (request.source === "claude-code")
						meta = record(rows.find((entry) => entry.type === "user" && !entry.isSidechain));
					else if (request.source === "grok-build")
						meta = record(rows.find((entry) => record(entry.params).sessionId));
					externalId = meta.id ?? meta.sessionId ?? record(meta.params).sessionId;
					cwd = meta.cwd;
					title =
						rows.findLast((entry) => entry.type === "title")?.title ??
						meta.title ??
						rows.findLast((entry) => entry.type === "custom-title")?.customTitle;
					if (!title)
						for (const row of rows) {
							const message = record(row.message ?? row.payload ?? row.data);
							if (row.type === "user" || row.type === "user/message" || message.role === "user") {
								const content = message.content;
								title =
									typeof content === "string"
										? content
										: Array.isArray(content)
											? string(record(content[0]).text)
											: undefined;
								if (title) break;
							}
						}
				}
				if (!string(externalId) && request.source === "grok-build") externalId = basename(dirname(file.path));
				if (!string(externalId)) continue;
				this.remember(summaries, request.source, file, sorted, String(externalId), title, cwd);
			} catch (error) {
				warnings.push(`${basename(file.path)}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		while (this.candidates.size > 4000) this.candidates.delete(this.candidates.keys().next().value!);
		return {
			candidates: summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
			paths,
			warnings: [...new Set(warnings)].slice(0, 30),
		};
	}
	private remember(
		summaries: SessionImportCandidate[],
		source: SessionImportSource,
		file: CandidateFile,
		files: CandidateFile[],
		externalId: string,
		title: unknown,
		cwd: unknown,
		modified?: unknown,
		database = false,
	): void {
		const candidateId = createHash("sha256").update(`${source}\0${file.path}\0${externalId}`).digest("hex");
		const summary: SessionImportCandidate = {
			candidateId,
			source,
			sourceSessionId: externalId,
			title: (string(title) ?? externalId).replace(/\s+/g, " ").slice(0, 200),
			cwd: string(cwd),
			updatedAt: new Date(timestamp(modified) ?? file.modified).toISOString(),
		};
		this.candidates.set(candidateId, {
			...summary,
			path: file.path,
			files,
			expires: Date.now() + 30 * 60 * 1000,
			database,
		});
		summaries.push(summary);
	}
	private candidate(id: string): Candidate {
		const candidate = this.candidates.get(id);
		if (!candidate || candidate.expires < Date.now())
			throw new HarnessError("履歴一覧の有効期限が切れました。再読み込みしてください。", 404);
		return candidate;
	}
	async preview(id: string): Promise<SessionImportPreview> {
		const candidate = this.candidate(id);
		const { data, revision } = await this.read(id);
		return {
			candidateId: id,
			source: data.source,
			sourceSessionId: data.sourceSessionId,
			title: data.title,
			cwd: data.cwd,
			updatedAt: candidate.updatedAt,
			revision,
			messageCount: data.messages.length,
			messages: data.messages.slice(-12).map((message) => ({ ...message, text: message.text.slice(0, 4000) })),
			warnings: data.warnings,
		};
	}
	async read(id: string, expectedRevision?: string): Promise<{ data: ImportedTranscript; revision: string }> {
		const candidate = this.candidate(id);
		const warnings: string[] = [];
		const digest = createHash("sha256");
		let totalBytes = 0;
		const read = async (path: string): Promise<string> => {
			const text = await readTranscript(path);
			totalBytes += Buffer.byteLength(text);
			if (totalBytes > MAX_BYTES) throw new HarnessError("継承元を含む履歴が64 MiBを超えています。", 413);
			digest.update(path).update("\0").update(text);
			return text;
		};
		let data: ImportedTranscript;
		if (candidate.database) {
			if ((await realpath(candidate.path)) !== candidate.path)
				throw new HarnessError("保存先が変更されました。再読み込みしてください。", 409);
			const snapshot = await readOpenCodeDatabase(candidate.path, candidate.sourceSessionId);
			digest.update(JSON.stringify(snapshot));
			data = parseOpenCode(snapshot, candidate.sourceSessionId, warnings);
		} else if (candidate.source === "grok-build") {
			const root = dirname(candidate.path);
			const optional = async (name: string): Promise<string> => {
				try {
					return await read(join(root, name));
				} catch (error) {
					if (missing(error)) return "";
					throw error;
				}
			};
			const summary = record(JSON.parse((await optional("summary.json")) || "{}"));
			const updates = jsonLines(await optional("updates.jsonl"), warnings);
			const checkpoints = new Map<string, JsonRecord>();
			for (const entry of activeGrokUpdates(updates)) {
				const update = record(record(entry.params).update ?? entry.update);
				if (update.sessionUpdate !== "compaction_checkpoint") continue;
				const path = string(update.checkpoint_file);
				if (
					!path ||
					!/^compaction_checkpoints\/[a-zA-Z0-9_-]+\.json$/.test(path) ||
					!within(root, resolve(root, path))
				)
					throw new HarnessError("Grok Build のチェックポイントのパスが不正です。");
				try {
					checkpoints.set(path, record(JSON.parse(await read(resolve(root, path)))));
				} catch (error) {
					if (!missing(error)) throw error;
				}
			}
			data = parseGrok(
				updates,
				summary,
				updates.length ? [] : jsonLines(await optional("chat_history.jsonl"), warnings),
				checkpoints,
				candidate.sourceSessionId,
				warnings,
			);
		} else if (candidate.source === "opencode")
			data = parseOpenCode(JSON.parse(await read(candidate.path)), candidate.sourceSessionId, warnings);
		else {
			let entries = jsonLines(await read(candidate.path), warnings);
			if (candidate.source === "codex") {
				const seen = new Set<string>([candidate.path]);
				let meta = record(entries.find((entry) => entry.type === "session_meta")?.payload);
				while (meta.history_base) {
					const base = record(meta.history_base);
					const parentId = string(base.thread_id);
					if (!parentId || !/^[a-zA-Z0-9-]+$/.test(parentId) || !Number.isSafeInteger(base.end_ordinal_exclusive))
						throw new HarnessError("Codex の継承元の指定が不正です。");
					const parent = candidate.files.find((file) => basename(file.path).includes(parentId));
					if (!parent || seen.has(parent.path) || seen.size > 16)
						throw new HarnessError(
							"Codex の継承元が見つかりません。親セッションを含む保存フォルダーを指定してください。",
						);
					seen.add(parent.path);
					const prefix = jsonLines(await read(parent.path), warnings).filter(
						(entry, index) => Number(entry.ordinal ?? index) < Number(base.end_ordinal_exclusive),
					);
					meta = record(prefix.find((entry) => entry.type === "session_meta")?.payload);
					entries = [
						...entries.filter((entry) => entry.type === "session_meta"),
						...prefix.filter((entry) => entry.type !== "session_meta"),
						...entries.filter((entry) => entry.type !== "session_meta"),
					];
				}
				data = parseCodex(entries, candidate.sourceSessionId, warnings);
			} else if (candidate.source === "claude-code")
				data = parseClaude(entries, candidate.sourceSessionId, warnings);
			else if (candidate.source === "oh-my-pi") data = parseOhMyPi(entries, candidate.sourceSessionId, warnings);
			else data = parseDeepSeek(entries, candidate.sourceSessionId, warnings);
		}
		if (!data.messages.length) throw new HarnessError("取り込める会話メッセージがありません。");
		if (data.messages.length > 50000 || Buffer.byteLength(JSON.stringify(data.messages)) > MAX_BYTES)
			throw new HarnessError("取り込む会話が大きすぎます。必要な範囲を書き出して指定してください。", 413);
		const revision = digest.digest("hex");
		if (expectedRevision && revision !== expectedRevision)
			throw new HarnessError(
				"元のセッションが更新されました。プレビューを再読み込みしてから引き継いでください。",
				409,
			);
		return { data, revision };
	}
}
