import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	isFailedCheck,
	type PrCiCheck,
	type PrCiCheckConclusion,
	type PrCiCheckFailure,
	type PrCiCheckStatus,
	type PrCommitNode,
	type PrConflictEntry,
	type PrLifecyclePhase,
	type PrLifecycleSurface,
	type PrViewMode,
	type WorkspaceGitSummary,
	type WorkspaceOpenPr,
} from "../shared/pr-lifecycle.ts";
import { HarnessError } from "./session-registry.ts";
import type { SurfaceManager } from "./surface-manager.ts";

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 15_000;
const CI_POLL_INTERVAL_MS = 5_000;

interface ExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number | string | null;
}

async function runCmd(
	file: "git" | "gh",
	args: string[],
	cwd: string,
	timeout = file === "gh" ? GH_TIMEOUT_MS : GIT_TIMEOUT_MS,
): Promise<ExecResult> {
	try {
		const { stdout, stderr } = await exec(file, args, {
			cwd,
			encoding: "utf8",
			timeout,
			maxBuffer: 4 * 1024 * 1024,
			windowsHide: true,
			env: file === "gh" ? { ...process.env, GH_PROMPT_DISABLED: "1" } : process.env,
		});
		return { ok: true, stdout, stderr, code: 0 };
	} catch (error) {
		const err = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
		return {
			ok: false,
			stdout: typeof err.stdout === "string" ? err.stdout : "",
			stderr: typeof err.stderr === "string" ? err.stderr : "",
			code: typeof err.code === "number" || typeof err.code === "string" ? err.code : 1,
		};
	}
}

async function runGit(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<ExecResult> {
	return runCmd("git", ["-c", "core.quotePath=false", ...args], cwd, timeout);
}

async function runGh(cwd: string, args: string[], timeout = GH_TIMEOUT_MS): Promise<ExecResult> {
	return runCmd("gh", args, cwd, timeout);
}

async function resolveBaseBranch(cwd: string, preferred?: string): Promise<{ name: string; ref: string }> {
	if (preferred?.trim()) {
		const clean = preferred.trim();
		const remote = await runGit(cwd, ["rev-parse", "--verify", "--end-of-options", `origin/${clean}^{commit}`]);
		if (remote.ok) return { name: clean, ref: `origin/${clean}` };
		const local = await runGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${clean}^{commit}`]);
		if (local.ok) return { name: clean, ref: clean };
		return { name: clean, ref: clean };
	}
	const originHead = await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (originHead.ok && originHead.stdout.trim()) {
		const ref = originHead.stdout.trim();
		const name = ref.replace(/^origin\//, "");
		return { name, ref };
	}
	for (const candidate of ["main", "master", "develop"]) {
		const remote = await runGit(cwd, ["rev-parse", "--verify", `origin/${candidate}^{commit}`]);
		if (remote.ok) return { name: candidate, ref: `origin/${candidate}` };
		const local = await runGit(cwd, ["rev-parse", "--verify", `${candidate}^{commit}`]);
		if (local.ok) return { name: candidate, ref: candidate };
	}
	return { name: "main", ref: "main" };
}

function slugBranchName(title: string): string {
	const words = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 36);
	return `pr/${words || `changes-${Date.now().toString(36)}`}`;
}

async function readOpenPr(cwd: string): Promise<WorkspaceOpenPr | undefined> {
	const res = await runGh(cwd, ["pr", "view", "--json", "number,title,url,state,isDraft"], 4_000);
	if (!res.ok || !res.stdout.trim()) return undefined;
	try {
		const data = JSON.parse(res.stdout) as Partial<WorkspaceOpenPr>;
		if (typeof data.number === "number" && typeof data.url === "string") {
			return {
				number: data.number,
				title: typeof data.title === "string" ? data.title : `PR #${data.number}`,
				url: data.url,
				state: typeof data.state === "string" ? data.state : "OPEN",
				isDraft: Boolean(data.isDraft),
			};
		}
	} catch {
		// Ignore malformed CLI output.
	}
	return undefined;
}

