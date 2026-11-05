import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
const filePane = readFileSync(fileURLToPath(new URL("../src/client/files/FilePane.css", import.meta.url)), "utf8");

function declarations(css: string, property: string): string[] {
	return [...css.matchAll(new RegExp(`${property}:s*([^;}]+)`, "g"))].map((match) => match[1].trim());
}

// Regression: the scale grew to 28 sizes and 7 weights, and h2 was heavier than h1.
it("keeps font weights to the three the bundled faces provide", () => {
	const weights = new Set(declarations(styles + filePane, "font-weight").flatMap((value) => value.split(/\s+/)));
	for (const weight of weights)
		expect(["400", "500", "600", "700", "800", "bolder", "lighter", "normal", "bold"]).toContain(weight);
	expect(weights.has("550")).toBe(false);
	expect(weights.has("650")).toBe(false);
	expect(weights.has("300")).toBe(false);
});

it("sizes prose from the shared scale instead of raw pixels", () => {
	expect(styles).toContain("font-size: var(--text-base);");
	expect(styles).toMatch(/\.message-content \{[\s\S]*?line-height: var\(--leading-prose\)/);
});

// A 744px column held ~49 Japanese characters; 48em fills it instead of leaving a wide gutter.
it("bounds the reading measure", () => {
	expect(styles).toContain("--measure-prose: 48em;");
	expect(styles).toMatch(/\.message-content \{[\s\S]*?max-width: var\(--measure-prose\)/);
});

// Japanese typesetting was limited to overflow-wrap, which splits Latin words mid-word.
it("applies Japanese line-breaking rules to prose", () => {
	expect(styles).toMatch(/\.message-content \{[\s\S]*?line-break: strict/);
	// Phrase-aware breaking left wide gaps at line ends; lines must reach the measure.
	expect(styles).toMatch(/\.message-content \{[\s\S]*?word-break: normal/);
	expect(styles).toMatch(/\.message-content \{[\s\S]*?text-wrap: pretty/);
});

// Code used 12/12.5/13px and three leadings across surfaces.
it("uses one code size and leading", () => {
	expect(styles).toContain("--text-code:");
	expect(styles).toContain("--leading-code:");
	expect(declarations(styles, "line-height")).not.toContain("1.6");
});

// Mobile inputs must stay at 16px or iOS zooms the page on focus.
it("keeps mobile inputs at 16px", () => {
	expect(styles).toMatch(/@media \(max-width: 900px\) \{[\s\S]*?\.composer textarea \{ font-size: var\(--text-lg\)/);
});
