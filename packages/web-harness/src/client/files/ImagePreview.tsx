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

	const apply = useCallback((next: number, anchor?: { x: number; y: number }) => {
		const rect = stage.current?.getBoundingClientRect();
		setZoom((current) => {
			if (!rect) return { ...current, scale: next };
			// Keep the point under the anchor fixed while the scale changes.
			const originX = rect.width / 2 + current.x;
			const originY = rect.height / 2 + current.y;
			const ax = anchor ? anchor.x - rect.left : rect.width / 2;
			const ay = anchor ? anchor.y - rect.top : rect.height / 2;
			const ratio = next / current.scale;
			return { scale: next, x: originX + (ax - originX) * ratio - rect.width / 2, y: originY + (ay - originY) * ratio - rect.height / 2 };
		});
	}, []);

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
			onDoubleClick={() => setZoom({ scale: zoom.scale > 1 ? 1 : 2, x: 0, y: 0 })}
			onPointerDown={(event) => {
				if (!interactable || event.button !== 0) return;
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: zoom.x, y: zoom.y };
				setPanning(true);
			}}
			onPointerMove={(event) => {
				if (drag.current?.pointerId !== event.pointerId) return;
				setZoom((current) => ({ ...current, x: drag.current!.x + event.clientX - drag.current!.startX, y: drag.current!.y + event.clientY - drag.current!.startY }));
			}}
			onPointerUp={(event) => {
				if (drag.current?.pointerId !== event.pointerId) return;
				event.currentTarget.releasePointerCapture(event.pointerId);
				drag.current = undefined;
				setPanning(false);
			}}
			onLostPointerCapture={() => { drag.current = undefined; setPanning(false); }}
			onKeyDown={(event) => {
				if (event.key === "+" || event.key === "=") { event.preventDefault(); step(1); }
				else if (event.key === "-") { event.preventDefault(); step(-1); }
				else if (event.key === "0") { event.preventDefault(); setZoom({ scale: 1, x: 0, y: 0 }); }
				else if (interactable && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
					event.preventDefault();
					setZoom((current) => ({ ...current, x: current.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), y: current.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) }));
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
