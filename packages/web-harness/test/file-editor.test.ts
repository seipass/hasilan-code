import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readEditableFile, saveEditableFile } from "../src/server/file-editor.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";

it("saves edited text while refusing to overwrite a changed file", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "hasilan-editor-"));
	try {
		const files = new WorkspaceFiles();
		const { id } = await files.register(root);
		await writeFile(path.join(root, "test.txt"), "\ufefforiginal\r\n");
		const original = await readEditableFile(files, id, "test.txt");
		expect(original.text).toBe("\ufefforiginal\r\n");
		const saved = await saveEditableFile(files, id, "test.txt", original.revision, "\ufeffedited\r\n");
		expect(await readFile(path.join(root, "test.txt"), "utf8")).toBe("\ufeffedited\r\n");
		await writeFile(path.join(root, "test.txt"), "external");
		await expect(saveEditableFile(files, id, "test.txt", saved.revision, "stale")).rejects.toThrow("外部で変更");
		expect(await readFile(path.join(root, "test.txt"), "utf8")).toBe("external");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
