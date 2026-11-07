import { useEffect, useId, useRef } from "react";

/** Only the white selection flows; the three icon positions stay fixed. */
export function TabGestureHints({ left, top, active }: {
	left: number;
	top: number;
	active?: "file" | "terminal";
}) {
	const id = useId();
	const svg = useRef<SVGSVGElement>(null);
	const position = useRef({ x: 32, y: 32, tailX: 32, tailY: 32 });
	useEffect(() => {
		const element = svg.current;
		if (!element) return;
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const target = { x: active === "file" ? 102 : 32, y: active === "terminal" ? 102 : 32 };
		// Changing branches passes through the plus instead of cutting across empty space.
		let throughOrigin = (target.x === 32 && position.current.x > 33) || (target.y === 32 && position.current.y > 33);
		let frame = 0;
		let previous = performance.now();
		const draw = (now: number) => {
			const amount = reduced ? 1 : 1 - Math.exp(-Math.min(now - previous, 32) / 48);
			previous = now;
			const current = position.current;
			if (reduced || Math.abs(current.x - 32) + Math.abs(current.y - 32) < 1) throughOrigin = false;
			current.x += ((throughOrigin ? 32 : target.x) - current.x) * amount;
			current.y += ((throughOrigin ? 32 : target.y) - current.y) * amount;
			current.tailX += (current.x - current.tailX) * amount;
			current.tailY += (current.y - current.tailY) * amount;
			element.querySelector('[data-selection="head"]')?.setAttribute("transform", `translate(${current.x} ${current.y})`);
			element.querySelector('[data-selection="tail"]')?.setAttribute("transform", `translate(${current.tailX} ${current.tailY})`);
			if (Math.abs(target.x - current.tailX) + Math.abs(target.y - current.tailY) > .01) frame = requestAnimationFrame(draw);
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
				<circle data-selection="head" transform="translate(32 32)" r="23" />
				<circle data-selection="tail" transform="translate(32 32)" r="18" />
			</g></g>
			<g className="detail-gesture-hint" data-active={!active}><path d="M26 32h12m-6-6v12" /></g>
			<g className="detail-gesture-hint" data-part="file" data-active={active === "file"}><path d="M93 25h7l3 3h8v11H93Z" /></g>
			<g className="detail-gesture-hint" data-part="terminal" data-active={active === "terminal"}><rect x="23" y="94" width="18" height="16" rx="2" /><path d="m27 98 4 4-4 4m7 0h4" /></g>
		</svg>
	</div>;
}
