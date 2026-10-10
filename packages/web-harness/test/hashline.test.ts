import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HashlineSession, parsePatch, resolveBlock, snapshotOf } from "../src/server/tools/hashline/index.ts";
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
