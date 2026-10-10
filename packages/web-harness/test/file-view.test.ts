import { describe, expect, it } from "vitest";
import { fileView } from "../src/server/file-view.ts";
import { fileRevision } from "../src/server/workspace-files.ts";

function snapshot(text: string | Buffer) {
	const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
	return { path: "fixture", bytes, revision: fileRevision(bytes) };
}

describe("file viewer", () => {
	it("preserves Unicode text and line identity across CRLF windows and EOF", () => {
		const file = snapshot("日本語\r\n<script>window.bad=true</script>\r\nlast\r\n");
		expect(fileView(file, 2, 1)).toMatchObject({
			kind: "text",
			lines: [{ number: 2, text: "<script>window.bad=true</script>" }],
			nextOffset: 3,
		});
		expect(fileView(file, 3)).toMatchObject({ lines: [{ number: 3, text: "last" }] });
		expect(fileView(file, 3)).not.toHaveProperty("nextOffset");
		expect(fileView(snapshot(""))).toMatchObject({ kind: "text", lines: [] });
	});
	it("bounds a single huge Unicode line without splitting a codepoint or looping pagination", () => {
		const view = fileView(snapshot(`${"あ".repeat(30000)}\nnext`));
		expect(view.kind).toBe("text");
		if (view.kind !== "text") throw new Error("Expected text");
		expect(view.lines[0].truncated).toBe(true);
		expect(view.lines[0].text).toBe("あ".repeat(Math.floor(65536 / 3)));
		expect(view.nextOffset).toBe(2);
	});
	it("classifies invalid UTF8 and NUL as binary but keeps active document markup as text", () => {
		expect(fileView(snapshot(Buffer.from([255, 254]))).kind).toBe("binary");
		expect(fileView(snapshot("a\0b")).kind).toBe("binary");
		expect(fileView(snapshot('<svg onload="bad()"></svg>')).kind).toBe("text");
	});
});
