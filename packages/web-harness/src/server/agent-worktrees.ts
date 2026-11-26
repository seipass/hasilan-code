import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const previewLimit = 120_000;

export interface AgentWorktree {
	id: string;
	baseline: string;
	status: "active" | "adopted" | "discarded";
	branch?: string;
}

export class AgentWorktrees {
	constructor(privateDirectory: string) {
		this.directory = join(privateDirectory, "web-harness", "agent-worktrees");
	}

	private readonly directory: string;

	private async git(cwd: string, args: string[], index?: string): Promise<string> {
		const env = { ...process.env };
		for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
		if (index) env.GIT_INDEX_FILE = index;
		const { stdout } = await execute(
			"git",
			["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${join(this.directory, "hooks-disabled")}`, ...args],
			{
				cwd,
				env,
				windowsHide: true,
				timeout: 120_000,
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		return stdout;
	}

	private async repository(cwd: string): Promise<string | undefined> {
		try {
			return (await this.git(cwd, ["rev-parse", "--show-toplevel"])).trimEnd();
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				(("code" in error && error.code === "ENOENT") ||
					("stderr" in error && typeof error.stderr === "string" && error.stderr.includes("not a git repository")))
			)
				return undefined;
			throw error;
		}
	}

	private checkout(worktree: AgentWorktree): string {
		if (!/^[a-f0-9-]{36}$/.test(worktree.id) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(worktree.baseline)) {
			throw new Error("Invalid agent worktree metadata");
		}
		return join(this.directory, worktree.id);
	}

	async cwd(worktree: AgentWorktree, source: string): Promise<string> {
		const repository = await this.repository(source);
		const checkout = this.checkout(worktree);
		if (!repository || resolve((await this.repository(checkout)) ?? "") !== resolve(checkout))
			throw new Error("Agent worktree is unavailable");
		return join(checkout, relative(repository, source));
	}

	private async snapshot(repository: string, scratch: string): Promise<{ head: string; tree: string }> {
		const index = join(scratch, "index");
		const head = (
			await this.git(repository, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch((error: unknown) => {
				if (error && typeof error === "object" && "code" in error && error.code === 1) return "";
				throw error;
			})
		).trim();
		await this.git(repository, ["read-tree", head || "--empty"], index);
		await this.git(repository, ["add", "-A", "--", "."], index);
		return { head, tree: (await this.git(repository, ["write-tree"], index)).trim() };
	}

	async create(source: string, preferredBranch?: string): Promise<AgentWorktree | undefined> {
		const repository = await this.repository(source);
		if (!repository) return undefined;
		const worktreeLocation = relative(repository, this.directory);
		if (!isAbsolute(worktreeLocation) && worktreeLocation !== ".." && !worktreeLocation.startsWith(`..${sep}`))
			throw new Error("Agent worktree storage must be outside the source repository");
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const scratch = await mkdtemp(join(this.directory, "snapshot-"));
		try {
			const { head, tree: baseline } = await this.snapshot(repository, scratch);
			const commit = (
				await this.git(repository, [
					"-c",
					"user.name=Hasilan Code",
					"-c",
					"user.email=worktree@hasilan.invalid",
					"commit-tree",
					baseline,
					...(head ? ["-p", head] : []),
					"-m",
					"Agent worktree baseline",
				])
			).trim();
			const id = randomUUID();
			let branch: string | undefined;
			if (preferredBranch?.trim()) {
				const sanitized = preferredBranch
					.trim()
					.replace(/[^a-zA-Z0-9/_-]+/g, "-")
					.replace(/\/+/g, "/")
					.replace(/^-+|-+$|^\/+|\/+$/g, "")
					.slice(0, 72);
				if (sanitized && !sanitized.includes("..")) {
					const exists = await this.git(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${sanitized}`])
						.then(() => true)
						.catch(() => false);
					branch = exists ? `${sanitized}-${id.slice(0, 6)}` : sanitized;
				}
			}
			const worktree: AgentWorktree = { id, baseline, status: "active", ...(branch ? { branch } : {}) };
			await this.git(
				repository,
				branch
					? ["worktree", "add", "-b", branch, "--", this.checkout(worktree), commit]
					: ["worktree", "add", "--detach", "--", this.checkout(worktree), commit],
			);
			return worktree;
		} finally {
			await rm(join(scratch, "index"), { force: true });
			await rmdir(scratch).catch(() => undefined);
		}
	}

	async changes(
		worktree: AgentWorktree,
		destination?: string,
	): Promise<{ diff: string; truncated: boolean; baseline: string; changed: boolean }> {
		const checkout = this.checkout(worktree);
		if (resolve((await this.repository(checkout)) ?? "") !== resolve(checkout))
			throw new Error("Agent worktree is unavailable");
		const scratch = await mkdtemp(join(this.directory, "diff-"));
		const patch = join(scratch, "changes.patch");
		try {
			const { tree: baseline } = await this.snapshot(checkout, scratch);
			if (baseline === worktree.baseline) return { diff: "", truncated: false, baseline, changed: false };
			await this.git(checkout, [
				"diff",
				"--binary",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				`--output=${patch}`,
				worktree.baseline,
				baseline,
			]);
			if (destination) {
				const repository = await this.repository(destination);
				if (!repository) throw new Error("The receiving workspace is no longer a Git repository");
				const commonDir = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
				if ((await this.git(repository, commonDir)).trimEnd() !== (await this.git(checkout, commonDir)).trimEnd())
					throw new Error("The receiving workspace belongs to a different repository");
				// Pin the tree before applying it so later comparisons survive Git garbage collection.
				await this.git(checkout, [
					"update-ref",
					`refs/hasilan/agent-worktrees/${worktree.id}/${baseline}`,
					baseline,
				]);
				try {
					await this.git(repository, ["apply", "--whitespace=nowarn", "--", patch]);
				} catch (error) {
					// A retry after a process interruption can find the complete patch already applied.
					try {
						await this.git(repository, ["apply", "--reverse", "--check", "--whitespace=nowarn", "--", patch]);
					} catch {
						throw error;
					}
				}
				return { diff: "", truncated: false, baseline, changed: true };
			}
			const file = await open(patch, "r");
			try {
				const buffer = Buffer.alloc(previewLimit + 1);
				const { bytesRead } = await file.read(buffer);
				return {
					diff: buffer.toString("utf8", 0, Math.min(previewLimit, bytesRead)),
					truncated: bytesRead > previewLimit,
					baseline,
					changed: true,
				};
			} finally {
				await file.close();
			}
		} finally {
			await Promise.all([rm(join(scratch, "index"), { force: true }), rm(patch, { force: true })]);
			await rmdir(scratch).catch(() => undefined);
		}
	}
}