export async function inspectWorkspaceGit(cwd: string, includePr = true): Promise<WorkspaceGitSummary> {
	const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) {
		return { isGitRepo: false, filesChanged: 0, additions: 0, deletions: 0, aheadCommits: 0, hasRemote: false };
	}

	const [branchRes, headRes, base, numstatRes, untrackedRes, remoteRes] = await Promise.all([
		runGit(cwd, ["symbolic-ref", "--short", "HEAD"]),
		runGit(cwd, ["log", "-1", "--format=%H%x1f%s"]),
		resolveBaseBranch(cwd),
		runGit(cwd, ["diff", "--numstat", "HEAD"]),
		runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
		runGit(cwd, ["remote"]),
	]);

	let branch = branchRes.ok ? branchRes.stdout.trim() : undefined;
	if (!branch) {
		const detached = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
		if (detached.ok) branch = detached.stdout.trim();
	}

	const [headSha, headSubject] = headRes.ok ? headRes.stdout.trim().split("\x1f") : [undefined, undefined];

	let filesChanged = 0;
	let additions = 0;
	let deletions = 0;

	if (numstatRes.ok) {
		for (const line of numstatRes.stdout.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const parts = line.split("\t");
			if (parts.length < 3) continue;
			filesChanged += 1;
			const added = Number(parts[0]);
			const removed = Number(parts[1]);
			if (Number.isFinite(added)) additions += added;
			if (Number.isFinite(removed)) deletions += removed;
		}
	}

	const untracked = untrackedRes.ok ? untrackedRes.stdout.split("\0").filter(Boolean) : [];
	filesChanged += untracked.length;
	for (const relPath of untracked.slice(0, 40)) {
		try {
			const content = await readFile(join(cwd, relPath), "utf8");
			if (content.length > 0) additions += content.split(/\r?\n/).length;
		} catch {
			// Skip unreadable/binary paths.
		}
	}

	let aheadCommits = 0;
	const aheadRes = await runGit(cwd, ["rev-list", "--count", `${base.ref}..HEAD`]);
	if (aheadRes.ok) {
		const parsed = Number(aheadRes.stdout.trim());
		if (Number.isFinite(parsed)) aheadCommits = parsed;
	}

	const hasRemote = remoteRes.ok && remoteRes.stdout.trim().length > 0;
	const openPr = includePr && hasRemote ? await readOpenPr(cwd) : undefined;

	return {
		isGitRepo: true,
		branch,
		baseBranch: base.name,
		headSha: headSha || undefined,
		headSubject: headSubject || undefined,
		filesChanged,
		additions,
		deletions,
		aheadCommits,
		hasRemote,
		openPr,
	};
}

function parseDecorations(raw: string): string[] {
	if (!raw.trim()) return [];
	const refs: string[] = [];
	for (const token of raw.split(",")) {
		const trimmed = token.trim();
		if (!trimmed || trimmed.startsWith("tag: ")) continue;
		const cleaned = trimmed.replace(/^HEAD -> /, "").trim();
		if (!cleaned || cleaned === "HEAD" || cleaned === "origin/HEAD") continue;
		if (!refs.includes(cleaned)) refs.push(cleaned);
	}
	return refs.slice(0, 3);
}

