import type { CanvasElement } from "../shared/canvas.ts";

export type CanvasTool =
	| "select"
	| "hand"
	| "rectangle"
	| "ellipse"
	| "diamond"
	| "arrow"
	| "line"
	| "freedraw"
	| "text"
	| "sticky";

export interface ElementStyleDefaults {
	stroke: string;
	fill: string;
	strokeWidth: number;
	strokeStyle: "solid" | "dashed" | "dotted";
	roughness: number;
	opacity: number;
	fontSize: number;
}

export const STROKE_PALETTE = [
	"#e8e8e8",
	"#9bbcf0",
	"#a6e3a1",
	"#f9e2af",
	"#fab387",
	"#f38ba8",
	"#cba6f7",
	"#1e1e2e",
] as const;
export const FILL_PALETTE = [
	"transparent",
	"#242c38",
	"#1c2b23",
	"#302a1f",
	"#321f24",
	"#2b2338",
	"#fef08a",
	"#bfdbfe",
] as const;

export const DEFAULT_STYLE: ElementStyleDefaults = {
	stroke: "#e8e8e8",
	fill: "transparent",
	strokeWidth: 2,
	strokeStyle: "solid",
	roughness: 1,
	opacity: 1,
	fontSize: 16,
};

/** Deterministic pseudo-random offset so hand-drawn strokes stay stable across renders. */
function hashJitter(seed: number, amplitude: number): number {
	const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return ((x - Math.floor(x)) * 2 - 1) * amplitude;
}

function seedFromId(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
	return Math.abs(hash) + 1;
}

