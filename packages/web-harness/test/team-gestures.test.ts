import { describe, expect, it } from "vitest";
import { TeamGestures } from "../src/client/team-gestures.ts";

describe("team graph touch gestures", () => {
	it("zooms around the two-finger midpoint and follows its translation", () => {
		const gestures = new TeamGestures();
		const view = { x: 20, y: 30, zoom: 1 };
		gestures.start(1, { x: 100, y: 100 }, view);
		gestures.start(2, { x: 200, y: 100 }, view);
		const zoomed = gestures.move(2, { x: 300, y: 100 });
		expect(zoomed).toEqual({ x: -60, y: -40, zoom: 2 });
		expect((200 - zoomed!.x) / zoomed!.zoom).toBe(130);
	});
	it("continues panning without jumping after a finger leaves", () => {
		const gestures = new TeamGestures();
		const view = { x: 0, y: 0, zoom: 1 };
		gestures.start(1, { x: 100, y: 100 }, view);
		gestures.start(2, { x: 200, y: 100 }, view);
		const zoomed = gestures.move(2, { x: 250, y: 100 })!;
		gestures.end(2, zoomed);
		expect(gestures.move(1, { x: 110, y: 120 })).toEqual({ ...zoomed, x: zoomed.x + 10, y: zoomed.y + 20 });
	});
	it("keeps taps clickable, suppresses pinch clicks, and resets after cancellation", () => {
		const gestures = new TeamGestures();
		const view = { x: 0, y: 0, zoom: 1 };
		gestures.start(1, { x: 0, y: 0 }, view);
		expect(gestures.move(1, { x: 2, y: 1 })).toBeUndefined();
		expect(gestures.moved).toBe(false);
		gestures.start(2, { x: 20, y: 0 }, view);
		expect(gestures.moved).toBe(true);
		gestures.end(1, view);
		gestures.end(2, view);
		expect(gestures.move(2, { x: 30, y: 0 })).toBeUndefined();
		gestures.start(3, { x: 0, y: 0 }, view);
		expect(gestures.moved).toBe(false);
	});
	it("clamps zoom and handles overlapping fingers without invalid coordinates", () => {
		const gestures = new TeamGestures();
		const view = { x: 0, y: 0, zoom: 1 };
		gestures.start(1, { x: 0, y: 0 }, view);
		gestures.start(2, { x: 100, y: 0 }, view);
		expect(gestures.move(2, { x: 0, y: 0 })?.zoom).toBe(0.01);
		expect(gestures.move(2, { x: 1000, y: 0 })?.zoom).toBe(2);
	});
});
