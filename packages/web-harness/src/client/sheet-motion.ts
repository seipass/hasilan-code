const motions = new WeakMap<HTMLElement, Animation>();

/** A live sheet tapers toward its trigger; interrupted motion starts at the visible shape. */
export function animateSheet(sheet: HTMLElement, anchor: HTMLElement | null, opening: boolean): void {
	const previous = motions.get(sheet);
	const style = previous && previous.playState !== "finished" ? getComputedStyle(sheet) : undefined;
	const visible: Keyframe | undefined = style
		? { transform: style.transform, clipPath: style.clipPath, opacity: style.opacity }
		: undefined;
	previous?.cancel();
	motions.delete(sheet);
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	const box = sheet.getBoundingClientRect();
	const target = anchor?.getBoundingClientRect();
	let frames: Keyframe[];
	if (box.width && box.height && target?.width && target.height) {
		const x = target.left - box.left;
		const y = target.top - box.top;
		const left = Math.max(0, Math.min(100, (x / box.width) * 100));
		const right = Math.max(left, Math.min(100, ((x + target.width) / box.width) * 100));
		const center = (left + right) / 2;
		const full =
			"polygon(0% 0%, 50% 0%, 100% 0%, 100% 12%, 100% 35%, 100% 70%, 100% 100%, 0% 100%, 0% 70%, 0% 35%, 0% 12%)";
		const neck = `polygon(${left}% 0%, ${center}% 0%, ${right}% 0%, ${right + (100 - right) * 0.05}% 12%, ${right + (100 - right) * 0.35}% 35%, 100% 70%, 100% 100%, 0% 100%, 0% 70%, ${left * 0.65}% 35%, ${left * 0.95}% 12%)`;
		frames = [
			{
				offset: 0,
				transform: `translate(${x}px, ${y}px) scale(${target.width / box.width}, ${target.height / box.height})`,
				clipPath: full,
				opacity: 0,
			},
			{ offset: 0.3, transform: `translate(0px, ${y * 0.8}px) scale(1, .28)`, clipPath: neck, opacity: 0.9 },
			{ offset: 0.68, transform: `translate(0px, ${y * 0.2}px) scale(1, .88)`, opacity: 1 },
			{ offset: 1, transform: "translate(0px, 0px) scale(1, 1)", clipPath: full, opacity: 1 },
		];
		if (!opening) frames = frames.reverse().map((frame) => ({ ...frame, offset: 1 - Number(frame.offset) }));
	} else frames = [{ opacity: opening ? 0 : 1 }, { opacity: opening ? 1 : 0 }];
	if (visible) frames = [visible, frames[frames.length - 1]];
	const animation = sheet.animate(frames, {
		duration: visible ? 180 : opening ? 380 : 280,
		easing: opening ? "cubic-bezier(.2, .65, .25, 1)" : "cubic-bezier(.4, 0, .65, 1)",
		fill: "both",
	});
	motions.set(sheet, animation);
	void animation.finished.then(
		() => {
			if (motions.get(sheet) === animation && opening) {
				motions.delete(sheet);
				animation.cancel();
			}
		},
		() => {
			if (motions.get(sheet) === animation) motions.delete(sheet);
		},
	);
}

export function cancelSheetMotion(sheet: HTMLElement): void {
	motions.get(sheet)?.cancel();
	motions.delete(sheet);
}
