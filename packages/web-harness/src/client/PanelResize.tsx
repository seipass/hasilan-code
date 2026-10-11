import { useRef } from "react";

export function PanelResize({ value, minimum, maximum, label, onChange }: {
	value: number; minimum: number; maximum: number; label: string; onChange: (value: number) => void;
}) {
	const drag = useRef<{ coordinate: number; value: number } | undefined>(undefined);
	return <div className="panel-resize" role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={value}
		onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); drag.current = { coordinate: event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); }}
		onPointerMove={(event) => { if (!drag.current) return; onChange(Math.max(minimum, Math.min(maximum, drag.current.value + drag.current.coordinate - event.clientX))); }}
		onPointerUp={(event) => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
		onLostPointerCapture={() => { drag.current = undefined; }}
		onKeyDown={(event) => { let next: number; if (event.key === "ArrowLeft") next = value + (event.shiftKey ? 48 : 16); else if (event.key === "ArrowRight") next = value - (event.shiftKey ? 48 : 16); else if (event.key === "Home") next = minimum; else if (event.key === "End") next = maximum; else return; event.preventDefault(); onChange(Math.max(minimum, Math.min(maximum, next))); }} />;
}
