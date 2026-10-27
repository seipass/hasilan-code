import { cloneElement, isValidElement, type ReactElement, type ReactNode, type Ref, type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { motionEntries, type MotionEntry } from "./motion-items.ts";
import "./Motion.css";

const ease = "cubic-bezier(.2, .75, .25, 1)";
const mediaAnimations = new WeakMap<Element, Animation>();

export function mediaReady(element: Element) {
	const previous = mediaAnimations.get(element);
	const opacity = previous && previous.playState !== "finished" ? getComputedStyle(element).opacity : .25;
	previous?.cancel();
	mediaAnimations.delete(element);
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	const animation = element.animate([{ opacity }, { opacity: 1 }], { duration: 160, easing: ease });
	mediaAnimations.set(element, animation);
	const clear = () => { if (mediaAnimations.get(element) === animation) mediaAnimations.delete(element); };
	void animation.finished.then(clear, clear);
}

export function useContentMotion(ref: RefObject<Element | null>, version: unknown) {
	const previous = useRef(version);
	useLayoutEffect(() => {
		if (previous.current !== version && ref.current) mediaReady(ref.current);
		previous.current = version;
	}, [ref, version]);
}

export function useLayoutMotion(ref: RefObject<Element | null>, version: unknown, enabled = true, size = false, resizeWidth = false) {
	const previous = useRef<{ parent: Element | null; x: number; y: number; width: number; height: number } | undefined>(undefined);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element || !(element instanceof HTMLElement) || !element.getClientRects().length) { previous.current = undefined; return; }
		const next = { parent: element.offsetParent, x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight };
		const before = previous.current;
		previous.current = next;
		if (!enabled || !before || before.parent !== next.parent || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const animations: Animation[] = [];
		if (size && before.height !== next.height) animations.push(element.animate([
			{ height: `${before.height}px`, overflow: "clip" }, { height: `${next.height}px`, overflow: "clip" },
		], { duration: 180, easing: ease }));
		if (!size && (before.x !== next.x || before.y !== next.y || resizeWidth && before.width !== next.width)) animations.push(element.animate([
			{ translate: `${before.x - next.x}px ${before.y - next.y}px`, ...(resizeWidth && next.width ? { scale: `${before.width / next.width} 1`, transformOrigin: "top left" } : {}) }, { translate: "0px 0px", ...(resizeWidth ? { scale: "1 1", transformOrigin: "top left" } : {}) },
		], { duration: 180, easing: ease }));
		return () => {
			for (const animation of animations) {
				const progress = animation.effect?.getComputedTiming().progress ?? 1;
				if (progress < 1) previous.current = size
					? { ...next, height: before.height + (next.height - before.height) * progress }
					: { ...next, x: before.x + (next.x - before.x) * progress, y: before.y + (next.y - before.y) * progress, width: before.width + (next.width - before.width) * progress };
				animation.cancel();
			}
		};
	}, [ref, version, enabled, size, resizeWidth]);
}

