import {
	CANVAS_LIMITS,
	type CanvasDesign,
	type CanvasEdge,
	type CanvasElement,
	type CanvasElementType,
	type CanvasNode,
	isCanvasDocument,
} from "./canvas.ts";

export type CanvasImportSource = "excalidraw" | "tldraw" | "hasilan";

export interface CanvasImportResult {
	source: CanvasImportSource;
	title?: string;
	description?: string;
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	elements: CanvasElement[];
	skippedCount: number;
	warnings: string[];
}

export interface CanvasImportOptions {
	fileName?: string;
	darkCanvas?: boolean;
}

interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const SAFE_SPAN = CANVAS_LIMITS.coordinate * 1.8;

const NAMED_CSS_COLORS: Record<string, string> = {
	transparent: "transparent",
	none: "transparent",
	black: "#000000",
	white: "#ffffff",
	gray: "#808080",
	grey: "#808080",
	red: "#f87171",
	green: "#4ade80",
	blue: "#60a5fa",
	yellow: "#facc15",
	orange: "#fb923c",
	purple: "#a855f7",
	violet: "#a855f7",
	pink: "#f472b6",
	cyan: "#22d3ee",
};

const TLDRAW_DARK_COLORS: Record<string, string> = {
	black: "#e8e8e8",
	grey: "#9ca3af",
	"light-violet": "#d8b4fe",
	violet: "#a855f7",
	blue: "#60a5fa",
	"light-blue": "#93c5fd",
	yellow: "#facc15",
	orange: "#fb923c",
	green: "#4ade80",
	"light-green": "#86efac",
	"light-red": "#fca5a5",
	red: "#f87171",
	white: "#ffffff",
};

const TLDRAW_LIGHT_COLORS: Record<string, string> = {
	black: "#1e1e2e",
	grey: "#6b7280",
	"light-violet": "#c084fc",
	violet: "#7e22ce",
	blue: "#2563eb",
	"light-blue": "#3b82f6",
	yellow: "#ca8a04",
	orange: "#ea580c",
	green: "#16a34a",
	"light-green": "#22c55e",
	"light-red": "#ef4444",
	red: "#dc2626",
	white: "#ffffff",
};

const TLDRAW_NOTE_FILLS: Record<string, string> = {
	black: "#fef08a",
	yellow: "#fef08a",
	grey: "#e5e7eb",
	"light-violet": "#f3e8ff",
	violet: "#e9d5ff",
	blue: "#bfdbfe",
	"light-blue": "#dbeafe",
	orange: "#fed7aa",
	green: "#bbf7d0",
	"light-green": "#dcfce7",
	"light-red": "#fecaca",
	red: "#fca5a5",
	white: "#ffffff",
};

const TLDRAW_STROKE_WIDTHS: Record<string, number> = {
	s: 1.5,
	m: 2.5,
	l: 4,
	xl: 6,
};

