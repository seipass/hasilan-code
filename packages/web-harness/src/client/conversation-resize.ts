/** Observe only mounted rows; keep the virtualizer's measurement work independent of history length. */
export function observeConversation(
	element: HTMLElement,
	heights: Map<string, number>,
	onMeasurements: () => void,
	onViewport: () => void,
): ResizeObserver {
	const observer = new ResizeObserver((entries) => {
		let changed = false;
		// Offscreen rows remain estimates at their last measured size. Clearing them on every
		// animated width change collapses spacers and repeatedly moves the scroll anchor.
		for (const entry of entries) {
			const row = entry.target as HTMLElement;
			const id = row.dataset.messageId;
			if (!id) continue;
			const height = entry.borderBoxSize?.[0]?.blockSize ?? row.getBoundingClientRect().height;
			if (height > 0 && heights.get(id) !== height) {
				heights.set(id, height);
				changed = true;
			}
		}
		if (changed) onMeasurements();
		onViewport();
	});
	observer.observe(element);
	return observer;
}
