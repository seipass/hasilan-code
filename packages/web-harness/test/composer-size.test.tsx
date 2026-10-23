import type * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatPane } from "../src/client/ChatPane.tsx";

const hooks = vi.hoisted(() => ({ effects: [] as (() => void)[], refs: [] as { current: unknown }[], index: 0, text: "" }));
vi.mock("react", async () => ({
	...await vi.importActual<typeof React>("react"),
	useId: () => "composer",
	useState: (initial: unknown) => [typeof initial === "string" ? hooks.text : typeof initial === "function" ? initial() : initial, vi.fn()],
	useRef: (initial: unknown) => hooks.refs[hooks.index++] ?? (hooks.refs[hooks.index - 1] = { current: initial }),
	useLayoutEffect: (effect: () => void) => hooks.effects.push(effect),
	useEffect: () => {},
}));

afterEach(() => { vi.unstubAllGlobals(); hooks.refs = []; hooks.effects = []; hooks.index = 0; hooks.text = ""; });

it("sets the initial composer height immediately and animates later edits", () => {
	vi.stubGlobal("localStorage", { getItem: () => null });
	vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
	const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: undefined }));
	const input = { style: { height: "", overflowY: "" }, scrollHeight: 24, getBoundingClientRect: () => ({ height: 71.4 }), animate };
	function render() {
		hooks.index = 0;
		ChatPane({ draftKey: "new:workspace", connected: true, modelControl: null, goalControl: null, onDraftInserted: vi.fn(), onSend: vi.fn(), onPendingInputAction: vi.fn(), onFile: vi.fn(), onStop: vi.fn(), onParent: vi.fn(), onModelSelect: vi.fn(), onProviderSettings: vi.fn() });
		hooks.refs[0].current = input;
		for (const effect of hooks.effects.splice(0)) effect();
	}
	render();
	expect(input.style.height).toBe("70px");
	expect(animate).not.toHaveBeenCalled();
	hooks.text = "multiple\nlines\nof\ntext";
	input.scrollHeight = 96;
	render();
	expect(animate).toHaveBeenCalledOnce();
	expect(input.style.height).toBe("96px");
});
