import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CANVAS_LIMITS, type CanvasDesign, isCanvasDocument } from "../src/shared/canvas.ts";
import {
	decodeFloat16,
	decodeTldrawB64Points,
	detectCanvasImportSource,
	mergeImportedCanvas,
	normalizeCanvasColor,
	parseCanvasImport,
} from "../src/shared/canvas-import.ts";

function encodeFloat16(value: number): number {
	const buf = new ArrayBuffer(4);
	const view = new DataView(buf);
	view.setFloat32(0, value, true);
	const bits = view.getUint32(0, true);
	const sign = (bits >>> 16) & 0x8000;
	const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
	const mantissa = (bits >>> 13) & 0x03ff;
	if (exponent <= 0) return sign;
	if (exponent >= 31) return sign | 0x7c00;
	return sign | (exponent << 10) | mantissa;
}

function encodeTldrawB64Points(points: readonly (readonly [number, number])[], dim: 2 | 3 = 3): string {
	const firstBytes = dim * 4;
	const deltaBytes = dim * 2;
	const total = firstBytes + Math.max(0, points.length - 1) * deltaBytes;
	const bytes = new Uint8Array(total);
	const view = new DataView(bytes.buffer);
	view.setFloat32(0, points[0][0], true);
	view.setFloat32(4, points[0][1], true);
	if (dim === 3) view.setFloat32(8, 0.5, true);
	let prevX = points[0][0];
	let prevY = points[0][1];
	for (let i = 1; i < points.length; i++) {
		const offset = firstBytes + (i - 1) * deltaBytes;
		view.setUint16(offset, encodeFloat16(points[i][0] - prevX), true);
		view.setUint16(offset + 2, encodeFloat16(points[i][1] - prevY), true);
		if (dim === 3) view.setUint16(offset + 4, encodeFloat16(0), true);
		prevX = points[i][0];
		prevY = points[i][1];
	}
	return Buffer.from(bytes).toString("base64");
}

describe("canvas import helpers", () => {
	it("normalizes CSS colors to schema-valid hex or transparent", () => {
		expect(normalizeCanvasColor("transparent", "#fff")).toBe("transparent");
		expect(normalizeCanvasColor("none", "#fff")).toBe("transparent");
		expect(normalizeCanvasColor("#1e1e1e", "#fff")).toBe("#1e1e1e");
		expect(normalizeCanvasColor("rgb(255, 0, 128)", "#fff")).toBe("#ff0080");
		expect(normalizeCanvasColor("rgba(16, 32, 48, 0.5)", "#fff")).toBe("#10203080");
		expect(normalizeCanvasColor("rgba(16, 32, 48, 0)", "#fff")).toBe("transparent");
		expect(normalizeCanvasColor("invalid-color", "#e8e8e8")).toBe("#e8e8e8");
	});

	it("decodes IEEE 754 Float16 and tldraw b64Vecs points for dim 2 and dim 3", () => {
		expect(decodeFloat16(0x0000)).toBe(0);
		expect(decodeFloat16(0x3c00)).toBe(1);
		expect(decodeFloat16(0x3800)).toBe(0.5);
		expect(decodeFloat16(0xc000)).toBe(-2);

		const pts: [number, number][] = [
			[10, 20],
			[25.5, 35],
			[40, 12.5],
		];
		const decoded3 = decodeTldrawB64Points(encodeTldrawB64Points(pts, 3));
		expect(decoded3).toEqual(pts);
		const decoded2 = decodeTldrawB64Points(encodeTldrawB64Points(pts, 2), 2);
		expect(decoded2).toEqual(pts);
	});
});

