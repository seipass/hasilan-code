import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = join(root, "node_modules/vitest/dist/cli.js");
const web = join(root, "packages/web-harness");
const files = readdirSync(join(web, "test"))
	.filter((name) => name.endsWith(".test.ts") && !name.endsWith("-e2e.test.ts"))
	.map((name) => `test/${name}`);
execFileSync(process.execPath, ["--test", "scripts/hasilan-release.test.mjs", "scripts/check-runtime-deps.test.mjs"], {
	cwd: root,
	stdio: "inherit",
});
execFileSync(process.execPath, [vitest, "--run", "--maxWorkers=2", ...files], {
	cwd: web,
	stdio: "inherit",
	env: { ...process.env, PI_OFFLINE: "1", PI_NO_LOCAL_LLM: "1" },
});
execFileSync(
	process.execPath,
	[
		vitest,
		"--run",
		"--maxWorkers=2",
		"test/suite/agent-session-context-injection.test.ts",
		"test/suite/agent-session-queue.test.ts",
	],
	{
		cwd: join(root, "packages/coding-agent"),
		stdio: "inherit",
		env: { ...process.env, PI_OFFLINE: "1", PI_NO_LOCAL_LLM: "1" },
	},
);
