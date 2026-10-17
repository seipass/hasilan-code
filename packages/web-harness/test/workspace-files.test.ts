import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FileChange, type FilesChanged, WorkspaceFiles } from "../src/server/workspace-files.ts";

const failure = vi.hoisted(() => ({ destination: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: async (...args: Parameters<typeof actual.rename>) => {
			if (String(args[1]) === failure.destination) throw new Error("Injected rename I/O failure");
			return actual.rename(...args);
		},
	};
});
const temporary: string[] = [];
afterEach(async () => {
	failure.destination = "";
	await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(): Promise<{ root: string; id: string; files: WorkspaceFiles; events: FilesChanged[] }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-files-"));
	temporary.push(root);
	const events: FilesChanged[] = [];
	const files = new WorkspaceFiles({ onChanged: (event) => events.push(event) });
	const { id } = await files.register(root);
	return { root, id, files, events };
}
async function update(files: WorkspaceFiles, id: string, name: string, text: string): Promise<FileChange> {
	const before = await files.read(id, name);
	return {
		path: name,
		expectedRevision: before.revision,
		beforeBytes: before.bytes,
		afterBytes: Buffer.from(text),
		operation: "update",
	};
}

describe("WorkspaceFiles", () => {
	it("canonicalizes aliases, lists hidden files directories first, and preserves raw revisions", async () => {
		const { root, id, files } = await fixture();
		await mkdir(path.join(root, "folder"));
		await writeFile(path.join(root, ".hidden"), Buffer.from("\uFEFF日本語\r\n"));
		expect(await files.register(path.join(root, "folder", ".."))).toEqual({ id, path: files.getWorkspaceRoot(id) });
		expect((await files.list(id, "")).map((entry) => entry.name)).toEqual(["folder", ".hidden"]);
		const first = await files.read(id, ".hidden");
		expect(first.bytes).toEqual(Buffer.from("\uFEFF日本語\r\n"));
		await writeFile(path.join(root, ".hidden"), "日本語\n");
		expect((await files.read(id, ".hidden")).revision).not.toBe(first.revision);
	});
	it("rejects traversal, drive-relative, ADS, absolute, UNC/device, NUL and root mutation paths", async () => {
		const { id, files } = await fixture();
		for (const invalid of [
			"../escape",
			"a/../../escape",
			"C:relative",
			"file:stream",
			"/absolute",
			"\\\\server\\share",
			"\\\\?\\C:\\device",
			"nul\0name",
		]) {
			await expect(files.create(id, invalid, Buffer.from("x"))).rejects.toThrow();
		}
		await expect(files.create(id, "", Buffer.from("x"))).rejects.toThrow("root");
	});
	it("lists external symlinks without following them and rejects reads and creates through them", async () => {
		const { root, id, files } = await fixture();
		const outside = await mkdtemp(path.join(os.tmpdir(), "pi-outside-"));
		temporary.push(outside);
		await writeFile(path.join(outside, "secret"), "private");
		await symlink(outside, path.join(root, "external"), process.platform === "win32" ? "junction" : "dir");
		expect((await files.list(id)).find((entry) => entry.name === "external")?.kind).toBe("symlink");
		await expect(files.read(id, "external/secret")).rejects.toThrow("Symlink escapes");
		await expect(files.create(id, "external/new/sub", Buffer.from("x"))).rejects.toThrow("Symlink escapes");
	});
	it("serializes overlapping roots and permits only one stale-preimage contender", async () => {
		const { root, id, files } = await fixture();
		await mkdir(path.join(root, "nested"));
		await files.create(id, "nested/file", Buffer.from("original"));
		const secondFiles = new WorkspaceFiles();
		const second = await secondFiles.register(path.join(root, "nested"));
		const firstChange = await update(files, id, "nested/file", "first");
		const secondChange = await update(secondFiles, second.id, "file", "second");
		const results = await Promise.allSettled([
			files.commit(id, [firstChange]),
			secondFiles.commit(second.id, [secondChange]),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});
	it("validates every source before writing any file and refuses overwrite destinations", async () => {
		const { id, files } = await fixture();
		await files.create(id, "first", Buffer.from("one"));
		await files.create(id, "second", Buffer.from("two"));
		const first = await update(files, id, "first", "ONE");
		const stale = { ...(await update(files, id, "second", "TWO")), expectedRevision: "stale" };
		await expect(files.commit(id, [first, stale])).rejects.toThrow("Stale snapshot");
		expect((await files.read(id, "first")).bytes.toString()).toBe("one");
		await expect(files.commit(id, [{ ...first, operation: "move", moveDest: "second" }])).rejects.toThrow(
			"destination exists",
		);
		await expect(files.create(id, "first", Buffer.from("overwrite"))).rejects.toThrow(
			"File exists; use read and edit",
		);
	});
	it("reports applied and unapplied files accurately after an I/O failure, with no temp residue", async () => {
		const { root, id, files, events } = await fixture();
		for (const name of ["first", "second", "third"]) await files.create(id, name, Buffer.from(name));
		const changes = await Promise.all(
			["first", "second", "third"].map((name) => update(files, id, name, name.toUpperCase())),
		);
		failure.destination = path.join(files.getWorkspaceRoot(id), "second");
		const result = await files.commit(id, changes);
		expect(result.files.map((file) => file.status)).toEqual(["applied", "not_applied", "not_applied"]);
		expect(result.files[1].error).toContain("Injected rename");
		expect(await readFile(path.join(root, "first"), "utf8")).toBe("FIRST");
		expect(await readFile(path.join(root, "second"), "utf8")).toBe("second");
		expect(await readFile(path.join(root, "third"), "utf8")).toBe("third");
		expect((await files.list(id)).map((entry) => entry.name)).toEqual(["first", "second", "third"]);
		expect(events.at(-1)?.paths).toEqual(["first"]);
	});
	it("supports move-with-update and deletion while notifying source and destination", async () => {
		const { id, files, events } = await fixture();
		await files.create(id, "old", Buffer.from("old"));
		const move = {
			...(await update(files, id, "old", "new")),
			operation: "move" as const,
			moveDest: "folder/new #%.txt",
		};
		expect((await files.commit(id, [move])).files[0].status).toBe("applied");
		await expect(files.read(id, "old")).rejects.toThrow();
		expect((await files.read(id, move.moveDest)).bytes.toString()).toBe("new");
		expect(events.at(-1)?.paths).toEqual(["old", move.moveDest]);
		const removal = { ...(await update(files, id, move.moveDest, "")), operation: "delete" as const };
		expect((await files.commit(id, [removal])).files[0].status).toBe("applied");
		await expect(files.read(id, move.moveDest)).rejects.toThrow();
	});
});
