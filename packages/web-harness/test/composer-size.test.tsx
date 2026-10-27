import type * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComposerSize } from "../src/client/use-composer-size.ts";

const hooks = vi.hoisted(() => ({ ref: { current: undefined as unknown }, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async () => ({
	...await vi.importActual<typeof React>("react"),
	useRef: () => hooks.ref,
	useLayoutEffect: (effect: () => void) => hooks.effects.push(effect),
}));

let resize: () => void;
let cleanup: void | (() => void);
let unmount: void | (() => void);
let reduced = false;
const input = {
	style: { height: "", overflowY: "" }, clientWidth: 700, scrollHeight: 24, visibleHeight: 48,
	getBoundingClientRect: () => ({ height: input.visibleHeight }),
	animate: vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ cancel: vi.fn(), onfinish: undefined as undefined | (() => void) })),
};
const ref = { current: input as unknown as HTMLTextAreaElement };
function render(text = "") {
	hooks.effects = [];
	useComposerSize(ref, text);
	cleanup?.();
	cleanup = hooks.effects[0]();
	unmount = hooks.effects[1]();
}
beforeEach(() => {
	cleanup = undefined; unmount = undefined; reduced = false; hooks.ref.current = undefined;
	input.style = { height: "", overflowY: "" }; input.clientWidth = 700; input.scrollHeight = 24; input.visibleHeight = 48;
	input.animate.mockClear();
	vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: () => void) { resize = callback; }
		observe() {}
		disconnect() {}
	});
});
afterEach(() => { cleanup?.(); unmount?.(); vi.unstubAllGlobals(); });

it("sets the initial composer height immediately and animates later edits", () => {
	render();
	expect(input.style.height).toBe("48px");
	expect(input.animate).not.toHaveBeenCalled();
	input.scrollHeight = 96;
	render("multiple\nlines");
	expect(input.animate).toHaveBeenCalledOnce();
	expect(input.style.height).toBe("96px");
});

it("recalculates wrapping during width changes without delaying direct resizing", () => {
	render(); input.clientWidth = 270; input.scrollHeight = 119; resize();
	expect(input.style.height).toBe("119px");
	expect(input.style.overflowY).toBe("hidden");
	expect(input.animate).not.toHaveBeenCalled();
	input.clientWidth = 220; input.scrollHeight = 280; resize();
	expect(input.style.height).toBe("220px");
	expect(input.style.overflowY).toBe("auto");
});

it("ignores its own height observations and resumes fast edits from the visible height", () => {
	render(); input.scrollHeight = 96; render("more text");
	const previous = input.animate.mock.results[0].value;
	resize();
	expect(previous.cancel).not.toHaveBeenCalled();
	input.visibleHeight = 66; input.scrollHeight = 140; render("even more text");
	expect(previous.cancel).toHaveBeenCalledOnce();
	expect(input.animate.mock.calls[1][0]).toEqual([{ height: "66px" }, { height: "140px" }]);
});

it("honors reduced motion and releases an active animation on unmount", () => {
	render(); input.scrollHeight = 96; render("text");
	const animation = input.animate.mock.results[0].value;
	unmount?.();
	expect(animation.cancel).toHaveBeenCalledOnce();
	reduced = true; input.scrollHeight = 120; render("new text");
	expect(input.animate).toHaveBeenCalledOnce();
	expect(input.style.height).toBe("120px");
});