describe("Excalidraw import", () => {
	it("imports shapes, merges bound box text, keeps arrow labels, skips deleted/unsupported, and adapts dark ink", async () => {
		const excalidraw = {
			type: "excalidraw",
			version: 2,
			appState: { name: "API Architecture" },
			elements: [
				{
					id: "rect-1",
					type: "rectangle",
					x: 100,
					y: 80,
					width: 200,
					height: 100,
					strokeColor: "#1e1e1e",
					backgroundColor: "transparent",
					strokeWidth: 2,
					strokeStyle: "dashed",
					roughness: 1,
					opacity: 80,
					isDeleted: false,
				},
				{
					id: "txt-bound",
					type: "text",
					containerId: "rect-1",
					x: 120,
					y: 110,
					width: 140,
					height: 30,
					text: "API Gateway",
					fontSize: 20,
					strokeColor: "#1e1e1e",
					backgroundColor: "transparent",
					strokeWidth: 1,
					opacity: 100,
					isDeleted: false,
				},
				{
					id: "pastel-box",
					type: "diamond",
					x: 420,
					y: 140,
					width: -120,
					height: -80,
					strokeColor: "#1e1e1e",
					backgroundColor: "#ffec99",
					strokeWidth: 2,
					strokeStyle: "solid",
					roughness: 1,
					opacity: 100,
					isDeleted: false,
				},
				{
					id: "arrow-1",
					type: "arrow",
					x: 300,
					y: 130,
					width: 120,
					height: 20,
					strokeColor: "#1971c2",
					backgroundColor: "transparent",
					strokeWidth: 2,
					strokeStyle: "solid",
					roughness: 1,
					opacity: 100,
					points: [
						[0, 0],
						[120, 20],
					],
					startArrowhead: null,
					endArrowhead: "arrow",
					isDeleted: false,
				},
				{
					id: "arrow-label",
					type: "text",
					containerId: "arrow-1",
					x: 340,
					y: 115,
					width: 60,
					height: 20,
					text: "HTTPS",
					fontSize: 14,
					strokeColor: "#1e1e1e",
					backgroundColor: "transparent",
					opacity: 100,
					isDeleted: false,
				},
				{
					id: "rev-arrow",
					type: "arrow",
					x: 200,
					y: 250,
					width: 80,
					height: 0,
					strokeColor: "#e03131",
					backgroundColor: "transparent",
					strokeWidth: 2,
					points: [
						[0, 0],
						[80, 0],
					],
					startArrowhead: "arrow",
					endArrowhead: null,
					isDeleted: false,
				},
				{
					id: "frame-1",
					type: "frame",
					name: "Backend",
					x: 40,
					y: 40,
					width: 500,
					height: 300,
					strokeColor: "#868e96",
					backgroundColor: "transparent",
					opacity: 100,
					isDeleted: false,
				},
				{
					id: "deleted-rect",
					type: "rectangle",
					x: 0,
					y: 0,
					width: 50,
					height: 50,
					isDeleted: true,
				},
				{
					id: "img-1",
					type: "image",
					x: 0,
					y: 0,
					width: 100,
					height: 100,
					isDeleted: false,
				},
			],
		};

		const raw = JSON.stringify(excalidraw);
		expect(detectCanvasImportSource(raw)).toBe("excalidraw");
		const parsed = await parseCanvasImport(raw, { darkCanvas: true });
		expect(parsed.source).toBe("excalidraw");
		expect(parsed.title).toBe("API Architecture");
		expect(parsed.skippedCount).toBe(1);

		const rect = parsed.elements.find((el) => el.type === "rectangle" && el.text === "API Gateway");
		expect(rect).toBeDefined();
		expect(rect?.stroke).toBe("#e8e8e8");
		expect(rect?.opacity).toBeCloseTo(0.8);
		expect(rect?.strokeStyle).toBe("dashed");
		expect(rect?.fontSize).toBe(20);
		// Bound box text was merged into rect rather than emitted as standalone text.
		expect(parsed.elements.filter((el) => el.type === "text" && el.text === "API Gateway")).toHaveLength(0);

		// Pastel box keeps dark stroke and normalizes negative width/height.
		const diamond = parsed.elements.find((el) => el.type === "diamond");
		expect(diamond).toMatchObject({ x: 300, y: 60, width: 120, height: 80, stroke: "#1e1e1e", fill: "#ffec99" });

		// Arrow label preserved as standalone text.
		expect(parsed.elements.some((el) => el.type === "text" && el.text === "HTTPS")).toBe(true);

		// Start-only arrow reverses points so arrowhead renders at the original start.
		const rev = parsed.elements.find((el) => el.stroke === "#e03131");
		expect(rev?.type).toBe("arrow");
		expect(rev?.points).toEqual([
			[80, 0],
			[0, 0],
		]);

		// Frame emits dashed border + title label.
		expect(parsed.elements.some((el) => el.type === "text" && el.text === "Backend")).toBe(true);

		const merged = mergeImportedCanvas(
			{ title: "新しいプロジェクト設計", description: "", nodes: [], edges: [] },
			parsed,
			"replace",
		);
		expect(isCanvasDocument({ revision: 0, design: merged.design })).toBe(true);
		expect(merged.design.title).toBe("API Architecture");
	});

	it("imports Excalidraw clipboard JSON and downsamples huge freedraw strokes", async () => {
		const densePoints = Array.from({ length: 2600 }, (_, i) => [i * 3, Math.sin(i / 20) * 40, 0.5]);
		const clipboard = JSON.stringify({
			type: "excalidraw/clipboard",
			elements: [
				{
					id: "pen-1",
					type: "freedraw",
					x: 10,
					y: 20,
					width: 7800,
					height: 80,
					strokeColor: "#a6e3a1",
					backgroundColor: "transparent",
					strokeWidth: 3,
					opacity: 100,
					points: densePoints,
				},
			],
		});
		expect(detectCanvasImportSource(clipboard)).toBe("excalidraw");
		const parsed = await parseCanvasImport(clipboard);
		expect(parsed.elements).toHaveLength(1);
		expect(parsed.elements[0].type).toBe("freedraw");
		expect(parsed.elements[0].points!.length).toBeLessThanOrEqual(CANVAS_LIMITS.points);
	});

	it("extracts compressed Excalidraw v2 scene embedded inside .excalidraw.svg", async () => {
		const scene = JSON.stringify({
			type: "excalidraw",
			version: 2,
			elements: [
				{
					id: "svg-el",
					type: "ellipse",
					x: 50,
					y: 60,
					width: 120,
					height: 80,
					strokeColor: "#75beff",
					backgroundColor: "transparent",
					strokeWidth: 2,
					opacity: 100,
				},
			],
		});
		const deflated = deflateSync(Buffer.from(scene, "utf8"));
		let bstring = "";
		for (const byte of deflated) bstring += String.fromCharCode(byte);
		const envelope = JSON.stringify({ version: "1", encoding: "bstring", compressed: true, encoded: bstring });
		const svg = `<svg xmlns="http://www.w3.org/2000/svg"><metadata><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-version:2 --><!-- payload-start -->${Buffer.from(envelope, "utf8").toString("base64")}<!-- payload-end --></metadata></svg>`;

		expect(detectCanvasImportSource(svg)).toBe("excalidraw");
		const parsed = await parseCanvasImport(svg, { fileName: "flow.excalidraw.svg" });
		expect(parsed.source).toBe("excalidraw");
		expect(parsed.title).toBe("flow");
		expect(parsed.elements).toHaveLength(1);
		expect(parsed.elements[0]).toMatchObject({ type: "ellipse", x: 50, y: 60, width: 120, height: 80 });
	});
});

