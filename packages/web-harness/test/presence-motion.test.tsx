import { createElement } from "react";
import type * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Presence } from "../src/client/Motion.tsx";

const hooks = vi.hoisted(() => ({
	refs: [] as { current: unknown }[],
	refIndex: 0,
	present: undefined as boolean | undefined,
	effects: [] as (() => void | (() => void))[],
}));
vi.mock("react", async () => ({
	...(await vi.importActual<typeof React>("react")),
	useRef: (value: unknown) => hooks.refs[hooks.refIndex++] ??= { current: value },
	useState: (value: boolean) => [hooks.present ??= value, (next: boolean) => { hooks.present = next; }],
	useCallback: (callback: unknown) => callback,
	useLayoutEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));

class FadeAnimation {
	progress = 0;
	playState = "running";
	effect = { getComputedTiming: () => ({ progress: this.progress }) };
	finished = new Promise<void>(() => {});
	cancel = vi.fn(() => { this.playState = "idle"; });
	frames: Keyframe[];
	constructor(frames: Keyframe[]) { this.frames = frames; }
}
class FadeElement {
	inert = false;
	animationName = "none";
	style = { position: "", left: "", top: "", width: "", height: "" };
	animations: FadeAnimation[] = [];
	computed() {
		const style = { display: "block", position: "static", animationName: this.animationName, opacity: "1", height: "80px", width: "100px", marginTop: "8px", marginBottom: "8px", paddingTop: "4px", paddingBottom: "4px", marginLeft: "6px", marginRight: "6px", paddingLeft: "2px", paddingRight: "2px" };
		for (const animation of this.animations) {
			if (animation.playState === "idle") continue;
			for (const name of ["opacity", "height", "width", "marginTop", "marginBottom", "paddingTop", "paddingBottom", "marginLeft", "marginRight", "paddingLeft", "paddingRight"] as const) {
				const from = animation.frames[0][name];
				const to = animation.frames[1][name];
				if (from === undefined || to === undefined) continue;
				const value = Number.parseFloat(String(from)) + (Number.parseFloat(String(to)) - Number.parseFloat(String(from))) * animation.progress;
				style[name] = `${value}${name === "opacity" ? "" : "px"}`;
			}
		}
		return style;
	}
	get offsetHeight() { return Number.parseFloat(this.computed().height); }
	get offsetWidth() { return Number.parseFloat(this.computed().width); }
	getClientRects() { return [{}]; }
	getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: this.offsetHeight }; }
	animate(frames: Keyframe[]) { const animation = new FadeAnimation(frames); this.animations.push(animation); return animation; }
}
let cleanups: (() => void)[] = [];
function render(element: FadeElement, show: boolean, collapse = false, axis: "height" | "width" = "height") {
	hooks.refIndex = 0;
	hooks.effects = [];
	let result = Presence({ show, collapse, axis, children: createElement("div") });
	if (!result && show) {
		hooks.refIndex = 0; hooks.effects = [];
		result = Presence({ show, collapse, axis, children: createElement("div") });
	}
	cleanups.forEach((cleanup) => cleanup());
	if (result && typeof result.props.ref === "function") result.props.ref(element as unknown as Element);
	cleanups = hooks.effects.map((effect) => effect()).filter((cleanup): cleanup is () => void => !!cleanup);
}
beforeEach(() => {
	hooks.refs = [];
	hooks.present = undefined;
	cleanups = [];
	vi.stubGlobal("HTMLElement", FadeElement);
	vi.stubGlobal("HTMLDialogElement", class {});
	vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 1000, matchMedia: () => ({ matches: false }) });
	vi.stubGlobal("getComputedStyle", (element: FadeElement) => element.computed());
});
afterEach(() => { cleanups.forEach((cleanup) => cleanup()); vi.unstubAllGlobals(); });

it("reverses an unfinished entrance from the visible opacity", () => {
	const element = new FadeElement();
	render(element, true);
	element.animations[0].progress = 0.4;
	render(element, false);
	expect(element.animations[1].frames[0].opacity).toBe("0.4");
});

it("reopens a collapsing section from its visible height and opacity", () => {
	const element = new FadeElement();
	render(element, true, true);
	element.animations[0].progress = 1;
	element.animations[0].playState = "finished";
	render(element, false, true);
	element.animations[1].progress = 0.5;
	render(element, true, true);
	expect(element.animations[2].frames[0]).toMatchObject({ opacity: "0.5", height: "40px", marginTop: "4px", paddingTop: "2px" });
	expect(element.animations[2].frames[1]).toMatchObject({ opacity: 1, height: "80px", marginTop: "8px", paddingTop: "4px" });
});

it("expands a newly appearing notice from zero without collapsing initial layout", () => {
	const element = new FadeElement();
	element.animationName = "status-enter";
	render(element, false, true);
	render(element, true, true);
	expect(element.animations[0].frames[0]).toMatchObject({ height: "0px", paddingTop: "0px", marginTop: "0px" });
	expect(element.animations[0].frames[0].opacity).toBeUndefined();
	expect(element.animations[0].frames[1]).toMatchObject({ height: "80px", paddingTop: "4px" });
});

it("expands and reverses toolbar items across their width", () => {
	const element = new FadeElement();
	render(element, false, true, "width");
	render(element, true, true, "width");
	expect(element.animations[0].frames[0]).toMatchObject({ width: "0px", marginLeft: "0px" });
	element.animations[0].progress = 0.4;
	render(element, false, true, "width");
	expect(element.animations[1].frames[0]).toMatchObject({ width: "40px", opacity: "0.4" });
	expect(element.animations[1].frames[1].width).toBe("0px");
});
