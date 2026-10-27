export interface MotionEntry<T> {
	key: string;
	value: T;
	visible: boolean;
}

/** Removed items keep their old slot until their exit finishes; reappearing keys reuse that slot. */
export function motionEntries<T>(
	previous: MotionEntry<T>[],
	items: readonly T[],
	key: (item: T) => string,
): MotionEntry<T>[] {
	const visible = previous.filter((entry) => entry.visible);
	if (
		visible.length === items.length &&
		items.every((item, index) => visible[index].value === item && visible[index].key === key(item))
	)
		return previous;
	const next = items.map((value) => ({ key: key(value), value, visible: true }));
	const keys = new Set(next.map((entry) => entry.key));
	previous.forEach((entry, index) => {
		if (!keys.has(entry.key)) next.splice(Math.min(index, next.length), 0, { ...entry, visible: false });
	});
	return next;
}