describe("tldraw import", () => {
	it("imports .tldr v3/v4 shapes, richText, group hierarchy, arrow bindings, line map, b64Vecs draw, and multi-page layout", async () => {
		const strokePath = encodeTldrawB64Points(
			[
				[0, 0],
				[30, 15],
				[60, 5],
			],
			3,
		);
		const tldr = {
			tldrawFileFormatVersion: 1,
			schema: { schemaVersion: 2 },
			records: [
				{ id: "document:document", typeName: "document", name: "Checkout Flow" },
				{ id: "page:p1", typeName: "page", name: "Page 1", index: "a1" },
				{ id: "page:p2", typeName: "page", name: "Page 2", index: "a2" },
				{
					id: "shape:group1",
					typeName: "shape",
					type: "group",
					parentId: "page:p1",
					index: "a1",
					x: 100,
					y: 50,
					rotation: 0,
					opacity: 1,
					props: {},
				},
				{
					id: "shape:box1",
					typeName: "shape",
					type: "geo",
					parentId: "shape:group1",
					index: "a1",
					x: 20,
					y: 30,
					rotation: 0,
					opacity: 1,
					props: {
						geo: "rectangle",
						w: 180,
						h: 90,
						color: "black",
						fill: "semi",
						dash: "draw",
						size: "m",
						richText: {
							type: "doc",
							content: [
								{ type: "paragraph", content: [{ type: "text", text: "Client" }] },
								{ type: "paragraph", content: [{ type: "text", text: "Web App" }] },
							],
						},
					},
				},
				{
					id: "shape:box2",
					typeName: "shape",
					type: "geo",
					parentId: "page:p1",
					index: "a2",
					x: 420,
					y: 80,
					rotation: 0,
					opacity: 1,
					props: {
						geo: "oval",
						w: 160,
						h: 90,
						color: "blue",
						fill: "solid",
						dash: "dashed",
						size: "l",
						text: "Payment API",
					},
				},
				{
					id: "shape:arrow1",
					typeName: "shape",
					type: "arrow",
					parentId: "page:p1",
					index: "a3",
					x: 300,
					y: 125,
					rotation: 0,
					opacity: 1,
					props: {
						color: "green",
						dash: "solid",
						size: "m",
						start: { x: 0, y: 0 },
						end: { x: 100, y: 0 },
						bend: 16,
						arrowheadStart: "none",
						arrowheadEnd: "arrow",
						text: "POST /pay",
					},
				},
				{
					id: "binding:b1",
					typeName: "binding",
					type: "arrow",
					fromId: "shape:arrow1",
					toId: "shape:box1",
					props: { terminal: "start", normalizedAnchor: { x: 1, y: 0.5 } },
				},
				{
					id: "binding:b2",
					typeName: "binding",
					type: "arrow",
					fromId: "shape:arrow1",
					toId: "shape:box2",
					props: { terminal: "end", normalizedAnchor: { x: 0, y: 0.5 } },
				},
				{
					id: "shape:note1",
					typeName: "shape",
					type: "note",
					parentId: "page:p1",
					index: "a4",
					x: 120,
					y: 220,
					rotation: 0,
					opacity: 1,
					props: { color: "yellow", size: "m", text: "Retry on 503", growY: 20 },
				},
				{
					id: "shape:line1",
					typeName: "shape",
					type: "line",
					parentId: "page:p1",
					index: "a5",
					x: 10,
					y: 300,
					rotation: 0,
					opacity: 1,
					props: {
						color: "grey",
						dash: "dotted",
						size: "s",
						points: {
							p2: { id: "p2", index: "a2", x: 90, y: 10 },
							p1: { id: "p1", index: "a1", x: 0, y: 0 },
						},
					},
				},
				{
					id: "shape:draw1",
					typeName: "shape",
					type: "draw",
					parentId: "page:p1",
					index: "a6",
					x: 50,
					y: 400,
					rotation: 0,
					opacity: 1,
					props: {
						color: "orange",
						dash: "draw",
						size: "m",
						segments: [{ type: "free", path: strokePath }],
					},
				},
				{
					id: "shape:p2box",
					typeName: "shape",
					type: "geo",
					parentId: "page:p2",
					index: "a1",
					x: 0,
					y: 0,
					rotation: 0,
					opacity: 1,
					props: {
						geo: "diamond",
						w: 120,
						h: 80,
						color: "violet",
						fill: "none",
						dash: "solid",
						size: "m",
						text: "Page 2",
					},
				},
			],
		};

		const raw = JSON.stringify(tldr);
		expect(detectCanvasImportSource(raw)).toBe("tldraw");
		const parsed = await parseCanvasImport(raw, { darkCanvas: true });
		expect(parsed.source).toBe("tldraw");
		expect(parsed.title).toBe("Checkout Flow");
		expect(parsed.skippedCount).toBe(0);

		// Group child resolved world position: (100+20, 50+30) = (120, 80) + richText extracted with newline.
		const client = parsed.elements.find((el) => el.text === "Client\nWeb App");
		expect(client).toMatchObject({ type: "rectangle", x: 120, y: 80, width: 180, height: 90, stroke: "#e8e8e8" });

		// Oval maps to ellipse.
		const payment = parsed.elements.find((el) => el.text === "Payment API");
		expect(payment).toMatchObject({ type: "ellipse", x: 420, y: 80, stroke: "#60a5fa", strokeStyle: "dashed" });

		// Arrow resolved bindings from box1 right edge (300, 125) to box2 left edge (420, 125) with bend midpoint + label.
		const arrow = parsed.elements.find((el) => el.type === "arrow");
		expect(arrow).toBeDefined();
		expect(arrow?.points).toHaveLength(3);
		expect(parsed.elements.some((el) => el.type === "text" && el.text === "POST /pay")).toBe(true);

		// Note maps to sticky.
		const sticky = parsed.elements.find((el) => el.type === "sticky");
		expect(sticky).toMatchObject({ text: "Retry on 503", fill: "#fef08a", height: 220 });

		// Line sorts object-map points by fractional index.
		const line = parsed.elements.find((el) => el.type === "line");
		expect(line).toMatchObject({
			strokeStyle: "dotted",
			points: [
				[0, 0],
				[90, 10],
			],
		});

		// b64Vecs draw decoded to freedraw.
		const freedraw = parsed.elements.find((el) => el.type === "freedraw");
		expect(freedraw?.points).toEqual([
			[0, 0],
			[30, 15],
			[60, 5],
		]);

		// Page 2 diamond shifted right of Page 1 content rather than overlapping at (0, 0).
		const page2 = parsed.elements.find((el) => el.text === "Page 2");
		expect(page2?.type).toBe("diamond");
		expect(page2!.x).toBeGreaterThan(580);

		const merged = mergeImportedCanvas(
			{ title: "新しいプロジェクト設計", description: "", nodes: [], edges: [] },
			parsed,
			"replace",
		);
		expect(isCanvasDocument({ revision: 0, design: merged.design })).toBe(true);
	});
});

