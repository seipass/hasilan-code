import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@hasilan-code/pi-ai";
import { ModelRuntime } from "@hasilan-code/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsService } from "../src/server/settings.ts";
import { transformText } from "../src/server/text-transform.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";

let directory = "";
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

it("persists the selected language and model, translates a file without modifying it, and summarizes thinking", async () => {
	directory = await mkdtemp(join(tmpdir(), "text-transform-"));
	const runtime = await ModelRuntime.create({
		refreshOnCreate: false,
		modelsPath: null,
		authPath: join(directory, "auth.json"),
	});
	const model = runtime.getModels().find((entry) => entry.provider === "commandcode");
	if (!model) throw new Error("Missing test model");
	vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
	const complete = vi
		.spyOn(runtime, "completeSimple")
		.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "結果" }] } as AssistantMessage);
	const settings = await SettingsService.open(directory, runtime);
	await settings.patch({ translation: { language: "日本語", model: { provider: model.provider, id: model.id } } });
	const restored = await SettingsService.open(directory, runtime);
	expect(restored.get().translation).toEqual({
		language: "日本語",
		model: { provider: model.provider, id: model.id },
	});
	const files = new WorkspaceFiles();
	const workspace = await files.register(directory);
	await writeFile(join(directory, "original.txt"), "original text");
	const signal = new AbortController().signal;
	expect(
		await transformText(
			{ operation: "translate", source: { kind: "file", workspaceId: workspace.id, path: "original.txt" } },
			restored,
			runtime,
			files,
			signal,
		),
	).toEqual({ text: "結果" });
	expect(await readFile(join(directory, "original.txt"), "utf8")).toBe("original text");
	expect(complete.mock.calls[0][1].systemPrompt).toContain("日本語");
	expect(complete.mock.calls[0][1].messages[0]).toMatchObject({ content: [{ type: "text", text: "original text" }] });
	await transformText(
		{ operation: "summarize", source: { kind: "text", text: "reasoning" } },
		restored,
		runtime,
		files,
		signal,
	);
	expect(complete.mock.calls[1][1].systemPrompt).toContain("summarizer");
	await writeFile(join(directory, "binary"), Buffer.from([0, 1]));
	await expect(
		transformText(
			{ operation: "translate", source: { kind: "file", workspaceId: workspace.id, path: "binary" } },
			restored,
			runtime,
			files,
			signal,
		),
	).rejects.toThrow("テキスト");
	expect(complete).toHaveBeenCalledTimes(2);
});
