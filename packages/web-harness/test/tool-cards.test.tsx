import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ToolCard } from "../src/client/ToolInspector.tsx";
import type { ToolCall } from "../src/client/types.ts";

function card(tool: Pick<ToolCall, "name" | "input"> & Partial<ToolCall>): string {
	const value: ToolCall = { key: "k", sessionId: "s", callId: "call-1", status: "success", ...tool };
	return renderToStaticMarkup(<ToolCard expanded tool={value} onFile={() => undefined} />);
}

// Regression: the highlight pass covered the whole diff line, so prepending the marker
// cell rendered "++const a = 2;" and "- -const a = 1;".
it("draws the diff marker once", () => {
	const markup = card({
		name: "edit",
		input: { path: "app.ts" },
		result: { details: { files: [{ path: "app.ts", status: "applied" }], diff: "--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;" } },
	});
	expect(markup).toContain('<span class="tool-diff-marker">-</span>');
	expect(markup).toContain('<span class="tool-diff-marker">+</span>');
	expect(markup).not.toContain("--const");
	expect(markup).not.toContain("++const");
	expect(markup).toContain("const a = 1;");
	expect(markup).toContain("const a = 2;");
});

// The gutter is a control that opens the file at that line, so it must stay a button
// and the code must stay a sibling instead of being folded into the number.
it("keeps the read gutter and the code apart", () => {
	const markup = card({
		name: "read",
		input: { path: "app.ts", offset: 1 },
		result: { details: { kind: "text", path: "app.ts", tag: "AB12", totalLines: 2 }, content: [{ type: "text", text: "[app.ts#AB12]\n1:const a = 1;\n2:const b = 2;" }] },
	});
	expect(markup).toContain('title="Open app.ts at line 1"');
	expect(markup).toContain("const a = 1;");
	expect(markup).toContain("const b = 2;");
	expect(markup).not.toContain("[app.ts#AB12]");
});

// A created file is shown verbatim, so blank lines have to survive the highlight pass.
it("keeps blank lines in a created file", () => {
	const markup = card({ name: "write", input: { path: "app.ts", content: "const a = 1;\n\nconst b = 2;" } });
	const body = markup.slice(markup.indexOf('<pre class="tool-written files-highlight">'), markup.indexOf("</pre>"));
	expect(body.match(/<span/gu)?.length).toBe(3);
	expect(body).toContain("const b = 2;");
});
