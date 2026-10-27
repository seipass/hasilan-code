import { type CSSProperties, type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Presence, useChildrenMotion } from "./Motion.tsx";
import "./SplitLayout.css";

export type SplitMode = "single" | "columns" | "rows";
export type PaneIndex = 0 | 1;
export type SplitEdge = "left" | "right" | "top" | "bottom";

export function SplitActions({ label, mode, onChange }: { label: string; mode: SplitMode; onChange: (mode: SplitMode) => void }) {
	return <div className="split-actions" role="group" aria-label={`${label}の表示操作`}>
		<button type="button" aria-label={`${label}を左右に分割`} title="左右に分割" aria-pressed={mode === "columns"} onClick={() => onChange("columns")}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M10 4v12" /></svg></button>
		<button type="button" aria-label={`${label}を上下に分割`} title="上下に分割" aria-pressed={mode === "rows"} onClick={() => onChange("rows")}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M3 10h14" /></svg></button>
		{mode !== "single" && <button type="button" aria-label={`${label}の分割を統合`} title="分割を統合" onClick={() => onChange("single")}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="m6 8 2 2-2 2m8-4-2 2 2 2" /></svg></button>}
	</div>;
}

/** Children retain their React parents and keys when moved between grid areas. */
export function SplitLayout({ mode, label, children, dragging = false, onEdgeDrop }: { mode: SplitMode; label: string; children: ReactNode; dragging?: boolean; onEdgeDrop?: (edge: SplitEdge) => void }) {
	const [ratio, setRatio] = useState(50);
	const [resizing, setResizing] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const pointer = useRef<number | undefined>(undefined);
	const [dropEdge, setDropEdge] = useState<SplitEdge>();
	useChildrenMotion(root, mode, !dragging && !resizing);
	useEffect(() => { if (!dragging) setDropEdge(undefined); }, [dragging]);
	function edgeAt(event: DragEvent<HTMLDivElement>): SplitEdge | undefined {
		if (!dragging || !onEdgeDrop || !root.current) return undefined;
		if (event.target instanceof Element && event.target.closest('[role="tablist"], .files-tab-header, .split-tab-header')) return undefined;
		const bounds = root.current.getBoundingClientRect();
		if (!bounds.width || !bounds.height) return undefined;
		const horizontal = Math.min(80, bounds.width * 0.22);
		const vertical = Math.min(80, bounds.height * 0.22);
		const left = (event.clientX - bounds.left) / horizontal;
		const right = (bounds.right - event.clientX) / horizontal;
		const top = (event.clientY - bounds.top) / vertical;
		const bottom = (bounds.bottom - event.clientY) / vertical;
		const nearest = Math.min(left, right, top, bottom);
		if (nearest < 0 || nearest > 1) return undefined;
		if (nearest === left) return "left";
		if (nearest === right) return "right";
		return nearest === top ? "top" : "bottom";
	}
	return <div ref={root} className="split-layout" data-split={mode} style={{ "--split-first": `${ratio}fr`, "--split-second": `${100 - ratio}fr` } as CSSProperties}
		onDragOverCapture={(event) => {
			const edge = edgeAt(event);
			setDropEdge(edge);
			if (edge) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; }
		}}
		onDropCapture={(event) => {
			const edge = edgeAt(event);
			setDropEdge(undefined);
			if (edge) { event.preventDefault(); event.stopPropagation(); setRatio(50); onEdgeDrop?.(edge); }
		}}
		onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropEdge(undefined); }}
		onDragEndCapture={() => setDropEdge(undefined)}
		onKeyDownCapture={(event) => { if (dragging && event.key === "Escape") { event.stopPropagation(); setDropEdge(undefined); } }}>
		{children}
		{mode !== "single" && <div className="split-divider" role="separator" tabIndex={0} aria-label={`${label}の分割境界`} aria-orientation={mode === "columns" ? "vertical" : "horizontal"} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(ratio)} onPointerDown={(event) => {
			if (event.button !== 0) return;
			event.preventDefault(); pointer.current = event.pointerId; setResizing(true); event.currentTarget.setPointerCapture(event.pointerId);
		}} onPointerMove={(event) => {
			if (pointer.current !== event.pointerId || !root.current) return;
			const bounds = root.current.getBoundingClientRect();
			const extent = mode === "columns" ? bounds.width : bounds.height;
			if (extent > 8) setRatio(Math.max(15, Math.min(85, ((mode === "columns" ? event.clientX - bounds.left : event.clientY - bounds.top) - 4) / (extent - 8) * 100)));
		}} onPointerUp={(event) => { if (pointer.current === event.pointerId) { pointer.current = undefined; setResizing(false); event.currentTarget.releasePointerCapture(event.pointerId); } }} onLostPointerCapture={() => { pointer.current = undefined; setResizing(false); }} onKeyDown={(event) => {
			const negative = mode === "columns" ? "ArrowLeft" : "ArrowUp";
			const positive = mode === "columns" ? "ArrowRight" : "ArrowDown";
			if (event.key === negative || event.key === positive) { event.preventDefault(); setRatio((value) => Math.max(15, Math.min(85, value + (event.key === negative ? -1 : 1) * (event.shiftKey ? 10 : 2)))); }
			else if (event.key === "Home" || event.key === "End") { event.preventDefault(); setRatio(event.key === "Home" ? 15 : 85); }
		}} />}
		<Presence show={!!dropEdge}><div className="split-drop-preview" data-edge={dropEdge} aria-hidden="true"><span>{dropEdge && ({ left: "左に分割", right: "右に分割", top: "上に分割", bottom: "下に分割" })[dropEdge]}</span></div></Presence>
	</div>;
}
