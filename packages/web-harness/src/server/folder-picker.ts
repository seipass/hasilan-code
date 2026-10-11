import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { windowsFolderDialog } from "./windows-folder-dialog.ts";

const execute = promisify(execFile);

/** Runs the host OS chooser; browser directory uploads cannot reveal a usable local path. */
export async function pickWorkspaceFolder(cwd: string, signal: AbortSignal): Promise<string | undefined> {
	let command: string;
	let args: string[];
	if (process.platform === "win32") {
		command = join(
			process.env.SystemRoot ?? "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		);
		args = [
			"-NoLogo",
			"-NoProfile",
			"-STA",
			"-EncodedCommand",
			Buffer.from(windowsFolderDialog, "utf16le").toString("base64"),
		];
	} else if (process.platform === "darwin") {
		command = "/usr/bin/osascript";
		args = ["-e", 'POSIX path of (choose folder with prompt "Hasilan Code - ワークスペースを選択")'];
	} else {
		command = "zenity";
		args = ["--file-selection", "--directory", "--title=Hasilan Code - ワークスペースを選択", `--filename=${cwd}/`];
	}
	try {
		const { stdout } = await execute(command, args, {
			encoding: "utf8",
			windowsHide: true,
			signal,
			maxBuffer: 64 * 1024,
			env: { ...process.env, HASILAN_PICKER_CWD: cwd },
		});
		return stdout.trim() || undefined;
	} catch (error) {
		if (signal.aborted) throw new Error("Folder picker cancelled because the host is shutting down");
		if (
			error instanceof Error &&
			"code" in error &&
			error.code === 1 &&
			"stderr" in error &&
			typeof error.stderr === "string" &&
			(!error.stderr.trim() || (process.platform === "darwin" && error.stderr.includes("(-128)")))
		)
			return undefined;
		if (
			process.platform !== "win32" &&
			process.platform !== "darwin" &&
			error instanceof Error &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			try {
				const { stdout } = await execute(
					"kdialog",
					["--getexistingdirectory", cwd, "--title", "Hasilan Code - ワークスペースを選択"],
					{ encoding: "utf8", signal, maxBuffer: 64 * 1024 },
				);
				return stdout.trim() || undefined;
			} catch (fallbackError) {
				if (
					fallbackError instanceof Error &&
					"code" in fallbackError &&
					fallbackError.code === 1 &&
					"stderr" in fallbackError &&
					typeof fallbackError.stderr === "string" &&
					!fallbackError.stderr.trim()
				)
					return undefined;
				throw new Error(
					"ネイティブフォルダー選択を開けません。Linuxではzenityまたはkdialogとデスクトップ環境が必要です。",
					{ cause: fallbackError },
				);
			}
		}
		throw new Error("ネイティブフォルダー選択を開けません。ホストのデスクトップ環境を確認してください。", {
			cause: error,
		});
	}
}
