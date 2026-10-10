import { useRef } from "react";

export function PanelResize({ axis, value, minimum, maximum, label, onChange }: {
	axis: "x" | "y"; value: number; minimum: number; maximum: number; label: string; onChange: (value: number) => void;
}) {
	const drag = useRef<{ coordinate: number; value: number } | undefined>(undefined);
	return <div className={`panel-resize panel-resize-${axis}`} role="separator" tabIndex={0} aria-label={label} aria-orientation={axis === "x" ? "vertical" : "horizontal"} aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={value}
		onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); drag.current = { coordinate: axis === "x" ? event.clientX : event.clientY, value }; event.currentTarget.setPointerCapture(event.pointerId); }}
		onPointerMove={(event) => { if (!drag.current) return; const coordinate = axis === "x" ? event.clientX : event.clientY; onChange(Math.max(minimum, Math.min(maximum, drag.current.value + drag.current.coordinate - coordinate))); }}
		onPointerUp={(event) => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
		onLostPointerCapture={() => { drag.current = undefined; }}
		onKeyDown={(event) => { const grow = axis === "x" ? "ArrowLeft" : "ArrowUp"; const shrink = axis === "x" ? "ArrowRight" : "ArrowDown"; let next: number; if (event.key === grow) next = value + (event.shiftKey ? 48 : 16); else if (event.key === shrink) next = value - (event.shiftKey ? 48 : 16); else if (event.key === "Home") next = minimum; else if (event.key === "End") next = maximum; else return; event.preventDefault(); onChange(Math.max(minimum, Math.min(maximum, next))); }} />;
}