describe("mergeImportedCanvas and Hasilan JSON import", () => {
	it("re-centers far-away coordinates into valid bounds and avoids ID collisions on append", async () => {
		const farExcalidraw = JSON.stringify({
			type: "excalidraw",
			version: 2,
			elements: [
				{
					id: "same",
					type: "rectangle",
					x: 25000,
					y: -18000,
					width: 120,
					height: 60,
					strokeColor: "#fff",
					backgroundColor: "transparent",
				},
				{
					id: "same2",
					type: "rectangle",
					x: 25200,
					y: -17900,
					width: 120,
					height: 60,
					strokeColor: "#fff",
					backgroundColor: "transparent",
				},
			],
		});
		const parsed = await parseCanvasImport(farExcalidraw);
		const existing: CanvasDesign = {
			title: "既存設計",
			description: "",
			nodes: [{ id: "n1", title: "A", description: "", x: 0, y: 0 }],
			edges: [],
			elements: [
				{
					id: "el_ex_same",
					type: "rectangle",
					x: 40,
					y: 40,
					width: 100,
					height: 60,
					stroke: "#e8e8e8",
					fill: "transparent",
					strokeWidth: 2,
				},
			],
		};

		const replaced = mergeImportedCanvas(existing, parsed, "replace");
		expect(isCanvasDocument({ revision: 0, design: replaced.design })).toBe(true);
		const [a, b] = replaced.design.elements!;
		// Relative offset (200, 100) preserved even though raw coordinates were outside [-10000, 10000].
		expect(b.x - a.x).toBeCloseTo(200, 1);
		expect(b.y - a.y).toBeCloseTo(100, 1);

		const appended = mergeImportedCanvas(existing, parsed, "append");
		expect(isCanvasDocument({ revision: 0, design: appended.design })).toBe(true);
		expect(appended.design.elements).toHaveLength(3);
		expect(new Set(appended.design.elements!.map((el) => el.id)).size).toBe(3);
	});

	it("re-imports native Hasilan canvas JSON and remaps node/edge IDs on append", async () => {
		const nativeJson = JSON.stringify({
			revision: 3,
			design: {
				title: "エクスポート済み設計",
				description: "メモ",
				nodes: [
					{ id: "n1", title: "Input", description: "", x: 0, y: 0 },
					{ id: "n2", title: "Output", description: "", x: 300, y: 0 },
				],
				edges: [{ id: "e1", source: "n1", target: "n2", label: "flow" }],
			},
		});
		expect(detectCanvasImportSource(nativeJson)).toBe("hasilan");
		const parsed = await parseCanvasImport(nativeJson);
		const existing: CanvasDesign = {
			title: "既存",
			description: "",
			nodes: [{ id: "n1", title: "Existing", description: "", x: 0, y: 0 }],
			edges: [],
		};
		const appended = mergeImportedCanvas(existing, parsed, "append");
		expect(isCanvasDocument({ revision: 0, design: appended.design })).toBe(true);
		expect(appended.design.nodes).toHaveLength(3);
		expect(appended.design.edges).toHaveLength(1);
		expect(appended.design.edges[0].source).not.toBe("n1");
		expect(appended.addedNodeIds).toContain(appended.design.edges[0].source);
		expect(appended.addedNodeIds).toContain(appended.design.edges[0].target);
	});

	it("rejects unsupported files with clear messages", async () => {
		await expect(parseCanvasImport("")).rejects.toThrow(/空/);
		await expect(parseCanvasImport("not json")).rejects.toThrow(/Excalidraw/);
		await expect(parseCanvasImport("<svg><rect /></svg>")).rejects.toThrow(/Excalidraw/);
		await expect(parseCanvasImport(JSON.stringify({ hello: "world" }))).rejects.toThrow(/未対応/);
	});
});
