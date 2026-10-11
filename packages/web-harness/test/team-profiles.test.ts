import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTeamProfiles } from "../src/server/team-profiles.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; project: string; global: string }> {
	const root = await mkdtemp(join(tmpdir(), "hasilan-profiles-"));
	directories.push(root);
	const project = join(root, "workspace");
	const global = join(root, "agent");
	await mkdir(join(project, ".hasilan-code", "agents"), { recursive: true });
	await mkdir(join(global, "agents"), { recursive: true });
	return { root, project, global };
}

function definition(name: string, systemPrompt: string) {
	return { name, description: `${name} specialist`, systemPrompt };
}

describe("team profile loading", () => {
	it("sorts by exact name, prefers the project, deduplicates tools, and preserves instructions as text", async () => {
		const { project, global } = await fixture();
		const projectAgents = join(project, ".hasilan-code", "agents");
		const globalAgents = join(global, "agents");
		await writeFile(join(globalAgents, "zeta.json"), JSON.stringify(definition("zeta", "Global zeta")));
		await writeFile(join(globalAgents, "alpha.json"), JSON.stringify(definition("alpha", "Global alpha")));
		await writeFile(join(globalAgents, "middle.json"), JSON.stringify(definition("middle", "Global middle")));
		const prompt = "process.exit(42); // literal instructions, not JavaScript";
		await writeFile(
			join(projectAgents, "alpha.json"),
			JSON.stringify({
				...definition("alpha", prompt),
				model: { provider: "openai", id: "test-model" },
				tools: ["read", "send", "read"],
			}),
		);
		await writeFile(join(projectAgents, "Beta.json"), JSON.stringify(definition("Beta", "Project beta")));
		await writeFile(join(projectAgents, "ignored.txt"), "not JSON");

		const profiles = await loadTeamProfiles(project, global);
		expect(profiles.map(({ name }) => name)).toEqual(["Beta", "alpha", "middle", "zeta"]);
		expect(profiles[1]).toEqual({
			...definition("alpha", prompt),
			model: { provider: "openai", id: "test-model" },
			tools: ["read", "send"],
		});
	});

	it("accepts missing profile directories", async () => {
		const { root } = await fixture();
		expect(await loadTeamProfiles(join(root, "other-workspace"), join(root, "other-agent"))).toEqual([]);
	});

	it("rejects malformed JSON and schema errors with the offending path, including shadowed global profiles", async () => {
		const { project, global } = await fixture();
		const projectFile = join(project, ".hasilan-code", "agents", "builder.json");
		await writeFile(projectFile, "{ broken JSON");
		await expect(loadTeamProfiles(project, global)).rejects.toThrow(projectFile);

		await writeFile(projectFile, JSON.stringify(definition("builder", "Valid instructions")));
		const globalFile = join(global, "agents", "builder.json");
		await writeFile(
			globalFile,
			JSON.stringify({ ...definition("builder", "Global"), model: { provider: "x", id: "y", extra: true } }),
		);
		await expect(loadTeamProfiles(project, global)).rejects.toThrow(globalFile);

		await writeFile(globalFile, JSON.stringify({ ...definition("wrong-name", "Global") }));
		await expect(loadTeamProfiles(project, global)).rejects.toThrow(globalFile);

		await writeFile(globalFile, JSON.stringify({ ...definition("builder", "Global"), tools: ["read", 1] }));
		await expect(loadTeamProfiles(project, global)).rejects.toThrow(globalFile);
	});

	it("rejects symlinked profile files and configuration directories", async () => {
		const { root, project, global } = await fixture();
		const outside = join(root, "outside.json");
		await writeFile(outside, JSON.stringify(definition("outside", "Outside")));
		const link = join(project, ".hasilan-code", "agents", "outside.json");
		let fileLinkSupported = true;
		try {
			await symlink(outside, link, "file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			fileLinkSupported = false;
		}
		if (fileLinkSupported) {
			await expect(loadTeamProfiles(project, global)).rejects.toThrow(link);
			await rm(link);
		}

		const linkedDirectory = join(global, "agents");
		await rm(linkedDirectory, { recursive: true });
		await symlink(
			join(project, ".hasilan-code", "agents"),
			linkedDirectory,
			process.platform === "win32" ? "junction" : "dir",
		);
		await expect(loadTeamProfiles(project, global)).rejects.toThrow(linkedDirectory);
	});

	it("enforces a bounded profile size and total file count", async () => {
		const { project, global } = await fixture();
		const directory = join(project, ".hasilan-code", "agents");
		const oversized = join(directory, "oversized.json");
		await writeFile(oversized, JSON.stringify(definition("oversized", "x".repeat(65 * 1024))));
		await expect(loadTeamProfiles(project, global)).rejects.toThrow(oversized);
		await rm(oversized);
		for (let index = 0; index <= 128; index++) {
			const name = `agent-${index}`;
			await writeFile(join(directory, `${name}.json`), JSON.stringify(definition(name, "Instructions")));
		}
		await expect(loadTeamProfiles(project, global)).rejects.toThrow("more than 128 profile files");
	});
});
