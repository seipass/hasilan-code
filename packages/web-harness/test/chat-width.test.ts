import { expect, it } from "vitest";
import { CHAT_GUTTER, CHAT_MAX_WIDTH, CHAT_MIN_WIDTH, clampChatWidth } from "../src/client/chat-width.ts";

// Regression: a width saved on a wide window was applied verbatim after the pane shrank, so the
// drag handle sat at the pane edge and the column could not be resized again.
it("clamps the saved width to the visible pane", () => {
	expect(clampChatWidth(3000, 1440)).toBe(1440 - CHAT_GUTTER);
	expect(clampChatWidth(3000, 666)).toBe(666 - CHAT_GUTTER);
	expect(clampChatWidth(600, 1440)).toBe(600);
	expect(clampChatWidth(600, 0)).toBe(600);
});

it("keeps a usable minimum on a narrow pane", () => {
	expect(clampChatWidth(3000, 320)).toBe(CHAT_MIN_WIDTH);
	expect(clampChatWidth(100, 1440)).toBe(CHAT_MIN_WIDTH);
	expect(clampChatWidth(Number.POSITIVE_INFINITY, 429)).toBe(429 - CHAT_GUTTER);
	// Below the gutter the minimum wins, since a 320px column needs ~376px of pane.
	expect(clampChatWidth(Number.POSITIVE_INFINITY, 300)).toBe(CHAT_MIN_WIDTH);
});

it("never exceeds the global maximum on a very wide window", () => {
	expect(clampChatWidth(9999, 5000)).toBe(CHAT_MAX_WIDTH);
});
