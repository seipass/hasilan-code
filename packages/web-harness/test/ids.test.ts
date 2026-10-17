import { describe, expect, it } from "vitest";
import { nextId } from "../src/shared/ids.ts";

describe("compact persisted identifiers", () => {
	it("allocates after the highest saved ID even when old UUIDs and reordered records coexist", () => {
		const records = [{ id: "n9" }, { id: "b58b0775-69c4-424f-b340-59352a856c58" }, { id: "n2" }, { id: "e42" }];
		const id = nextId("n", records, "id");
		expect(id).toBe("n10");
		records.push({ id });
		expect(nextId("n", records, "id")).toBe("n11");
		expect(nextId("e", records, "id")).toBe("e43");
	});
	it("refuses exhausted sequences instead of rounding into an existing ID", () => {
		expect(() => nextId("a", [{ agentId: `a${Number.MAX_SAFE_INTEGER}` }], "agentId")).toThrow(
			"ID sequence exhausted",
		);
	});
});
