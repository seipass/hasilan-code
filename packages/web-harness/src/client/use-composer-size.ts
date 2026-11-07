import { type RefObject, useLayoutEffect, useRef } from "react";
import { animationsEnabled } from "./motion-policy.ts";

export function useComposerSize(ref: RefObject<HTMLTextAreaElement | null>, text: string) {
	const motion = useRef<Animation | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Text edits must remeasure wrapping even when the element and its width are unchanged.
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		element.style.scrollbarGutter = "stable";
		element.style.overflowY = "auto";
		let width = element.clientWidth;
		const resize = (animate: boolean) => {
			const initialized = element.style.height !== "";
			const before = element.getBoundingClientRect().height;
			motion.current?.cancel();
			element.style.height = "auto";
			const height = Math.max(48, Math.min(element.scrollHeight, 220));
			element.style.height = `${height}px`;
			if (
				animate &&
				initialized &&
				before !== height &&
				!(!animationsEnabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
			) {
				const animation = element.animate([{ height: `${before}px` }, { height: `${height}px` }], {
					duration: 180,
					easing: "cubic-bezier(.2, .75, .25, 1)",
				});
				motion.current = animation;
			}
		};
		resize(true);
		const observer = new ResizeObserver(() => {
			if (element.clientWidth === width) return;
			width = element.clientWidth;
			resize(false);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, text]);
	useLayoutEffect(() => () => motion.current?.cancel(), []);
}
