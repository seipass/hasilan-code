import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	createReadStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execNpmSync } from "./npm-command.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";

async function fileDigest(path, algorithm, encoding) {
	const hash = createHash(algorithm);
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest(encoding);
}

export function releaseVersion(manifest, tag) {
	if (manifest.name !== "hasilan-code" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))
		throw new Error("Invalid Hasilan Code release manifest");
	if (tag && tag !== `hasilan-v${manifest.version}`)
		throw new Error(`Tag ${tag} does not match Hasilan Code ${manifest.version}`);
	return manifest.version;
}

/** Every Pi dependency must come from this checkout, including transitive dependencies. */
export function localPiPackages(workspaces, dependencies) {
	const selected = new Map();
	function visit(name, version) {
		if (!name.startsWith("@hasilan-code/")) return;
		const pkg = workspaces.get(name);
		if (!pkg) throw new Error(`Missing local Pi package: ${name}`);
		if (version !== pkg.version)
			throw new Error(`${name} must use exact local version ${pkg.version}, found ${version}`);
		if (selected.has(name)) return;
		selected.set(name, pkg);
		for (const [dependency, specifier] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies }))
			visit(dependency, specifier);
	}
	for (const [name, version] of Object.entries(dependencies)) visit(name, version);
	return [...selected.values()];
}