const TLDRAW_FONT_SIZES: Record<string, number> = {
	s: 14,
	m: 18,
	l: 24,
	xl: 34,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function clampCoord(value: number): number {
	return round1(clamp(value, -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate));
}

function clampDim(value: number): number {
	return round1(clamp(value, 0, CANVAS_LIMITS.dimension));
}

function truncate(value: string, maxLength: number): string {
	return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function hexByte(value: number): string {
	return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

/** Normalizes hex, rgb()/rgba(), or named colors to our schema's transparent | #hex format. */
export function normalizeCanvasColor(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return fallback;
	if (trimmed === "transparent" || trimmed === "none") return "transparent";
	if (/^#[0-9a-f]{3,8}$/.test(trimmed)) return trimmed;
	const named = NAMED_CSS_COLORS[trimmed];
	if (named) return named;
	const rgb = /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/.exec(
		trimmed,
	);
	if (rgb) {
		const r = hexByte(Number(rgb[1]));
		const g = hexByte(Number(rgb[2]));
		const b = hexByte(Number(rgb[3]));
		if (rgb[4] !== undefined) {
			const rawAlpha = rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
			if (Number.isFinite(rawAlpha) && rawAlpha < 0.995) {
				if (rawAlpha <= 0.01) return "transparent";
				return `#${r}${g}${b}${hexByte(rawAlpha * 255)}`;
			}
		}
		return `#${r}${g}${b}`;
	}
	return fallback;
}

function hexLuminance(hex: string): number | undefined {
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
	if (!match) return undefined;
	const raw = match[1];
	const full = raw.length === 3 ? `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}` : raw.slice(0, 6);
	const r = Number.parseInt(full.slice(0, 2), 16) / 255;
	const g = Number.parseInt(full.slice(2, 4), 16) / 255;
	const b = Number.parseInt(full.slice(4, 6), 16) / 255;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function withAlphaHex(hex: string, alphaHex: string): string {
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex);
	if (!match) return hex;
	const raw = match[1];
	const full = raw.length === 3 ? `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}` : raw;
	return `#${full}${alphaHex}`;
}

function adaptExcalidrawStroke(stroke: string, fill: string, darkCanvas: boolean): string {
	if (!darkCanvas || stroke === "transparent") return stroke;
	const strokeLum = hexLuminance(stroke);
	if (strokeLum === undefined || strokeLum > 0.14) return stroke;
	// Keep dark ink on light filled shapes (like pastel boxes) so contrast stays readable.
	if (fill !== "transparent") {
		const fillLum = hexLuminance(fill);
		if (fillLum !== undefined && fillLum > 0.48) return stroke;
	}
	return "#e8e8e8";
}

function downsamplePoints(points: [number, number][], maxPoints = CANVAS_LIMITS.points): [number, number][] {
	if (points.length <= maxPoints) return points;
	const result: [number, number][] = [];
	const step = (points.length - 1) / (maxPoints - 1);
	for (let i = 0; i < maxPoints - 1; i++) {
		result.push(points[Math.round(i * step)]);
	}
	result.push(points[points.length - 1]);
	return result;
}

function simplifyAndBoundPoints(rawPoints: [number, number][], minDistance = 1.5): [number, number][] {
	if (rawPoints.length <= 2) {
		return rawPoints.map(([x, y]) => [clampCoord(x), clampCoord(y)]);
	}
	const simplified: [number, number][] = [[clampCoord(rawPoints[0][0]), clampCoord(rawPoints[0][1])]];
	for (let i = 1; i < rawPoints.length - 1; i++) {
		const prev = simplified[simplified.length - 1];
		const nx = clampCoord(rawPoints[i][0]);
		const ny = clampCoord(rawPoints[i][1]);
		if (Math.hypot(nx - prev[0], ny - prev[1]) >= minDistance) {
			simplified.push([nx, ny]);
		}
	}
	const last = rawPoints[rawPoints.length - 1];
	simplified.push([clampCoord(last[0]), clampCoord(last[1])]);
	return downsamplePoints(simplified, CANVAS_LIMITS.points);
}

function normalizePointOrigin(
	x: number,
	y: number,
	points: [number, number][],
): { x: number; y: number; width: number; height: number; points: [number, number][] } {
	let minPx = Number.POSITIVE_INFINITY;
	let minPy = Number.POSITIVE_INFINITY;
	let maxPx = Number.NEGATIVE_INFINITY;
	let maxPy = Number.NEGATIVE_INFINITY;
	for (const [px, py] of points) {
		minPx = Math.min(minPx, px);
		minPy = Math.min(minPy, py);
		maxPx = Math.max(maxPx, px);
		maxPy = Math.max(maxPy, py);
	}
	return {
		x: round1(x + minPx),
		y: round1(y + minPy),
		width: Math.max(1, round1(maxPx - minPx)),
		height: Math.max(1, round1(maxPy - minPy)),
		points: points.map(([px, py]) => [round1(px - minPx), round1(py - minPy)]),
	};
}

function allocateId(preferred: unknown, prefix: string, used: Set<string>): string {
	const cleaned =
		typeof preferred === "string"
			? preferred
					.replace(/[^A-Za-z0-9_-]+/g, "_")
					.replace(/^_+|_+$/g, "")
					.slice(0, 64)
			: "";
	let base = cleaned ? (cleaned.startsWith(`${prefix}_`) ? cleaned : `${prefix}_${cleaned}`).slice(0, 72) : "";
	if (!base) {
		let index = 1;
		while (used.has(`${prefix}${index}`)) index += 1;
		base = `${prefix}${index}`;
	}
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let suffix = 2;
	while (used.has(`${base.slice(0, 70)}_${suffix}`)) suffix += 1;
	const unique = `${base.slice(0, 70)}_${suffix}`;
	used.add(unique);
	return unique;
}

function titleFromFileName(fileName?: string): string | undefined {
	if (!fileName) return undefined;
	const base = fileName
		.replace(/^.*[\\/]/, "")
		.replace(/\.(excalidraw\.svg|excalidraw|tldr|json|svg)$/i, "")
		.trim();
	return base ? truncate(base, CANVAS_LIMITS.title) : undefined;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
	const normalized = base64.replace(/\s+/g, "");
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function inflateZlibBytes(bytes: Uint8Array): Promise<string> {
	const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate"));
	const buffer = await new Response(stream).arrayBuffer();
	return new TextDecoder("utf-8").decode(buffer);
}

/** Extracts embedded Excalidraw scene JSON from an exported .excalidraw.svg file. */
async function extractExcalidrawFromSvg(svg: string): Promise<unknown> {
	const match = /<!--\s*payload-start\s*-->([\s\S]*?)<!--\s*payload-end\s*-->/.exec(svg);
	if (!match?.[1]) {
		throw new Error("この SVG には Excalidraw の埋め込みシーンデータが含まれていません。");
	}
	const payload = match[1].trim();
	let decodedText: string;
	try {
		const bytes = decodeBase64ToBytes(payload);
		// Some exporters embed raw zlib bytes directly; others base64-encode a JSON envelope.
		if (bytes.length >= 2 && bytes[0] === 0x78) {
			decodedText = await inflateZlibBytes(bytes);
		} else {
			decodedText = new TextDecoder("utf-8").decode(bytes);
		}
	} catch {
		decodedText = payload;
	}
	const parsed: unknown = JSON.parse(decodedText);
	if (isRecord(parsed) && typeof parsed.encoded === "string") {
		if (parsed.compressed === true) {
			const bytes = new Uint8Array(parsed.encoded.length);
			for (let i = 0; i < parsed.encoded.length; i++) bytes[i] = parsed.encoded.charCodeAt(i) & 0xff;
			const inflated = await inflateZlibBytes(bytes);
			return JSON.parse(inflated) as unknown;
		}
		return JSON.parse(parsed.encoded) as unknown;
	}
	return parsed;
}

/** Decodes an IEEE 754 binary16 (Float16) 16-bit integer to a JS number. */
export function decodeFloat16(bits: number): number {
	const sign = bits & 0x8000 ? -1 : 1;
	const exponent = (bits >> 10) & 0x1f;
	const fraction = bits & 0x03ff;
	if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
	if (exponent === 0x1f) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
	return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Decodes tldraw v4+ b64Vecs delta-encoded draw segment paths (Float32 first point + Float16 deltas). */
export function decodeTldrawB64Points(path: string, dimHint?: number): [number, number][] {
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64ToBytes(path);
	} catch {
		return [];
	}
	const dim =
		dimHint === 2 || dimHint === 3
			? dimHint
			: bytes.length >= 12 && (bytes.length - 12) % 6 === 0
				? 3
				: bytes.length >= 8 && (bytes.length - 8) % 4 === 0
					? 2
					: 0;
	if (!dim) return [];
	const firstBytes = dim * 4;
	const deltaBytes = dim * 2;
	if (bytes.length < firstBytes) return [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let x = view.getFloat32(0, true);
	let y = view.getFloat32(4, true);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
	const points: [number, number][] = [[x, y]];
	for (let offset = firstBytes; offset + deltaBytes <= bytes.length; offset += deltaBytes) {
		const dx = decodeFloat16(view.getUint16(offset, true));
		const dy = decodeFloat16(view.getUint16(offset + 2, true));
		if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
		x += dx;
		y += dy;
		points.push([x, y]);
	}
	return points;
}

function extractTldrawRichText(node: unknown): string {
	if (!isRecord(node)) return "";
	if (node.type === "text" && typeof node.text === "string") return node.text;
	if (node.type === "hardBreak") return "\n";
	if (!Array.isArray(node.content)) return "";
	const parts = node.content.map((child) => extractTldrawRichText(child));
	if (node.type === "doc" || node.type === "bulletList" || node.type === "orderedList") {
		return parts.join("\n");
	}
	return parts.join("");
}

function extractTldrawText(props: Record<string, unknown>): string {
	if (typeof props.text === "string") return props.text;
	if (isRecord(props.richText)) return extractTldrawRichText(props.richText);
	return "";
}

function parseExcalidrawDocument(data: Record<string, unknown>, options: CanvasImportOptions): CanvasImportResult {
	const darkCanvas = options.darkCanvas ?? true;
	const rawElements = Array.isArray(data.elements) ? data.elements.filter(isRecord) : [];
	const liveElements = rawElements.filter((item) => item.isDeleted !== true);

	// Index bound text elements by containerId so box labels merge cleanly into their parent shape.
	const containerTypeById = new Map<string, string>();
	for (const item of liveElements) {
		if (typeof item.id === "string" && typeof item.type === "string") {
			containerTypeById.set(item.id, item.type);
		}
	}
	const boundTextByContainer = new Map<string, Record<string, unknown>>();
	const mergedTextIds = new Set<string>();
	for (const item of liveElements) {
		if (item.type !== "text" || typeof item.containerId !== "string") continue;
		const containerType = containerTypeById.get(item.containerId);
		if (containerType === "rectangle" || containerType === "ellipse" || containerType === "diamond") {
			boundTextByContainer.set(item.containerId, item);
			if (typeof item.id === "string") mergedTextIds.add(item.id);
		}
	}

	const usedIds = new Set<string>();
	const elements: CanvasElement[] = [];
	let skippedCount = 0;

	for (const item of liveElements) {
		const rawType = typeof item.type === "string" ? item.type : "";
		const rawId = typeof item.id === "string" ? item.id : undefined;
		if (rawId && mergedTextIds.has(rawId)) continue;

		const rawStroke = normalizeCanvasColor(item.strokeColor, darkCanvas ? "#e8e8e8" : "#1e1e2e");
		const fill = normalizeCanvasColor(item.backgroundColor, "transparent");
		const stroke = adaptExcalidrawStroke(rawStroke, fill, darkCanvas);
		const strokeWidth = clamp(finiteNumber(item.strokeWidth, 2), 0.5, 24);
		const strokeStyle =
			item.strokeStyle === "dashed" || item.strokeStyle === "dotted" ? item.strokeStyle : ("solid" as const);
		const roughness = clamp(finiteNumber(item.roughness, 1), 0, 3);
		const rawOpacity = finiteNumber(item.opacity, 100);
		const opacity = clamp(rawOpacity > 1 ? rawOpacity / 100 : rawOpacity, 0.05, 1);

		let x = finiteNumber(item.x, 0);
		let y = finiteNumber(item.y, 0);
		let width = finiteNumber(item.width, 0);
		let height = finiteNumber(item.height, 0);

		if (rawType === "rectangle" || rawType === "ellipse" || rawType === "diamond") {
			if (width < 0) {
				x += width;
				width = Math.abs(width);
			}
			if (height < 0) {
				y += height;
				height = Math.abs(height);
			}
			const boundText = rawId ? boundTextByContainer.get(rawId) : undefined;
			const label = typeof boundText?.text === "string" ? truncate(boundText.text, CANVAS_LIMITS.text) : undefined;
			const fontSize = boundText ? clamp(finiteNumber(boundText.fontSize, 16), 10, 96) : undefined;
			elements.push({
				id: allocateId(rawId, "ex", usedIds),
				type: rawType,
				x: round1(x),
				y: round1(y),
				width: Math.max(4, round1(width)),
				height: Math.max(4, round1(height)),
				stroke,
				fill,
				strokeWidth,
				strokeStyle,
				opacity,
				roughness,
				...(label ? { text: label } : {}),
				...(fontSize ? { fontSize } : {}),
			});
			continue;
		}

		if (rawType === "frame" || rawType === "magicframe") {
			if (width < 0) {
				x += width;
				width = Math.abs(width);
			}
			if (height < 0) {
				y += height;
				height = Math.abs(height);
			}
			const frameStroke = rawStroke === "transparent" ? (darkCanvas ? "#6b7280" : "#9ca3af") : stroke;
			elements.push({
				id: allocateId(rawId, "ex", usedIds),
				type: "rectangle",
				x: round1(x),
				y: round1(y),
				width: Math.max(20, round1(width)),
				height: Math.max(20, round1(height)),
				stroke: frameStroke,
				fill: "transparent",
				strokeWidth: 1.5,
				strokeStyle: "dashed",
				opacity,
				roughness: 0,
			});
			const frameName = typeof item.name === "string" ? item.name.trim() : "";
			if (frameName) {
				elements.push({
					id: allocateId(rawId ? `${rawId}_label` : undefined, "ex", usedIds),
					type: "text",
					x: round1(x + 4),
					y: round1(y - 26),
					width: Math.max(80, Math.min(480, frameName.length * 14 + 24)),
					height: 26,
					stroke: frameStroke,
					fill: "transparent",
					strokeWidth: 1,
					opacity,
					roughness: 0,
					text: truncate(frameName, CANVAS_LIMITS.text),
					fontSize: 14,
				});
			}
			continue;
		}

		if (rawType === "text") {
			const text = typeof item.text === "string" ? item.text : "";
			if (!text.trim()) continue;
			const fontSize = clamp(finiteNumber(item.fontSize, 18), 10, 96);
			const lines = text.split("\n");
			const longest = Math.max(...lines.map((line) => line.length), 1);
			const boxW = Math.max(48, (width > 0 ? width : longest * fontSize * 0.72) + 14);
			const boxH = Math.max(24, height > 0 ? height : lines.length * fontSize * 1.4 + 8);
			elements.push({
				id: allocateId(rawId, "ex", usedIds),
				type: "text",
				x: round1(x),
				y: round1(y),
				width: round1(boxW),
				height: round1(boxH),
				stroke: stroke === "transparent" ? (darkCanvas ? "#e8e8e8" : "#1e1e2e") : stroke,
				fill: "transparent",
				strokeWidth: 1,
				opacity,
				roughness: 0,
				text: truncate(text, CANVAS_LIMITS.text),
				fontSize,
			});
			continue;
		}

		if (rawType === "line" || rawType === "arrow" || rawType === "freedraw") {
			const rawPts = Array.isArray(item.points) ? item.points : [];
			const parsedPts: [number, number][] = [];
			for (const pt of rawPts) {
				if (Array.isArray(pt) && pt.length >= 2) {
					const px = finiteNumber(pt[0], Number.NaN);
					const py = finiteNumber(pt[1], Number.NaN);
					if (Number.isFinite(px) && Number.isFinite(py)) parsedPts.push([px, py]);
				}
			}
			if (parsedPts.length === 0) {
				if (rawType === "freedraw") continue;
				parsedPts.push([0, 0], [width || 80, height || 0]);
			}
			let elementType: CanvasElementType = rawType;
			if (rawType === "arrow") {
				const hasEnd = item.endArrowhead !== null;
				const hasStart = item.startArrowhead !== null && item.startArrowhead !== undefined;
				if (!hasEnd && !hasStart) {
					elementType = "line";
				} else if (!hasEnd && hasStart) {
					parsedPts.reverse();
				}
			}
			const pts = rawType === "freedraw" ? simplifyAndBoundPoints(parsedPts, 1.8) : downsamplePoints(parsedPts);
			const geom = normalizePointOrigin(x, y, pts);
			elements.push({
				id: allocateId(rawId, "ex", usedIds),
				type: elementType,
				x: geom.x,
				y: geom.y,
				width: geom.width,
				height: geom.height,
				stroke: stroke === "transparent" ? (darkCanvas ? "#e8e8e8" : "#1e1e2e") : stroke,
				fill: rawType === "line" && fill !== "transparent" ? fill : "transparent",
				strokeWidth,
				strokeStyle,
				opacity,
				roughness: rawType === "freedraw" ? 0 : roughness,
				points: geom.points,
			});
			continue;
		}

		skippedCount += 1;
	}

	const appState = isRecord(data.appState) ? data.appState : undefined;
	const docTitle =
		typeof appState?.name === "string" && appState.name.trim()
			? truncate(appState.name.trim(), CANVAS_LIMITS.title)
			: titleFromFileName(options.fileName);

	return {
		source: "excalidraw",
		title: docTitle,
		nodes: [],
		edges: [],
		elements,
		skippedCount,
		warnings: skippedCount > 0 ? [`未対応の要素 ${skippedCount} 件（画像・埋め込み等）をスキップしました。`] : [],
	};
}

interface TldrawShapeRecord {
	id: string;
	type: string;
	parentId: string;
	index: string;
	x: number;
	y: number;
	rotation: number;
	opacity: number;
	props: Record<string, unknown>;
}

interface TldrawBindingRecord {
	fromId: string;
	toId: string;
	terminal: "start" | "end";
	anchorX: number;
	anchorY: number;
}

function compareFractionalIndex(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function extractTldrawRecords(data: Record<string, unknown>): {
	title?: string;
	pages: { id: string; index: string; name: string }[];
	shapes: TldrawShapeRecord[];
	bindings: TldrawBindingRecord[];
} {
	const rawRecords: Record<string, unknown>[] = [];
	if (Array.isArray(data.records)) {
		for (const record of data.records) {
			if (isRecord(record)) rawRecords.push(record);
		}
	} else if (isRecord(data.store)) {
		for (const record of Object.values(data.store)) {
			if (isRecord(record)) rawRecords.push(record);
		}
	} else if (isRecord(data.document) && isRecord(data.document.store)) {
		for (const record of Object.values(data.document.store)) {
			if (isRecord(record)) rawRecords.push(record);
		}
	} else if (Array.isArray(data.shapes)) {
		for (const shape of data.shapes) {
			if (isRecord(shape)) rawRecords.push({ typeName: "shape", ...shape });
		}
		if (Array.isArray(data.bindings)) {
			for (const binding of data.bindings) {
				if (isRecord(binding)) rawRecords.push({ typeName: "binding", ...binding });
			}
		}
	}

	let title: string | undefined;
	const pages: { id: string; index: string; name: string }[] = [];
	const shapes: TldrawShapeRecord[] = [];
	const bindings: TldrawBindingRecord[] = [];

	for (const record of rawRecords) {
		const typeName = typeof record.typeName === "string" ? record.typeName : "";
		if (typeName === "document" && typeof record.name === "string" && record.name.trim()) {
			title = truncate(record.name.trim(), CANVAS_LIMITS.title);
			continue;
		}
		if (typeName === "page" && typeof record.id === "string") {
			pages.push({
				id: record.id,
				index: typeof record.index === "string" ? record.index : "a1",
				name: typeof record.name === "string" ? record.name : "",
			});
			continue;
		}
		if (typeName === "binding" && record.type === "arrow" && isRecord(record.props)) {
			const fromId = typeof record.fromId === "string" ? record.fromId : "";
			const toId = typeof record.toId === "string" ? record.toId : "";
			const terminal =
				record.props.terminal === "start" || record.props.terminal === "end" ? record.props.terminal : undefined;
			const anchor = isRecord(record.props.normalizedAnchor) ? record.props.normalizedAnchor : undefined;
			if (fromId && toId && terminal) {
				bindings.push({
					fromId,
					toId,
					terminal,
					anchorX: clamp(finiteNumber(anchor?.x, 0.5), 0, 1),
					anchorY: clamp(finiteNumber(anchor?.y, 0.5), 0, 1),
				});
			}
			continue;
		}
		if (
			typeName === "shape" &&
			typeof record.id === "string" &&
			typeof record.type === "string" &&
			isRecord(record.props)
		) {
			shapes.push({
				id: record.id,
				type: record.type,
				parentId: typeof record.parentId === "string" ? record.parentId : "page:page",
				index: typeof record.index === "string" ? record.index : "a1",
				x: finiteNumber(record.x, 0),
				y: finiteNumber(record.y, 0),
				rotation: finiteNumber(record.rotation, 0),
				opacity: clamp(finiteNumber(record.opacity, 1), 0.05, 1),
				props: record.props,
			});
		}
	}

	pages.sort((a, b) => compareFractionalIndex(a.index, b.index));
	shapes.sort((a, b) => compareFractionalIndex(a.index, b.index));
	return { title, pages, shapes, bindings };
}

function tldrawColor(value: unknown, darkCanvas: boolean): string {
	if (typeof value === "string") {
		const lower = value.trim().toLowerCase();
		const palette = darkCanvas ? TLDRAW_DARK_COLORS : TLDRAW_LIGHT_COLORS;
		if (palette[lower]) return palette[lower];
	}
	return normalizeCanvasColor(value, darkCanvas ? "#e8e8e8" : "#1e1e2e");
}

function tldrawFill(fillKind: unknown, strokeHex: string, darkCanvas: boolean): string {
	if (typeof fillKind !== "string" || fillKind === "none") return "transparent";
	if (fillKind === "semi") return darkCanvas ? "#1f242d" : "#f3f4f6";
	if (fillKind === "solid") return withAlphaHex(strokeHex, darkCanvas ? "38" : "2e");
	if (fillKind === "fill") return withAlphaHex(strokeHex, darkCanvas ? "52" : "40");
	if (fillKind === "pattern" || fillKind === "lined-fill") return withAlphaHex(strokeHex, "28");
	return normalizeCanvasColor(fillKind, "transparent");
}

function tldrawDash(dash: unknown): { strokeStyle: "solid" | "dashed" | "dotted"; roughness: number } {
	if (dash === "dashed") return { strokeStyle: "dashed", roughness: 0 };
	if (dash === "dotted") return { strokeStyle: "dotted", roughness: 0 };
	if (dash === "solid") return { strokeStyle: "solid", roughness: 0 };
	return { strokeStyle: "solid", roughness: 1 };
}

function parseTldrawDocument(data: Record<string, unknown>, options: CanvasImportOptions): CanvasImportResult {
	const darkCanvas = options.darkCanvas ?? true;
	const { title, pages, shapes, bindings } = extractTldrawRecords(data);
	const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));

	// Resolve world (x, y) and owning pageId for each shape by walking parentId through groups and frames.
	const worldCache = new Map<string, { x: number; y: number; pageId: string }>();
	function resolveWorld(
		shape: TldrawShapeRecord,
		visited = new Set<string>(),
	): { x: number; y: number; pageId: string } {
		const cached = worldCache.get(shape.id);
		if (cached) return cached;
		if (visited.has(shape.id)) return { x: shape.x, y: shape.y, pageId: shape.parentId };
		visited.add(shape.id);
		const parent = shapeById.get(shape.parentId);
		if (!parent) {
			const result = { x: shape.x, y: shape.y, pageId: shape.parentId };
			worldCache.set(shape.id, result);
			return result;
		}
		const parentWorld = resolveWorld(parent, visited);
		const cos = Math.cos(parent.rotation);
		const sin = Math.sin(parent.rotation);
		const x = parentWorld.x + shape.x * cos - shape.y * sin;
		const y = parentWorld.y + shape.x * sin + shape.y * cos;
		const result = { x, y, pageId: parentWorld.pageId };
		worldCache.set(shape.id, result);
		return result;
	}

	// Precompute world boxes for arrow binding resolution.
	const shapeBoxes = new Map<string, { x: number; y: number; width: number; height: number }>();
	for (const shape of shapes) {
		const world = resolveWorld(shape);
		if (shape.type === "geo" || shape.type === "frame") {
			shapeBoxes.set(shape.id, {
				x: world.x,
				y: world.y,
				width: Math.max(10, finiteNumber(shape.props.w, 120)),
				height: Math.max(10, finiteNumber(shape.props.h, 80) + finiteNumber(shape.props.growY, 0)),
			});
		} else if (shape.type === "note") {
			shapeBoxes.set(shape.id, {
				x: world.x,
				y: world.y,
				width: 200,
				height: 200 + finiteNumber(shape.props.growY, 0),
			});
		} else if (shape.type === "text") {
			shapeBoxes.set(shape.id, {
				x: world.x,
				y: world.y,
				width: Math.max(60, finiteNumber(shape.props.w, 160)),
				height: 40,
			});
		}
	}

	const bindingsByArrow = new Map<string, TldrawBindingRecord[]>();
	for (const binding of bindings) {
		const list = bindingsByArrow.get(binding.fromId);
		if (list) list.push(binding);
		else bindingsByArrow.set(binding.fromId, [binding]);
	}

	// Group shapes by page so multi-page .tldr files lay out side-by-side without overlapping.
	const pageOrder = pages.map((page) => page.id);
	const pageIds: string[] = [];
	for (const id of pageOrder) pageIds.push(id);
	for (const shape of shapes) {
		const { pageId } = resolveWorld(shape);
		if (!pageIds.includes(pageId)) pageIds.push(pageId);
	}

	const usedIds = new Set<string>();
	const allElements: CanvasElement[] = [];
	let skippedCount = 0;
	let nextPageOffsetX = 0;

	for (const pageId of pageIds) {
		const pageShapes = shapes.filter((shape) => resolveWorld(shape).pageId === pageId);
		if (!pageShapes.length) continue;

		const pageElements: CanvasElement[] = [];

		for (const shape of pageShapes) {
			if (shape.type === "group") continue;
			const world = resolveWorld(shape);
			const props = shape.props;
			const sizeKey = typeof props.size === "string" ? props.size : "m";
			const strokeWidth = TLDRAW_STROKE_WIDTHS[sizeKey] ?? 2.5;
			const fontSize = TLDRAW_FONT_SIZES[sizeKey] ?? 18;
			const { strokeStyle, roughness } = tldrawDash(props.dash);
			const stroke = tldrawColor(props.color, darkCanvas);
			const opacity = shape.opacity;

			if (shape.type === "geo") {
				const geo = typeof props.geo === "string" ? props.geo : "rectangle";
				const type: CanvasElementType =
					geo === "ellipse" || geo === "oval"
						? "ellipse"
						: geo === "diamond" || geo === "rhombus" || geo === "rhombus-2"
							? "diamond"
							: "rectangle";
				const width = Math.max(8, finiteNumber(props.w, 140));
				const height = Math.max(8, finiteNumber(props.h, 80) + finiteNumber(props.growY, 0));
				const label = extractTldrawText(props);
				pageElements.push({
					id: allocateId(shape.id, "tl", usedIds),
					type,
					x: round1(world.x),
					y: round1(world.y),
					width: round1(width),
					height: round1(height),
					stroke,
					fill: tldrawFill(props.fill, stroke, darkCanvas),
					strokeWidth,
					strokeStyle,
					opacity,
					roughness,
					...(label ? { text: truncate(label, CANVAS_LIMITS.text), fontSize } : {}),
				});
				continue;
			}

			if (shape.type === "note") {
				const colorKey = typeof props.color === "string" ? props.color.toLowerCase() : "yellow";
				const noteFill = TLDRAW_NOTE_FILLS[colorKey] ?? "#fef08a";
				const text = extractTldrawText(props);
				pageElements.push({
					id: allocateId(shape.id, "tl", usedIds),
					type: "sticky",
					x: round1(world.x),
					y: round1(world.y),
					width: 200,
					height: round1(200 + Math.max(0, finiteNumber(props.growY, 0))),
					stroke: "#ca8a04",
					fill: noteFill,
					strokeWidth: 1.5,
					strokeStyle: "solid",
					opacity,
					roughness: 0.5,
					text: truncate(text, CANVAS_LIMITS.text),
					fontSize,
				});
				continue;
			}

			if (shape.type === "text") {
				const text = extractTldrawText(props);
				if (!text.trim()) continue;
				const lines = text.split("\n");
				const longest = Math.max(...lines.map((line) => line.length), 1);
				const autoSize = props.autoSize !== false;
				const width = autoSize
					? Math.max(60, longest * fontSize * 0.72 + 16)
					: Math.max(60, finiteNumber(props.w, 180) + 12);
				const height = Math.max(28, lines.length * fontSize * 1.4 + 8);
				pageElements.push({
					id: allocateId(shape.id, "tl", usedIds),
					type: "text",
					x: round1(world.x),
					y: round1(world.y),
					width: round1(width),
					height: round1(height),
					stroke,
					fill: "transparent",
					strokeWidth: 1,
					opacity,
					roughness: 0,
					text: truncate(text, CANVAS_LIMITS.text),
					fontSize,
				});
				continue;
			}

			if (shape.type === "frame") {
				const width = Math.max(40, finiteNumber(props.w, 320));
				const height = Math.max(40, finiteNumber(props.h, 240));
				const frameStroke = darkCanvas ? "#6b7280" : "#9ca3af";
				pageElements.push({
					id: allocateId(shape.id, "tl", usedIds),
					type: "rectangle",
					x: round1(world.x),
					y: round1(world.y),
					width: round1(width),
					height: round1(height),
					stroke: frameStroke,
					fill: "transparent",
					strokeWidth: 1.5,
					strokeStyle: "dashed",
					opacity,
					roughness: 0,
				});
				const name = typeof props.name === "string" ? props.name.trim() : "";
				if (name) {
					pageElements.push({
						id: allocateId(`${shape.id}_label`, "tl", usedIds),
						type: "text",
						x: round1(world.x + 4),
						y: round1(world.y - 26),
						width: Math.max(80, Math.min(480, name.length * 14 + 24)),
						height: 26,
						stroke: frameStroke,
						fill: "transparent",
						strokeWidth: 1,
						opacity,
						roughness: 0,
						text: truncate(name, CANVAS_LIMITS.text),
						fontSize: 14,
					});
				}
				continue;
			}

			if (shape.type === "line") {
				const rawPoints: [number, number][] = [];
				if (Array.isArray(props.points)) {
					for (const pt of props.points) {
						if (isRecord(pt)) {
							const px = finiteNumber(pt.x, Number.NaN);
							const py = finiteNumber(pt.y, Number.NaN);
							if (Number.isFinite(px) && Number.isFinite(py)) rawPoints.push([px, py]);
						}
					}
				} else if (isRecord(props.points)) {
					const entries = Object.values(props.points)
						.filter(isRecord)
						.sort((a, b) =>
							compareFractionalIndex(
								typeof a.index === "string" ? a.index : "",
								typeof b.index === "string" ? b.index : "",
							),
						);
					for (const pt of entries) {
						const px = finiteNumber(pt.x, Number.NaN);
						const py = finiteNumber(pt.y, Number.NaN);
						if (Number.isFinite(px) && Number.isFinite(py)) rawPoints.push([px, py]);
					}
				}
				if (rawPoints.length < 2) continue;
				const pts = downsamplePoints(rawPoints);
				const geom = normalizePointOrigin(world.x, world.y, pts);
				pageElements.push({
					id: allocateId(shape.id, "tl", usedIds),
					type: "line",
					x: geom.x,
					y: geom.y,
					width: geom.width,
					height: geom.height,
					stroke,
					fill: "transparent",
					strokeWidth,
					strokeStyle,
					opacity,
					roughness,
					points: geom.points,
				});
				continue;
			}

			if (shape.type === "arrow") {
				const arrowBindings = bindingsByArrow.get(shape.id) ?? [];
				const resolveEndpoint = (terminal: "start" | "end", raw: unknown): [number, number] => {
					const binding = arrowBindings.find((entry) => entry.terminal === terminal);
					if (binding) {
						const box = shapeBoxes.get(binding.toId);
						if (box) {
							return [
								box.x + box.width * binding.anchorX - world.x,
								box.y + box.height * binding.anchorY - world.y,
							];
						}
					}
					if (isRecord(raw)) {
						if (raw.type === "binding" && typeof raw.boundShapeId === "string") {
							const box = shapeBoxes.get(raw.boundShapeId);
							const anchor = isRecord(raw.normalizedAnchor) ? raw.normalizedAnchor : undefined;
							if (box) {
								return [
									box.x + box.width * clamp(finiteNumber(anchor?.x, 0.5), 0, 1) - world.x,
									box.y + box.height * clamp(finiteNumber(anchor?.y, 0.5), 0, 1) - world.y,
								];
							}
						}
						const px = finiteNumber(raw.x, Number.NaN);
						const py = finiteNumber(raw.y, Number.NaN);
						if (Number.isFinite(px) && Number.isFinite(py)) return [px, py];
					}
					return terminal === "start" ? [0, 0] : [100, 0];
				};

				const start = resolveEndpoint("start", props.start);
				const end = resolveEndpoint("end", props.end);
				const bend = finiteNumber(props.bend, 0);
				const points: [number, number][] = [start];
				if (Math.abs(bend) > 1) {
					const dx = end[0] - start[0];
					const dy = end[1] - start[1];
					const len = Math.hypot(dx, dy);
					if (len > 1) {
						const nx = -dy / len;
						const ny = dx / len;
						points.push([(start[0] + end[0]) / 2 + nx * bend, (start[1] + end[1]) / 2 + ny * bend]);
					}
				}
				points.push(end);

				const hasEndHead = props.arrowheadEnd !== "none";
				const hasStartHead = typeof props.arrowheadStart === "string" && props.arrowheadStart !== "none";
				let type: CanvasElementType = "arrow";
				if (!hasEndHead && !hasStartHead) {
					type = "line";
				} else if (!hasEndHead && hasStartHead) {
					points.reverse();
				}

				const geom = normalizePointOrigin(world.x, world.y, points);
				pageElements.push({
					id: allocateId(shape.id, "tl", usedIds),
					type,
					x: geom.x,
					y: geom.y,
					width: geom.width,
					height: geom.height,
					stroke,
					fill: "transparent",
					strokeWidth,
					strokeStyle,
					opacity,
					roughness,
					points: geom.points,
				});

				const arrowText = extractTldrawText(props).trim();
				if (arrowText) {
					const mid = points.length === 3 ? points[1] : [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
					const labelW = Math.max(48, Math.min(320, arrowText.length * 9 + 16));
					pageElements.push({
						id: allocateId(`${shape.id}_label`, "tl", usedIds),
						type: "text",
						x: round1(world.x + mid[0] - labelW / 2),
						y: round1(world.y + mid[1] - 24),
						width: round1(labelW),
						height: 24,
						stroke: tldrawColor(props.labelColor ?? props.color, darkCanvas),
						fill: "transparent",
						strokeWidth: 1,
						opacity,
						roughness: 0,
						text: truncate(arrowText, CANVAS_LIMITS.text),
						fontSize: Math.min(fontSize, 15),
					});
				}
				continue;
			}

			if (shape.type === "draw" || shape.type === "highlight") {
				const segments = Array.isArray(props.segments) ? props.segments.filter(isRecord) : [];
				const rawPoints: [number, number][] = [];
				for (const segment of segments) {
					if (typeof segment.path === "string" && segment.path.length > 0) {
						const dim = typeof segment.dim === "number" ? segment.dim : undefined;
						rawPoints.push(...decodeTldrawB64Points(segment.path, dim));
					} else if (Array.isArray(segment.points)) {
						for (const pt of segment.points) {
							if (isRecord(pt)) {
								const px = finiteNumber(pt.x, Number.NaN);
								const py = finiteNumber(pt.y, Number.NaN);
								if (Number.isFinite(px) && Number.isFinite(py)) rawPoints.push([px, py]);
							}
						}
					}
				}
				if (!rawPoints.length) continue;
				const pts = simplifyAndBoundPoints(rawPoints, 1.8);
				const geom = normalizePointOrigin(world.x, world.y, pts);
				const isHighlight = shape.type === "highlight";
				pageElements.push({
					id: allocateId(shape.id, "tl", usedIds),
					type: "freedraw",
					x: geom.x,
					y: geom.y,
					width: geom.width,
					height: geom.height,
					stroke,
					fill: "transparent",
					strokeWidth: isHighlight ? Math.min(24, strokeWidth * 4) : strokeWidth,
					strokeStyle: isHighlight ? "solid" : strokeStyle,
					opacity: isHighlight ? Math.min(opacity, 0.35) : opacity,
					roughness: 0,
					points: geom.points,
				});
				continue;
			}

			skippedCount += 1;
		}

		if (!pageElements.length) continue;

		if (allElements.length > 0) {
			const pageBox = computeElementsBBox([], pageElements);
			if (pageBox) {
				const dx = nextPageOffsetX - pageBox.minX;
				for (const el of pageElements) el.x = round1(el.x + dx);
			}
		}
		allElements.push(...pageElements);
		const combinedBox = computeElementsBBox([], allElements);
		if (combinedBox) nextPageOffsetX = combinedBox.maxX + 160;
	}

	return {
		source: "tldraw",
		title: title ?? titleFromFileName(options.fileName),
		nodes: [],
		edges: [],
		elements: allElements,
		skippedCount,
		warnings: skippedCount > 0 ? [`未対応の要素 ${skippedCount} 件（画像・埋め込み等）をスキップしました。`] : [],
	};
}

function parseHasilanDocument(data: unknown, options: CanvasImportOptions): CanvasImportResult | undefined {
	if (isCanvasDocument(data)) {
		return {
			source: "hasilan",
			title: data.design.title || titleFromFileName(options.fileName),
			description: data.design.description,
			nodes: structuredClone(data.design.nodes),
			edges: structuredClone(data.design.edges),
			elements: structuredClone(data.design.elements ?? []),
			skippedCount: 0,
			warnings: [],
		};
	}
	if (isRecord(data) && Array.isArray(data.nodes) && Array.isArray(data.edges)) {
		const candidate = { revision: 0, design: data };
		if (isCanvasDocument(candidate)) {
			return {
				source: "hasilan",
				title: candidate.design.title || titleFromFileName(options.fileName),
				description: candidate.design.description,
				nodes: structuredClone(candidate.design.nodes),
				edges: structuredClone(candidate.design.edges),
				elements: structuredClone(candidate.design.elements ?? []),
				skippedCount: 0,
				warnings: [],
			};
		}
	}
	return undefined;
}

function isExcalidrawPayload(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	if (value.type === "excalidraw" || value.type === "excalidraw/clipboard") return Array.isArray(value.elements);
	return false;
}

function isTldrawPayload(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	if (typeof value.tldrawFileFormatVersion === "number" && Array.isArray(value.records)) return true;
	if (Array.isArray(value.records) && value.records.some((r) => isRecord(r) && typeof r.typeName === "string")) {
		return true;
	}
	if (
		isRecord(value.store) &&
		Object.keys(value.store).some((key) => key.startsWith("shape:") || key.startsWith("page:"))
	) {
		return true;
	}
	if (
		isRecord(value.document) &&
		isRecord(value.document.store) &&
		Object.keys(value.document.store).some((key) => key.startsWith("shape:") || key.startsWith("page:"))
	) {
		return true;
	}
	if (
		Array.isArray(value.shapes) &&
		value.shapes.some((s) => isRecord(s) && isRecord(s.props) && typeof s.type === "string")
	) {
		return true;
	}
	return false;
}

/** Lightweight format detector for paste/drop sniffing. */
export function detectCanvasImportSource(rawText: string): CanvasImportSource | undefined {
	const trimmed = rawText.trim();
	if (!trimmed) return undefined;
	if (trimmed.includes("payload-type:application/vnd.excalidraw+json") && trimmed.includes("payload-start")) {
		return "excalidraw";
	}
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (isExcalidrawPayload(parsed)) return "excalidraw";
		if (isTldrawPayload(parsed)) return "tldraw";
		if (parseHasilanDocument(parsed, {})) return "hasilan";
	} catch {
		return undefined;
	}
	return undefined;
}

/** Parses Excalidraw (.excalidraw / clipboard / .excalidraw.svg), tldraw (.tldr / snapshot), or Hasilan JSON. */
export async function parseCanvasImport(
	rawText: string,
	options: CanvasImportOptions = {},
): Promise<CanvasImportResult> {
	if (rawText.length > MAX_IMPORT_BYTES) {
		throw new Error("ファイルサイズが大きすぎます（16 MB 以下にしてください）。");
	}
	const trimmed = rawText.trim();
	if (!trimmed) {
		throw new Error("インポートするデータが空です。");
	}

	let parsed: unknown;
	if (trimmed.startsWith("<") && trimmed.includes("payload-start")) {
		parsed = await extractExcalidrawFromSvg(trimmed);
	} else {
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error(
				"対応形式のファイルではありません。Excalidraw (.excalidraw / .svg)、tldraw (.tldr)、またはキャンバス JSON を指定してください。",
			);
		}
	}

	if (isExcalidrawPayload(parsed)) {
		return parseExcalidrawDocument(parsed, options);
	}
	if (isTldrawPayload(parsed)) {
		return parseTldrawDocument(parsed, options);
	}
	const hasil = parseHasilanDocument(parsed, options);
	if (hasil) return hasil;

	throw new Error(
		"未対応の JSON 形式です。Excalidraw (.excalidraw)、tldraw (.tldr)、または Hasilan キャンバス JSON を選択してください。",
	);
}

function elementWorldBox(el: CanvasElement): BBox {
	if (el.points?.length) {
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const [px, py] of el.points) {
			minX = Math.min(minX, el.x + px);
			minY = Math.min(minY, el.y + py);
			maxX = Math.max(maxX, el.x + px);
			maxY = Math.max(maxY, el.y + py);
		}
		return { minX, minY, maxX, maxY };
	}
	return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
}

function computeElementsBBox(nodes: readonly CanvasNode[], elements: readonly CanvasElement[]): BBox | undefined {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const node of nodes) {
		minX = Math.min(minX, node.x);
		minY = Math.min(minY, node.y);
		maxX = Math.max(maxX, node.x + 252);
		maxY = Math.max(maxY, node.y + 150);
	}
	for (const el of elements) {
		const b = elementWorldBox(el);
		minX = Math.min(minX, b.minX);
		minY = Math.min(minY, b.minY);
		maxX = Math.max(maxX, b.maxX);
		maxY = Math.max(maxY, b.maxY);
	}
	if (!Number.isFinite(minX)) return undefined;
	return { minX, minY, maxX, maxY };
}

/** Normalizes coordinates, deduplicates IDs, and merges or replaces the canvas design safely. */
export function mergeImportedCanvas(
	current: CanvasDesign,
	imported: CanvasImportResult,
	mode: "replace" | "append",
	options: { anchor?: { x: number; y: number } } = {},
): { design: CanvasDesign; addedNodeIds: string[]; addedElementIds: string[] } {
	const baseNodes = mode === "replace" ? [] : [...current.nodes];
	const baseEdges = mode === "replace" ? [] : [...current.edges];
	const baseElements = mode === "replace" ? [] : [...(current.elements ?? [])];

	const usedIds = new Set<string>();
	for (const n of baseNodes) usedIds.add(n.id);
	for (const e of baseEdges) usedIds.add(e.id);
	for (const el of baseElements) usedIds.add(el.id);

	const rawNodes = structuredClone(imported.nodes);
	const rawEdges = structuredClone(imported.edges);
	const rawElements = structuredClone(imported.elements);

	// Uniformly scale and translate if the imported diagram sits far from the origin or exceeds canvas coordinate limits.
	const importBox = computeElementsBBox(rawNodes, rawElements);
	if (importBox) {
		const spanX = Math.max(1, importBox.maxX - importBox.minX);
		const spanY = Math.max(1, importBox.maxY - importBox.minY);
		const scale = Math.min(1, SAFE_SPAN / spanX, SAFE_SPAN / spanY);

		let targetX = importBox.minX;
		let targetY = importBox.minY;
		if (mode === "append") {
			if (options.anchor) {
				targetX = options.anchor.x - (spanX * scale) / 2;
				targetY = options.anchor.y - (spanY * scale) / 2;
			} else {
				const existingBox = computeElementsBBox(baseNodes, baseElements);
				if (existingBox) {
					targetX = existingBox.maxX + 80;
					targetY = existingBox.minY;
				} else {
					targetX = 80;
					targetY = 80;
				}
			}
		} else if (
			scale < 1 ||
			importBox.minX < -CANVAS_LIMITS.coordinate + 200 ||
			importBox.maxX > CANVAS_LIMITS.coordinate - 200 ||
			importBox.minY < -CANVAS_LIMITS.coordinate + 200 ||
			importBox.maxY > CANVAS_LIMITS.coordinate - 200
		) {
			targetX = 80;
			targetY = 80;
		}

		// Clamp target origin so the scaled diagram stays inside [-coordinate, coordinate].
		const maxAllowedX = CANVAS_LIMITS.coordinate - spanX * scale - 20;
		const maxAllowedY = CANVAS_LIMITS.coordinate - spanY * scale - 20;
		targetX = clamp(targetX, -CANVAS_LIMITS.coordinate + 20, Math.max(-CANVAS_LIMITS.coordinate + 20, maxAllowedX));
		targetY = clamp(targetY, -CANVAS_LIMITS.coordinate + 20, Math.max(-CANVAS_LIMITS.coordinate + 20, maxAllowedY));

		const tx = (value: number) => clampCoord((value - importBox.minX) * scale + targetX);
		const ty = (value: number) => clampCoord((value - importBox.minY) * scale + targetY);

		for (const node of rawNodes) {
			node.x = tx(node.x);
			node.y = ty(node.y);
		}
		for (const el of rawElements) {
			el.x = tx(el.x);
			el.y = ty(el.y);
			el.width = clampDim(el.width * scale);
			el.height = clampDim(el.height * scale);
			if (el.points) {
				el.points = el.points.map(([px, py]) => [clampCoord(px * scale), clampCoord(py * scale)]);
			}
		}
	}

	const nodeIdMap = new Map<string, string>();
	const addedNodeIds: string[] = [];
	const mappedNodes: CanvasNode[] = rawNodes.map((node) => {
		const nextNodeId = allocateId(node.id, "n", usedIds);
		nodeIdMap.set(node.id, nextNodeId);
		addedNodeIds.push(nextNodeId);
		return {
			id: nextNodeId,
			title: truncate(node.title, CANVAS_LIMITS.title),
			description: truncate(node.description, CANVAS_LIMITS.description),
			x: clampCoord(node.x),
			y: clampCoord(node.y),
		};
	});

	const mappedEdges: CanvasEdge[] = [];
	for (const edge of rawEdges) {
		const source = nodeIdMap.get(edge.source);
		const target = nodeIdMap.get(edge.target);
		if (!source || !target) continue;
		mappedEdges.push({
			id: allocateId(edge.id, "e", usedIds),
			source,
			target,
			label: truncate(edge.label, CANVAS_LIMITS.label),
		});
	}

	const addedElementIds: string[] = [];
	const mappedElements: CanvasElement[] = rawElements.map((el) => {
		const nextElId = allocateId(el.id, "el", usedIds);
		addedElementIds.push(nextElId);
		return {
			...el,
			id: nextElId,
			x: clampCoord(el.x),
			y: clampCoord(el.y),
			width: clampDim(el.width),
			height: clampDim(el.height),
			strokeWidth: clamp(el.strokeWidth, 0.5, 24),
			...(el.opacity !== undefined ? { opacity: clamp(el.opacity, 0.05, 1) } : {}),
			...(el.roughness !== undefined ? { roughness: clamp(el.roughness, 0, 3) } : {}),
			...(el.fontSize !== undefined ? { fontSize: clamp(el.fontSize, 10, 96) } : {}),
			...(el.text !== undefined ? { text: truncate(el.text, CANVAS_LIMITS.text) } : {}),
		};
	});

	const isDefaultTitle = !current.title.trim() || current.title === "新しいプロジェクト設計";
	const nextTitle =
		imported.title && (mode === "replace" || isDefaultTitle)
			? truncate(imported.title, CANVAS_LIMITS.title)
			: current.title;
	const nextDescription =
		mode === "replace" && imported.description !== undefined
			? truncate(imported.description, CANVAS_LIMITS.description)
			: current.description;

	const combinedElements = [...baseElements, ...mappedElements];
	const design: CanvasDesign = {
		title: nextTitle,
		description: nextDescription,
		nodes: [...baseNodes, ...mappedNodes],
		edges: [...baseEdges, ...mappedEdges],
		...(combinedElements.length ? { elements: combinedElements } : {}),
	};

	return { design, addedNodeIds, addedElementIds };
}
