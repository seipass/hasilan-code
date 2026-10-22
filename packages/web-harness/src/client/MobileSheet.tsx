import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import "./MobileSheet.css";

/** Matches the app's overlay-panel breakpoint. */
export function useMobileLayout(): boolean {
	const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 900px)").matches);
	useEffect(() => {
		const query = window.matchMedia("(max-width: 900px)");
		const update = () => setMobile(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return mobile;
}

export function MobileSheet({ open, side, title, busy = false, onClosing, onClose, children }: {
	open: boolean;
	side: "bottom" | "right";
	title: string;
	onClose: () => void;
	onClosing?: () => void;
	busy?: boolean;
	children: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		if (open && !element.open) { element.inert = false; element.showModal(); }
		else if (!open && element.open) element.close();
		const viewport = window.visualViewport;
		const resize = () => {
			element.style.setProperty("--sheet-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
			element.style.setProperty("--sheet-bottom", `${Math.max(0, window.innerHeight - (viewport?.offsetTop ?? 0) - (viewport?.height ?? window.innerHeight))}px`);
		};
		if (open) {
			resize();
			viewport?.addEventListener("resize", resize);
			viewport?.addEventListener("scroll", resize);
			window.addEventListener("resize", resize);
		}
		return () => {
			viewport?.removeEventListener("resize", resize);
			viewport?.removeEventListener("scroll", resize);
			window.removeEventListener("resize", resize);
			if (element.open) element.close();
		};
	}, [open]);
	const requestClose = () => {
		if (busy || !dialog.current?.open) return;
		dialog.current.inert = true;
		dialog.current.close();
		onClosing?.();
	};
	return <dialog ref={dialog} className={`mobile-sheet is-${side}`} aria-labelledby={titleId} aria-busy={busy} inert={!open}
		onCancel={(event) => { event.preventDefault(); requestClose(); }}
		onClose={async (event) => {
			const element = event.currentTarget;
			// Keep conditionally mounted sheets alive through their native exit transition.
			await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
			if (!element.open && element.isConnected) onClose();
		}}
		onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
		onClick={(event) => {
			if (event.target !== event.currentTarget) return;
			const bounds = event.currentTarget.getBoundingClientRect();
			if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) requestClose();
		}}>
		<header className="mobile-sheet-heading"><h2 id={titleId}>{title}</h2><button type="button" disabled={busy} onClick={requestClose} aria-label={`${title}を閉じる`}>閉じる</button></header>
		<div className="mobile-sheet-content">{children}</div>
	</dialog>;
}
