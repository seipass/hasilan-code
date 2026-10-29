import assert from "node:assert/strict";
import { test } from "node:test";
import { localPiPackages, mergeHasilanCatalog, releaseVersion } from "./hasilan-release.mjs";

test("Hasilan's catalog supplements the pinned Pi catalog without losing upstream models", () => {
	const upstreamModel = { type: "chat", id: "upstream", provider: "example", api: "openai-completions" };
	const jev = { type: "classifier", id: "typesafe/jev", provider: "commandcode", api: "typesafe-system-one" };
	const catalog = { example: [upstreamModel] };
	const overlay = { commandcode: [jev] };
	assert.deepEqual(mergeHasilanCatalog(catalog, overlay), { example: [upstreamModel], commandcode: [jev] });
	assert.deepEqual(catalog, { example: [upstreamModel] });
	assert.throws(() => mergeHasilanCatalog(catalog, { commandcode: [] }), /commandcode/);
	assert.throws(() => mergeHasilanCatalog(catalog, { commandcode: [{ ...jev, provider: "other" }] }), /commandcode/);
});

test("Hasilan's catalog overrides duplicate model IDs without discarding other upstream models", () => {
	const one = { type: "chat", id: "one", provider: "commandcode", api: "openai-completions", name: "old" };
	const two = { type: "chat", id: "two", provider: "commandcode", api: "openai-completions" };
	const updated = { ...one, name: "new" };
	assert.deepEqual(mergeHasilanCatalog({ commandcode: [one, two] }, { commandcode: [updated] }), {
		commandcode: [updated, two],
	});
});

test("application tags cannot publish an upstream Pi version or a different app version", () => {
	const manifest = { name: "hasilan-code", version: "1.1.0", hasilanCode: { piVersion: "1.3.0" } };
	assert.equal(releaseVersion(manifest, "hasilan-v1.1.0"), "1.1.0");
	assert.throws(() => releaseVersion(manifest, "v1.3.0"), /does not match/);
	assert.throws(() => releaseVersion(manifest, "hasilan-v1.3.0"), /does not match/);
	assert.throws(() => releaseVersion({ ...manifest, name: "@hasilan-code/pi-coding-agent" }), /Invalid/);
	assert.throws(() => releaseVersion({ ...manifest, version: "latest" }), /Invalid/);
});

test("transitive and optional Pi packages stay local even when dependency paths overlap", () => {
	const ai = {
		name: "@hasilan-code/pi-ai",
		version: "1.3.0",
		dependencies: { "@hasilan-code/pi-telemetry": "1.3.0", openai: "7.19.0" },
	};
	const agent = {
		name: "@hasilan-code/pi-agent-core",
		version: "1.3.0",
		dependencies: { "@hasilan-code/pi-ai": "1.3.0" },
		optionalDependencies: { "@hasilan-code/pi-telemetry": "1.3.0" },
	};
	const telemetry = { name: "@hasilan-code/pi-telemetry", version: "1.3.0" };
	const packages = new Map([ai, agent, telemetry].map((pkg) => [pkg.name, pkg]));
	assert.deepEqual(
		new Set(
			localPiPackages(packages, { [agent.name]: "1.3.0", [ai.name]: "1.3.0", react: "19.3.0" }).map(
				(pkg) => pkg.name,
			),
		),
		new Set([agent.name, ai.name, telemetry.name]),
	);
});

test("missing or mismatched local Pi code blocks packaging instead of using registry code", () => {
	const ai = {
		name: "@hasilan-code/pi-ai",
		version: "1.3.0",
		dependencies: { "@hasilan-code/pi-telemetry": "1.3.0" },
	};
	assert.throws(() => localPiPackages(new Map([[ai.name, ai]]), { [ai.name]: "1.3.0" }), /Missing local Pi package/);
	assert.throws(() => localPiPackages(new Map([[ai.name, ai]]), { [ai.name]: "1.1.0" }), /exact local version/);
	assert.throws(() => localPiPackages(new Map([[ai.name, ai]]), { [ai.name]: "^1.3.0" }), /exact local version/);
});
