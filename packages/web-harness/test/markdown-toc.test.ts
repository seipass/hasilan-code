import { describe, expect, it } from "vitest";
import { activeHeadingIndex } from "../src/client/files/MarkdownToc.tsx";
import { formatShortcut } from "../src/client/Tooltip.tsx";

describe("markdown toc active heading", () => {
	it("selects the last heading scrolled past the reading threshold", () => {
		expect(activeHeadingIndex([10, 120, 260], 64)).toBe(0);
		expect(activeHeadingIndex([-120, 32, 240], 64)).toBe(1);
		expect(activeHeadingIndex([-300, -100, 40], 64)).toBe(2);
		expect(activeHeadingIndex([120, 240], 64)).toBe(0);
	});
});

describe("tooltip shortcut formatting", () => {
	it("splits chord tokens and normalizes key labels", () => {
		expect(formatShortcut("shift+enter")).toEqual([expect.stringMatching(/^(Shift|⇧)$/), "↵"]);
		expect(formatShortcut("mod+f")).toEqual([expect.stringMatching(/^(Ctrl|⌘)$/), "F"]);
		expect(formatShortcut("esc")).toEqual(["Esc"]);
	});
});