/** Generates a slightly wobbly hand-drawn line between two points when roughness > 0. */
function roughSegment(x1: number, y1: number, x2: number, y2: number, seed: number, roughness: number): string {
	if (roughness <= 0) return `L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
	const length = Math.hypot(x2 - x1, y2 - y1);
	const amp = Math.min(3.2, Math.max(0.6, length * 0.012)) * roughness;
	const mx = (x1 + x2) / 2 + hashJitter(seed + 1, amp);
	const my = (y1 + y2) / 2 + hashJitter(seed + 2, amp);
	const ex = x2 + hashJitter(seed + 3, amp * 0.45);
	const ey = y2 + hashJitter(seed + 4, amp * 0.45);
	return `Q ${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
}

export function elementStrokeDasharray(style?: "solid" | "dashed" | "dotted"): string | undefined {
	if (style === "dashed") return "10 7";
	if (style === "dotted") return "2 6";
	return undefined;
}

/** Smooth quadratic-curve SVG path for freehand strokes. */
export function freedrawPath(points: readonly (readonly [number, number])[]): string {
	if (!points.length) return "";
	if (points.length === 1) {
		const [x, y] = points[0];
		return `M ${x.toFixed(1)} ${y.toFixed(1)} L ${(x + 0.5).toFixed(1)} ${(y + 0.5).toFixed(1)}`;
	}
	let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
	for (let i = 1; i < points.length - 1; i++) {
		const [x1, y1] = points[i];
		const [x2, y2] = points[i + 1];
		const mx = (x1 + x2) / 2;
		const my = (y1 + y2) / 2;
		d += ` Q ${x1.toFixed(1)} ${y1.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
	}
	const last = points[points.length - 1];
	d += ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
	return d;
}

/** Generates an SVG path string in element-local coordinates (0..width, 0..height). */
export function shapePath(element: CanvasElement): string {
	const w = Math.max(1, element.width);
	const h = Math.max(1, element.height);
	const r = element.roughness ?? 1;
	const seed = seedFromId(element.id);
	if (element.type === "rectangle" || element.type === "sticky") {
		if (r <= 0) {
			const radius = element.type === "sticky" ? 6 : Math.min(10, w / 4, h / 4);
			return `M ${radius} 0 H ${w - radius} Q ${w} 0 ${w} ${radius} V ${h - radius} Q ${w} ${h} ${w - radius} ${h} H ${radius} Q 0 ${h} 0 ${h - radius} V ${radius} Q 0 0 ${radius} 0 Z`;
		}
		const o = hashJitter(seed, 0.9 * r);
		return [
			`M ${o.toFixed(1)} ${o.toFixed(1)}`,
			roughSegment(0, 0, w, 0, seed + 10, r),
			roughSegment(w, 0, w, h, seed + 20, r),
			roughSegment(w, h, 0, h, seed + 30, r),
			roughSegment(0, h, 0, 0, seed + 40, r),
			"Z",
		].join(" ");
	}
	if (element.type === "diamond") {
		const cx = w / 2;
		const cy = h / 2;
		return [
			`M ${cx.toFixed(1)} 0`,
			roughSegment(cx, 0, w, cy, seed + 10, r),
			roughSegment(w, cy, cx, h, seed + 20, r),
			roughSegment(cx, h, 0, cy, seed + 30, r),
			roughSegment(0, cy, cx, 0, seed + 40, r),
			"Z",
		].join(" ");
	}
	if (element.type === "ellipse") {
		const rx = w / 2;
		const ry = h / 2;
		if (r <= 0) {
			return `M ${rx.toFixed(1)} 0 A ${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${rx.toFixed(1)} ${h.toFixed(1)} A ${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${rx.toFixed(1)} 0 Z`;
		}
		const steps = 20;
		const pts: [number, number][] = [];
		for (let i = 0; i <= steps; i++) {
			const theta = (i / steps) * Math.PI * 2;
			const jitter = 1 + hashJitter(seed + i * 3, 0.025 * r);
			pts.push([rx + Math.cos(theta) * rx * jitter, ry + Math.sin(theta) * ry * jitter]);
		}
		return `${freedrawPath(pts)} Z`;
	}
	if (element.type === "line" || element.type === "arrow") {
		const pts: readonly (readonly [number, number])[] = element.points?.length
			? element.points
			: [
					[0, 0],
					[w, h],
				];
		if (pts.length === 2) {
			return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} ${roughSegment(pts[0][0], pts[0][1], pts[1][0], pts[1][1], seed + 5, r)}`;
		}
		return freedrawPath(pts);
	}
	if (element.type === "freedraw") {
		return freedrawPath(element.points ?? []);
	}
	return "";
}

/** Arrowhead path at the end of an arrow element (in element-local coordinates). */
export function arrowHeadPath(element: CanvasElement): string {
	if (element.type !== "arrow") return "";
	const pts =
		element.points?.length && element.points.length >= 2
			? element.points
			: [
					[0, 0],
					[element.width, element.height],
				];
	const [x1, y1] = pts[pts.length - 2];
	const [x2, y2] = pts[pts.length - 1];
	const angle = Math.atan2(y2 - y1, x2 - x1);
	const size = Math.max(10, (element.strokeWidth || 2) * 4.5);
	const spread = Math.PI / 6.5;
	const ax = x2 - size * Math.cos(angle - spread);
	const ay = y2 - size * Math.sin(angle - spread);
	const bx = x2 - size * Math.cos(angle + spread);
	const by = y2 - size * Math.sin(angle + spread);
	return `M ${ax.toFixed(1)} ${ay.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)} L ${bx.toFixed(1)} ${by.toFixed(1)}`;
}

export function elementBounds(element: CanvasElement): { x: number; y: number; width: number; height: number } {
	if (element.points?.length) {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const [px, py] of element.points) {
			minX = Math.min(minX, px);
			minY = Math.min(minY, py);
			maxX = Math.max(maxX, px);
			maxY = Math.max(maxY, py);
		}
		return {
			x: element.x + minX,
			y: element.y + minY,
			width: Math.max(12, maxX - minX),
			height: Math.max(12, maxY - minY),
		};
	}
	return {
		x: element.x,
		y: element.y,
		width: Math.max(12, element.width),
		height: Math.max(12, element.height),
	};
}

export function intersectsRect(
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number },
): boolean {
	return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

/** Simplifies raw pointer samples while preserving curves so freedraw JSON stays compact. */
export function simplifyPoints(points: readonly [number, number][], minDistance = 2.5): [number, number][] {
	if (points.length <= 2) return points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
	const result: [number, number][] = [[Math.round(points[0][0] * 10) / 10, Math.round(points[0][1] * 10) / 10]];
	for (let i = 1; i < points.length - 1; i++) {
		const prev = result[result.length - 1];
		if (Math.hypot(points[i][0] - prev[0], points[i][1] - prev[1]) >= minDistance) {
			result.push([Math.round(points[i][0] * 10) / 10, Math.round(points[i][1] * 10) / 10]);
		}
	}
	const last = points[points.length - 1];
	result.push([Math.round(last[0] * 10) / 10, Math.round(last[1] * 10) / 10]);
	return result;
}
