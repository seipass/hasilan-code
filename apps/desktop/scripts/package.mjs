import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build, createTargets, Platform } from "electron-builder";
import { packHasilan } from "../../../scripts/hasilan-release.mjs";
import { execNpmSync } from "../../../scripts/npm-command.mjs";
import { appDirectory, provision, runtimeDirectory } from "./provision.mjs";

const root = resolve(appDirectory, "../..");
const web = JSON.parse(await readFile(join(root, "packages/web-harness/package.json"), "utf8"));
const shell = JSON.parse(await readFile(join(appDirectory, "package.json"), "utf8"));
const output = resolve(root, ".artifacts/desktop");
const temporary = await mkdtemp(join(tmpdir(), "hasilan-desktop-package-"));
const stage = await realpath(temporary);
const owned = relative(await realpath(tmpdir()), stage);
if (!owned || owned === ".." || owned.startsWith(`..${sep}`)) throw new Error("Unsafe desktop staging path");
const directoryOnly = process.argv.includes("--dir");
try {
	await provision();
	await readFile(join(appDirectory, "dist/main.cjs"));
	await readFile(join(root, "packages/web-harness/dist/server/desktop-host.js"));
	const supplied = process.argv.indexOf("--web-package");
	let archive;
	if (supplied !== -1) {
		if (!process.argv[supplied + 1]) throw new Error("--web-package requires a tarball path");
		archive = resolve(root, process.argv[supplied + 1]);
	} else {
		archive = await packHasilan({ root, out: join(output, "web"), skipBuild: true });
	}
	const harness = join(stage, "harness");
	await mkdir(harness);
	// npm unpacks the reviewed bundled Web artifact without invoking any lifecycle scripts.
	execNpmSync(
		[
			"install",
			"--prefix",
			harness,
			"--ignore-scripts",
			"--omit=dev",
			"--no-audit",
			"--no-fund",
			pathToFileURL(archive).href,
		],
		{ cwd: root, stdio: "inherit" },
	);
	const runtime = join(harness, "node_modules/hasilan-code");
	const bundled = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
	if (bundled.version !== web.version || bundled.name !== "hasilan-code")
		throw new Error("Desktop/Web version mismatch");
	await readFile(join(runtime, "dist/server/desktop-host.js"));
	if (process.argv.includes("--build-pty")) {
		// Explicit opt-in, using the existing reviewed setup command and only node-pty's lifecycle.
		execFileSync(
			process.execPath,
			[join(runtime, "bin/hasilan-code.mjs"), "setup", "--build-pty", "--skip-browser"],
			{ cwd: runtime, stdio: "inherit" },
		);
	} else if (process.platform === "linux") {
		throw new Error("Linux packaging requires --build-pty to explicitly compile the terminal addon before shipping");
	}
	const nativeCheck = join(stage, "native-check.mjs");
	await writeFile(
		nativeCheck,
		`import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url'; const require=createRequire(pathToFileURL(process.argv[2])); require('node-pty'); require('typescript');`,
	);
	execFileSync(await provision(), [nativeCheck, join(runtime, "package.json")], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		windowsHide: true,
		stdio: "inherit",
	});
	const platform = Platform.current();
	const targets = createTargets([platform], directoryOnly ? "dir" : undefined, process.arch);
	await build({
		projectDir: root,
		targets,
		publish: "never",
		config: {
			appId: "dev.hasilan.code",
			productName: "Hasilan Code",
			directories: { app: appDirectory, output },
			extraMetadata: { version: web.version },
			electronVersion: shell.devDependencies.electron,
			electronDist: runtimeDirectory,
			files: ["dist/**/*", "package.json"],
			// The copier always excludes a source-root node_modules directory. Start inside it.
			extraResources: [{ from: join(harness, "node_modules"), to: "harness/node_modules", filter: ["**/*"] }],
			afterPack: async (context) => {
				const resources = context.packager.getResourcesDir(context.appOutDir);
				for (const file of [
					"harness/node_modules/hasilan-code/dist/server/desktop-host.js",
					"harness/node_modules/hasilan-code/dist/client/index.html",
					"harness/node_modules/typescript/package.json",
				]) {
					await readFile(join(resources, file));
				}
			},
			asar: true,
			npmRebuild: false,
			nodeGypRebuild: false,
			allowMissingDependencies: false,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands its own placeholders.
			artifactName: "Hasilan-Code-${version}-${os}-${arch}.${ext}",
			publish: [{ provider: "generic", url: "https://github.com/seipass/hasilan-code/releases/latest/download/" }],
			win: { target: "nsis", icon: join(appDirectory, "dist/icon.png") },
			nsis: {
				oneClick: false,
				perMachine: false,
				allowToChangeInstallationDirectory: true,
				deleteAppDataOnUninstall: false,
			},
			mac: {
				target: ["dmg", "zip"],
				icon: join(appDirectory, "dist/icon.png"),
				category: "public.app-category.developer-tools",
			},
			linux: { target: "AppImage", icon: join(appDirectory, "dist/icon.png"), category: "Development" },
		},
	});
} finally {
	// The temporary path is explicitly created above. Never remove a caller-supplied output or tarball.
	await rm(stage, { recursive: true, force: true });
}
