import type * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mediaReady, useChildrenMotion, useLayoutMotion } from "../src/client/Motion.tsx";

const hooks = vi.hoisted(() => ({
	reference: undefined as { current: unknown } | undefined,
	effect: undefined as (() => undefined | (() => void)) | undefined,
}));
vi.mock("react", async () => ({
	...(await vi.importActual<typeof React>("react")),
	useRef: (value: unknown) => {
		hooks.reference ??= { current: value };
		return hooks.reference;
	},
	useLayoutEffect: (effect: () => undefined | (() => void)) => {
		hooks.effect = effect;
	},
}));

class AnimationFixture {
	progress = 0;
	playState = "running";
	effect = { getComputedTiming: () => ({ progress: this.progress }) };
	cancel = vi.fn();
	finished = new Promise<void>(() => {});
}
class LayoutElement {
	offsetLeft = 0;
	offsetTop = 0;
	offsetWidth = 100;
	offsetHeight = 50;
	offsetParent = {};
	children: LayoutElement[] = [];
	opacity = "1";
	animations: { frames: Keyframe[]; animation: AnimationFixture }[] = [];
	getClientRects() {
		return [{}];
	}
	animate(frames: Keyframe[]) {
		const animation = new AnimationFixture();
		this.animations.push({ frames, animation });
		return animation;
	}
}
let cleanup: undefined | (() => void);
function render(element: LayoutElement, mode: "position" | "height" | "children" | "width", version: number) {
	const ref = { current: element as unknown as HTMLElement };
	if (mode === "children") {
		// biome-ignore lint/correctness/useHookAtTopLevel: React hooks are mocked to capture an isolated effect for this test.
		useChildrenMotion(ref, version);
	} else {
		// biome-ignore lint/correctness/useHookAtTopLevel: React hooks are mocked to capture an isolated effect for this test.
		useLayoutMotion(ref, version, true, mode === "height", mode === "width");
	}
	cleanup?.();
	cleanup = hooks.effect?.();
}
beforeEach(() => {
	hooks.reference = undefined;
	hooks.effect = undefined;
	cleanup = undefined;
	vi.stubGlobal("HTMLElement", LayoutElement);
	vi.stubGlobal("HTMLDialogElement", class {});
	vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("getComputedStyle", (element: LayoutElement) => ({ opacity: element.opacity }));
});
afterEach(() => {
	cleanup?.();
	vi.unstubAllGlobals();
});

it("continues a moving row from its visible position when its destination changes", () => {
	const element = new LayoutElement();
	render(element, "position", 0);
	element.offsetLeft = 100;
	render(element, "position", 1);
	element.animations[0].animation.progress = 0.5;
	element.offsetLeft = 200;
	render(element, "position", 2);
	expect(element.animations[1].frames[0].translate).toBe("-150px 0px");
});
it("does not jump to the destination when an unrelated list update interrupts movement", () => {
	const element = new LayoutElement();
	render(element, "position", 0);
	element.offsetLeft = 100;
	render(element, "position", 1);
	element.animations[0].animation.progress = 0.5;
	render(element, "position", 2);
	expect(element.animations).toHaveLength(2);
	expect(element.animations[1].frames[0].translate).toBe("-50px 0px");
});
it("resumes an interrupted height change from the currently displayed height", () => {
	const element = new LayoutElement();
	render(element, "height", 0);
	element.offsetHeight = 150;
	render(element, "height", 1);
	element.animations[0].animation.progress = 0.25;
	element.offsetHeight = 200;
	render(element, "height", 2);
	expect(element.animations[1].frames[0].height).toBe("75px");
});
it("preserves visible position and dimensions when a split layout animation is interrupted", () => {
	const root = new LayoutElement();
	const pane = new LayoutElement();
	root.children = [pane];
	render(root, "children", 0);
	pane.offsetLeft = 100;
	pane.offsetWidth = 200;
	render(root, "children", 1);
	pane.animations[0].animation.progress = 0.5;
	pane.offsetLeft = 200;
	pane.offsetWidth = 300;
	render(root, "children", 2);
	expect(pane.animations[1].frames[0]).toMatchObject({ translate: "-150px 0px", scale: "0.5 1" });
});

it("continues a changing screenshot fade without stacking animations or resetting its opacity", () => {
	const element = new LayoutElement();
	mediaReady(element as unknown as Element);
	element.opacity = "0.6";
	mediaReady(element as unknown as Element);
	expect(element.animations[0].animation.cancel).toHaveBeenCalledOnce();
	expect(element.animations[1].frames[0].opacity).toBe("0.6");
});

it("keeps a changing tab width continuous when its title changes again", () => {
	const element = new LayoutElement();
	render(element, "width", 0);
	element.offsetWidth = 200;
	render(element, "width", 1);
	expect(element.animations[0].frames[0].scale).toBe("0.5 1");
	element.animations[0].animation.progress = 0.5;
	element.offsetWidth = 300;
	render(element, "width", 2);
	expect(element.animations[1].frames[0].scale).toBe("0.5 1");
});
