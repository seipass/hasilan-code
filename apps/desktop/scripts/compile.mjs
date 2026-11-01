import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import sharp from "sharp";
import { build as buildWeb } from "vite";
import { appDirectory, provision } from "./provision.mjs";

const require = createRequire(import.meta.url);
const root = resolve(appDirectory, "../..");
const web = resolve(root, "packages/web-harness");
// SDK compilation remains the existing build:hasilan task. Do not rewrite the model catalog here.
await readFile(resolve(root, "packages/coding-agent/dist/index.js"));
execFileSync(
	process.execPath,
	[resolve(dirname(require.resolve("typescript/package.json")), "bin/tsc"), "-p", resolve(web, "tsconfig.build.json")],
	{ cwd: root, stdio: "inherit" },
);
await buildWeb({ configFile: resolve(web, "vite.config.ts") });
await mkdir(resolve(appDirectory, "dist"), { recursive: true });
await build({
	entryPoints: [resolve(appDirectory, "src/main.ts")],
	outfile: resolve(appDirectory, "dist/main.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	sourcemap: true,
	external: ["electron", "electron-updater"],
});
await build({
	entryPoints: [resolve(appDirectory, "src/preload.ts")],
	outfile: resolve(appDirectory, "dist/preload.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	sourcemap: true,
	loader: { ".css": "text", ".svg": "text" },
	external: ["electron"],
});
await build({
	entryPoints: [resolve(appDirectory, "src/browser-preload.ts")],
	outfile: resolve(appDirectory, "dist/browser-preload.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	sourcemap: true,
	external: ["electron"],
});
const html = await readFile(resolve(appDirectory, "assets/startup.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const hash = createHash("sha256").update(script).digest("base64");
await writeFile(resolve(appDirectory, "dist/startup.html"), html.replace("sha256-REPLACE", `sha256-${hash}`));
await copyFile(
	resolve(appDirectory, "assets/THIRD_PARTY_NOTICES.txt"),
	resolve(appDirectory, "dist/THIRD_PARTY_NOTICES.txt"),
);
await copyFile(
	resolve(appDirectory, "assets/codicons/LICENSE.txt"),
	resolve(appDirectory, "dist/CODICONS-LICENSE.txt"),
);
await sharp(resolve(web, "public/icon.svg")).resize(512, 512).png().toFile(resolve(appDirectory, "dist/icon.png"));
await provision();
console.log("Desktop shell, shared server and Web UI compiled.");
