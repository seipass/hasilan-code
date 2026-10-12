import { describe, expect, it } from "vitest";
import { ANONYMOUS_REGISTER, parsePatch } from "../src/server/tools/hashline/parser.ts";

const payload = "[file.ts#ABCD]\nPUT 1.=2:\n+replacement\n+";
const expected = [
	{
		path: "file.ts",
		tag: "ABCD",
		operations: [{ kind: "put", locator: { kind: "range", start: 1, end: 2 }, body: ["replacement", ""] }],
	},
];

describe("Hashline parser envelopes", () => {
	it.each([
		{ name: "unwrapped", input: payload },
		{ name: "unwrapped with final newline", input: `${payload}\n` },
		{ name: "unwrapped with outer blank lines", input: `\n \t\n${payload}\n\t \n\n` },
		{ name: "wrapped", input: `*** Begin Patch\n${payload}\n*** End Patch` },
		{ name: "wrapped with final newline", input: `*** Begin Patch\n${payload}\n*** End Patch\n` },
		{ name: "wrapped with outer blank lines", input: `\n\t\n*** Begin Patch\n${payload}\n*** End Patch\n \n\n` },
		{ name: "unwrapped CRLF", input: payload.replaceAll("\n", "\r\n") },
		{
			name: "wrapped CRLF",
			input: `\r\n*** Begin Patch\r\n${payload.replaceAll("\n", "\r\n")}\r\n*** End Patch\r\n\r\n`,
		},
	])("accepts $name without changing payload", ({ input }) => {
		expect(parsePatch(input)).toEqual(expected);
	});

	it("preserves literal body rows without treating them as markers or diff syntax", () => {
		expect(
			parsePatch("[space #%.txt#ABCD]\nPUT >$:\n+\n++literal\n+-literal\n+  indented  \n+*** End Patch\n+++ file"),
		).toEqual([
			{
				path: "space #%.txt",
				tag: "ABCD",
				operations: [
					{
						kind: "put",
						locator: { kind: "tail" },
						body: ["", "+literal", "-literal", "  indented  ", "*** End Patch", "++ file"],
					},
				],
			},
		]);
	});

	it("parses multiple files and register operations without an envelope", () => {
		expect(
			parsePatch(
				'[source.ts#ABCD]\nCUT 2.=3 @saved\nCUT 4*\nPUT >5\nPUT <1 @saved\nPUT >1* @saved\nPUT >$ @saved\nPUT 6* @saved\nPUT 7.=8 @saved\nMV "directory/new name.ts"\n[destination.ts#012F]\nPUT >$ @saved\nREM',
			),
		).toEqual([
			{
				path: "source.ts",
				tag: "ABCD",
				operations: [
					{ kind: "cut", locator: { kind: "range", start: 2, end: 3 }, register: "saved" },
					{ kind: "cut", locator: { kind: "block", line: 4 }, register: ANONYMOUS_REGISTER },
					{
						kind: "put",
						locator: { kind: "gap", side: "after", line: 5, block: false },
						register: ANONYMOUS_REGISTER,
					},
					{ kind: "put", locator: { kind: "gap", side: "before", line: 1, block: false }, register: "saved" },
					{ kind: "put", locator: { kind: "gap", side: "after", line: 1, block: true }, register: "saved" },
					{ kind: "put", locator: { kind: "tail" }, register: "saved" },
					{ kind: "put", locator: { kind: "block", line: 6 }, register: "saved" },
					{ kind: "put", locator: { kind: "range", start: 7, end: 8 }, register: "saved" },
					{ kind: "move", destination: "directory/new name.ts" },
				],
			},
			{
				path: "destination.ts",
				tag: "012F",
				operations: [{ kind: "put", locator: { kind: "tail" }, register: "saved" }, { kind: "remove" }],
			},
		]);
	});
});