export async function collectCommitGraph(
	cwd: string,
	headBranch: string,
	baseBranch: string,
	limit = 12,
): Promise<PrCommitNode[]> {
	const base = await resolveBaseBranch(cwd, baseBranch);
	const refsRes = await runGit(cwd, [
		"for-each-ref",
		"--sort=-committerdate",
		"--format=%(refname:short)",
		"refs/heads",
	]);
	const siblingBranch = refsRes.ok
		? refsRes.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find((name) => name && name !== headBranch && name !== base.name && name !== base.ref)
		: undefined;

	const logRefs = ["HEAD"];
	const baseValid = await runGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${base.ref}^{commit}`]);
	if (baseValid.ok) logRefs.push(base.ref);
	if (siblingBranch) logRefs.push(siblingBranch);

	const [logRes, baseFirstRes, headOnlyRes, siblingOnlyRes] = await Promise.all([
		runGit(cwd, [
			"log",
			"--topo-order",
			`--max-count=${limit}`,
			"--format=%H%x1f%P%x1f%D%x1f%an%x1f%cr%x1f%s",
			...logRefs,
		]),
		baseValid.ok
			? runGit(cwd, ["rev-list", "--first-parent", "--max-count=60", base.ref])
			: Promise.resolve({ ok: false, stdout: "", stderr: "", code: 1 }),
		baseValid.ok
			? runGit(cwd, ["rev-list", "--max-count=60", `${base.ref}..HEAD`])
			: Promise.resolve({ ok: false, stdout: "", stderr: "", code: 1 }),
		siblingBranch && baseValid.ok
			? runGit(cwd, ["rev-list", "--max-count=30", `${base.ref}..${siblingBranch}`])
			: Promise.resolve({ ok: false, stdout: "", stderr: "", code: 1 }),
	]);

	if (!logRes.ok) return [];

	const baseFirst = new Set(baseFirstRes.ok ? baseFirstRes.stdout.split(/\r?\n/).filter(Boolean) : []);
	const headOnly = new Set(headOnlyRes.ok ? headOnlyRes.stdout.split(/\r?\n/).filter(Boolean) : []);
	const siblingOnly = new Set(siblingOnlyRes.ok ? siblingOnlyRes.stdout.split(/\r?\n/).filter(Boolean) : []);

	const nodes: PrCommitNode[] = [];
	for (const line of logRes.stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [sha, parentsRaw, decorRaw, author, relativeTime, ...subjectParts] = line.split("\x1f");
		if (!sha) continue;
		const parents = parentsRaw ? parentsRaw.trim().split(/\s+/).filter(Boolean) : [];
		let lane: 0 | 1 | 2 = 0;
		if (headOnly.has(sha)) lane = 1;
		else if (siblingOnly.has(sha) && !baseFirst.has(sha)) lane = 2;
		else lane = 0;

		nodes.push({
			sha,
			shortSha: sha.slice(0, 7),
			parents,
			lane,
			branchRefs: parseDecorations(decorRaw ?? ""),
			author: author ?? "",
			relativeTime: relativeTime ?? "",
			subject: subjectParts.join("\x1f").trim(),
			...(parents.length > 1 ? { isMerge: true } : {}),
		});
	}
	return nodes;
}

export function parseConflictMarkers(
	file: string,
	content: string,
	theirsMeta?: { sha?: string; author?: string },
): PrConflictEntry[] {
	const lines = content.split(/\r?\n/);
	const entries: PrConflictEntry[] = [];
	let index = 0;
	let oursLineCounter = 0;

	while (index < lines.length) {
		const line = lines[index];
		if (!line.startsWith("<<<<<<<")) {
			oursLineCounter += 1;
			index += 1;
			continue;
		}
		const conflictStartLine = oursLineCounter + 1;
		index += 1;
		const oursLines: string[] = [];
		const theirsLines: string[] = [];
		let section: "ours" | "base" | "theirs" = "ours";

		while (index < lines.length) {
			const current = lines[index];
			if (current.startsWith("|||||||")) {
				section = "base";
				index += 1;
				continue;
			}
			if (current.startsWith("=======")) {
				section = "theirs";
				index += 1;
				continue;
			}
			if (current.startsWith(">>>>>>>")) {
				index += 1;
				break;
			}
			if (section === "ours") {
				oursLines.push(current);
				oursLineCounter += 1;
			} else if (section === "theirs") {
				theirsLines.push(current);
			}
			index += 1;
		}

		entries.push({
			id: `${file}:${conflictStartLine}:${entries.length}`,
			file,
			line: conflictStartLine,
			...(theirsMeta?.author ? { theirsAuthor: theirsMeta.author } : {}),
			...(theirsMeta?.sha ? { theirsCommitSha: theirsMeta.sha } : {}),
			oursText: oursLines.join("\n").slice(0, 2_000),
			theirsText: theirsLines.join("\n").slice(0, 2_000),
			resolved: false,
		});
	}
	return entries;
}

export async function detectMergeConflicts(cwd: string, baseBranchOrRef: string): Promise<PrConflictEntry[]> {
	const base = await resolveBaseBranch(cwd, baseBranchOrRef);
	const verify = await runGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${base.ref}^{commit}`]);
	if (!verify.ok) return [];

	const mergeTree = await runGit(cwd, ["merge-tree", "--write-tree", "--messages", "HEAD", base.ref]);
	if (mergeTree.ok) return [];

	const outputLines = mergeTree.stdout.split(/\r?\n/);
	const treeOid = outputLines[0]?.trim();
	if (!treeOid || !/^[0-9a-f]{40}$/i.test(treeOid)) return [];

	const conflictedFiles = new Set<string>();
	for (const line of outputLines.slice(1)) {
		const match = /CONFLICT \([^)]+\): (?:Merge conflict in|.*?) (.+)$/.exec(line.trim());
		if (match) {
			const candidate = match[1].trim();
			if (candidate) conflictedFiles.add(candidate);
		}
	}

	const entries: PrConflictEntry[] = [];
	for (const file of conflictedFiles) {
		const [blobRes, authorRes] = await Promise.all([
			runGit(cwd, ["cat-file", "-p", `${treeOid}:${file}`]),
			runGit(cwd, ["log", "-1", "--format=%H%x1f%an", base.ref, "--", file]),
		]);
		const [theirsSha, theirsAuthor] = authorRes.ok ? authorRes.stdout.trim().split("\x1f") : [undefined, undefined];
		if (blobRes.ok && blobRes.stdout.includes("<<<<<<<")) {
			entries.push(
				...parseConflictMarkers(file, blobRes.stdout, {
					sha: theirsSha || undefined,
					author: theirsAuthor || undefined,
				}),
			);
		} else {
			entries.push({
				id: `${file}:1:0`,
				file,
				line: 1,
				...(theirsAuthor ? { theirsAuthor } : {}),
				...(theirsSha ? { theirsCommitSha: theirsSha } : {}),
				oursText: "(branch version)",
				theirsText: "(base branch version)",
				resolved: false,
			});
		}
	}
	return entries;
}

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function parseCiFailureOutput(output: string): PrCiCheckFailure | undefined {
	if (!output.trim()) return undefined;
	const clean = output.replace(ANSI_ESCAPE_RE, "");
	const lines = clean.split(/\r?\n/);

	let file: string | undefined;
	let lineNumber: number | undefined;
	let testTitle: string | undefined;
	let expected: string | undefined;
	let received: string | undefined;

	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;

		if (!testTitle) {
			const pw = /^\d+\)\s+(?:\[[^\]]+\]\s*[›>]\s*)?([^\s:]+\.[a-z]{1,4}):(\d+)(?::\d+)?\s*[›>]\s*(.+)$/.exec(line);
			if (pw) {
				file = pw[1];
				lineNumber = Number(pw[2]);
				testTitle = pw[3].trim();
			} else {
				const vt = /^(?:FAIL|[×✕✗])\s+(.+)$/.exec(line);
				if (vt) testTitle = vt[1].trim();
			}
		}

		if (!file) {
			const loc = /(?:at\s+)?([\w./-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|spec\.ts|test\.tsx?)):(\d+)(?::\d+)?/.exec(
				line,
			);
			if (loc) {
				file = loc[1];
				lineNumber = Number(loc[2]);
			} else {
				const tsLoc = /^([\w./-]+\.tsx?)\((\d+),\d+\):\s+error\b/.exec(line);
				if (tsLoc) {
					file = tsLoc[1];
					lineNumber = Number(tsLoc[2]);
				}
			}
		}

		if (!expected) {
			const exp = /^Expected(?:\s+\w+)?:\s*(.+)$/i.exec(line);
			if (exp) expected = exp[1].trim();
		}
		if (!received) {
			const rec = /^Received(?:\s+\w+)?:\s*(.+)$/i.exec(line);
			if (rec) received = rec[1].trim();
		}
	}

	const errorLines = lines
		.map((l) => l.trim())
		.filter((l) => l && /(error|fail|expected|received|assertion|timed out|exception)/i.test(l))
		.slice(0, 4);
	const excerpt =
		errorLines.length > 0
			? errorLines.join("\n").slice(0, 800)
			: lines
					.map((l) => l.trim())
					.filter(Boolean)
					.slice(0, 4)
					.join("\n")
					.slice(0, 800);

	if (!file && !testTitle && !expected && !received && !excerpt) return undefined;
	return {
		...(file ? { file } : {}),
		...(lineNumber && Number.isFinite(lineNumber) ? { line: lineNumber } : {}),
		...(testTitle ? { testTitle } : {}),
		...(expected ? { expected } : {}),
		...(received ? { received } : {}),
		...(excerpt ? { excerpt } : {}),
	};
}

