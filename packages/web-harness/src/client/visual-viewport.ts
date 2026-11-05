/**
 * Keeps the shell above the software keyboard. iOS Safari does not resize the layout
 * viewport when a field is focused, so the composer would otherwise sit underneath the
 * keyboard. The variable is only written while something editable has focus, which
 * keeps the collapsing browser chrome from resizing the app mid-scroll.
 */
export function trackVisualViewport(): () => void {
	const root = document.documentElement;
	const viewport = window.visualViewport;
	let frame = 0;

	const typing = () => {
		const active = document.activeElement;
		return (
			active instanceof HTMLElement &&
			(active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
		);
	};

	const update = () => {
		if (!viewport || !typing()) {
			root.style.removeProperty("--visual-viewport-height");
			delete root.dataset.keyboard;
			return;
		}
		// Pinch zoom also changes the visual viewport; the shell must not chase it.
		if (viewport.scale > 1.01) return;
		const height = Math.round(viewport.height);
		root.style.setProperty("--visual-viewport-height", `${height}px`);
	};

	const schedule = () => {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			update();
		});
	};

	const onFocusOut = () => {
		window.setTimeout(schedule, 60);
	};

	update();
	viewport?.addEventListener("resize", schedule);
	viewport?.addEventListener("scroll", schedule);
	window.addEventListener("resize", schedule);
	window.addEventListener("orientationchange", schedule);
	document.addEventListener("focusin", schedule);
	document.addEventListener("focusout", onFocusOut);

	return () => {
		if (frame) cancelAnimationFrame(frame);
		viewport?.removeEventListener("resize", schedule);
		viewport?.removeEventListener("scroll", schedule);
		window.removeEventListener("resize", schedule);
		window.removeEventListener("orientationchange", schedule);
		document.removeEventListener("focusin", schedule);
		document.removeEventListener("focusout", onFocusOut);
		root.style.removeProperty("--visual-viewport-height");
	};
}
