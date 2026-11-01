import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Regression for seipass/hasilan-code#1 (GHSA-xjj6-f33q-929c).
it("uses the patched HTTP implementation after the shared web and desktop startup", () => {
	const resolver = new URL("../../coding-agent/src/experimental/source-resolver.ts", import.meta.url).href;
	const fixture = fileURLToPath(new URL("./fixtures/http-dispatcher-startup.mjs", import.meta.url));
	const output = execFileSync(process.execPath, ["--import", resolver, fixture], {
		encoding: "utf8",
		timeout: 30_000,
	});
	expect(output.trim()).toBe("survived excessive content encodings");
});
