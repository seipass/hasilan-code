type Size = { width: number; height: number };
type Anchor = { rect: Size & { x: number; y: number }; viewport: Size };

export function browserCommentPosition(anchor: Anchor, area: Size, bubble: Size) {
	const inset = 8;
	const gap = 8;
	const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
	const scaleX = area.width / Math.max(1, anchor.viewport.width);
	const scaleY = area.height / Math.max(1, anchor.viewport.height);
	const { x, y, width, height } = anchor.rect;
	const targetX = clamp((x + width / 2) * scaleX, inset, area.width - inset);
	const above = clamp(y * scaleY, 0, area.height);
	const below = clamp((y + height) * scaleY, 0, area.height);
	const left = clamp(targetX - bubble.width / 2, inset, area.width - bubble.width - inset);
	const fitsBelow = below + gap + bubble.height <= area.height - inset;
	const fitsAbove = above - gap - bubble.height >= inset;
	const placeBelow = fitsBelow || (!fitsAbove && area.height - below >= above);
	const top = clamp(
		placeBelow ? below + gap : above - gap - bubble.height,
		inset,
		area.height - bubble.height - inset,
	);
	return { left, top };
}
