import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnimatedView } from "../src/client/animated-view.ts";

const hooks = vi.hoisted(() => ({ update: vi.fn(), cleanup: undefined as (() => void) | undefined }));
vi.mock("react", async () => ({
	...(await vi.importActual<typeof React>("react")),
	useState: (initial: unknown) => [initial, hooks.update],
	useRef: (current: unknown) => ({ current }),
	useCallback: (callback: unknown) => callback,
	useEffect: (effect: () => () => void) => {
		hooks.cleanup = effect();
	},
}));

const frames = new Map<number, FrameRequestCallback>();
let sequence = 0;
let reduced = false;
beforeEach(() => {
	sequence = 0;
	reduced = false;
	frames.clear();
	hooks.update.mockClear();
	vi.spyOn(performance, "now").mockReturnValue(0);
	vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++sequence, callback);
		return sequence;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
	hooks.cleanup?.();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("animated graph commands", () => {
	it("interpolates commands and lets direct gestures cancel them at the visible position", () => {
		const motion = useAnimatedView({ x: 0, y: 0, zoom: 1 });
		motion.animateView({ x: 100, y: 80, zoom: 2 });
		expect(motion.viewRef.current).toEqual({ x: 0, y: 0, zoom: 1 });
		const tick = frames.get(1)!;
		frames.delete(1);
		tick(110);
		expect(motion.viewRef.current).toEqual({ x: 87.5, y: 70, zoom: 1.875 });
		motion.setView((visible) => ({ ...visible, x: visible.x + 10 }));
		expect(frames.size).toBe(0);
		expect(motion.viewRef.current.x).toBe(97.5);
	});
	it("applies commands immediately when reduced motion is enabled", () => {
		reduced = true;
		const motion = useAnimatedView({ x: 0, y: 0, zoom: 1 });
		motion.animateView({ x: 100, y: 80, zoom: 2 });
		expect(motion.viewRef.current).toEqual({ x: 100, y: 80, zoom: 2 });
		expect(frames.size).toBe(0);
	});
	it("stops outstanding animation frames on unmount", () => {
		const motion = useAnimatedView({ x: 0, y: 0, zoom: 1 });
		motion.animateView({ x: 100, y: 80, zoom: 2 });
		expect(frames.size).toBe(1);
		hooks.cleanup?.();
		expect(frames.size).toBe(0);
	});
});
