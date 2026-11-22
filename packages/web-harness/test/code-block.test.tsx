import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Content } from "../src/client/Content.tsx";

describe("fenced markdown code blocks", () => {
	it("renders a framed code block with language label and copy button", () => {
		const html = renderToStaticMarkup(<Content value={"```ts\nconst answer = 42;\n```"} onFile={() => {}} />);
		expect(html).toContain("code-block-frame");
		expect(html).toContain("code-block-header");
		expect(html).toContain("code-block-language");
		expect(html).toContain("code-block-copy");
		expect(html).toContain("const answer = 42;");
	});
});
