import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { animateSheet, cancelSheetMotion } from "../src/client/sheet-motion.ts";

class SheetAnimation {
	playState = "running";
	finished = new Promise<void>(() => {});
	cancel = vi.fn(() => {
		this.playState = "idle";
	});
}
class SheetElement {
	box = { left: 100, top: 60, width: 480, height: 600 };
	animations: { frames: Keyframe[]; options: KeyframeAnimationOptions; animation: SheetAnimation }[] = [];
	getBoundingClientRect() {
		return this.box;
	}
	animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
		const animation = new SheetAnimation();
		this.animations.push({ frames, options, animation });
		return animation;
	}
}
let reduced = false;
const visible = {
	transform: "matrix(1, 0, 0, .6, 0, -20)",
	clipPath: "polygon(40% 0%, 60% 0%, 100% 100%, 0% 100%)",
	opacity: ".85",
};
beforeEach(() => {
	reduced = false;
	vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
	vi.stubGlobal("getComputedStyle", () => visible);
});
afterEach(() => vi.unstubAllGlobals());

it("opens from the clicked button's viewport position through a tapered shape", () => {
	const sheet = new SheetElement();
	const anchor = new SheetElement();
	anchor.box = { left: 300, top: 10, width: 120, height: 40 };
	animateSheet(sheet as unknown as HTMLElement, anchor as unknown as HTMLElement, true);
	const { frames } = sheet.animations[0];
	expect(frames[0].transform).toBe("translate(200px, -50px) scale(0.25, 0.06666666666666667)");
	expect(frames[1].clipPath).not.toBe(frames[0].clipPath);
	expect(frames[3]).toMatchObject({ transform: "translate(0px, 0px) scale(1, 1)", opacity: 1 });
	cancelSheetMotion(sheet as unknown as HTMLElement);
});

it("closes back into the same trigger using the reversed shape sequence", () => {
	const opening = new SheetElement();
	const closing = new SheetElement();
	const anchor = new SheetElement();
	anchor.box = { left: 550, top: 10, width: 30, height: 40 };
	animateSheet(opening as unknown as HTMLElement, anchor as unknown as HTMLElement, true);
	animateSheet(closing as unknown as HTMLElement, anchor as unknown as HTMLElement, false);
	expect(closing.animations[0].frames.map(({ transform, clipPath }) => ({ transform, clipPath }))).toEqual(
		opening.animations[0].frames.toReversed().map(({ transform, clipPath }) => ({ transform, clipPath })),
	);
	cancelSheetMotion(opening as unknown as HTMLElement);
	cancelSheetMotion(closing as unknown as HTMLElement);
});

it("reverses a running animation from the visible shape without stacking another motion", () => {
	const sheet = new SheetElement();
	const anchor = new SheetElement();
	animateSheet(sheet as unknown as HTMLElement, anchor as unknown as HTMLElement, true);
	animateSheet(sheet as unknown as HTMLElement, anchor as unknown as HTMLElement, false);
	expect(sheet.animations[0].animation.cancel).toHaveBeenCalledOnce();
	expect(sheet.animations[1].frames).toHaveLength(2);
	expect(sheet.animations[1].frames[0]).toEqual(visible);
	cancelSheetMotion(sheet as unknown as HTMLElement);
});

it("cancels outstanding motion and uses native visibility when reduced motion is enabled", () => {
	const sheet = new SheetElement();
	animateSheet(sheet as unknown as HTMLElement, null, true);
	reduced = true;
	animateSheet(sheet as unknown as HTMLElement, null, false);
	expect(sheet.animations).toHaveLength(1);
	expect(sheet.animations[0].animation.cancel).toHaveBeenCalledOnce();
});
