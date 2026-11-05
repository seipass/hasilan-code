import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../Icon.tsx";

interface Zoom {
	/** 1 fits the image inside the pane. */
	scale: number;
	x: number;
	y: number;
}

const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const MAX_SCALE = 8;

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A drag that outruns the image would leave an empty pane with no clue how to get back,
 * so the translation stops where the image still meets the pane: edges stay covered when
 * the image is larger than the pane, and the image stays inside it when it is smaller.
 */
function bounded(zoom: Zoom, box?: { width: number; height: number }, size?: { width: number; height: number }): Zoom {
	if (!box || !size) return zoom;
	const limitX = Math.abs(size.width * zoom.scale - box.width) / 2;
	const limitY = Math.abs(size.height * zoom.scale - box.height) / 2;
	return { scale: zoom.scale, x: Math.max(-limitX, Math.min(limitX, zoom.x)), y: Math.max(-limitY, Math.min(limitY, zoom.y)) };
}

/**
 * Image viewer with the affordances a screenshot actually needs: the whole image is
 * visible first, then zoom, pan, pixel-accurate inspection on click, and a way out to
 * the raw file. Zoom anchors on the pointer so the pixel under the cursor stays put.
 */
export function ImagePreview({ path, src, size, mime, revision }: {
	path: string; src: string; size: number; mime?: string; revision: string;
}) {
	const [zoom, setZoom] = useState<Zoom>({ scale: 1, x: 0, y: 0 });
	const [natural, setNatural] = useState<{ width: number; height: number }>();
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState(false);
	const [checker, setChecker] = useState(false);
	const stage = useRef<HTMLDivElement>(null);
	const image = useRef<HTMLImageElement>(null);
	const drag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | undefined>(undefined);
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const pinch = useRef<{ distance: number; scale: number; x: number; y: number; midX: number; midY: number } | undefined>(undefined);
	const lastTap = useRef<{ time: number; x: number; y: number } | undefined>(undefined);
	const downs = useRef(new Map<number, { x: number; y: number }>());
	const [panning, setPanning] = useState(false);
	const interactable = zoom.scale > 1;

	// A new file must not inherit the previous zoom state, and a cached image finishes
	// loading before React attaches onLoad, so completion is checked directly.
	useEffect(() => {
		setZoom({ scale: 1, x: 0, y: 0 });
		setFailed(false);
		setNatural(undefined);
		const element = image.current;
		const ready = !!element && element.complete && element.naturalWidth > 0;
		setLoaded(ready);
		if (element && ready) setNatural({ width: element.naturalWidth, height: element.naturalHeight });
	}, [path, revision]);

	// The pane box without its padding, plus the image's laid-out (unscaled) size.
	const measure = useCallback(() => {
		const element = stage.current;
		const picture = image.current;
		if (!element || !picture) return {};
		const style = getComputedStyle(element);
		return {
			box: {
				width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
				height: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
			},
			size: { width: picture.offsetWidth, height: picture.offsetHeight },
		};
	}, []);

	const apply = useCallback((next: number, anchor?: { x: number; y: number }) => {
		const rect = stage.current?.getBoundingClientRect();
		const metrics = measure();
		setZoom((current) => {
			if (!rect) return { ...current, scale: next };
			// Keep the point under the anchor fixed while the scale changes.
			const originX = rect.width / 2 + current.x;
			const originY = rect.height / 2 + current.y;
			const ax = anchor ? anchor.x - rect.left : rect.width / 2;
			const ay = anchor ? anchor.y - rect.top : rect.height / 2;
			const ratio = next / current.scale;
			return bounded({ scale: next, x: originX + (ax - originX) * ratio - rect.width / 2, y: originY + (ay - originY) * ratio - rect.height / 2 }, metrics.box, metrics.size);
		});
	}, [measure]);

	// A wider pane or a window resize changes how much of the image fits, so re-clamp.
	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		const observer = new ResizeObserver(() => {
			const metrics = measure();
			setZoom((current) => bounded(current, metrics.box, metrics.size));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [measure]);

	const step = (direction: 1 | -1) => {
		const index = STEPS.findIndex((value) => value >= zoom.scale - 0.001);
		const next = STEPS[Math.min(STEPS.length - 1, Math.max(0, (index === -1 ? STEPS.length - 1 : index) + direction))];
		apply(next);
	};

	useEffect(() => {
		if (!interactable) return;
		const element = stage.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			apply(Math.min(MAX_SCALE, Math.max(0.25, zoom.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15))), { x: event.clientX, y: event.clientY });
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [interactable, zoom.scale, apply]);

	return <div className="image-viewer" data-panning={panning || undefined}>
		<div className="image-viewer-toolbar">
			<button type="button" aria-label="縮小" title="縮小 (−)" disabled={zoom.scale <= STEPS[0]} onClick={() => step(-1)}><Icon name="minus" size="inline" /></button>
			<button type="button" className="image-viewer-scale" title="等倍に戻す" onClick={() => setZoom({ scale: 1, x: 0, y: 0 })}>{Math.round(zoom.scale * 100)}%</button>
			<button type="button" aria-label="拡大" title="拡大 (+)" disabled={zoom.scale >= MAX_SCALE} onClick={() => step(1)}><Icon name="plus" size="inline" /></button>
			<span className="image-viewer-divider" aria-hidden="true" />
			<button type="button" aria-pressed={checker} title="透過部分を市松模様で表示" onClick={() => setChecker((value) => !value)}>透過</button>
			<a className="image-viewer-open" href={src} target="_blank" rel="noopener noreferrer" title="元の画像を新しいタブで開く"><Icon name="external" size="inline" />元画像</a>
		</div>
		<div
			ref={stage}
			className="image-viewer-stage"
			data-checker={checker || undefined}
			data-interactable={interactable || undefined}
			tabIndex={0}
			role="img"
			aria-label={`${path}（${Math.round(zoom.scale * 100)} パーセント）`}
			onPointerDown={(event) => {
				if (event.pointerType === "mouse" && event.button !== 0) return;
				event.currentTarget.setPointerCapture(event.pointerId);
				pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
				downs.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
				if (pointers.current.size === 1) {
					drag.current = interactable ? { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: zoom.x, y: zoom.y } : undefined;
					setPanning(interactable);
					return;
				}
				if (pointers.current.size === 2) {
					// Two fingers: pinch to zoom around their midpoint and pan with it.
					const [a, b] = [...pointers.current.values()];
					pinch.current = {
						distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
						scale: zoom.scale,
						x: zoom.x,
						y: zoom.y,
						midX: (a.x + b.x) / 2,
						midY: (a.y + b.y) / 2,
					};
					drag.current = undefined;
					setPanning(true);
				}
			}}
			onPointerMove={(event) => {
				if (!pointers.current.has(event.pointerId)) return;
				pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
				const metrics = measure();
				const start = pinch.current;
				if (start && pointers.current.size >= 2) {
					const rect = stage.current?.getBoundingClientRect();
					if (!rect) return;
					const [a, b] = [...pointers.current.values()];
					const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
					const next = Math.min(MAX_SCALE, Math.max(STEPS[0], start.scale * (Math.hypot(a.x - b.x, a.y - b.y) / start.distance)));
					// Keep the content under the starting midpoint under the moving midpoint.
					const centerX = rect.left + rect.width / 2;
					const centerY = rect.top + rect.height / 2;
					const contentX = (start.midX - centerX - start.x) / start.scale;
					const contentY = (start.midY - centerY - start.y) / start.scale;
					setZoom(bounded({ scale: next, x: mid.x - centerX - contentX * next, y: mid.y - centerY - contentY * next }, metrics.box, metrics.size));
					return;
				}
				const active = drag.current;
				if (active?.pointerId !== event.pointerId) return;
				setZoom((current) => bounded({ ...current, x: active.x + event.clientX - active.startX, y: active.y + event.clientY - active.startY }, metrics.box, metrics.size));
			}}
			onPointerUp={(event) => {
				const start = downs.current.get(event.pointerId);
				downs.current.delete(event.pointerId);
				const moved = !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12;
				pointers.current.delete(event.pointerId);
				if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
				if (pointers.current.size < 2) pinch.current = undefined;
				if (pointers.current.size === 0) {
					drag.current = undefined;
					setPanning(false);
				} else {
					const [id] = [...pointers.current.keys()];
					const point = pointers.current.get(id)!;
					drag.current = { pointerId: id, startX: point.x, startY: point.y, x: zoom.x, y: zoom.y };
				}
				// One double-tap path for mouse and touch: dblclick fires a second time on
				// touch after these handlers, which used to zoom in twice.
				if (!moved) {
					const last = lastTap.current;
					const now = Date.now();
					if (last && now - last.time < 320 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 26) {
						lastTap.current = undefined;
						setZoom((current) => current.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: 2, x: 0, y: 0 });
					} else {
						lastTap.current = { time: now, x: event.clientX, y: event.clientY };
					}
				}
			}}
			onLostPointerCapture={() => { pointers.current.clear(); downs.current.clear(); pinch.current = undefined; drag.current = undefined; setPanning(false); }}
			onKeyDown={(event) => {
				if (event.key === "+" || event.key === "=") { event.preventDefault(); step(1); }
				else if (event.key === "-") { event.preventDefault(); step(-1); }
				else if (event.key === "0") { event.preventDefault(); setZoom({ scale: 1, x: 0, y: 0 }); }
				else if (interactable && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
					event.preventDefault();
					const metrics = measure();
					setZoom((current) => bounded({ ...current, x: current.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), y: current.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) }, metrics.box, metrics.size));
				}
			}}
		>
			{!loaded && !failed && <p className="image-viewer-status" role="status">読み込み中…</p>}
			{failed && <p className="image-viewer-status error" role="alert">画像を表示できません。ファイルが破損しているか、形式が未対応です。</p>}
			<img
				ref={image}
				className="image-viewer-image"
				style={{ opacity: loaded ? 1 : 0, transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
				alt={path}
				draggable={false}
				onLoad={(event) => {
					setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
					setLoaded(true);
				}}
				onError={() => setFailed(true)}
				src={src}
			/>
		</div>
		<p className="image-viewer-meta">
			<span>{path.split(/[\\/]/).at(-1)}</span>
			{natural && <span>{natural.width} × {natural.height}</span>}
			<span>{formatBytes(size)}</span>
			{mime && <span>{mime.replace("image/", "").toUpperCase()}</span>}
			{natural && zoom.scale === 1 && natural.width > 600 && <span className="image-viewer-hint">ダブルクリックで拡大</span>}
		</p>
	</div>;
}
