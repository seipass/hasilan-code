import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HashlineSession,
	parsePatch,
	resolveBlock,
	SnapshotStore,
	snapshotOf,
} from "../src/server/tools/hashline/index.ts";
import { fileRevision, WorkspaceFiles } from "../src/server/workspace-files.ts";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(content: string | Buffer = "one\ntwo\nthree\n", name = "file.txt") {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-hashline-"));
	temporary.push(root);
	const files = new WorkspaceFiles();
	const { id } = await files.register(root);
	await files.create(id, name, Buffer.isBuffer(content) ? content : Buffer.from(content));
	return { root, files, id, agent: new HashlineSession(files, id), name };
}
function patch(name: string, tag: string, body: string): string {
	return `*** Begin Patch\n[${name}#${tag}]\n${body}\n*** End Patch\n`;
}

describe("Hashline read and mutation", () => {
	it("updates original line positions and returns a fresh header and diff", async () => {
		const { agent, files, id, name } = await fixture();
		const read = await agent.read(name);
		expect(read.content).toEqual([{ type: "text", text: `[${name}#${read.details.tag}]\n1:one\n2:two\n3:three` }]);
		const result = await agent.edit(patch(name, read.details.tag!, "PUT 2.=2:\n+TWO"));
		expect((await files.read(id, name)).bytes.toString()).toBe("one\nTWO\nthree\n");
		expect(result.details.headers[0]).not.toContain(`#${read.details.tag}]`);
		expect(result.details.diff).toContain("-two\n+TWO");
		await expect(agent.edit(patch(name, read.details.tag!, "PUT 1.=1:\n+changed"))).rejects.toThrow("Stale snapshot");
	});
	it("reuses the returned tag for unshifted seen lines and numbered edited previews", async () => {
		const { agent, files, id, name } = await fixture();
		const read = await agent.read(name);
		const first = await agent.edit(patch(name, read.details.tag!, "PUT 3.=3:\n+THREE"));
		expect(first.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("3:THREE") });
		const firstTag = agent.snapshots.get(name)!.tag;
		expect(first.details.headers).toEqual([`[${name}#${firstTag}]`]);
		const second = await agent.edit(patch(name, firstTag, "PUT 2.=2:\n+TWO"));
		const secondTag = agent.snapshots.get(name)!.tag;
		expect(second.details.headers).toEqual([`[${name}#${secondTag}]`]);
		await agent.edit(patch(name, secondTag, "PUT 2.=2:\n+SECOND"));
		expect((await files.read(id, name)).bytes.toString()).toBe("one\nSECOND\nTHREE\n");
	});
	it("does not inherit seen numbers for unchanged lines shifted by an edit", async () => {
		const { agent, files, id, name } = await fixture();
		const read = await agent.read(name);
		const inserted = await agent.edit(patch(name, read.details.tag!, "PUT >1:\n+inserted"));
		expect(inserted.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("2:inserted") });
		const tag = agent.snapshots.get(name)!.tag;
		await expect(agent.edit(patch(name, tag, "PUT 3.=3:\n+changed"))).rejects.toThrow("Unread line 3");
		await agent.edit(patch(name, tag, "PUT 2.=2:\n+INSERTED"));
		expect((await files.read(id, name)).bytes.toString()).toBe("one\nINSERTED\ntwo\nthree\n");
	});
	it("marks only complete edited preview rows, not truncated diff text", async () => {
		const { agent, name } = await fixture();
		const read = await agent.read(name, 2, 1);
		const result = await agent.edit(patch(name, read.details.tag!, `PUT 2.=2:\n+${"大".repeat(30_000)}`));
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Edited preview truncated"),
		});
		expect(agent.snapshots.get(name)!.seenLines.has(2)).toBe(false);
		await expect(agent.edit(patch(name, agent.snapshots.get(name)!.tag, "PUT 2.=2:\n+x"))).rejects.toThrow(
			"Unread line 2",
		);
	});
	it("recovers a unique unchanged target after a harmless earlier insertion", async () => {
		const { agent, root, files, id, name } = await fixture();
		const read = await agent.read(name);
		await writeFile(path.join(root, name), "prefix\none\ntwo\nthree\n");
		const result = await agent.edit(patch(name, read.details.tag!, "PUT 2.=2:\n+TWO"));
		expect((await files.read(id, name)).bytes.toString()).toBe("prefix\none\nTWO\nthree\n");
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("3:TWO") });
	});
	it("retains read snapshots for recovery even after a newer partial read", async () => {
		const { agent, root, files, id, name } = await fixture();
		const original = await agent.read(name, 2, 1);
		await writeFile(path.join(root, name), "prefix\none\ntwo\nthree\n");
		const newer = await agent.read(name, 1, 1);
		expect(newer.details.tag).not.toBe(original.details.tag);
		await agent.edit(patch(name, original.details.tag!, "PUT 2.=2:\n+TWO"));
		expect((await files.read(id, name)).bytes.toString()).toBe("prefix\none\nTWO\nthree\n");
	});
	it.each(["prefix\none\nmodified\nthree\n", "prefix\nchanged context\ntwo\nthree\n"])(
		"rejects stale recovery when the target or adjacent context changed: %j",
		async (current) => {
			const { agent, root, files, id, name } = await fixture();
			const read = await agent.read(name);
			await writeFile(path.join(root, name), current);
			await expect(agent.edit(patch(name, read.details.tag!, "PUT 2.=2:\n+TWO"))).rejects.toThrow("Stale snapshot");
			expect((await files.read(id, name)).bytes.toString()).toBe(current);
		},
	);
	it("rejects context already repeated in the source, even when the numbered target was read", async () => {
		const source = "start\nleft\ntarget\nright\nseparator\nleft\ntarget\nright\nend\n";
		const { agent, root, files, id, name } = await fixture(source);
		const read = await agent.read(name);
		await writeFile(path.join(root, name), `prefix\n${source}`);
		await expect(agent.edit(patch(name, read.details.tag!, "PUT 3.=3:\n+changed"))).rejects.toThrow("ambiguous");
		expect((await files.read(id, name)).bytes.toString()).toBe(`prefix\n${source}`);
	});
	it("rejects formerly unique context duplicated in the current file", async () => {
		const source = "start\nleft\ntarget\nright\nend\n";
		const current = `prefix\nleft\ntarget\nright\n${source}`;
		const { agent, root, files, id, name } = await fixture(source);
		const read = await agent.read(name);
		await writeFile(path.join(root, name), current);
		await expect(agent.edit(patch(name, read.details.tag!, "PUT 3.=3:\n+changed"))).rejects.toThrow("ambiguous");
		expect((await files.read(id, name)).bytes.toString()).toBe(current);
	});
	it("cannot use recovery or the returned tag to bypass unseen target protection", async () => {
		const { agent, root, files, id, name } = await fixture();
		const read = await agent.read(name, 2, 1);
		await writeFile(path.join(root, name), "prefix\none\ntwo\nthree\n");
		await expect(agent.edit(patch(name, read.details.tag!, "PUT 1.=1:\n+changed"))).rejects.toThrow("Unread line 1");
		await agent.edit(patch(name, read.details.tag!, "PUT 2.=2:\n+TWO"));
		await expect(agent.edit(patch(name, agent.snapshots.get(name)!.tag, "PUT 2.=2:\n+changed"))).rejects.toThrow(
			"Unread line 2",
		);
		expect((await files.read(id, name)).bytes.toString()).toBe("prefix\none\nTWO\nthree\n");
	});
	it.each(["REM", "MV moved.txt"])("rejects stale whole-file operations: %s", async (operation) => {
		const { agent, root, files, id, name } = await fixture();
		const read = await agent.read(name);
		await writeFile(path.join(root, name), "prefix\none\ntwo\nthree\n");
		await expect(agent.edit(patch(name, read.details.tag!, operation))).rejects.toThrow("Stale snapshot");
		expect((await files.read(id, name)).bytes.toString()).toBe("prefix\none\ntwo\nthree\n");
	});
	it("rejects unknown and known colliding tags rather than guessing a source snapshot", async () => {
		const { agent, root, files, id, name } = await fixture("one  \ntwo\n");
		const before = await agent.read(name);
		const guessed = before.details.tag === "0000" ? "FFFF" : "0000";
		await expect(agent.edit(patch(name, guessed, "PUT 2.=2:\n+TWO"))).rejects.toThrow("unknown or expired");
		await writeFile(path.join(root, name), "one\ntwo\n");
		const after = await agent.read(name);
		expect(after.details.tag).toBe(before.details.tag);
		await expect(agent.edit(patch(name, after.details.tag!, "PUT 2.=2:\n+TWO"))).rejects.toThrow("colliding tag");
		expect((await files.read(id, name)).bytes.toString()).toBe("one\ntwo\n");
	});
	it("rejects a concurrent write after recovery resolves the current raw preimage", async () => {
		const { agent, root, files, id, name } = await fixture();
		const read = await agent.read(name);
		await writeFile(path.join(root, name), "prefix\none\ntwo\nthree\n");
		const commit = files.commit.bind(files);
		const intercepted = vi.spyOn(files, "commit").mockImplementationOnce(async (workspaceId, changes) => {
			expect(changes[0].beforeBytes.toString()).toBe("prefix\none\ntwo\nthree\n");
			expect(changes[0].expectedRevision).toBe(fileRevision(changes[0].beforeBytes));
			await writeFile(path.join(root, name), "prefix\none\nconcurrent\nthree\n");
			return commit(workspaceId, changes);
		});
		try {
			await expect(agent.edit(patch(name, read.details.tag!, "PUT 2.=2:\n+TWO"))).rejects.toThrow("Stale snapshot");
			expect((await files.read(id, name)).bytes.toString()).toBe("prefix\none\nconcurrent\nthree\n");
		} finally {
			intercepted.mockRestore();
		}
	});
	it("recovers an older retained post-edit preimage only where the target context is still unchanged", async () => {
		const { agent, files, id, name } = await fixture("one\ntwo\nthree\nfour\nfive\n");
		const read = await agent.read(name);
		await agent.edit(patch(name, read.details.tag!, "PUT 5.=5:\n+FIVE"));
		await agent.edit(patch(name, read.details.tag!, "PUT 2.=2:\n+TWO"));
		expect((await files.read(id, name)).bytes.toString()).toBe("one\nTWO\nthree\nfour\nFIVE\n");
		await expect(agent.edit(patch(name, read.details.tag!, "PUT 5.=5:\n+again"))).rejects.toThrow("Stale snapshot");
	});
	it("keeps current displayed provenance when applying an older retained snapshot", async () => {
		const { agent, root, files, id, name } = await fixture();
		const original = await agent.read(name, 2, 1);
		await writeFile(path.join(root, name), "prefix\none\ntwo\nthree\n");
		await agent.read(name, 1, 1);
		await agent.edit(patch(name, original.details.tag!, "PUT 2.=2:\n+TWO"));
		await agent.edit(patch(name, agent.snapshots.get(name)!.tag, "PUT 1.=1:\n+PREFIX"));
		expect((await files.read(id, name)).bytes.toString()).toBe("PREFIX\none\nTWO\nthree\n");
	});
	it.each(["\uFEFFprefix\none\ntwo\nthree\n", "prefix\r\none\r\ntwo\r\nthree\r\n", "prefix\none\ntwo\nthree"])(
		"rejects stale metadata changes rather than guessing their safety: %j",
		async (current) => {
			const { agent, root, files, id, name } = await fixture();
			const read = await agent.read(name);
			await writeFile(path.join(root, name), current);
			await expect(agent.edit(patch(name, read.details.tag!, "PUT 2.=2:\n+TWO"))).rejects.toThrow("Stale snapshot");
			expect((await files.read(id, name)).bytes.toString()).toBe(current);
		},
	);
	it.each([
		{
			name: "file.ts",
			source:
				"function first() {\n  before();\n  target();\n  after();\n}\nfunction second() {\n  otherBefore();\n  otherTarget();\n  otherAfter();\n}\n",
			current: "function second() {\n  before();\n  target();\n  after();\n}\n",
		},
		{
			name: "file.md",
			source: "# First\nbefore\ntarget\nafter\n# Second\nother before\nother target\nother after\n",
			current: "# Second\nbefore\ntarget\nafter\n",
		},
	])("rejects stale target migration to a sibling construct in $name", async ({ name, source, current }) => {
		const { agent, root, files, id } = await fixture(source, name);
		const read = await agent.read(name);
		await writeFile(path.join(root, name), current);
		await expect(agent.edit(patch(name, read.details.tag!, "PUT 3.=3:\n+changed"))).rejects.toThrow(
			"enclosing construct",
		);
		expect((await files.read(id, name)).bytes.toString()).toBe(current);
	});
	it.each([
		{
			name: "file.ts",
			source: "function first() {\n  before();\n  target();\n  after();\n}\n",
			prefix: "// earlier\n",
		},
		{ name: "file.md", source: "# First\nbefore\ntarget\nafter\n", prefix: "earlier\n" },
	])(
		"recovers an unchanged enclosing opener after an earlier insertion in $name",
		async ({ name, source, prefix }) => {
			const { agent, root, files, id } = await fixture(source, name);
			const read = await agent.read(name);
			await writeFile(path.join(root, name), prefix + source);
			await agent.edit(patch(name, read.details.tag!, "PUT 3.=3:\n+changed"));
			expect((await files.read(id, name)).bytes.toString()).toBe(
				prefix + source.replace(source.split("\n")[2], "changed"),
			);
		},
	);
	it("includes declaration names after shared doc comments in enclosing identity", async () => {
		const source = "/** shared */\nfunction first() {\n  before();\n  target();\n  after();\n}\n";
		const current = source.replace("first", "second");
		const { agent, root, files, id, name } = await fixture(source, "file.ts");
		const read = await agent.read(name);
		await writeFile(path.join(root, name), current);
		await expect(agent.edit(patch(name, read.details.tag!, "PUT 4.=4:\n+changed"))).rejects.toThrow(
			"enclosing construct",
		);
		expect((await files.read(id, name)).bytes.toString()).toBe(current);
	});
	it("rejects a stale multi-hunk edit when uniquely matched targets moved by different offsets", async () => {
		const source = "one\nfirst\nthree\nseparator\nfive\nsecond\nseven\n";
		const current = "prefix\none\nfirst\nthree\ninserted\nseparator\nfive\nsecond\nseven\n";
		const { agent, root, files, id, name } = await fixture(source);
		const read = await agent.read(name);
		await writeFile(path.join(root, name), current);
		await expect(agent.edit(patch(name, read.details.tag!, "PUT 2.=2:\n+FIRST\nPUT 6.=6:\n+SECOND"))).rejects.toThrow(
			"inconsistent target shifts",
		);
		expect((await files.read(id, name)).bytes.toString()).toBe(current);
	});
	it("bounds retained raw bytes while allowing one oversized current snapshot", () => {
		const store = new SnapshotStore();
		const bytes = Buffer.alloc(17 * 1024 * 1024, "a");
		const first = store.observe({ path: "first.txt", bytes, revision: fileRevision(bytes) });
		store.observe({ path: "second.txt", bytes, revision: first.revision });
		expect(store.get("first.txt")).toBeUndefined();
		expect(store.get("second.txt")).toBeDefined();
		const oversized = Buffer.alloc(33 * 1024 * 1024, "b");
		const current = store.observe({ path: "large.txt", bytes: oversized, revision: fileRevision(oversized) });
		expect(store.get("second.txt")).toBeUndefined();
		expect(store.get("large.txt")).toBe(current);
		store.invalidate("large.txt");
		expect(store.get("large.txt")).toBeUndefined();
	}, 30_000);
	it("bounds snapshot history per path and across all paths without forgetting retained provenance", () => {
		const store = new SnapshotStore();
		const tags = new Set<string>();
		const versions: ReturnType<typeof snapshotOf>[] = [];
		for (let index = 0; versions.length < 9; index++) {
			const bytes = Buffer.from(`version ${index}\n`);
			const file = { path: "same.txt", bytes, revision: fileRevision(bytes) };
			if (tags.has(snapshotOf(file).tag)) continue;
			const snapshot = store.observe(file);
			tags.add(snapshot.tag);
			versions.push(snapshot);
		}
		expect(() => store.resolve("same.txt", versions[0].tag)).toThrow("unknown or expired");
		versions[1].seenLines.add(1);
		expect(store.resolve("same.txt", versions[1].tag).seenLines.has(1)).toBe(true);
		const originalBytes = Buffer.from("original\n");
		const original = store.observe({ path: "old.txt", bytes: originalBytes, revision: fileRevision(originalBytes) });
		for (let index = 0; index < 64; index++) {
			const bytes = Buffer.from(`file ${index}\n`);
			store.observe({ path: `${index}.txt`, bytes, revision: fileRevision(bytes) });
		}
		expect(store.get("old.txt")).toBeUndefined();
		expect(() => store.resolve("old.txt", original.tag)).toThrow("Unread file");
		expect(store.get("63.txt")).toBeDefined();
	});
	it("recovers exact ranges, anchor gaps, tail inserts and captured registers", async () => {
		const { agent, root, files, id, name } = await fixture("one\ntwo\nthree\nfour\nfive\n");
		await files.create(id, "target.txt", Buffer.from("target\n"));
		const read = await agent.read(name);
		const target = await agent.read("target.txt");
		await writeFile(path.join(root, name), "prefix\none\ntwo\nthree\nfour\nfive\n");
		await agent.edit(
			`*** Begin Patch\n[${name}#${read.details.tag}]\nCUT 2.=3 @saved\nPUT >4:\n+gap\nPUT >$:\n+tail\n[target.txt#${target.details.tag}]\nPUT >1 @saved\n*** End Patch`,
		);
		expect((await files.read(id, name)).bytes.toString()).toBe("prefix\none\nfour\ngap\nfive\ntail\n");
		expect((await files.read(id, "target.txt")).bytes.toString()).toBe("target\ntwo\nthree\n");
	});
	it("recovers only the unchanged fully seen span of a block locator", async () => {
		const source = "# Prefix\nprefix content\n# Target\ntarget content\n# End\nend content\n";
		const { agent, root, files, id, name } = await fixture(source, "file.md");
		const read = await agent.read(name);
		await writeFile(path.join(root, name), `earlier insertion\n${source}`);
		await agent.edit(patch(name, read.details.tag!, "PUT 3*:\n+# Replaced\n+new content"));
		expect((await files.read(id, name)).bytes.toString()).toBe(
			"earlier insertion\n# Prefix\nprefix content\n# Replaced\nnew content\n# End\nend content\n",
		);
	});
	it("does not retain registers from a failed stale multi-file batch", async () => {
		const { agent, root, files, id, name } = await fixture();
		await files.create(id, "target.txt", Buffer.from("target\n"));
		const first = await agent.read(name);
		const target = await agent.read("target.txt");
		await writeFile(path.join(root, "target.txt"), "changed\n");
		await expect(
			agent.edit(
				`*** Begin Patch\n[${name}#${first.details.tag}]\nCUT 2.=2 @failed\n[target.txt#${target.details.tag}]\nPUT 1.=1:\n+replacement\n*** End Patch`,
			),
		).rejects.toThrow("Stale snapshot");
		expect((await files.read(id, name)).bytes.toString()).toBe("one\ntwo\nthree\n");
		await expect(agent.edit(patch(name, first.details.tag!, "PUT >1 @failed"))).rejects.toThrow("Undefined register");
	});
	it("rejects edits to unseen lines, guessed headers, and full-file operations before full reads", async () => {
		const { agent, files, id, name } = await fixture();
		const viewed = await files.read(id, name);
		await expect(agent.edit(patch(name, snapshotOf(viewed).tag, "PUT 1.=1:\n+x"))).rejects.toThrow("Unread file");
		const read = await agent.read(name, 2, 1);
		for (const operation of ["PUT 1.=1:\n+x", "REM", "MV renamed"])
			await expect(agent.edit(patch(name, read.details.tag!, operation))).rejects.toThrow("Unread line");
		expect((await files.read(id, name)).bytes).toEqual(viewed.bytes);
		await expect(agent.read(name, 0)).rejects.toThrow("positive integers");
		await expect(agent.read(name, 4)).rejects.toThrow("beyond end");
	});
	it("uses raw revision and full text rather than a 16-bit tag alone for stale detection", async () => {
		const { agent, root, name } = await fixture("one  \ntwo\n");
		const before = await agent.read(name);
		await writeFile(path.join(root, name), "one\ntwo\n");
		const currentBytes = Buffer.from("one\ntwo\n");
		expect(snapshotOf({ path: name, bytes: currentBytes, revision: fileRevision(currentBytes) }).tag).toBe(
			before.details.tag,
		);
		await expect(agent.edit(patch(name, before.details.tag!, "PUT 2.=2:\n+TWO"))).rejects.toThrow("Stale snapshot");
	});
	it("allows only one of two independent sessions to commit the same preimage", async () => {
		const { agent, files, id, name } = await fixture();
		const other = new HashlineSession(files, id);
		const first = await agent.read(name);
		const second = await other.read(name);
		const results = await Promise.allSettled([
			agent.edit(patch(name, first.details.tag!, "PUT 2.=2:\n+first")),
			other.edit(patch(name, second.details.tag!, "PUT 2.=2:\n+second")),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});
	it.each(["\uFEFFone\r\ntwo\r\n", "one\r\ntwo", "one\ntwo\n", "one\rtwo\r"])(
		"preserves BOM, EOL and trailing newline for %j",
		async (source) => {
			const { agent, files, id, name } = await fixture(source);
			const read = await agent.read(name);
			await agent.edit(patch(name, read.details.tag!, "PUT 2.=2:\n+日本語\t "));
			expect((await files.read(id, name)).bytes).toEqual(Buffer.from(source.replace("two", "日本語\t ")));
		},
	);
	it("rejects mixed EOL mutation, non-UTF-8 files and partial oversized lines", async () => {
		const mixed = await fixture("one\r\ntwo\n");
		const read = await mixed.agent.read(mixed.name);
		await expect(mixed.agent.edit(patch(mixed.name, read.details.tag!, "PUT 1.=1:\n+x"))).rejects.toThrow(
			"Mixed line endings",
		);
		const binary = await fixture(Buffer.from([255, 254, 0, 0]));
		await expect(binary.agent.read(binary.name)).rejects.toThrow("non-UTF-8");
		const large = await fixture(`small\n${"大".repeat(30_000)}\nlast\n`);
		const window = await large.agent.read(large.name);
		expect(window.details.nextOffset).toBe(2);
		expect(window.content[0].type === "text" && Buffer.byteLength(window.content[0].text)).toBeLessThanOrEqual(
			64 * 1024,
		);
		await expect(large.agent.edit(patch(large.name, window.details.tag!, "PUT 2.=2:\n+x"))).rejects.toThrow(
			"Unread line",
		);
	});
	it("handles empty files, Unicode normalization hashing and exclusive creation", async () => {
		const { agent, files, id, name } = await fixture("");
		const read = await agent.read(name);
		expect(read.details.tag).toBe("5D05");
		expect(read.details.totalLines).toBe(0);
		await agent.edit(patch(name, read.details.tag!, "PUT >$:\n+日本語"));
		expect((await files.read(id, name)).bytes.toString()).toBe("日本語");
		await agent.write("new/folder/name #%.txt", "created\n");
		await expect(agent.write("new/folder/name #%.txt", "overwrite")).rejects.toThrow("File exists");
		const bytesA = Buffer.from("\uFEFF日本語\t \r\n末尾 \r\n");
		const bytesB = Buffer.from("日本語\n末尾\n");
		expect(snapshotOf({ path: "a", bytes: bytesA, revision: fileRevision(bytesA) }).tag).toBe(
			snapshotOf({ path: "b", bytes: bytesB, revision: fileRevision(bytesB) }).tag,
		);
	});
	it("cuts and pastes cross-file registers, retains registers within the session and preserves original numbers", async () => {
		const { agent, files, id, name } = await fixture();
		await files.create(id, "target.txt", Buffer.from("target\n"));
		const first = await agent.read(name);
		const target = await agent.read("target.txt");
		await agent.edit(
			`*** Begin Patch\n[${name}#${first.details.tag}]\nCUT 2.=2 @saved\nPUT 3.=3:\n+THREE\n[target.txt#${target.details.tag}]\nPUT >1 @saved\n*** End Patch`,
		);
		expect((await files.read(id, name)).bytes.toString()).toBe("one\nTHREE\n");
		expect((await files.read(id, "target.txt")).bytes.toString()).toBe("target\ntwo\n");
		const reread = await agent.read(name);
		await agent.edit(patch(name, reread.details.tag!, "PUT <1 @saved"));
		expect((await files.read(id, name)).bytes.toString()).toBe("two\none\nTHREE\n");
	});
	it("supports anonymous CUT paste and rejects undefined registers and overlap before writes", async () => {
		const { agent, files, id, name } = await fixture();
		const read = await agent.read(name);
		for (const operation of ["PUT >1 @missing", "CUT 1.=2\nPUT 2.=3:\n+x", "CUT 1.=3\nPUT >1:\n+x"])
			await expect(agent.edit(patch(name, read.details.tag!, operation))).rejects.toThrow();
		expect((await files.read(id, name)).bytes.toString()).toBe("one\ntwo\nthree\n");
		await agent.edit(patch(name, read.details.tag!, "CUT 2.=2\nPUT >3"));
		expect((await files.read(id, name)).bytes.toString()).toBe("one\nthree\ntwo\n");
	});
	it("supports REM, MV and directory reads without recording directory snapshots", async () => {
		const { agent, files, id, name } = await fixture();
		await agent.read("");
		expect(agent.snapshots.get("")).toBeUndefined();
		const read = await agent.read(name);
		await agent.edit(patch(name, read.details.tag!, 'MV "folder/moved #%.txt"'));
		await expect(files.read(id, name)).rejects.toThrow();
		const moved = await agent.read("folder/moved #%.txt");
		await agent.edit(patch("folder/moved #%.txt", moved.details.tag!, "REM"));
		await expect(files.read(id, "folder/moved #%.txt")).rejects.toThrow();
	});
});

