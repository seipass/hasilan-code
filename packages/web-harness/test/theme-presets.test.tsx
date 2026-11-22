import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/client/Content.tsx";
import { ThemeAppearance } from "../src/client/ThemeAppearance.tsx";

describe("UI polish features", () => {
	it("renders fenced code blocks with a header, language tag, and copy button", () => {
		const html = renderToStaticMarkup(<Markdown text={"```typescript\nconst ok = true;\n```"} onFile={() => {}} />);
		expect(html).toContain('class="code-block"');
		expect(html).toContain('class="code-block-header"');
		expect(html).toContain(">typescript<");
		expect(html).toContain('aria-label="コードをコピー"');
		expect(html).toContain("const ok = true;");
	});

	it("shows theme presets including classic monochrome in appearance settings", () => {
		const html = renderToStaticMarkup(<ThemeAppearance />);
		expect(html).toContain("Obsidian Slate（標準）");
		expect(html).toContain("クラシックモノクロ");
	});
});
