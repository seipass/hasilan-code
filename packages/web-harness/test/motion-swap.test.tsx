import { createElement, type ReactElement, type TransitionEvent } from "react";
import type * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MotionSwap, useMeasuredSize } from "../src/client/MotionSwap.tsx";

const hooks = vi.hoisted(() => ({
	refs: [] as { current: unknown }[], states: [] as unknown[], refIndex: 0, stateIndex: 0,
	effects: [] as (() => void)[], layout: undefined as undefined | (() => void | (() => void)),
}));
vi.mock("react", async () => ({
	...await vi.importActual<typeof React>("react"),
	useRef: (value: unknown) => hooks.refs[hooks.refIndex++] ??= { current: value },
	useState: (value: unknown) => { const index = hooks.stateIndex++; if (hooks.states.length <= index) hooks.states[index] = value; return [hooks.states[index], (next: unknown) => { hooks.states[index] = next; }]; },
	useEffect: (effect: () => void) => hooks.effects.push(effect),
	useLayoutEffect: (effect: () => void | (() => void)) => { hooks.layout = effect; },
}));

let reduced = false;
function render(identity: string, ready = true, enabled = true) {
	hooks.refIndex = 0; hooks.stateIndex = 0; hooks.effects = [];
	const result = MotionSwap({ identity, ready, enabled, children: createElement("textarea", { key: identity, id: "message" }) });
	for (const effect of hooks.effects) effect();
	return result;
}
function body(result: ReturnType<typeof render>) {
	return result.props.children as ReactElement<{ children: ReactElement; "data-phase": string; onTransitionEnd: (event: TransitionEvent) => void; onTransitionCancel: (event: TransitionEvent) => void }>;
}
function finish(result: ReturnType<typeof render>) {
	const node = {};
	body(result).props.onTransitionEnd({ target: node, currentTarget: node, propertyName: "opacity" } as unknown as TransitionEvent);
}
beforeEach(() => {
	hooks.refs = []; hooks.states = []; hooks.refIndex = 0; hooks.stateIndex = 0; hooks.layout = undefined; reduced = false;
	vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps exactly one old page until loading and its exit finish", () => {
	render("old");
	let result = render("new", false);
	expect(body(result).props.children.key).toBe("old");
	expect(result.props.inert).toBe(true);
	result = render("new");
	result = render("new");
	expect(body(result).props["data-phase"]).toBe("out");
	expect(body(result).props.children.key).toBe("old");
	finish(result);
	result = render("new");
	expect(body(result).props.children.key).toBe("new");
	expect(result.props.inert).toBe(false);
});

it("uses the latest destination during rapid switches and can return to the old page", () => {
	render("old"); render("first"); render("second");
	let result = render("second");
	finish(result);
	result = render("second");
	expect(body(result).props.children.key).toBe("second");
	render("other"); render("second");
	result = render("second");
	expect(body(result).props["data-phase"]).toBe("stable");
	expect(body(result).props.children.key).toBe("second");
});

it("does not require a transition event for reduced motion or direct manipulation", () => {
	render("old"); reduced = true; render("new");
	expect(body(render("new")).props.children.key).toBe("new");
	reduced = false;
	expect(body(render("dragged", true, false)).props.children.key).toBe("dragged");
});

it("does not skip the old page exit when reversing an unfinished entrance", () => {
	render("old"); render("next");
	const result = render("next");
	const node = { getClientRects: () => [{}] };
	body(result).props.onTransitionCancel({ target: node, currentTarget: node, propertyName: "opacity" } as unknown as TransitionEvent);
	expect(body(render("next")).props.children.key).toBe("old");
	reduced = true;
	body(result).props.onTransitionCancel({ target: node, currentTarget: node, propertyName: "opacity" } as unknown as TransitionEvent);
	expect(body(render("next")).props.children.key).toBe("next");
});

it("updates hidden tab content immediately without waiting for an event that cannot fire", () => {
	render("old");
	hooks.refs[3].current = { getClientRects: () => [] };
	render("new");
	expect(body(render("new")).props.children.key).toBe("new");
});

it("measures intrinsic content and resumes a size change from the visible interpolation", () => {
	let resize = () => {};
	const animations: { frames: Keyframe[]; progress: number; cancel: ReturnType<typeof vi.fn> }[] = [];
	const outer = {
		getClientRects: () => [{}],
		animate: (frames: Keyframe[]) => {
			const item = { frames, progress: 0, cancel: vi.fn() }; animations.push(item);
			return { cancel: item.cancel, effect: { getComputedTiming: () => ({ progress: item.progress }) } };
		},
	};
	const inner = { offsetWidth: 200.25, offsetHeight: 50, getBoundingClientRect: () => ({ width: inner.offsetWidth, height: inner.offsetHeight }), getAnimations: () => [] };
	vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
	useMeasuredSize({ current: outer as unknown as HTMLElement }, { current: inner as unknown as HTMLElement }, "width");
	const cleanup = hooks.layout?.();
	inner.offsetWidth = 400.25; resize();
	animations[0].progress = 0.5;
	inner.offsetWidth = 500; resize();
	expect(animations[1].frames[0].width).toBe("300.25px");
	expect(animations[0].cancel).toHaveBeenCalledOnce();
	resize();
	expect(animations).toHaveLength(2);
	cleanup?.();
	expect(animations[1].cancel).toHaveBeenCalledOnce();
});

it("lets an accordion drive its own height instead of stacking a delayed wrapper animation", () => {
	let resize = () => {};
	class Effect { getKeyframes() { return [{ height: "0px" }, { height: "100px" }]; } }
	vi.stubGlobal("KeyframeEffect", Effect);
	const outer = { getClientRects: () => [{}], animate: vi.fn() };
	let height = 0;
	const inner = { getBoundingClientRect: () => ({ height }), getAnimations: () => [{ effect: new Effect() }] };
	vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
	useMeasuredSize({ current: outer as unknown as HTMLElement }, { current: inner as unknown as HTMLElement }, "height");
	const cleanup = hooks.layout?.();
	height = 40; resize(); height = 80; resize(); height = 100; resize();
	expect(outer.animate).not.toHaveBeenCalled();
	cleanup?.();
});
