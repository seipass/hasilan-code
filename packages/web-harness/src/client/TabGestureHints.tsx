import { useEffect, useId, useRef } from "react";

/** Only the white selection flows; the three icon positions stay fixed. */
export function TabGestureHints({ left, top, active }: {
	left: number;
	top: number;
	active?: "file" | "terminal";
}) {
	const id = useId();
	const svg = useRef<SVGSVGElement>(null);
	const position = useRef({ head: 0, headVelocity: 0, tail: 0, tailVelocity: 0 });
	useEffect(() => {
		const element = svg.current;
		if (!element) return;
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const target = active === "file" ? 1 : active === "terminal" ? -1 : 0;
		const head = element.querySelector('[data-selection="head"]');
		const tail = element.querySelector('[data-selection="tail"]');
		const bridge = element.querySelector('[data-selection="bridge"]');
		const icons = element.querySelectorAll<SVGGElement>(".detail-gesture-hint");
		let frame = 0;
		let previous = performance.now();
		const draw = (now: number) => {
			const elapsed = Math.min(now - previous, 50) / 1000;
			previous = now;
			const current = position.current;
			// Exact critically damped springs retain velocity when the direction changes.
			// One path coordinate crosses the plus continuously, with no stop at its center.
			const headDecay = Math.exp(-22 * elapsed);
			const headOffset = current.head - target;
			const headImpulse = current.headVelocity + 22 * headOffset;
			current.head = reduced ? target : target + (headOffset + headImpulse * elapsed) * headDecay;
			current.headVelocity = reduced ? 0 : (current.headVelocity - 22 * headImpulse * elapsed) * headDecay;
			const tailDecay = Math.exp(-19 * elapsed);
			const tailOffset = current.tail - current.head;
			const tailImpulse = current.tailVelocity + 19 * tailOffset;
			current.tail = reduced ? target : current.head + (tailOffset + tailImpulse * elapsed) * tailDecay;
			current.tailVelocity = reduced ? 0 : (current.tailVelocity - 19 * tailImpulse * elapsed) * tailDecay;
			const headX = 32 + Math.max(0, current.head) * 70;
			const headY = 32 + Math.max(0, -current.head) * 70;
			const tailX = 32 + Math.max(0, current.tail) * 70;
			const tailY = 32 + Math.max(0, -current.tail) * 70;
			head?.setAttribute("transform", `translate(${headX} ${headY})`);
			tail?.setAttribute("transform", `translate(${tailX} ${tailY})`);
			bridge?.setAttribute("d", `M${headX} ${headY}${current.head * current.tail < 0 ? "L32 32" : ""}L${tailX} ${tailY}`);
			for (const icon of icons) {
				const iconX = icon.dataset.part === "file" ? 102 : 32;
				const iconY = icon.dataset.part === "terminal" ? 102 : 32;
				const distance = Math.min(Math.hypot(headX - iconX, headY - iconY), Math.hypot(tailX - iconX, tailY - iconY));
				const coverage = Math.max(0, Math.min(1, (31 - distance) / 14));
				icon.style.stroke = `color-mix(in srgb, var(--surface) ${coverage * 100}%, var(--on-surface-secondary))`;
			}
			if (Math.abs(target - current.tail) + Math.abs(current.headVelocity) + Math.abs(current.tailVelocity) > .001) frame = requestAnimationFrame(draw);
		};
		frame = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(frame);
	}, [active]);
	return <div className="detail-gesture-hints" role="status" style={{ left, top }}>
		<span className="sr-only">右へスライドでファイル、下へスライドでターミナル</span>
		<svg ref={svg} width="140" height="140" viewBox="0 0 140 140" aria-hidden="true">
			<defs><filter id={id} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="3" /><feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9" /></filter>
				<clipPath id={`${id}-clip`}><circle cx="32" cy="32" r="24" /><circle cx="102" cy="32" r="24" /><circle cx="32" cy="102" r="24" /><path d="M32 20Q67 38 102 20V44Q67 26 32 44ZM20 32Q38 67 20 102H44Q26 67 44 32Z" /></clipPath>
			</defs>
			<g className="detail-gesture-surface" filter={`url(#${id})`}>
				<circle cx="32" cy="32" r="24" /><circle cx="102" cy="32" r="24" /><circle cx="32" cy="102" r="24" />
				<path d="M32 20Q67 38 102 20V44Q67 26 32 44ZM20 32Q38 67 20 102H44Q26 67 44 32Z" />
			</g>
			<g clipPath={`url(#${id}-clip)`}><g className="detail-gesture-selection" filter={`url(#${id})`}>
				<path data-selection="bridge" fill="none" stroke="var(--on-surface)" strokeWidth="32" strokeLinecap="round" strokeLinejoin="round" />
				<circle data-selection="head" transform="translate(32 32)" r="23" />
				<circle data-selection="tail" transform="translate(32 32)" r="18" />
			</g></g>
			<g className="detail-gesture-hint" data-active={!active}><path d="M26 32h12m-6-6v12" /></g>
			<g className="detail-gesture-hint" data-part="file" data-active={active === "file"}><path d="M93 25h7l3 3h8v11H93Z" /></g>
			<g className="detail-gesture-hint" data-part="terminal" data-active={active === "terminal"}><rect x="23" y="94" width="18" height="16" rx="2" /><path d="m27 98 4 4-4 4m7 0h4" /></g>
		</svg>
	</div>;
}
