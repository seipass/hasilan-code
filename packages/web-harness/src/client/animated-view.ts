import { type SetStateAction, useCallback, useEffect, useRef, useState } from "react";

export interface AnimatedView {
	x: number;
	y: number;
	zoom: number;
}

/** Commands ease to their target; direct gestures cancel the tween and use the visible position. */
export function useAnimatedView(initial: AnimatedView) {
	const [view, update] = useState(initial);
	const current = useRef(view);
	const frame = useRef(0);
	const setView = useCallback((change: SetStateAction<AnimatedView>) => {
		cancelAnimationFrame(frame.current);
		current.current = typeof change === "function" ? change(current.current) : change;
		update(current.current);
	}, []);
	const animateView = useCallback(
		(change: SetStateAction<AnimatedView>) => {
			cancelAnimationFrame(frame.current);
			const before = current.current;
			const target = typeof change === "function" ? change(before) : change;
			if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
				setView(target);
				return;
			}
			const start = performance.now();
			const tick = (now: number) => {
				const progress = Math.min(1, Math.max(0, (now - start) / 220));
				const eased = 1 - (1 - progress) ** 3;
				current.current = {
					x: before.x + (target.x - before.x) * eased,
					y: before.y + (target.y - before.y) * eased,
					zoom: before.zoom + (target.zoom - before.zoom) * eased,
				};
				update(current.current);
				if (progress < 1) frame.current = requestAnimationFrame(tick);
			};
			frame.current = requestAnimationFrame(tick);
		},
		[setView],
	);
	useEffect(() => () => cancelAnimationFrame(frame.current), []);
	return { view, setView, animateView, viewRef: current };
}
