import { expect, it } from "vitest";
import { discardDraft, getDraft, setDraft, subscribeDraft } from "../src/client/files/file-drafts.ts";

it("releases clean closed documents, while preserving unsaved text until save or explicit discard", () => {
	const key = "memory-fixture";
	const saved = { text: "saved", saved: "saved", revision: "r1", newline: "\n" as const };
	const first = subscribeDraft(key, () => {});
	const second = subscribeDraft(key, () => {});
	try {
		setDraft(key, saved);
		first();
		expect(getDraft(key)).toEqual(saved);
		second();
		expect(getDraft(key)).toBeUndefined();
		setDraft(key, { ...saved, text: "unsaved" });
		expect(getDraft(key)?.text).toBe("unsaved");
		// A save that completes after the tab closes must not recreate a clean orphan.
		setDraft(key, { ...saved, text: "unsaved", saved: "unsaved", revision: "r2" });
		expect(getDraft(key)).toBeUndefined();
	} finally {
		first();
		second();
		discardDraft(key);
	}
});
