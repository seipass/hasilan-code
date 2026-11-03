import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Icon } from "../src/client/Icon.tsx";

// Controls that show only an icon need a stable, font-independent shape and no extra accessible text.
it("renders stroke icons as hidden decoration", () => {
	const markup = renderToStaticMarkup(<Icon name="close" />);
	expect(markup).toContain('aria-hidden="true"');
	expect(markup).toContain('fill="none"');
	expect(markup).toContain('stroke="currentColor"');
	expect(markup).not.toContain("<title");
});

it("renders stop as a filled square rather than a glyph", () => {
	const markup = renderToStaticMarkup(<Icon name="stop" size={14} />);
	expect(markup).toContain("<rect");
	expect(markup).toContain('fill="currentColor"');
	expect(markup).toContain('width="14"');
});
