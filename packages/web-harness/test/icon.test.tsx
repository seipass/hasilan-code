import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ICON_SIZES, Icon } from "../src/client/Icon.tsx";

// Controls that show only an icon need a stable, font-independent shape and no extra accessible text.
it("renders stroke icons as hidden decoration", () => {
	const markup = renderToStaticMarkup(<Icon name="close" />);
	expect(markup).toContain('aria-hidden="true"');
	expect(markup).toContain('fill="none"');
	expect(markup).toContain('stroke="currentColor"');
	expect(markup).not.toContain("<title");
});

it("renders stop as a filled square rather than a glyph", () => {
	const markup = renderToStaticMarkup(<Icon name="stop" size="primary" />);
	expect(markup).toContain("<rect");
	expect(markup).toContain('fill="currentColor"');
	expect(markup).toContain(`width="${ICON_SIZES.primary}"`);
});

// Regression: sizes were chosen per call site (13/14/15/17/18/20px in one toolbar).
it("uses one of the shared sizes", () => {
	for (const size of Object.keys(ICON_SIZES) as (keyof typeof ICON_SIZES)[]) {
		const markup = renderToStaticMarkup(<Icon name="plus" size={size} />);
		expect(markup).toContain(`width="${ICON_SIZES[size]}"`);
		expect(markup).toContain(`height="${ICON_SIZES[size]}"`);
	}
});