function durationSeconds(startedAt?: string, completedAt?: string): number | undefined {
	if (!startedAt || !completedAt) return undefined;
	const start = Date.parse(startedAt);
	const end = Date.parse(completedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
	return Math.max(0, Math.round((end - start) / 1000));
}

function normalizeCheckStatus(value: unknown): PrCiCheckStatus {
	if (value === "in_progress" || value === "completed") return value;
	return "queued";
}

function normalizeConclusion(value: unknown): PrCiCheckConclusion | undefined {
	switch (value) {
		case "success":
		case "failure":
		case "neutral":
		case "cancelled":
		case "skipped":
		case "timed_out":
		case "action_required":
			return value;
		default:
			return undefined;
	}
}

export async function fetchCheckRuns(cwd: string, headSha: string): Promise<PrCiCheck[]> {
	const repoRes = await runGh(cwd, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], 5_000);
	const repo = repoRes.ok ? repoRes.stdout.trim() : "";
	if (!repo || !repo.includes("/")) return [];

	const [checksRes, statusRes] = await Promise.all([
		runGh(cwd, ["api", `repos/${repo}/commits/${headSha}/check-runs`], 8_000),
		runGh(cwd, ["api", `repos/${repo}/commits/${headSha}/status`], 8_000),
	]);

	const checks: PrCiCheck[] = [];
	const seenNames = new Set<string>();

	if (checksRes.ok && checksRes.stdout.trim()) {
		try {
			const parsed = JSON.parse(checksRes.stdout) as {
				check_runs?: Array<{
					id?: number;
					name?: string;
					status?: string;
					conclusion?: string | null;
					started_at?: string | null;
					completed_at?: string | null;
					html_url?: string | null;
					details_url?: string | null;
					output?: { title?: string | null; summary?: string | null; text?: string | null };
				}>;
			};
			for (const run of parsed.check_runs ?? []) {
				if (!run.name) continue;
				seenNames.add(run.name);
				const status = normalizeCheckStatus(run.status);
				const conclusion = normalizeConclusion(run.conclusion);
				const startedAt = run.started_at ?? undefined;
				const completedAt = run.completed_at ?? undefined;
				const check: PrCiCheck = {
					id: String(run.id ?? run.name),
					name: run.name,
					status,
					...(conclusion ? { conclusion } : {}),
					...(startedAt ? { startedAt } : {}),
					...(completedAt ? { completedAt } : {}),
					...(durationSeconds(startedAt, completedAt) !== undefined
						? { durationSec: durationSeconds(startedAt, completedAt) }
						: {}),
					...(run.output?.title || run.output?.summary
						? { detail: (run.output.title || run.output.summary || "").slice(0, 200) }
						: {}),
					...(run.html_url || run.details_url ? { url: (run.html_url || run.details_url) ?? undefined } : {}),
				};

				if (isFailedCheck(check)) {
					let failure: PrCiCheckFailure | undefined;
					const combinedOutput = [run.output?.title, run.output?.summary, run.output?.text]
						.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
						.join("\n");
					failure = parseCiFailureOutput(combinedOutput);

					if ((!failure || (!failure.expected && !failure.file)) && typeof run.id === "number") {
						const annRes = await runGh(cwd, ["api", `repos/${repo}/check-runs/${run.id}/annotations`], 5_000);
						if (annRes.ok && annRes.stdout.trim()) {
							try {
								const anns = JSON.parse(annRes.stdout) as Array<{
									path?: string;
									start_line?: number;
									title?: string;
									message?: string;
								}>;
								const first = anns.find((entry) => entry.message || entry.path);
								if (first) {
									const fromMsg = parseCiFailureOutput(first.message ?? "");
									failure = {
										...fromMsg,
										file: first.path || fromMsg?.file,
										line: first.start_line ?? fromMsg?.line,
										testTitle: first.title || fromMsg?.testTitle,
										excerpt: fromMsg?.excerpt ?? first.message?.slice(0, 600),
									};
								}
							} catch {
								// Ignore annotation parse errors.
							}
						}
					}

					const runIdMatch = /\/actions\/runs\/(\d+)/.exec(run.details_url ?? run.html_url ?? "");
					if ((!failure || !failure.expected) && runIdMatch) {
						const logRes = await runGh(cwd, ["run", "view", runIdMatch[1], "--log-failed"], 8_000);
						if (logRes.ok && logRes.stdout.trim()) {
							const parsedLog = parseCiFailureOutput(logRes.stdout.slice(-16_000));
							if (parsedLog) failure = { ...failure, ...parsedLog };
						}
					}
					if (failure) check.failure = failure;
				}

				checks.push(check);
			}
		} catch {
			// Ignore malformed check-runs JSON.
		}
	}

	if (statusRes.ok && statusRes.stdout.trim()) {
		try {
			const parsed = JSON.parse(statusRes.stdout) as {
				statuses?: Array<{
					id?: number;
					context?: string;
					state?: string;
					description?: string | null;
					target_url?: string | null;
					created_at?: string;
					updated_at?: string;
				}>;
			};
			for (const item of parsed.statuses ?? []) {
				if (!item.context || seenNames.has(item.context)) continue;
				seenNames.add(item.context);
				const status: PrCiCheckStatus = item.state === "pending" ? "in_progress" : "completed";
				const conclusion: PrCiCheckConclusion | undefined =
					item.state === "success"
						? "success"
						: item.state === "failure" || item.state === "error"
							? "failure"
							: undefined;
				checks.push({
					id: `status-${item.id ?? item.context}`,
					name: item.context,
					status,
					...(conclusion ? { conclusion } : {}),
					...(item.created_at ? { startedAt: item.created_at } : {}),
					...(status === "completed" && item.updated_at ? { completedAt: item.updated_at } : {}),
					...(item.description ? { detail: item.description.slice(0, 200) } : {}),
					...(item.target_url ? { url: item.target_url } : {}),
				});
			}
		} catch {
			// Ignore malformed status JSON.
		}
	}

	return checks;
}

