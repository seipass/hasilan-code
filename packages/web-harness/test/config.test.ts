import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarnessSettings, getHarnessAgentDir } from "../src/server/config.ts";

const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("independent Hasilan configuration", () => {
	it("ignores Pi's directory override and uses only its own override", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "pi-private"));
		vi.stubEnv("HASILAN_CODE_AGENT_DIR", "");
		expect(getHarnessAgentDir()).toBe(join(homedir(), ".hasilan-code", "agent"));
		vi.stubEnv("HASILAN_CODE_AGENT_DIR", join(tmpdir(), "hasilan-private"));
		expect(getHarnessAgentDir()).toBe(join(tmpdir(), "hasilan-private"));
	});

	it("ignores Pi project settings and persists global and project changes independently", async () => {
		const root = await mkdtemp(join(tmpdir(), "hasilan-config-"));
		directories.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		const piFile = join(cwd, ".pi", "settings.json");
		const piContents = JSON.stringify({
			defaultProvider: "pi-provider",
			defaultModel: "pi-model",
			skills: ["pi-skill"],
		});
		await writeFile(piFile, piContents);
		const settings = createHarnessSettings(cwd, agentDir);
		expect(settings.getDefaultModel()).toBeUndefined();
		expect(settings.getSkillPaths()).not.toContain("pi-skill");
		settings.setDefaultModelAndProvider("hasilan-provider", "hasilan-model");
		settings.setProjectSkillPaths(["hasilan-skill"]);
		const deviceId = settings.getOrCreateDeviceId();
		await settings.flush();
		expect(settings.drainErrors()).toEqual([]);
		const restored = createHarnessSettings(cwd, agentDir);
		expect(restored.getDefaultProvider()).toBe("hasilan-provider");
		expect(restored.getDefaultModel()).toBe("hasilan-model");
		expect(restored.getSkillPaths()).toEqual(["hasilan-skill"]);
		expect(restored.getOrCreateDeviceId()).toBe(deviceId);
		expect(await readFile(piFile, "utf8")).toBe(piContents);
		expect(JSON.parse(await readFile(join(cwd, ".hasilan-code", "settings.json"), "utf8")).skills).toEqual([
			"hasilan-skill",
		]);
	});

	it("keeps project prompts, skills and system instructions in separate namespaces", async () => {
		const root = await mkdtemp(join(tmpdir(), "hasilan-resources-"));
		directories.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		for (const [directory, name] of [
			[".pi", "pi-only"],
			[".hasilan-code", "hasilan-only"],
		]) {
			const base = join(cwd, directory);
			await mkdir(join(base, "prompts"), { recursive: true });
			await mkdir(join(base, "skills", name), { recursive: true });
			await writeFile(join(base, "SYSTEM.md"), `${name} system instructions`);
			await writeFile(join(base, "APPEND_SYSTEM.md"), `${name} appended instructions`);
			await writeFile(join(base, "prompts", `${name}.md`), `${name} prompt`);
			await writeFile(
				join(base, "skills", name, "SKILL.md"),
				`---\nname: ${name}\ndescription: Namespace isolation fixture\n---\n${name} skill instructions\n`,
			);
		}
		const pi = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
		await pi.reload();
		expect(pi.getSystemPrompt()).toBe("pi-only system instructions");
		const hasilan = new DefaultResourceLoader({
			cwd,
			agentDir,
			projectConfigDirName: ".hasilan-code",
			noContextFiles: true,
		});
		await hasilan.reload();
		expect(hasilan.getSystemPrompt()).toBe("hasilan-only system instructions");
		expect(hasilan.getAppendSystemPrompt()).toEqual(["hasilan-only appended instructions"]);
		expect(hasilan.getPrompts().prompts.map((prompt) => prompt.name)).toContain("hasilan-only");
		expect(hasilan.getPrompts().prompts.map((prompt) => prompt.name)).not.toContain("pi-only");
		expect(hasilan.getSkills().skills.map((skill) => skill.name)).toContain("hasilan-only");
		expect(hasilan.getSkills().skills.map((skill) => skill.name)).not.toContain("pi-only");
		await rm(join(cwd, ".hasilan-code", "SYSTEM.md"));
		await hasilan.reload();
		expect(hasilan.getSystemPrompt()).toBeUndefined();
	});
});
