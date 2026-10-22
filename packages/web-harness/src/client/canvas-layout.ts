import { CANVAS_LIMITS, type CanvasNode } from "../shared/canvas.ts";

export const CARD_WIDTH = 240;
export const CARD_HEIGHT = 176;

/** Search around the last touched node, keeping a gap between cards. */
export function nextCanvasPosition(
	nodes: readonly CanvasNode[],
	anchor: CanvasNode | undefined,
	fallback: { x: number; y: number },
): { x: number; y: number } {
	const origin = anchor ?? fallback;
	let candidate = { x: origin.x, y: origin.y };
	for (let ring = anchor ? 1 : 0; ring <= nodes.length + 1; ring++) {
		for (const [dx, dy] of [
			[1, 0],
			[1, 1],
			[0, 1],
			[-1, 1],
			[-1, 0],
			[-1, -1],
			[0, -1],
			[1, -1],
		]) {
			candidate = {
				x: Math.round(
					Math.max(
						-CANVAS_LIMITS.coordinate,
						Math.min(CANVAS_LIMITS.coordinate, origin.x + dx * ring * (CARD_WIDTH + 64)),
					),
				),
				y: Math.round(
					Math.max(
						-CANVAS_LIMITS.coordinate,
						Math.min(CANVAS_LIMITS.coordinate, origin.y + dy * ring * (CARD_HEIGHT + 48)),
					),
				),
			};
			if (
				!nodes.some(
					(node) =>
						Math.abs(node.x - candidate.x) < CARD_WIDTH + 24 && Math.abs(node.y - candidate.y) < CARD_HEIGHT + 24,
				)
			)
				return candidate;
		}
	}
	return candidate;
}