export async function buildHasilan(root) {
	const pin = JSON.parse(readFileSync(join(root, "nix/model-catalog.json"), "utf8"));
	const response = await fetch(`https://pi.dev/api/models/revisions/${pin.revision}?types=chat,image,classifier`);
	if (!response.ok) throw new Error(`Pinned model catalog download failed: ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (`sha256-${createHash("sha256").update(bytes).digest("hex")}` !== pin.revision)
		throw new Error("Pinned model catalog checksum mismatch");
	const temporary = mkdtempSync(join(tmpdir(), "hasilan-catalog-"));
	try {
		const catalog = join(temporary, "catalog.json");
		writeFileSync(catalog, bytes);
		execFileSync(process.execPath, ["packages/ai/scripts/hydrate-model-catalog.ts", catalog], {
			cwd: root,
			stdio: "inherit",
		});
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
	for (const name of [
		"pi-tui",
		"pi-telemetry",
		"pi-codemode",
		"pi-mcp",
		"pi-ai",
		"pi-agent-core",
		"pi-coding-agent",
	]) {
		execNpmSync(["run", name === "pi-ai" ? "build:offline" : "build", `--workspace=@hasilan-code/${name}`], {
			cwd: root,
			stdio: "inherit",
		});
	}
	execNpmSync(["run", "build", "--workspace=hasilan-code"], { cwd: root, stdio: "inherit" });
}

export async function packHasilan({ root, out, tag, skipBuild = false }) {
	const sourceDirectory = join(root, "packages/web-harness");
	const sourceManifest = JSON.parse(readFileSync(join(sourceDirectory, "package.json"), "utf8"));
	const version = releaseVersion(sourceManifest, tag);
	if (!skipBuild) await buildHasilan(root);
	if (!existsSync(join(sourceDirectory, "dist/client/index.html")))
		throw new Error("Build Hasilan Code before packaging");
	mkdirSync(out, { recursive: true });
	const stage = mkdtempSync(join(tmpdir(), "hasilan-package-"));
	try {
		const tarballs = join(stage, "tarballs");
		const application = join(stage, "application");
		mkdirSync(tarballs);
		mkdirSync(application);
		const workspaces = new Map(
			findPackageDirectories(join(root, "packages")).map((directory) => {
				const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
				return [manifest.name, { ...manifest, directory }];
			}),
		);
		const packages = localPiPackages(workspaces, sourceManifest.dependencies);
		const specifiers = {};
		for (const pkg of packages) {
			const packed = JSON.parse(
				execNpmSync(["pack", "--ignore-scripts", "--json", "--pack-destination", tarballs], {
					cwd: pkg.directory,
					encoding: "utf8",
				}),
			)[0];
			specifiers[pkg.name] = pathToFileURL(join(tarballs, packed.filename)).href;
		}
		for (const name of ["dist", "bin", "README.md"])
			cpSync(join(sourceDirectory, name), join(application, name), { recursive: true });
		cpSync(join(root, "LICENSE"), join(application, "LICENSE"));
		// TypeScript selects an exact-version platform executable at installation time.
		const manifest = {
			...sourceManifest,
			scripts: { start: "node bin/hasilan-code.mjs" },
			bundledDependencies: Object.keys(sourceManifest.dependencies).filter((name) => name !== "typescript"),
		};
		delete manifest.private;
		delete manifest.devDependencies;
		const installManifest = { ...manifest, dependencies: { ...manifest.dependencies }, overrides: specifiers };
		for (const name of Object.keys(specifiers))
			if (Object.hasOwn(installManifest.dependencies, name)) installManifest.dependencies[name] = specifiers[name];
		writeFileSync(join(application, "package.json"), `${JSON.stringify(installManifest, null, "\t")}\n`);
		const rootLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
		const seed = {
			name: manifest.name,
			version,
			lockfileVersion: 3,
			requires: true,
			packages: {
				"": { name: manifest.name, version, dependencies: installManifest.dependencies, engines: manifest.engines },
			},
		};
		for (const [path, entry] of Object.entries(rootLock.packages)) {
			if (entry.link || !path.includes("node_modules/")) continue;
			let destination = path.startsWith("node_modules/") ? path : undefined;
			const webPrefix = "packages/web-harness/";
			if (path.startsWith(`${webPrefix}node_modules/`)) destination = path.slice(webPrefix.length);
			for (const pkg of packages) {
				const prefix = `${relative(root, pkg.directory).replaceAll("\\", "/")}/`;
				if (path.startsWith(`${prefix}node_modules/`))
					destination = `node_modules/${pkg.name}/${path.slice(prefix.length)}`;
			}
			if (destination) seed.packages[destination] = { ...entry };
		}
		for (const pkg of packages) {
			const entry = {
				version: pkg.version,
				resolved: specifiers[pkg.name],
				integrity: `sha512-${await fileDigest(fileURLToPath(specifiers[pkg.name]), "sha512", "base64")}`,
			};
			for (const key of [
				"dependencies",
				"optionalDependencies",
				"peerDependencies",
				"peerDependenciesMeta",
				"engines",
				"bin",
				"license",
			])
				if (pkg[key]) entry[key] = pkg[key];
			seed.packages[`node_modules/${pkg.name}`] = entry;
		}
		writeFileSync(join(application, "package-lock.json"), `${JSON.stringify(seed, null, "\t")}\n`);
		execNpmSync(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
			cwd: application,
			stdio: "inherit",
			timeout: 300_000,
		});
		const allowed = new Set(
			Object.entries(rootLock.packages)
				.filter(([path, entry]) => path.includes("node_modules/") && !entry.link)
				.map(
					([path, entry]) =>
						`${path.slice(path.lastIndexOf("node_modules/") + 13)}@${entry.version}:${entry.integrity}`,
				),
		);
		const installedLock = JSON.parse(readFileSync(join(application, "package-lock.json"), "utf8"));
		for (const [path, entry] of Object.entries(installedLock.packages)) {
			if (!path.includes("node_modules/")) continue;
			const name = path.slice(path.lastIndexOf("node_modules/") + 13);
			if (Object.hasOwn(specifiers, name)) continue;
			if (!allowed.has(`${name}@${entry.version}:${entry.integrity}`))
				throw new Error(
					`Unreviewed dependency resolution: ${name}@${entry.version}; update and review the root lockfile first`,
				);
		}
		writeFileSync(join(application, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		const filename = execNpmSync(["pack", "--ignore-scripts", "--silent", "--pack-destination", out], {
			cwd: application,
			encoding: "utf8",
		}).trim();
		if (filename !== `hasilan-code-${version}.tgz`) throw new Error(`Unexpected package filename: ${filename}`);
		cpSync(join(root, "scripts/install-hasilan.mjs"), join(out, "install-hasilan.mjs"));
		writeFileSync(
			join(out, "release.json"),
			`${JSON.stringify({ name: manifest.name, version, piVersion: manifest.hasilanCode.piVersion, piCommit: manifest.hasilanCode.piCommit, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), tarball: filename }, null, "\t")}\n`,
		);
		const checksums = [];
		for (const name of [filename, "install-hasilan.mjs", "release.json"])
			checksums.push(`${await fileDigest(join(out, name), "sha256", "hex")}  ${name}\n`);
		writeFileSync(join(out, "SHA256SUMS"), checksums.join(""));
		console.log(`Hasilan Code ${version}: ${join(out, filename)} (${statSync(join(out, filename)).size} bytes)`);
		return join(out, filename);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	let tag;
	let skipBuild = false;
	let buildOnly = false;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--tag" && args[index + 1]) tag = args[++index];
		else if (args[index] === "--skip-build") skipBuild = true;
		else if (args[index] === "--build-only") buildOnly = true;
		else throw new Error(`Unknown release argument: ${args[index]}`);
	}
	const root = fileURLToPath(new URL("../", import.meta.url));
	if (buildOnly) await buildHasilan(root);
	else await packHasilan({ root, out: join(root, ".artifacts/hasilan-code"), tag, skipBuild });
}