function decorateGraphWithConflicts(
	commits: PrCommitNode[],
	conflicts: PrConflictEntry[],
	headBranch: string,
	baseBranch: string,
	phase: PrLifecyclePhase,
): PrCommitNode[] {
	const unresolved = conflicts.filter((entry) => !entry.resolved);
	const countsBySha = new Map<string, number>();
	for (const conflict of unresolved) {
		if (conflict.theirsCommitSha) {
			countsBySha.set(conflict.theirsCommitSha, (countsBySha.get(conflict.theirsCommitSha) ?? 0) + 1);
		}
	}

	const annotated = commits.map((node) => {
		const count = countsBySha.get(node.sha);
		return count ? { ...node, conflictCount: count } : node;
	});

	const headNode = annotated.find((node) => node.lane === 1);
	const baseNode = annotated.find((node) => node.lane === 0);
	if (headNode && baseNode && headNode.sha !== baseNode.sha && phase !== "merged") {
		const projected: PrCommitNode = {
			sha: "projected-merge",
			shortSha: "merge",
			parents: [headNode.sha, baseNode.sha],
			lane: 1,
			branchRefs: [],
			author: "Merge preview",
			relativeTime: unresolved.length > 0 ? `${unresolved.length} 件の競合` : "マージ可能",
			subject: `${baseBranch} ← ${headBranch}`,
			isMerge: true,
			isProjectedMerge: true,
			...(unresolved.length > 0
				? { conflictCount: unresolved.length }
				: { conflictsResolved: conflicts.length > 0 }),
		};
		return [projected, ...annotated];
	}
	return annotated;
}

export interface CreatePrOptions {
	title?: string;
	baseBranch?: string;
	commitMessage?: string;
	draft?: boolean;
	/** Synchronous mode for tests; production streams intermediate steps asynchronously. */
	waitForReady?: boolean;
}

export class PrLifecycleManager {
	private readonly surfaces: SurfaceManager;
	private readonly pollers = new Map<string, ReturnType<typeof setInterval>>();

	constructor(surfaces: SurfaceManager) {
		this.surfaces = surfaces;
	}

	inspect(cwd: string): Promise<WorkspaceGitSummary> {
		return inspectWorkspaceGit(cwd);
	}

	async createOrAttach(sessionId: string, cwd: string, options: CreatePrOptions = {}): Promise<PrLifecycleSurface> {
		const summary = await inspectWorkspaceGit(cwd);
		if (!summary.isGitRepo) {
			throw new HarnessError("現在のワークスペースは Git リポジトリではありません。", 400);
		}

		const baseBranch = options.baseBranch?.trim() || summary.baseBranch || "main";
		const existing = this.surfaces.getPrSurface(sessionId);
		const now = new Date().toISOString();
		const title =
			options.title?.trim() || summary.openPr?.title || summary.headSubject || `${summary.branch ?? "changes"}`;

		const surface: PrLifecycleSurface =
			existing && existing.phase !== "merged"
				? {
						...existing,
						title,
						baseBranch,
						viewMode: "inline",
						error: undefined,
						updatedAt: now,
					}
				: {
						kind: "pr_lifecycle",
						surfaceId: `pr-${randomUUID()}`,
						sessionId,
						viewMode: "inline",
						phase: summary.filesChanged > 0 ? "committing" : "fetching",
						title,
						headBranch: summary.branch ?? "HEAD",
						baseBranch,
						headSha: summary.headSha,
						headSubject: summary.headSubject,
						prNumber: summary.openPr?.number,
						prUrl: summary.openPr?.url,
						statusNote:
							summary.filesChanged > 0 ? "変更をコミットしています…" : "ブランチと PR を確認しています…",
						filesChanged: summary.filesChanged,
						additions: summary.additions,
						deletions: summary.deletions,
						commits: [],
						conflicts: [],
						checks: [],
						createdAt: now,
						updatedAt: now,
					};

		const saved = this.surfaces.upsertPrSurface(sessionId, surface, true);
		const task = this.runCreatePipeline(sessionId, saved.surfaceId, cwd, options, summary);
		if (options.waitForReady) {
			return await task;
		}
		void task.catch(() => undefined);
		return saved;
	}