/** The single intrinsic child keeps its parent, key, and original ref. No extra layout box is introduced. */
export function Presence({ show, children, keepMounted = false, collapse = false, axis = "height", layoutVersion, resizeWidth = false, onExited }: {
	show: boolean;
	children: ReactNode;
	keepMounted?: boolean;
	collapse?: boolean;
	axis?: "height" | "width";
	layoutVersion?: unknown;
	resizeWidth?: boolean;
	onExited?: () => void;
}) {
	const [present, setPresent] = useState(show);
	const wasShown = useRef(show);
	const element = useRef<Element>(null);
	const saved = useRef<ReactElement | undefined>(undefined);
	const closedDialogs = useRef(new Set<HTMLDialogElement>());
	const itemBox = useRef<{ x: number; y: number; width: number; height: number } | undefined>(undefined);
	const interrupted = useRef(new Map<Element, Keyframe>());
	const exited = useRef(onExited);
	exited.current = onExited;
	if (isValidElement(children) && (show || keepMounted)) saved.current = children;
	if (show && !present) setPresent(true);
	const child = (show || keepMounted) && isValidElement(children) ? children : saved.current;
	type ChildProps = { ref?: Ref<Element>; hidden?: boolean; inert?: boolean; "data-motion-exit"?: boolean };
	const originalRef = (child?.props as ChildProps | undefined)?.ref;
	const attach = useCallback((node: Element | null) => {
		element.current = node;
		if (typeof originalRef === "function") return originalRef(node);
		if (originalRef) originalRef.current = node;
	}, [originalRef]);
	useLayoutMotion(element, layoutVersion, layoutVersion !== undefined && show, false, resizeWidth);
	useLayoutEffect(() => {
		const node = element.current;
		if (show && layoutVersion !== undefined && node instanceof HTMLElement) itemBox.current = { x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight };
	}, [show, layoutVersion]);
	useLayoutEffect(() => {
		const expand = show && !wasShown.current;
		wasShown.current = show;
		const host = element.current;
		if (!host || !present) return;
		const nodes = host instanceof HTMLElement && getComputedStyle(host).display === "contents" ? [...host.children] : [host];
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		let cancelled = false;
		const animations: Animation[] = [];
		const animatedNodes = new Map<Element, Animation>();
		const snapshots = interrupted.current;
		interrupted.current = new Map();
		let restorePosition: (() => void) | undefined;
		if (!show && layoutVersion !== undefined && itemBox.current && host instanceof HTMLElement && !["absolute", "fixed"].includes(getComputedStyle(host).position)) {
			const saved = { position: host.style.position, left: host.style.left, top: host.style.top, width: host.style.width, height: host.style.height };
			const box = itemBox.current;
			Object.assign(host.style, { position: "absolute", left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
			restorePosition = () => Object.assign(host.style, saved);
		}
		for (const node of nodes) {
			if (node instanceof HTMLElement) node.inert = !show || (node === host && !!(child?.props as ChildProps).inert);
			if (node instanceof HTMLDialogElement) {
				if (show && !node.open && closedDialogs.current.has(node)) node.showModal();
				if (!show && node.open) { closedDialogs.current.add(node); node.close(); }
				if (!show) animations.push(...node.getAnimations());
				continue;
			}
			if (reduced || !node.getClientRects().length) continue;
			const bounds = node.getBoundingClientRect();
			if (bounds.bottom < 0 || bounds.top > window.innerHeight || bounds.right < 0 || bounds.left > window.innerWidth) continue;
			const style = getComputedStyle(node);
			const snapshot = snapshots.get(node);
			const cssEntrance = show && style.animationName !== "none" && !snapshot;
			if (cssEntrance && !(collapse && expand)) continue;
			const from: Keyframe = cssEntrance ? {} : { opacity: show ? 0 : style.opacity, ...snapshot };
			const to: Keyframe = cssEntrance ? {} : { opacity: show ? 1 : 0 };
			if (collapse && node instanceof HTMLElement && (!show || expand || snapshot?.[axis] !== undefined)) {
				const natural = axis === "height"
					? { height: `${node.offsetHeight}px`, marginTop: style.marginTop, marginBottom: style.marginBottom, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom }
					: { width: `${node.offsetWidth}px`, marginLeft: style.marginLeft, marginRight: style.marginRight, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight };
				const zero = Object.fromEntries(Object.keys(natural).map((key) => [key, "0px"]));
				const constraints = { [axis === "height" ? "minHeight" : "minWidth"]: 0, overflow: "clip" };
				Object.assign(from, show && expand ? zero : natural, snapshot, constraints);
				Object.assign(to, show ? natural : zero, constraints);
			}
			const animation = node.animate([from, to], { duration: show ? 160 : 140, easing: ease, fill: show ? "none" : "both" });
			animations.push(animation);
			animatedNodes.set(node, animation);
		}
		if (!show) void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
			if (!cancelled) { setPresent(false); exited.current?.(); }
		});
		return () => {
			cancelled = true;
			for (const [node, animation] of animatedNodes) {
				if ((animation.effect?.getComputedTiming().progress ?? 1) >= 1) continue;
				const style = getComputedStyle(node);
				const snapshot: Keyframe = { opacity: style.opacity };
				if (collapse) Object.assign(snapshot, axis === "height"
					? { height: style.height, marginTop: style.marginTop, marginBottom: style.marginBottom, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom }
					: { width: style.width, marginLeft: style.marginLeft, marginRight: style.marginRight, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight });
				interrupted.current.set(node, snapshot);
			}
			animations.forEach((animation) => animation.cancel());
			restorePosition?.();
		};
	}, [show, present, collapse, axis]);
	if ((!present && !keepMounted) || !child) return null;
	return cloneElement(child as ReactElement<ChildProps>, { ref: attach, hidden: !present || (!keepMounted && (child.props as ChildProps).hidden) || undefined, "data-motion-exit": !show || undefined });
}

