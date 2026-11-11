import { type RefObject, useLayoutEffect } from "react";

export function useComposerSize(ref: RefObject<HTMLTextAreaElement | null>, text: string, home = false) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: Text edits must remeasure wrapping even when the element and its width are unchanged.
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		element.style.scrollbarGutter = "stable";
		element.style.overflowY = "auto";
		let width = element.clientWidth;
		const resize = () => {
			element.style.height = "auto";
			const height = Math.max(32, Math.min(element.scrollHeight, 220));
			element.style.height = `${height}px`;
		};
		resize();
		const observer = new ResizeObserver(() => {
			if (element.clientWidth === width) return;
			width = element.clientWidth;
			resize();
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, text, home]);
}
