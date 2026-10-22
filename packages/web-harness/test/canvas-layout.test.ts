import { describe, expect, it } from "vitest";
import { CARD_HEIGHT, CARD_WIDTH, nextCanvasPosition } from "../src/client/canvas-layout.ts";
import type { CanvasNode } from "../src/shared/canvas.ts";
import { CANVAS_LIMITS } from "../src/shared/canvas.ts";

const node: CanvasNode = { id: "n1", title: "Node", description: "", x: 100, y: 200 };

describe("new Canvas node placement", () => {
	it("places the first node at the visible center", () => {
		expect(nextCanvasPosition([], undefined, { x: 50, y: 90 })).toEqual({ x: 50, y: 90 });
	});
	it("uses the last touched node even when it is far from the visible center", () => {
		expect(nextCanvasPosition([node], node, { x: 9000, y: -9000 })).toEqual({
			x: node.x + CARD_WIDTH + 64,
			y: node.y,
		});
	});
	it("finds a free position near that node when its right side is occupied", () => {
		const occupied = { ...node, id: "n2", x: node.x + CARD_WIDTH + 64 };
		const next = nextCanvasPosition([node, occupied], node, { x: 0, y: 0 });
		expect(next).toEqual({ x: occupied.x, y: node.y + CARD_HEIGHT + 48 });
	});
	it("keeps a new node within the coordinate bounds near the edge", () => {
		const edge = { ...node, x: CANVAS_LIMITS.coordinate, y: CANVAS_LIMITS.coordinate };
		const next = nextCanvasPosition([edge], edge, { x: 0, y: 0 });
		expect(Math.abs(next.x)).toBeLessThanOrEqual(CANVAS_LIMITS.coordinate);
		expect(Math.abs(next.y)).toBeLessThanOrEqual(CANVAS_LIMITS.coordinate);
		expect(Math.abs(next.x - edge.x) >= CARD_WIDTH + 24 || Math.abs(next.y - edge.y) >= CARD_HEIGHT + 24).toBe(true);
	});
});
