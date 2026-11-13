import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HttpError } from "./http-host.ts";

const exec = promisify(execFile);

export async function gitReview(cwd: string, mode: string | null, base: string | null) {
	if (mode !== "worktree" && mode !== "staged" && mode !== "branch")
		throw new HttpError(400, "差分の種類を選択してください。");
	const git = async (args: string[], allowDifference = false) => {
		try {
			return (
				await exec("git", ["-c", "core.quotePath=false", ...args], {
					cwd,
					encoding: "utf8",
					timeout: 5000,
					maxBuffer: 1024 * 1024,
					windowsHide: true,
				})
			).stdout;
		} catch (error) {
			if (
				allowDifference &&
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === 1 &&
				"stdout" in error &&
				typeof error.stdout === "string"
			)
				return error.stdout;
			throw new HttpError(
				400,
				"Git の差分を取得できませんでした。比較先、リポジトリの状態、差分サイズ（上限 1 MB）を確認してください。",
			);
		}
	};
	await git(["rev-parse", "--show-toplevel"]);
	const options = ["--no-ext-diff", "--no-textconv", "--no-color", "--relative", "--src-prefix=a/", "--dst-prefix=b/"];
	if (mode === "staged") return { patches: [await git(["diff", ...options, "--cached", "--", "."])] };
	if (mode === "branch") {
		const ref = base?.trim() || "@{upstream}";
		if (ref.length > 256) throw new HttpError(400, "比較先が長すぎます。");
		const commit = (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
		return { patches: [await git(["diff", ...options, `${commit}...HEAD`, "--", "."])] };
	}
	const tracked = await git(["diff", ...options, "--", "."]);
	const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]))
		.split("\0")
		.filter(Boolean);
	if (untracked.length > 40)
		throw new HttpError(400, "未追跡ファイルが40件を超えています。ステージ差分で確認してください。");
	let bytes = Buffer.byteLength(tracked);
	const patches = [tracked];
	for (const path of untracked) {
		const patch = await git(["diff", "--no-index", ...options, "--", "/dev/null", path], true);
		bytes += Buffer.byteLength(patch);
		if (bytes > 1024 * 1024) throw new HttpError(400, "差分が大きすぎます（上限 1 MB）。");
		patches.push(patch);
	}
	return { patches };
}
