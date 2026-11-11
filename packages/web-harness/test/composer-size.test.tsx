import type * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComposerSize } from "../src/client/use-composer-size.ts";

const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async () => ({
	...await vi.importActual<typeof React>("react"),
	useLayoutEffect: (effect: () => void) => hooks.effects.push(effect),
}));

let resize: () => void;
let cleanup: void | (() => void);
const input = {
	style: { height: "", overflowY: "", scrollbarGutter: "" }, clientWidth: 700, scrollHeight: 24, visibleHeight: 48,
	getBoundingClientRect: () => ({ height: input.visibleHeight }),
	animate: vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ cancel: vi.fn(), onfinish: undefined as undefined | (() => void) })),
};
const ref = { current: input as unknown as HTMLTextAreaElement };
function render(text = "") {
	hooks.effects = [];
	useComposerSize(ref, text);
	cleanup?.();
	cleanup = hooks.effects[0]();
}
beforeEach(() => {
	cleanup = undefined;
	input.style = { height: "", overflowY: "", scrollbarGutter: "" }; input.clientWidth = 700; input.scrollHeight = 24; input.visibleHeight = 48;
	input.animate.mockClear();
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: () => void) { resize = callback; }
		observe() {}
		disconnect() {}
	});
});
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });

it("resizes immediately without animation on edits", () => {
	render();
	expect(input.style.height).toBe("32px");
	expect(input.animate).not.toHaveBeenCalled();
	input.scrollHeight = 96;
	render("multiple\nlines");
	expect(input.animate).not.toHaveBeenCalled();
	expect(input.style.height).toBe("96px");
});

it("keeps the scroll area stable while growing beyond the height limit", () => {
	render();
	input.scrollHeight = 280;
	render("long text");
	expect(input.style.overflowY).toBe("auto");
	expect(input.style.scrollbarGutter).toBe("stable");
});

it("recalculates wrapping during width changes without delaying direct resizing", () => {
	render(); input.clientWidth = 270; input.scrollHeight = 119; resize();
	expect(input.style.height).toBe("119px");
	expect(input.style.overflowY).toBe("auto");
	expect(input.animate).not.toHaveBeenCalled();
	input.clientWidth = 220; input.scrollHeight = 280; resize();
	expect(input.style.height).toBe("220px");
	expect(input.style.overflowY).toBe("auto");
});

it("ignores height-only observations", () => {
	render(); input.scrollHeight = 96; render("more text");
	input.scrollHeight = 140; resize();
	expect(input.style.height).toBe("96px");
	expect(input.animate).not.toHaveBeenCalled();
});
