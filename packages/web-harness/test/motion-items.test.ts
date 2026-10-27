import { describe, expect, it } from "vitest";
import { type MotionEntry, motionEntries } from "../src/client/motion-items.ts";

const key = (value: { id: string }) => value.id;
const a = { id: "a" };
const b = { id: "b" };
const c = { id: "c" };
const initial: MotionEntry<{ id: string }>[] = [a, b, c].map((value) => ({ key: value.id, value, visible: true }));

describe("motion list retention", () => {
	it("keeps removed rows until exit completes while preserving live order", () => {
		const next = motionEntries(initial, [c, a], key);
		expect(next.map((item) => [item.key, item.visible])).toEqual([
			["c", true],
			["b", false],
			["a", true],
		]);
		expect(next.filter((item) => item.visible).map((item) => item.value)).toEqual([c, a]);
	});
	it("reuses an exiting key with its latest data when it returns", () => {
		const exiting = motionEntries(initial, [a, c], key);
		const replacement = { id: "b", title: "Updated" };
		const returned = motionEntries(exiting, [replacement, a, c], key);
		expect(returned.map((item) => item.key)).toEqual(["b", "a", "c"]);
		expect(returned[0]).toEqual({ key: "b", value: replacement, visible: true });
	});
	it("does not restart exits or change identity on unrelated rerenders", () => {
		const exiting = motionEntries(initial, [a, c], key);
		expect(motionEntries(exiting, [a, c], key)).toBe(exiting);
		expect(motionEntries(initial, [a, b, c], key)).toBe(initial);
	});
	it("retains all removed rows through empty results, then accepts fresh input", () => {
		const empty = motionEntries(initial, [], key);
		expect(empty.every((item) => !item.visible)).toBe(true);
		expect(motionEntries(empty, [], key)).toBe(empty);
		expect(motionEntries([], [c], key)).toEqual([{ key: "c", value: c, visible: true }]);
	});
});
