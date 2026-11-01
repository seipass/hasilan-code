import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadArtifact } from "@electron/get";
import { extract } from "@electron-internal/extract-zip";

const require = createRequire(import.meta.url);
// A trailing backslash in the Windows command-line argument breaks Electron/Playwright startup.
export const appDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const runtimeDirectory = join(appDirectory, ".runtime/electron");
export const executable = join(
	runtimeDirectory,
	process.platform === "win32"
		? "electron.exe"
		: process.platform === "darwin"
			? "Electron.app/Contents/MacOS/Electron"
			: "electron",
);

/** Explicit provisioning replaces install lifecycle scripts. Verify against the pinned npm checksums. */
export async function provision() {
	const packageDirectory = dirname(require.resolve("electron/package.json"));
	const { version } = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
	try {
		if ((await readFile(join(runtimeDirectory, "version"), "utf8")).trim().replace(/^v/, "") === version) {
			await access(executable);
			return executable;
		}
	} catch {
		/* Download the locked runtime, never a floating version. */
	}
	const checksums = JSON.parse(await readFile(join(packageDirectory, "checksums.json"), "utf8"));
	const archive = await downloadArtifact({
		version,
		artifactName: "electron",
		platform: process.platform,
		arch: process.arch,
		checksums,
	});
	await mkdir(runtimeDirectory, { recursive: true });
	await extract(archive, { dir: runtimeDirectory });
	await writeFile(join(runtimeDirectory, "version"), version);
	return executable;
}
