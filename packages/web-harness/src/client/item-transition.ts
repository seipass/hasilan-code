import { flushSync } from "react-dom";
import { animationsEnabled } from "./motion-policy.ts";

/** Snapshot only named UI panels; preserve mounted inputs and terminal instances. */
export function transitionItems(update: () => void): void {
	if (
		!document.startViewTransition ||
		!animationsEnabled ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		update();
		return;
	}
	document.activeViewTransition?.skipTransition();
	document.startViewTransition(() => flushSync(update));
}