describe("Hashline parser malformed input", () => {
	it.each([
		{ name: "empty input", input: "" },
		{ name: "only outer blanks", input: "\n \t\n" },
		{ name: "empty envelope", input: "*** Begin Patch\n*** End Patch" },
		{ name: "missing closing marker", input: `\n*** Begin Patch\n${payload}\n` },
		{ name: "missing opening marker", input: `${payload}\n*** End Patch\n\n` },
		{ name: "wrong closing marker", input: `*** Begin Patch\n${payload}\n*** End File` },
		{ name: "reversed markers", input: `*** End Patch\n${payload}\n*** Begin Patch` },
		{
			name: "nested markers",
			input: `*** Begin Patch\n*** Begin Patch\n${payload}\n*** End Patch\n*** End Patch`,
		},
		{ name: "closing marker inside payload", input: `${payload}\n*** End Patch\nREM` },
		{ name: "blank inside envelope", input: `*** Begin Patch\n\n${payload}\n*** End Patch` },
		{ name: "blank between operations", input: "[file.ts#ABCD]\nCUT 1.=1\n\nREM" },
		{ name: "operation without header", input: "CUT 1.=1" },
		{ name: "lowercase guessed tag", input: "[file.ts#abcd]\nREM" },
		{ name: "missing tag", input: "[file.ts]\nREM" },
		{ name: "duplicate header", input: "[file.ts#ABCD]\nREM\n[file.ts#ABCD]\nREM" },
		{ name: "empty intermediate file", input: "[file.ts#ABCD]\n[other.ts#012F]\nREM" },
		{ name: "empty final file", input: "[file.ts#ABCD]" },
		{ name: "missing plus prefix", input: "[file.ts#ABCD]\nPUT 1.=1:\nreplacement" },
		{ name: "empty deletion body", input: "[file.ts#ABCD]\nPUT 1.=1:" },
		{ name: "diff deletion as body", input: "[file.ts#ABCD]\nPUT 1.=1:\n-old\n+new" },
		{ name: "missing prefix after valid row", input: "[file.ts#ABCD]\nPUT 1.=1:\n+new\ncontext" },
		{ name: "bare blank after valid row", input: "[file.ts#ABCD]\nPUT 1.=1:\n+new\n\nREM" },
		{ name: "orphan plus row", input: "[file.ts#ABCD]\n+replacement" },
		{ name: "missing colon", input: "[file.ts#ABCD]\nPUT 1.=1\n+replacement" },
		{ name: "anonymous range paste", input: "[file.ts#ABCD]\nPUT 1.=2" },
		{ name: "anonymous block paste", input: "[file.ts#ABCD]\nPUT 1*" },
		{ name: "register with literal body", input: "[file.ts#ABCD]\nPUT >1 @saved:\n+replacement" },
		{ name: "range reversed", input: "[file.ts#ABCD]\nCUT 2.=1" },
		{ name: "zero range", input: "[file.ts#ABCD]\nCUT 0.=1" },
		{ name: "unsafe integer", input: "[file.ts#ABCD]\nPUT >9007199254740992:\n+x" },
		{ name: "zero block", input: "[file.ts#ABCD]\nCUT 0*" },
		{ name: "block before gap", input: "[file.ts#ABCD]\nPUT <1*:\n+x" },
		{ name: "cut gap", input: "[file.ts#ABCD]\nCUT >1" },
		{ name: "cut tail", input: "[file.ts#ABCD]\nCUT >$" },
		{ name: "broken quoted move", input: '[file.ts#ABCD]\nMV "new name.ts' },
		{ name: "empty quoted move", input: '[file.ts#ABCD]\nMV ""' },
		{ name: "missing move path", input: "[file.ts#ABCD]\nMV " },
		{
			name: "unified diff preamble",
			input: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
		},
		{ name: "unified diff hunk", input: "[file.ts#ABCD]\n@@ -1 +1 @@\n-old\n+new" },
		{ name: "unified diff old path", input: "--- a/file.ts\n+++ b/file.ts" },
		{ name: "unified diff new path", input: "[file.ts#ABCD]\n+++ b/file.ts" },
		{ name: "markdown fenced payload", input: `\`\`\`\n${payload}\n\`\`\`` },
		{ name: "unstripped prose", input: `Here is the patch:\n${payload}` },
	])("rejects $name without guessing corrections", ({ input }) => {
		expect(() => parsePatch(input)).toThrow();
	});

	it("retains physical CRLF line numbers despite harmless outer blanks", () => {
		expect(() => parsePatch("\r\n \t\r\n*** Begin Patch\r\n[file.ts#ABCD]\r\nCUT 2.=1\r\n*** End Patch\r\n")).toThrow(
			/\b5\b/,
		);
	});
});