	private async runCreatePipeline(
		sessionId: string,
		surfaceId: string,
		cwd: string,
		options: CreatePrOptions,
		initial: WorkspaceGitSummary,
	): Promise<PrLifecycleSurface> {
		let surface = this.surfaces.getPrSurface(sessionId, surfaceId);
		if (!surface) throw new HarnessError("PR カードが見つかりません。", 404);

		try {
			let branch = surface.headBranch;
			const baseBranch = surface.baseBranch;

			if (initial.filesChanged > 0) {
				if (branch === baseBranch || !branch || branch === "HEAD") {
					const newBranch = slugBranchName(surface.title);
					const checkout = await runGit(cwd, ["checkout", "-b", newBranch]);
					if (!checkout.ok) {
						throw new Error(checkout.stderr.trim() || "新しいブランチを作成できませんでした。");
					}
					branch = newBranch;
					surface.headBranch = branch;
				}
				surface.phase = "committing";
				surface.statusNote = "変更をコミットしています…";
				this.surfaces.upsertPrSurface(sessionId, surface, false);

				const addRes = await runGit(cwd, ["add", "--all"]);
				if (!addRes.ok) throw new Error(addRes.stderr.trim() || "変更をステージできませんでした。");

				const commitMsg = options.commitMessage?.trim() || surface.title;
				const commitRes = await runGit(cwd, ["commit", "-m", commitMsg]);
				if (!commitRes.ok && !/nothing to commit/i.test(`${commitRes.stdout}\n${commitRes.stderr}`)) {
					throw new Error(commitRes.stderr.trim() || "コミットに失敗しました。");
				}
			}

			if (initial.hasRemote) {
				surface.phase = "pushing";
				surface.statusNote = `${branch} をプッシュしています…`;
				this.surfaces.upsertPrSurface(sessionId, surface, false);

				const pushRes = await runGit(cwd, ["push", "-u", "origin", branch], 25_000);
				if (!pushRes.ok) {
					surface.statusNote = `プッシュをスキップしました: ${pushRes.stderr.trim().slice(0, 140)}`;
				} else {
					let openPr = await readOpenPr(cwd);
					if (!openPr) {
						surface.phase = "opening";
						surface.statusNote = "Pull Request を作成しています…";
						this.surfaces.upsertPrSurface(sessionId, surface, false);

						const createArgs = [
							"pr",
							"create",
							"--title",
							surface.title,
							"--base",
							baseBranch,
							"--body",
							`Created from Hasilan Code (${branch} -> ${baseBranch}).`,
						];
						if (options.draft) createArgs.push("--draft");
						const createRes = await runGh(cwd, createArgs, 20_000);
						if (createRes.ok) {
							openPr = await readOpenPr(cwd);
							if (!openPr && createRes.stdout.trim().startsWith("http")) {
								const prUrl = createRes.stdout.trim().split(/\r?\n/).at(-1);
								const num = prUrl ? Number(/\/pull\/(\d+)/.exec(prUrl)?.[1]) : NaN;
								if (prUrl && Number.isFinite(num)) {
									openPr = { number: num, title: surface.title, url: prUrl, state: "OPEN" };
								}
							}
						} else {
							surface.statusNote =
								createRes.stderr.trim().slice(0, 160) ||
								"GitHub CLI (gh) で PR を作成できませんでした。ローカルの差分と競合を表示します。";
						}
					}
					if (openPr) {
						surface.prNumber = openPr.number;
						surface.prUrl = openPr.url;
						surface.title = openPr.title || surface.title;
					}
				}

				surface.phase = "fetching";
				surface.statusNote = `${baseBranch} を取得して競合を確認しています…`;
				this.surfaces.upsertPrSurface(sessionId, surface, false);
				await runGit(cwd, ["fetch", "origin", baseBranch], 15_000);
			}

			return await this.refresh(sessionId, surfaceId, cwd);
		} catch (error) {
			surface = this.surfaces.getPrSurface(sessionId, surfaceId) ?? surface;
			surface.phase = "error";
			surface.error = error instanceof Error ? error.message : "PR の作成に失敗しました。";
			surface.statusNote = undefined;
			return this.surfaces.upsertPrSurface(sessionId, surface, true);
		}
	}

