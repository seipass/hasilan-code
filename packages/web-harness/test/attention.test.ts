import { expect, it } from "vitest";
import { attentionTitle } from "../src/client/attention.ts";

// The document title is the only completion signal while the tab is in the background.
it("prefixes the conversation title with running and unread counts", () => {
	expect(attentionTitle(0, 0, "作業中の会話")).toBe("作業中の会話");
	expect(attentionTitle(2, 0, "作業中の会話")).toBe("(2) 実行中 · 作業中の会話");
	expect(attentionTitle(0, 1, "作業中の会話")).toBe("(1) 完了 · 作業中の会話");
	expect(attentionTitle(0, 0, "  ")).toBe("Hasilan Code");
	expect(attentionTitle(0, 0, undefined)).toBe("Hasilan Code");
});
