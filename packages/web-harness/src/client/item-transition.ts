import { flushSync } from "react-dom";

/** Snapshot only named UI panels; preserve mounted inputs and terminal instances. */
export function transitionItems(update: () => void): void {
	if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		update();
		return;
	}
	document.activeViewTransition?.skipTransition();
	document.startViewTransition(() => flushSync(update));
}