describe("independent patch grammar and blocks", () => {
	it("parses blank/body marker rows, tail/register locators and literal plus/minus text", () => {
		const parsed = parsePatch(
			patch("space #%.txt", "ABCD", "PUT 1.=2:\n+\n++literal\n+-literal\nPUT >1* @named\nCUT 3*"),
		);
		expect(parsed[0].operations[0]).toMatchObject({ kind: "put", body: ["", "+literal", "-literal"] });
		expect(parsed[0].operations[1]).toMatchObject({
			locator: { kind: "gap", side: "after", line: 1, block: true },
			register: "named",
		});
	});
	it.each([
		"",
		"*** Begin Patch\n*** End Patch",
		patch("file", "ABCD", "PUT 1.=1:"),
		patch("file", "ABCD", "PUT 2.=1:\n+x"),
		patch("file", "ABCD", "CUT >1"),
		patch("file", "ABCD", "PUT 1.=1"),
		patch("file", "ABCD", "PUT <1*:\n+x"),
	])("rejects invalid grammar %j", (input) => {
		expect(() => parsePatch(input)).toThrow();
	});
	it("resolves Markdown sections through nested headings but ignores fenced headings", () => {
		const lines = ["# First", "text", "```md", "# not a heading", "```", "## nested", "content", "# Second", "last"];
		expect(resolveBlock("file.md", lines, 1)).toEqual({ start: 1, end: 7 });
		expect(resolveBlock("file.md", lines, 6)).toEqual({ start: 6, end: 7 });
		expect(() => resolveBlock("file.md", lines, 4)).toThrow("Block locator unsupported");
	});
	it("resolves outer TypeScript blocks including JSDoc and decorators, not closers or single lines", () => {
		const lines = [
			"/** description */",
			"@sealed",
			"export class Example {",
			"  method() {",
			"    return 1;",
			"  }",
			"}",
			"const single = 1;",
		];
		expect(resolveBlock("file.ts", lines, 1)).toEqual({ start: 1, end: 7 });
		expect(resolveBlock("file.ts", lines, 4)).toEqual({ start: 4, end: 6 });
		for (const line of [3, 6, 7, 8])
			expect(() => resolveBlock("file.ts", lines, line)).toThrow("Block locator unsupported");
		expect(() => resolveBlock("file.py", ["def example():", "    pass"], 1)).toThrow("Block locator unsupported");
	});
	it("applies block replacement and block-after insertion only after full seen coverage", async () => {
		const { agent, files, id, name } = await fixture("# First\ncontent\n# Second\nlast\n", "file.md");
		const limited = await agent.read(name, 1, 1);
		await expect(agent.edit(patch(name, limited.details.tag!, "PUT 1*:\n+# Replaced\n+new"))).rejects.toThrow(
			"Unread line",
		);
		const full = await agent.read(name);
		await agent.edit(patch(name, full.details.tag!, "PUT 1*:\n+# Replaced\n+new\nPUT >3*:\n+tail"));
		expect((await files.read(id, name)).bytes.toString()).toBe("# Replaced\nnew\n# Second\nlast\ntail\n");
	});
});