	async refresh(sessionId: string, surfaceId: string, cwd: string): Promise<PrLifecycleSurface> {
		const existing = this.surfaces.getPrSurface(sessionId, surfaceId);
		if (!existing) throw new HarnessError("対象の PR カードが見つかりません。", 404);

		const summary = await inspectWorkspaceGit(cwd);
		const headBranch = summary.branch || existing.headBranch;
		const baseBranch = existing.baseBranch || summary.baseBranch || "main";
		const openPr = summary.openPr;

		const [rawCommits, freshConflicts, checks] = await Promise.all([
			collectCommitGraph(cwd, headBranch, baseBranch),
			detectMergeConflicts(cwd, baseBranch),
			summary.headSha && summary.hasRemote ? fetchCheckRuns(cwd, summary.headSha) : Promise.resolve([]),
		]);

		// Keep resolved markers visible once conflicts were cleared after a resolve loop.
		const conflicts: PrConflictEntry[] =
			freshConflicts.length > 0
				? freshConflicts
				: existing.conflicts.length > 0
					? existing.conflicts.map((entry) => ({ ...entry, resolved: true }))
					: [];

		const unresolvedCount = conflicts.filter((entry) => !entry.resolved).length;
		const checksRunning = checks.some((check) => check.status !== "completed");
		const checksFailed = checks.some((check) => isFailedCheck(check));

		let nextPhase: PrLifecyclePhase;
		let statusNote: string | undefined;
		if (openPr?.state === "MERGED" || existing.phase === "merged") {
			nextPhase = "merged";
		} else if (unresolvedCount > 0) {
			nextPhase = "conflicts";
			statusNote = `${unresolvedCount} 件のマージ競合があります`;
		} else if (checksRunning) {
			nextPhase = "checks_running";
			statusNote = undefined;
		} else if (checksFailed) {
			nextPhase = "check_failed";
			statusNote = undefined;
		} else {
			nextPhase = "ready";
			statusNote =
				existing.statusNote?.startsWith("プッシュをスキップ") || existing.statusNote?.startsWith("GitHub CLI")
					? existing.statusNote
					: undefined;
		}

		const earliestCheck = checks
			.map((check) => check.startedAt)
			.filter((ts): ts is string => Boolean(ts))
			.sort()[0];

		const updated: PrLifecycleSurface = {
			...existing,
			headBranch,
			baseBranch,
			headSha: summary.headSha ?? existing.headSha,
			headSubject: summary.headSubject ?? existing.headSubject,
			prNumber: openPr?.number ?? existing.prNumber,
			prUrl: openPr?.url ?? existing.prUrl,
			filesChanged: summary.filesChanged,
			additions: summary.additions,
			deletions: summary.deletions,
			commits: decorateGraphWithConflicts(rawCommits, conflicts, headBranch, baseBranch, nextPhase),
			conflicts,
			checks,
			checksStartedAt: earliestCheck ?? existing.checksStartedAt,
			phase: nextPhase,
			statusNote,
			fixingCheckName: undefined,
			error: undefined,
		};

		const persisted = this.surfaces.upsertPrSurface(sessionId, updated, true);
		if (nextPhase === "checks_running") {
			this.ensurePolling(sessionId, surfaceId, cwd);
		} else {
			this.stopPolling(sessionId, surfaceId);
		}
		return persisted;
	}

	setViewMode(sessionId: string, surfaceId: string, viewMode: PrViewMode): PrLifecycleSurface {
		const existing = this.surfaces.getPrSurface(sessionId, surfaceId);
		if (!existing) throw new HarnessError("対象の PR カードが見つかりません。", 404);
		existing.viewMode = viewMode;
		return this.surfaces.upsertPrSurface(sessionId, existing, true);
	}

	async startResolveConflicts(
		sessionId: string,
		surfaceId: string,
		cwd: string,
		launchPrompt: (text: string) => Promise<void>,
	): Promise<PrLifecycleSurface> {
		const existing = this.surfaces.getPrSurface(sessionId, surfaceId);
		if (!existing) throw new HarnessError("対象の PR カードが見つかりません。", 404);
		const unresolved = existing.conflicts.filter((entry) => !entry.resolved);
		if (unresolved.length === 0) {
			return await this.refresh(sessionId, surfaceId, cwd);
		}

		existing.phase = "resolving";
		existing.statusNote = `${unresolved.length} 件の競合を解消しています…`;
		existing.error = undefined;
		const saved = this.surfaces.upsertPrSurface(sessionId, existing, true);

		const conflictBrief = unresolved
			.slice(0, 12)
			.map(
				(entry, index) =>
					`### 競合 ${index + 1}: ${entry.file}${entry.line ? `:${entry.line}` : ""}\n` +
					`- ${entry.theirsAuthor ? `${entry.theirsAuthor} (${existing.baseBranch})` : existing.baseBranch}:\n\`\`\`\n${entry.theirsText}\n\`\`\`\n` +
					`- 現在のブランチ (${existing.headBranch}):\n\`\`\`\n${entry.oursText}\n\`\`\``,
			)
			.join("\n\n");

		const prompt = [
			`ブランチ \`${existing.headBranch}\` に \`${existing.baseBranch}\` を取り込んで、以下のマージ競合を解消してください。`,
			"",
			conflictBrief,
			"",
			"手順:",
			`1. \`git merge ${existing.baseBranch}\`（リモートがある場合は最新の \`origin/${existing.baseBranch}\`）を実行する。`,
			"2. 両ブランチの意図を損なわないように競合箇所を解消し、不要なコンフリクトマーカーを残さない。",
			"3. 関連する型チェックやテストを実行して問題がないことを確認する。",
			"4. マージコミットを作成し、リモートブランチが存在する場合はプッシュする。",
		].join("\n");

		await launchPrompt(prompt);
		return saved;
	}