export function MotionItems<T>({ items, itemKey, children, enabled = true, resizeWidth = false }: {
	items: readonly T[];
	itemKey: (item: T) => string;
	children: (item: T) => ReactElement;
	enabled?: boolean;
	resizeWidth?: boolean;
}) {
	const [entries, setEntries] = useState<MotionEntry<T>[]>(() => items.map((value) => ({ key: itemKey(value), value, visible: true })));
	const next = motionEntries(entries, items, itemKey);
	if (next !== entries) setEntries(next);
	return <>{next.map((entry) => <Presence key={entry.key} show={entry.visible} layoutVersion={enabled ? next : undefined} resizeWidth={resizeWidth} onExited={() => setEntries((current) => current.filter((item) => item.key !== entry.key || item.visible))}>{children(entry.value)}</Presence>)}</>;
}

/** Animate discrete grid changes. Resize observations update measurements without delaying direct input. */
export function useChildrenMotion(ref: RefObject<HTMLElement | null>, version: unknown, enabled = true) {
	const previous = useRef(new Map<Element, { x: number; y: number; width: number; height: number }>());
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const children = [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !(child instanceof HTMLDialogElement));
		const measure = () => new Map(children.filter((child) => child.getClientRects().length > 0).map((child) => [child, { x: child.offsetLeft, y: child.offsetTop, width: child.offsetWidth, height: child.offsetHeight }]));
		const next = measure();
		const animations: { child: HTMLElement; animation: Animation; before: { x: number; y: number; width: number; height: number }; box: { x: number; y: number; width: number; height: number } }[] = [];
		if (enabled && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) for (const [child, box] of next) {
			const before = previous.current.get(child);
			if (!before || !box.width || !box.height || (before.x === box.x && before.y === box.y && before.width === box.width && before.height === box.height)) continue;
			const animation = child.animate([
				{ translate: `${before.x - box.x}px ${before.y - box.y}px`, scale: `${before.width / box.width} ${before.height / box.height}`, transformOrigin: "top left" },
				{ translate: "0px 0px", scale: "1 1", transformOrigin: "top left" },
			], { duration: 180, easing: ease });
			animations.push({ child, animation, before, box });
		}
		previous.current = next;
		const observer = new ResizeObserver(() => { previous.current = measure(); });
		children.forEach((child) => observer.observe(child));
		return () => {
			observer.disconnect();
			for (const { child, animation, before, box } of animations) {
				const progress = animation.effect?.getComputedTiming().progress ?? 1;
				if (progress < 1) previous.current.set(child, {
					x: before.x + (box.x - before.x) * progress,
					y: before.y + (box.y - before.y) * progress,
					width: before.width + (box.width - before.width) * progress,
					height: before.height + (box.height - before.height) * progress,
				});
				animation.cancel();
			}
		};
	}, [ref, version, enabled]);
}
