import { afterEach, describe, expect, it, vi } from "vitest";
import { observeConversation } from "../src/client/conversation-resize.ts";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
	let callback: ResizeObserverCallback;
	class Observer {
		constructor(listener: ResizeObserverCallback) {
			callback = listener;
		}
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", Observer);
	const viewport = { clientWidth: 900, dataset: {} };
	const heights = new Map(Array.from({ length: 10000 }, (_, index) => [`m${index}`, 40 + (index % 5) * 20]));
	const measured = vi.fn();
	const observer = observeConversation(viewport as unknown as HTMLElement, heights, measured, () => {});
	return {
		viewport,
		heights,
		measured,
		deliver(entries: ResizeObserverEntry[]) {
			callback(entries, observer);
		},
	};
}

function row(id: string, height: number) {
	const readLayout = vi.fn(() => ({ height }));
	return {
		readLayout,
		entry: {
			target: { dataset: { messageId: id }, getBoundingClientRect: readLayout },
			borderBoxSize: [{ blockSize: height }],
		} as unknown as ResizeObserverEntry,
	};
}

describe("conversation resizing", () => {
	it("keeps offscreen measurements and their spacer stable throughout sidebar motion", () => {
		const state = fixture();
		const initial = [...state.heights].slice(0, 9994);
		const prefix = initial.reduce((sum, [, height]) => sum + height, 0);
		for (let frame = 0; frame < 20; frame++) {
			state.viewport.clientWidth = 900 - frame * 13;
			state.deliver(Array.from({ length: 6 }, (_, index) => row(`m${9994 + index}`, 60 + frame * 2).entry));
			expect(initial.every(([id, height]) => state.heights.get(id) === height)).toBe(true);
			expect(initial.reduce((sum, [id]) => sum + (state.heights.get(id) ?? 220), 0)).toBe(prefix);
		}
		expect(state.heights.size).toBe(10000);
		expect(state.heights.get("m9999")).toBe(98);
	});
	it("uses the observer's measured size without forcing another layout read", () => {
		const state = fixture();
		const visible = row("m9999", 180);
		state.deliver([visible.entry]);
		expect(state.heights.get("m9999")).toBe(180);
		expect(visible.readLayout).not.toHaveBeenCalled();
	});
	it("does not rebuild offsets when only the container width changes", () => {
		const state = fixture();
		state.viewport.clientWidth = 640;
		state.deliver([{ target: state.viewport } as unknown as ResizeObserverEntry]);
		expect(state.measured).not.toHaveBeenCalled();
		expect(state.heights.size).toBe(10000);
	});
	it("ignores hidden rows and falls back to layout bounds when observer sizes are unavailable", () => {
		const state = fixture();
		const hidden = row("m9999", 0);
		state.deliver([hidden.entry]);
		expect(state.heights.get("m9999")).toBe(120);
		expect(state.measured).not.toHaveBeenCalled();
		const fallback = row("m9999", 180);
		state.deliver([{ target: fallback.entry.target } as ResizeObserverEntry]);
		expect(fallback.readLayout).toHaveBeenCalledOnce();
		expect(state.heights.get("m9999")).toBe(180);
	});
});
