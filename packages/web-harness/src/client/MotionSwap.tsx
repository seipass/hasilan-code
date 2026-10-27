import { type ReactNode, type RefObject, type TransitionEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MotionItems } from "./Motion.tsx";
import "./MotionSwap.css";

/** Measure natural content, so animating the wrapper cannot feed back into its measurement. */
export function useMeasuredSize(outer: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, axis: "height" | "width", enabled = true) {
	useLayoutEffect(() => {
		const element = outer.current;
		const inner = content.current;
		if (!element || !inner || !enabled) return;
		let target = inner.getBoundingClientRect()[axis];
		let start = target;
		let animation: Animation | undefined;
		const observer = new ResizeObserver(() => {
			const next = inner.getBoundingClientRect()[axis];
			if (next === target || !element.getClientRects().length) return;
			// Native accordions and child collapses already animate their own geometry.
			if (inner.getAnimations({ subtree: true }).some((motion) => motion.effect instanceof KeyframeEffect && motion.effect.getKeyframes().some((frame) => frame[axis] !== undefined))) {
				animation?.cancel();
				start = target = next;
				return;
			}
			const progress = animation?.effect?.getComputedTiming().progress ?? 1;
			const before = progress < 1 ? start + (target - start) * progress : target;
			animation?.cancel();
			start = before;
			target = next;
			if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) animation = element.animate([
				{ [axis]: `${before}px`, overflow: "clip" }, { [axis]: `${next}px`, overflow: "clip" },
			], { duration: 180, easing: "cubic-bezier(.2, .75, .25, 1)" });
		});
		observer.observe(inner);
		return () => { observer.disconnect(); animation?.cancel(); };
	}, [outer, content, axis, enabled]);
}

export function MotionSize({ children, className = "" }: { children: ReactNode; className?: string }) {
	const outer = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	useMeasuredSize(outer, content, "height");
	return <div ref={outer} className={`motion-size ${className}`}><div ref={content}>{children}</div></div>;
}

export function MotionLabel({ value }: { value: string | number }) {
	const outer = useRef<HTMLSpanElement>(null);
	const content = useRef<HTMLSpanElement>(null);
	useMeasuredSize(outer, content, "width");
	const text = String(value);
	return <span ref={outer} className="motion-label-swap"><span ref={content}><MotionItems items={[text]} itemKey={(item) => item} enabled={false}>{(item) => <span key={item}>{item}</span>}</MotionItems></span></span>;
}

/** Only one live page exists: keep the old page until the next one is ready, then fade out and in. */
export function MotionSwap({ identity, ready = true, enabled = true, children, className = "", animateHeight = false, inline = false }: {
	identity: string;
	ready?: boolean;
	enabled?: boolean;
	children: ReactNode;
	className?: string;
	animateHeight?: boolean;
	inline?: boolean;
}) {
	const [displayed, setDisplayed] = useState(identity);
	const [phase, setPhase] = useState<"stable" | "out" | "in">("stable");
	const shown = useRef({ identity, children });
	const latest = useRef({ identity, children, ready });
	latest.current = { identity, children, ready };
	if (ready && (displayed === identity || !enabled)) shown.current = { identity, children };
	const outer = useRef<HTMLElement>(null);
	const content = useRef<HTMLElement>(null);
	useMeasuredSize(outer, content, "height", animateHeight);
	useEffect(() => {
		if (!ready || displayed === identity) { setPhase("stable"); return; }
		if (!enabled || !shown.current.children || content.current && !content.current.getClientRects().length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			shown.current = { identity, children: latest.current.children };
			setDisplayed(identity);
			setPhase("stable");
		} else setPhase("out");
	}, [identity, ready, enabled, displayed]);
	const finish = (event: TransitionEvent<HTMLElement>) => {
		if (event.target !== event.currentTarget || event.propertyName !== "opacity") return;
		const next = latest.current;
		if (phase === "out" && next.ready) {
			shown.current = { identity: next.identity, children: next.children };
			setDisplayed(next.identity);
			setPhase("in");
		} else setPhase("stable");
	};
	const Tag = inline ? "span" : "div";
	return <Tag ref={(node) => { outer.current = node; }} className={`motion-swap${inline ? " motion-swap-inline" : ""} ${className}`} aria-busy={!ready} inert={!ready || displayed !== identity || phase === "out"}>
		<Tag ref={(node) => { content.current = node; }} className="motion-swap-content" data-phase={phase} data-empty={!shown.current.children || undefined} onTransitionEnd={finish} onTransitionCancel={(event) => {
			if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !event.currentTarget.getClientRects().length) finish(event);
		}}>{shown.current.children}</Tag>
	</Tag>;
}
