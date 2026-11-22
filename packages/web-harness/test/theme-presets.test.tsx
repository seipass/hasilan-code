import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Content } from "../src/client/Content.tsx";
import { BUILTIN_THEME_PRESETS, readAppearance } from "../src/client/ThemeAppearance.tsx";
import { standardTheme } from "../src/shared/plugin-profile.ts";

describe("Desktop Antigravity Onyx theme & presets", () => {
	it("uses Desktop Antigravity Onyx (#070708 / #2f71e3) as standardTheme and keeps Classic Monochrome (#141414) as a preset", () => {
		expect(standardTheme.dark.background).toBe("#070708");
		expect(standardTheme.dark.foreground).toBe("#ffffff");
		expect(standardTheme.dark.accent).toBe("#2f71e3");
		expect(standardTheme.light.background).toBe("#ffffff");
		expect(standardTheme.light.foreground).toBe("#0a0a0c");
		expect(standardTheme.light.accent).toBe("#2f75c3");

		const monochrome = BUILTIN_THEME_PRESETS.find((preset) => preset.id === "theme-classic-monochrome");
		expect(monochrome).toBeDefined();
		expect(monochrome?.dark.background).toBe("#141414");
	});

	it("migrates unmodified legacy #141414 stored appearance to Desktop Antigravity Onyx while keeping explicit presets", () => {
		const migrated = readAppearance(
			JSON.stringify({
				mode: "dark",
				dark: { background: "#141414", foreground: "#e8e8e8", accent: "#e8e8e8", contrast: 35 },
				light: { background: "#ffffff", foreground: "#202124", accent: "#2563eb", contrast: 35 },
				codeTheme: "auto",
				contentFont: "",
				codeFont: "",
				uiSize: 13,
				codeSize: 13,
				translucentSidebar: false,
			}),
		);
		expect(migrated.dark.background).toBe("#070708");
		expect(migrated.dark.accent).toBe("#2f71e3");
		expect(migrated.light.accent).toBe("#2f75c3");

		const kept = readAppearance(
			JSON.stringify({
				mode: "dark",
				themeId: "theme-classic-monochrome",
				dark: { background: "#141414", foreground: "#e8e8e8", accent: "#e8e8e8", contrast: 35 },
				light: { background: "#ffffff", foreground: "#202124", accent: "#2563eb", contrast: 35 },
				codeTheme: "auto",
				contentFont: "",
				codeFont: "",
				uiSize: 13,
				codeSize: 13,
				translucentSidebar: false,
			}),
		);
		expect(kept.themeId).toBe("theme-classic-monochrome");
		expect(kept.dark.background).toBe("#141414");
	});

	it("renders fenced code blocks with language header and copy button", () => {
		const html = renderToStaticMarkup(<Content value={"```ts\nconst answer = 42;\n```"} onFile={() => {}} />);
		expect(html).toContain("code-block-frame");
		expect(html).toContain("code-block-header");
		expect(html).toContain("code-block-language");
		expect(html).toContain("code-block-copy");
		expect(html).toContain("const answer = 42;");
	});
});
