import assert from "node:assert/strict";
import { test } from "node:test";
import { localPiPackages, releaseVersion } from "./hasilan-release.mjs";

test("application tags cannot publish an upstream Pi version or a different app version", () => {
	const manifest = { name: "hasilan-code", version: "1.1.0", hasilanCode: { piVersion: "1.3.0" } };
	assert.equal(releaseVersion(manifest, "hasilan-v1.1.0"), "1.1.0");
	assert.throws(() => releaseVersion(manifest, "v1.3.0"), /does not match/);
	assert.throws(() => releaseVersion(manifest, "hasilan-v1.3.0"), /does not match/);
	assert.throws(() => releaseVersion({ ...manifest, name: "@earendil-works/pi-coding-agent" }), /Invalid/);
	assert.throws(() => releaseVersion({ ...manifest, version: "latest" }), /Invalid/);
});

test("transitive and optional Pi packages stay local even when dependency paths overlap", () => {
	const ai = {
		name: "@earendil-works/pi-ai",
		version: "1.3.0",
		dependencies: { "@earendil-works/pi-telemetry": "1.3.0", openai: "7.19.0" },
	};
	const agent = {
		name: "@earendil-works/pi-agent-core",
		version: "1.3.0",
		dependencies: { "@earendil-works/pi-ai": "1.3.0" },
		optionalDependencies: { "@earendil-works/pi-telemetry": "1.3.0" },
	};
	const telemetry = { name: "@earendil-works/pi-telemetry", version: "1.3.0" };
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
		name: "@earendil-works/pi-ai",
		version: "1.3.0",
		dependencies: { "@earendil-works/pi-telemetry": "1.3.0" },
	};
	assert.throws(() => localPiPackages(new Map([[ai.name, ai]]), { [ai.name]: "1.3.0" }), /Missing local Pi package/);
	assert.throws(() => localPiPackages(new Map([[ai.name, ai]]), { [ai.name]: "1.1.0" }), /exact local version/);
	assert.throws(() => localPiPackages(new Map([[ai.name, ai]]), { [ai.name]: "^1.3.0" }), /exact local version/);
});