	async startFixCi(
		sessionId: string,
		surfaceId: string,
		checkName: string | undefined,
		launchPrompt: (text: string) => Promise<void>,
	): Promise<PrLifecycleSurface> {
		const existing = this.surfaces.getPrSurface(sessionId, surfaceId);
		if (!existing) throw new HarnessError("対象の PR カードが見つかりません。", 404);
		const failedChecks = existing.checks.filter((check) => isFailedCheck(check));
		const target =
			(checkName ? failedChecks.find((check) => check.name === checkName) : undefined) ?? failedChecks[0];
		if (!target) throw new HarnessError("失敗している CI チェックが見つかりません。", 409);

		existing.phase = "fixing";
		existing.fixingCheckName = target.name;
		existing.viewMode = "docked_collapsed";
		existing.statusNote = `${target.name} の失敗を修正しています…`;
		existing.error = undefined;
		const saved = this.surfaces.upsertPrSurface(sessionId, existing, true);

		const failure = target.failure;
		const details = [
			`CI チェック **${target.name}** が失敗しました。原因を調査して修正し、ローカルで検証してからコミット・プッシュしてください。`,
			failure?.file ? `- ファイル: \`${failure.file}${failure.line ? `:${failure.line}` : ""}\`` : "",
			failure?.testTitle ? `- テスト: ${failure.testTitle}` : "",
			failure?.expected ? `- Expected: \`${failure.expected}\`` : "",
			failure?.received ? `- Received: \`${failure.received}\`` : "",
			failure?.excerpt ? `\n失敗ログ抜粋:\n\`\`\`\n${failure.excerpt}\n\`\`\`` : "",
		]
			.filter(Boolean)
			.join("\n");

		await launchPrompt(details);
		return saved;
	}

	async merge(
		sessionId: string,
		surfaceId: string,
		cwd: string,
		method: "merge" | "squash" | "rebase" = "merge",
	): Promise<PrLifecycleSurface> {
		const existing = this.surfaces.getPrSurface(sessionId, surfaceId);
		if (!existing) throw new HarnessError("対象の PR カードが見つかりません。", 404);
		if (existing.phase === "merged") return existing;
		if (!existing.prNumber) {
			throw new HarnessError("GitHub 上の PR が作成されていないため、リモートマージを実行できません。", 409);
		}

		this.stopPolling(sessionId, surfaceId);
		existing.phase = "merging";
		existing.statusNote = `${existing.baseBranch} にマージしています…`;
		existing.error = undefined;
		this.surfaces.upsertPrSurface(sessionId, existing, false);

		const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
		let mergeRes = await runGh(cwd, ["pr", "merge", String(existing.prNumber), flag, "--delete-branch"], 25_000);
		if (!mergeRes.ok && /worktree|cannot delete branch|not checked out/i.test(mergeRes.stderr)) {
			mergeRes = await runGh(cwd, ["pr", "merge", String(existing.prNumber), flag], 25_000);
		}

		if (!mergeRes.ok) {
			existing.phase = "ready";
			existing.statusNote = undefined;
			existing.error = mergeRes.stderr.trim() || "PR のマージに失敗しました。";
			return this.surfaces.upsertPrSurface(sessionId, existing, true);
		}

		existing.phase = "merged";
		existing.mergedAt = new Date().toISOString();
		existing.statusNote = undefined;
		existing.error = undefined;
		existing.commits = existing.commits.filter((node) => !node.isProjectedMerge);
		return this.surfaces.upsertPrSurface(sessionId, existing, true);
	}

	async onAgentSettled(sessionId: string, cwd: string): Promise<void> {
		const pr = this.surfaces.getPrSurface(sessionId);
		if (!pr) return;
		if (pr.phase !== "resolving" && pr.phase !== "fixing") return;
		try {
			await this.refresh(sessionId, pr.surfaceId, cwd);
		} catch {
			// Best-effort refresh after agent turn completes.
		}
	}

	private ensurePolling(sessionId: string, surfaceId: string, cwd: string): void {
		const key = `${sessionId}:${surfaceId}`;
		if (this.pollers.has(key)) return;
		const timer = setInterval(() => {
			const current = this.surfaces.getPrSurface(sessionId, surfaceId);
			if (!current || current.phase !== "checks_running") {
				this.stopPolling(sessionId, surfaceId);
				return;
			}
			void this.refresh(sessionId, surfaceId, cwd).catch(() => undefined);
		}, CI_POLL_INTERVAL_MS);
		timer.unref?.();
		this.pollers.set(key, timer);
	}

	private stopPolling(sessionId: string, surfaceId: string): void {
		const key = `${sessionId}:${surfaceId}`;
		const timer = this.pollers.get(key);
		if (!timer) return;
		clearInterval(timer);
		this.pollers.delete(key);
	}

	closeSession(sessionId: string): void {
		for (const [key, timer] of this.pollers) {
			if (key.startsWith(`${sessionId}:`)) {
				clearInterval(timer);
				this.pollers.delete(key);
			}
		}
	}

	close(): void {
		for (const timer of this.pollers.values()) clearInterval(timer);
		this.pollers.clear();
	}
}
