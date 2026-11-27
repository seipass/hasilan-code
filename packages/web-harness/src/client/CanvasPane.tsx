import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
	CANVAS_LIMITS,
	type CanvasDesign,
	type CanvasDocument,
	type CanvasElement,
	type CanvasNode,
	emptyCanvasDocument,
	isCanvasDocument,
} from "../shared/canvas.ts";
import { nextId } from "../shared/ids.ts";
import { useAnimatedView } from "./animated-view.ts";
import { api, command, errorMessage } from "./api.ts";
import {
	arrowHeadPath,
	type CanvasTool,
	DEFAULT_STYLE,
	type ElementStyleDefaults,
	elementBounds,
	elementStrokeDasharray,
	FILL_PALETTE,
	intersectsRect,
	STROKE_PALETTE,
	shapePath,
	simplifyPoints,
} from "./canvas-elements.ts";
import { CARD_HEIGHT, CARD_WIDTH, nextCanvasPosition } from "./canvas-layout.ts";
import { Icon } from "./Icon.tsx";
import { MotionItems, Presence } from "./Motion.tsx";
import "./CanvasPane.css";

export interface CanvasPaneProps {
	workspaceId: string;
	destinationControl: ReactNode;
	onComposeDesign: (path: string) => void;
	onDirtyChange?: (dirty: boolean) => void;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const MAX_HISTORY = 100;

type Selection = { kind: "node" | "edge"; id: string } | { kind: "elements"; ids: string[] } | undefined;
type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type PointerSession =
	| { mode: "pan"; pointer: number; clientX: number; clientY: number; x: number; y: number }
	| { mode: "node"; pointer: number; clientX: number; clientY: number; nodeId: string; x: number; y: number }
	| { mode: "move-elements"; pointer: number; startX: number; startY: number; origins: Map<string, { x: number; y: number }> }
	| { mode: "resize"; pointer: number; elementId: string; handle: ResizeHandle; startX: number; startY: number; origin: CanvasElement }
	| { mode: "draw"; pointer: number; elementId: string; startX: number; startY: number; rawPoints: [number, number][] }
	| { mode: "marquee"; pointer: number; startX: number; startY: number };

const TOOLS: readonly { id: CanvasTool; label: string; key: string; icon: ReactNode }[] = [
	{ id: "select", label: "選択", key: "V", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 9-7 2-3 7z" /></svg> },
	{ id: "hand", label: "手のひら（移動）", key: "H", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10V6a2 2 0 0 0-4 0v8l-1.5-1.5a2 2 0 0 0-2.8 2.8L7 21h9a4 4 0 0 0 4-4v-5a2 2 0 0 0-2-1Z" /></svg> },
	{ id: "rectangle", label: "四角形", key: "R", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2" /></svg> },
	{ id: "ellipse", label: "楕円", key: "O", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="8" ry="6" /></svg> },
	{ id: "diamond", label: "ひし形", key: "D", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 9-9 9-9-9z" /></svg> },
	{ id: "arrow", label: "矢印", key: "A", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19L19 5M11 5h8v8" /></svg> },
	{ id: "line", label: "線", key: "L", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19L19 5" /></svg> },
	{ id: "freedraw", label: "フリーハンド", key: "P", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17c2-5 5-8 8-4s6-2 8-7" /></svg> },
	{ id: "text", label: "テキスト", key: "T", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M12 6v13M8 19h8" /></svg> },
	{ id: "sticky", label: "付箋", key: "S", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v11l-5 5H4zM15 20v-5h5" /></svg> },
];

const SHORTCUT_TO_TOOL: Record<string, CanvasTool> = {
	v: "select", "1": "select",
	h: "hand", "2": "hand",
	r: "rectangle", "3": "rectangle",
	o: "ellipse", "4": "ellipse",
	d: "diamond", "5": "diamond",
	a: "arrow", "6": "arrow",
	l: "line", "7": "line",
	p: "freedraw", "8": "freedraw",
	t: "text", "9": "text",
	s: "sticky", "0": "sticky",
};

function clampCoord(value: number): number {
	return Math.round(Math.max(-CANVAS_LIMITS.coordinate, Math.min(CANVAS_LIMITS.coordinate, value)) * 10) / 10;
}

/** A keyed inner pane prevents a previous workspace draft or request from crossing workspace boundaries. */
export function CanvasPane(props: CanvasPaneProps) {
	return <CanvasWorkspace key={props.workspaceId} {...props} />;
}

function CanvasWorkspace({ workspaceId, destinationControl, onComposeDesign, onDirtyChange }: CanvasPaneProps) {
	const id = useId();
	const [document, setDocument] = useState<CanvasDocument>(emptyCanvasDocument);
	const [baseline, setBaseline] = useState(() => JSON.stringify(emptyCanvasDocument().design));
	const [ready, setReady] = useState(false);
	const [pending, setPending] = useState<"load" | "save" | "use">("load");
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState("");
	const [selection, setSelection] = useState<Selection>();
	const [tool, setTool] = useState<CanvasTool>("select");
	const [style, setStyle] = useState<ElementStyleDefaults>(DEFAULT_STYLE);
	const [spaceHeld, setSpaceHeld] = useState(false);
	const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number }>();
	const [editingElementId, setEditingElementId] = useState<string>();
	const [styleOpen, setStyleOpen] = useState(true);
	const { view, setView, animateView } = useAnimatedView({ x: 240, y: 80, zoom: 1 });
	const [moving, setMoving] = useState(false);
	const [editingNode, setEditingNode] = useState<string>();
	const [connectingFrom, setConnectingFrom] = useState<string>();
	const [connectionPointer, setConnectionPointer] = useState<{ x: number; y: number }>();
	const history = useRef<{ past: CanvasDesign[]; future: CanvasDesign[] }>({ past: [], future: [] });
	const [, setHistoryVersion] = useState(0);
	const inlineTitle = useRef<HTMLInputElement>(null);
	const inlineTextRef = useRef<HTMLTextAreaElement>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const pointerSession = useRef<PointerSession | undefined>(undefined);
	const lastTouchedNode = useRef<string | undefined>(undefined);
	const busyRef = useRef(true);
	const mounted = useRef(false);
	const dirtyCallback = useRef(onDirtyChange);
	dirtyCallback.current = onDirtyChange;
	const design = document.design;
	const elements = design.elements ?? [];
	const serialized = useMemo(() => JSON.stringify(design), [design]);
	const dirty = ready && serialized !== baseline;
	const node = selection?.kind === "node" ? design.nodes.find((item) => item.id === selection.id) : undefined;
	const edge = selection?.kind === "edge" ? design.edges.find((item) => item.id === selection.id) : undefined;
	const selectedElementIds = useMemo(
		() => new Set(selection?.kind === "elements" ? selection.ids : []),
		[selection],
	);
	const selectedElements = useMemo(
		() => elements.filter((el) => selectedElementIds.has(el.id)),
		[elements, selectedElementIds],
	);
	const primaryElement = selectedElements.length === 1 ? selectedElements[0] : undefined;
	const editingElement = editingElementId ? elements.find((el) => el.id === editingElementId) : undefined;
	const nodesById = useMemo(() => new Map(design.nodes.map((item) => [item.id, item])), [design.nodes]);
	const connectionSource = connectingFrom ? nodesById.get(connectingFrom) : undefined;
	const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/canvas`;

	const toWorld = useCallback(
		(clientX: number, clientY: number) => {
			const bounds = viewport.current?.getBoundingClientRect();
			if (!bounds) return { x: 0, y: 0 };
			return {
				x: (clientX - bounds.left - view.x) / view.zoom,
				y: (clientY - bounds.top - view.y) / view.zoom,
			};
		},
		[view.x, view.y, view.zoom],
	);

	useEffect(() => {
		mounted.current = true;
		const controller = new AbortController();
		void api<unknown>(endpoint, { signal: controller.signal })
			.then((loaded) => {
				if (!isCanvasDocument(loaded)) throw new Error("サーバーから届いた設計データが不正です。");
				if (!controller.signal.aborted) {
					setDocument(loaded);
					setBaseline(JSON.stringify(loaded.design));
					history.current = { past: [], future: [] };
					setReady(true);
				}
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(errorMessage(reason));
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					busyRef.current = false;
					setBusy(false);
				}
			});
		return () => {
			mounted.current = false;
			controller.abort();
			dirtyCallback.current?.(false);
		};
	}, [endpoint]);

	useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
	useEffect(() => {
		if (!dirty) return;
		const beforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", beforeUnload);
		return () => window.removeEventListener("beforeunload", beforeUnload);
	}, [dirty]);

	useEffect(() => {
		if (editingNode) {
			inlineTitle.current?.focus({ preventScroll: true });
			inlineTitle.current?.select();
		}
	}, [editingNode]);

	useEffect(() => {
		if (editingElementId) {
			inlineTextRef.current?.focus({ preventScroll: true });
			inlineTextRef.current?.select();
		}
	}, [editingElementId]);

	useEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const wheel = (event: WheelEvent) => {
			if (event.target instanceof Element && event.target.closest("input, textarea")) return;
			event.preventDefault();
			const bounds = element.getBoundingClientRect();
			const x = event.clientX - bounds.left;
			const y = event.clientY - bounds.top;
			setView((current) => {
				const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
				return { zoom, x: x - ((x - current.x) * zoom) / current.zoom, y: y - ((y - current.y) * zoom) / current.zoom };
			});
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, [setView]);

	function pushHistory(snapshot: CanvasDesign) {
		history.current.past.push(snapshot);
		if (history.current.past.length > MAX_HISTORY) history.current.past.shift();
		history.current.future = [];
		setHistoryVersion((v) => v + 1);
	}

	function edit(change: (current: CanvasDesign) => CanvasDesign, recordHistory = true) {
		if (!ready || busyRef.current) return;
		setDocument((current) => {
			if (recordHistory) pushHistory(current.design);
			return { ...current, design: change(current.design) };
		});
		setNotice("");
	}

	function undo() {
		if (!ready || busyRef.current || !history.current.past.length) return;
		setDocument((current) => {
			const previous = history.current.past.pop();
			if (!previous) return current;
			history.current.future.push(current.design);
			setHistoryVersion((v) => v + 1);
			return { ...current, design: previous };
		});
		setEditingElementId(undefined);
		setEditingNode(undefined);
	}

	function redo() {
		if (!ready || busyRef.current || !history.current.future.length) return;
		setDocument((current) => {
			const next = history.current.future.pop();
			if (!next) return current;
			history.current.past.push(current.design);
			setHistoryVersion((v) => v + 1);
			return { ...current, design: next };
		});
		setEditingElementId(undefined);
		setEditingNode(undefined);
	}

	function patchSelectedElements(patch: Partial<CanvasElement>, recordHistory = true) {
		if (!selectedElementIds.size) return;
		edit(
			(current) => ({
				...current,
				elements: (current.elements ?? []).map((el) => (selectedElementIds.has(el.id) ? { ...el, ...patch } : el)),
			}),
			recordHistory,
		);
	}

	function updateStyle<K extends keyof ElementStyleDefaults>(key: K, value: ElementStyleDefaults[K]) {
		setStyle((current) => ({ ...current, [key]: value }));
		if (selectedElementIds.size) patchSelectedElements({ [key]: value } as Partial<CanvasElement>);
	}

	function patchNode(patch: Partial<Omit<CanvasNode, "id">>) {
		if (!node) return;
		edit((current) => ({ ...current, nodes: current.nodes.map((item) => (item.id === node.id ? { ...item, ...patch } : item)) }));
	}

	function editOnBoard(item: CanvasNode) {
		if (!ready || busyRef.current) return;
		lastTouchedNode.current = item.id;
		setConnectingFrom(undefined);
		setConnectionPointer(undefined);
		setSelection({ kind: "node", id: item.id });
		setEditingNode(item.id);
	}

	function cancelConnection() {
		setConnectingFrom(undefined);
		setConnectionPointer(undefined);
	}

	function startConnection(item: CanvasNode) {
		if (!ready || busyRef.current) return;
		lastTouchedNode.current = item.id;
		setEditingNode(undefined);
		setSelection({ kind: "node", id: item.id });
		setConnectingFrom(item.id);
		setConnectionPointer(undefined);
	}

	function connectNodes(source: string, destination: string) {
		if (!ready || busyRef.current || !nodesById.has(source) || !nodesById.has(destination)) return;
		const newEdge = { id: nextId("e", design.edges, "id"), source, target: destination, label: "" };
		edit((current) => ({ ...current, edges: [...current.edges, newEdge] }));
		setSelection({ kind: "edge", id: newEdge.id });
		setEditingNode(undefined);
		cancelConnection();
	}

	async function perform(action: "load" | "save" | "use") {
		if (busyRef.current) return;
		if (action === "load" && dirty && !window.confirm("未保存の変更を破棄して、保存済みの設計を読み直しますか？")) return;
		busyRef.current = true;
		setBusy(true);
		setPending(action);
		setError(undefined);
		setNotice("");
		pointerSession.current = undefined;
		setEditingNode(undefined);
		setEditingElementId(undefined);
		cancelConnection();
		try {
			if (action === "use") {
				const { path } = await command<{ path: string }>(`${endpoint}/compose`, document);
				if (!mounted.current) return;
				onComposeDesign(path);
				setNotice("設計の指示と JSON を txt に保存し、ファイルのパスを下書きに追加しました。設計の保存は別操作です。");
			} else {
				const result = action === "load" ? await api<unknown>(endpoint) : await command<unknown>(endpoint, document, "PUT");
				if (!isCanvasDocument(result)) throw new Error("サーバーから届いた設計データが不正です。");
				if (!mounted.current) return;
				setDocument(result);
				setBaseline(JSON.stringify(result.design));
				if (action === "load") history.current = { past: [], future: [] };
				setReady(true);
				setSelection(undefined);
				setNotice(action === "save" ? "設計を保存しました。" : "保存済みの設計を読み込みました。");
			}
		} catch (reason) {
			if (mounted.current) setError(errorMessage(reason));
		} finally {
			if (mounted.current) {
				busyRef.current = false;
				setBusy(false);
			}
		}
	}

	function addNode(position?: { x: number; y: number }, source?: string) {
		if (!ready || busyRef.current) return;
		const bounds = viewport.current?.getBoundingClientRect();
		const centerX = ((bounds?.width ?? 600) / 2 - view.x) / view.zoom - CARD_WIDTH / 2;
		const centerY = ((bounds?.height ?? 400) / 2 - view.y) / view.zoom - CARD_HEIGHT / 2;
		const { x, y } = position ?? nextCanvasPosition(design.nodes, nodesById.get(lastTouchedNode.current ?? ""), { x: centerX, y: centerY });
		const newNode: CanvasNode = { id: nextId("n", design.nodes, "id"), title: `ノード ${design.nodes.length + 1}`, description: "", x, y };
		edit((current) => ({
			...current,
			nodes: [...current.nodes, newNode],
			edges: source ? [...current.edges, { id: nextId("e", current.edges, "id"), source, target: newNode.id, label: "" }] : current.edges,
		}));
		if (!position && (!bounds || x * view.zoom + view.x < 0 || y * view.zoom + view.y < 0 || (x + CARD_WIDTH) * view.zoom + view.x > bounds.width || (y + CARD_HEIGHT) * view.zoom + view.y > bounds.height))
			animateView((current) => ({ ...current, x: (bounds?.width ?? 600) / 2 - (x + CARD_WIDTH / 2) * current.zoom, y: (bounds?.height ?? 400) / 2 - (y + CARD_HEIGHT / 2) * current.zoom }));
		setTool("select");
		editOnBoard(newNode);
	}

	function removeSelection() {
		if (!selection || !ready || busyRef.current) return;
		if (selection.kind === "elements") {
			const toRemove = new Set(selection.ids);
			edit((current) => ({ ...current, elements: (current.elements ?? []).filter((el) => !toRemove.has(el.id)) }));
			setEditingElementId(undefined);
		} else if (selection.kind === "node") {
			edit((current) => ({
				...current,
				nodes: current.nodes.filter((item) => item.id !== selection.id),
				edges: current.edges.filter((item) => item.source !== selection.id && item.target !== selection.id),
			}));
		} else {
			edit((current) => ({ ...current, edges: current.edges.filter((item) => item.id !== selection.id) }));
		}
		setSelection(undefined);
		setEditingNode(undefined);
		cancelConnection();
	}

	function duplicateSelection() {
		if (!selectedElements.length || !ready || busyRef.current) return;
		const existing = [...elements];
		const clones: CanvasElement[] = [];
		for (const el of selectedElements) {
			const clone: CanvasElement = {
				...el,
				id: nextId("el", [...existing, ...clones], "id"),
				x: clampCoord(el.x + 24),
				y: clampCoord(el.y + 24),
				...(el.points ? { points: el.points.map(([px, py]) => [px, py] as [number, number]) } : {}),
			};
			clones.push(clone);
		}
		edit((current) => ({ ...current, elements: [...(current.elements ?? []), ...clones] }));
		setSelection({ kind: "elements", ids: clones.map((c) => c.id) });
	}

	function reorderSelection(direction: "front" | "back") {
		if (!selectedElementIds.size || !ready || busyRef.current) return;
		edit((current) => {
			const list = current.elements ?? [];
			const picked = list.filter((el) => selectedElementIds.has(el.id));
			const rest = list.filter((el) => !selectedElementIds.has(el.id));
			return { ...current, elements: direction === "front" ? [...rest, ...picked] : [...picked, ...rest] };
		});
	}

	function startViewportPointer(event: ReactPointerEvent<HTMLDivElement>) {
		if (busyRef.current || !ready) return;
		if (event.target instanceof Element && event.target.closest("button, input, textarea, select, a, .canvas-tool-dock, .canvas-style-panel")) return;
		const middlePan = event.button === 1;
		if (event.button !== 0 && !middlePan) return;
		event.stopPropagation();
		window.getSelection()?.removeAllRanges();
		if (connectingFrom) return;
		setEditingNode(undefined);
		setEditingElementId(undefined);
		event.currentTarget.focus();

		if (middlePan || spaceHeld || tool === "hand") {
			event.currentTarget.setPointerCapture(event.pointerId);
			setMoving(true);
			pointerSession.current = { mode: "pan", pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
			return;
		}

		const world = toWorld(event.clientX, event.clientY);
		if (tool === "select") {
			event.currentTarget.setPointerCapture(event.pointerId);
			setSelection(undefined);
			setMoving(true);
			pointerSession.current = { mode: "marquee", pointer: event.pointerId, startX: world.x, startY: world.y };
			setMarquee({ x: world.x, y: world.y, width: 0, height: 0 });
			return;
		}

		if (tool === "text") {
			const newEl: CanvasElement = {
				id: nextId("el", elements, "id"),
				type: "text",
				x: clampCoord(world.x),
				y: clampCoord(world.y),
				width: 200,
				height: Math.max(36, style.fontSize * 2),
				stroke: style.stroke,
				fill: "transparent",
				strokeWidth: style.strokeWidth,
				opacity: style.opacity,
				roughness: 0,
				text: "",
				fontSize: style.fontSize,
			};
			edit((current) => ({ ...current, elements: [...(current.elements ?? []), newEl] }));
			setSelection({ kind: "elements", ids: [newEl.id] });
			setEditingElementId(newEl.id);
			setTool("select");
			return;
		}

		event.currentTarget.setPointerCapture(event.pointerId);

		const isSticky = tool === "sticky";
		const isPath = tool === "freedraw" || tool === "line" || tool === "arrow";
		const newEl: CanvasElement = {
			id: nextId("el", elements, "id"),
			type: tool,
			x: clampCoord(world.x),
			y: clampCoord(world.y),
			width: isSticky ? 180 : 1,
			height: isSticky ? 140 : 1,
			stroke: isSticky ? "#ca8a04" : style.stroke,
			fill: isSticky ? "#fef08a" : isPath ? "transparent" : style.fill,
			strokeWidth: style.strokeWidth,
			strokeStyle: style.strokeStyle,
			opacity: style.opacity,
			roughness: isSticky ? 0.5 : style.roughness,
			fontSize: style.fontSize,
			...(isPath ? { points: [[0, 0]] } : {}),
			...(isSticky ? { text: "" } : {}),
		};
		pushHistory(design);
		setDocument((current) => ({ ...current, design: { ...current.design, elements: [...(current.design.elements ?? []), newEl] } }));
		setSelection({ kind: "elements", ids: [newEl.id] });
		setMoving(true);
		pointerSession.current = {
			mode: "draw",
			pointer: event.pointerId,
			elementId: newEl.id,
			startX: world.x,
			startY: world.y,
			rawPoints: [[0, 0]],
		};
	}

	function startElementPointer(event: ReactPointerEvent<SVGGElement>, element: CanvasElement) {
		if (event.button !== 0 || busyRef.current || !ready) return;
		if (spaceHeld || tool === "hand" || tool !== "select") return;
		event.stopPropagation();
		window.getSelection()?.removeAllRanges();
		setEditingNode(undefined);
		setEditingElementId(undefined);
		viewport.current?.focus();
		event.currentTarget.setPointerCapture(event.pointerId);
		const alreadySelected = selectedElementIds.has(element.id);
		const nextIds = event.shiftKey
			? alreadySelected
				? [...selectedElementIds].filter((existing) => existing !== element.id)
				: [...selectedElementIds, element.id]
			: alreadySelected
				? [...selectedElementIds]
				: [element.id];
		setSelection(nextIds.length ? { kind: "elements", ids: nextIds } : undefined);
		const world = toWorld(event.clientX, event.clientY);
		const origins = new Map<string, { x: number; y: number }>();
		for (const el of elements) {
			if (nextIds.includes(el.id)) origins.set(el.id, { x: el.x, y: el.y });
		}
		pushHistory(design);
		setMoving(true);
		pointerSession.current = { mode: "move-elements", pointer: event.pointerId, startX: world.x, startY: world.y, origins };
	}

	function startResizePointer(event: ReactPointerEvent<SVGRectElement>, element: CanvasElement, handle: ResizeHandle) {
		if (event.button !== 0 || busyRef.current || !ready) return;
		event.stopPropagation();
		window.getSelection()?.removeAllRanges();
		viewport.current?.focus();
		event.currentTarget.setPointerCapture(event.pointerId);
		const world = toWorld(event.clientX, event.clientY);
		pushHistory(design);
		setMoving(true);
		pointerSession.current = { mode: "resize", pointer: event.pointerId, elementId: element.id, handle, startX: world.x, startY: world.y, origin: { ...element } };
	}

	function startNodePointer(event: ReactPointerEvent<HTMLElement>, item: CanvasNode) {
		if (event.button !== 0 || busyRef.current || !ready) return;
		if (event.target instanceof Element && event.target.closest("button, input, textarea, select, a")) return;
		if (spaceHeld || tool !== "select") return;
		event.stopPropagation();
		window.getSelection()?.removeAllRanges();
		if (connectingFrom || editingNode === item.id) return;
		setMoving(true);
		setEditingNode(undefined);
		setEditingElementId(undefined);
		event.currentTarget.focus();
		event.currentTarget.setPointerCapture(event.pointerId);
		setSelection({ kind: "node", id: item.id });
		pushHistory(design);
		pointerSession.current = { mode: "node", pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, nodeId: item.id, x: item.x, y: item.y };
	}

	function movePointer(event: ReactPointerEvent<HTMLElement>) {
		if (connectingFrom) {
			const world = toWorld(event.clientX, event.clientY);
			setConnectionPointer(world);
		}
		const session = pointerSession.current;
		if (!session || session.pointer !== event.pointerId || busyRef.current) return;
		if (session.mode === "pan") {
			setView((value) => ({ ...value, x: session.x + (event.clientX - session.clientX), y: session.y + (event.clientY - session.clientY) }));
			return;
		}
		if (session.mode === "node") {
			const x = clampCoord(session.x + (event.clientX - session.clientX) / view.zoom);
			const y = clampCoord(session.y + (event.clientY - session.clientY) / view.zoom);
			edit((value) => ({ ...value, nodes: value.nodes.map((item) => (item.id === session.nodeId ? { ...item, x, y } : item)) }), false);
			return;
		}
		const world = toWorld(event.clientX, event.clientY);
		if (session.mode === "marquee") {
			const x = Math.min(session.startX, world.x);
			const y = Math.min(session.startY, world.y);
			const width = Math.abs(world.x - session.startX);
			const height = Math.abs(world.y - session.startY);
			setMarquee({ x, y, width, height });
			const hit = elements.filter((el) => intersectsRect(elementBounds(el), { x, y, width, height })).map((el) => el.id);
			setSelection(hit.length ? { kind: "elements", ids: hit } : undefined);
			return;
		}
		if (session.mode === "move-elements") {
			const dx = world.x - session.startX;
			const dy = world.y - session.startY;
			edit(
				(current) => ({
					...current,
					elements: (current.elements ?? []).map((el) => {
						const origin = session.origins.get(el.id);
						return origin ? { ...el, x: clampCoord(origin.x + dx), y: clampCoord(origin.y + dy) } : el;
					}),
				}),
				false,
			);
			return;
		}
		if (session.mode === "resize") {
			const dx = world.x - session.startX;
			const dy = world.y - session.startY;
			const { origin, handle } = session;
			let x = origin.x;
			let y = origin.y;
			let width = origin.width;
			let height = origin.height;
			if (handle.includes("e")) width = Math.max(20, origin.width + dx);
			if (handle.includes("s")) height = Math.max(20, origin.height + dy);
			if (handle.includes("w")) {
				const nextW = Math.max(20, origin.width - dx);
				x = origin.x + (origin.width - nextW);
				width = nextW;
			}
			if (handle.includes("n")) {
				const nextH = Math.max(20, origin.height - dy);
				y = origin.y + (origin.height - nextH);
				height = nextH;
			}
			edit(
				(current) => ({
					...current,
					elements: (current.elements ?? []).map((el) =>
						el.id === session.elementId ? { ...el, x: clampCoord(x), y: clampCoord(y), width: Math.round(width), height: Math.round(height) } : el,
					),
				}),
				false,
			);
			return;
		}
		if (session.mode === "draw") {
			const dx = world.x - session.startX;
			const dy = world.y - session.startY;
			edit(
				(current) => ({
					...current,
					elements: (current.elements ?? []).map((el) => {
						if (el.id !== session.elementId) return el;
						if (el.type === "freedraw") {
							session.rawPoints.push([clampCoord(dx), clampCoord(dy)]);
							const pts = simplifyPoints(session.rawPoints, 2);
							const xs = pts.map((p) => p[0]);
							const ys = pts.map((p) => p[1]);
							return { ...el, points: pts, width: Math.max(1, Math.max(...xs) - Math.min(...xs)), height: Math.max(1, Math.max(...ys) - Math.min(...ys)) };
						}
						if (el.type === "line" || el.type === "arrow") {
							return { ...el, points: [[0, 0], [clampCoord(dx), clampCoord(dy)]], width: Math.abs(Math.round(dx)), height: Math.abs(Math.round(dy)) };
						}
						return {
							...el,
							x: clampCoord(Math.min(session.startX, world.x)),
							y: clampCoord(Math.min(session.startY, world.y)),
							width: Math.max(4, Math.round(Math.abs(dx))),
							height: Math.max(4, Math.round(Math.abs(dy))),
						};
					}),
				}),
				false,
			);
		}
	}

	function finishPointer() {
		const session = pointerSession.current;
		pointerSession.current = undefined;
		setMoving(false);
		setMarquee(undefined);
		if (session?.mode === "draw") {
			const created = elements.find((el) => el.id === session.elementId);
			if (created) {
				if (created.type === "sticky") {
					if (created.width < 40 && created.height < 40) {
						edit((current) => ({
							...current,
							elements: (current.elements ?? []).map((el) => (el.id === created.id ? { ...el, width: 180, height: 140 } : el)),
						}), false);
					}
					setEditingElementId(created.id);
					setTool("select");
				} else if (created.type !== "freedraw") {
					if (created.width < 6 && created.height < 6) {
						edit((current) => ({ ...current, elements: (current.elements ?? []).filter((el) => el.id !== created.id) }), false);
						history.current.past.pop();
						setHistoryVersion((v) => v + 1);
						setSelection(undefined);
					} else {
						setTool("select");
					}
				}
			}
		}
	}

	function zoomTo(zoom: number, anchorX?: number, anchorY?: number) {
		const bounds = viewport.current?.getBoundingClientRect();
		const x = anchorX ?? (bounds?.width ?? 600) / 2;
		const y = anchorY ?? (bounds?.height ?? 400) / 2;
		animateView((current) => {
			const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
			return { zoom: next, x: x - ((x - current.x) * next) / current.zoom, y: y - ((y - current.y) * next) / current.zoom };
		});
	}

	function fitDesign() {
		const bounds = viewport.current?.getBoundingClientRect();
		if (!bounds || (!design.nodes.length && !elements.length)) {
			animateView({ x: 40, y: 40, zoom: 1 });
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const item of design.nodes) {
			minX = Math.min(minX, item.x);
			minY = Math.min(minY, item.y);
			maxX = Math.max(maxX, item.x + CARD_WIDTH);
			maxY = Math.max(maxY, item.y + CARD_HEIGHT);
		}
		for (const el of elements) {
			const b = elementBounds(el);
			minX = Math.min(minX, b.x);
			minY = Math.min(minY, b.y);
			maxX = Math.max(maxX, b.x + b.width);
			maxY = Math.max(maxY, b.y + b.height);
		}
		const width = Math.max(100, maxX - minX);
		const height = Math.max(100, maxY - minY);
		const zoom = Math.max(MIN_ZOOM, Math.min(1, (bounds.width - 96) / width, (bounds.height - 96) / height));
		animateView({ zoom, x: (bounds.width - width * zoom) / 2 - minX * zoom, y: (bounds.height - height * zoom) / 2 - minY * zoom });
	}

	function exportDesign() {
		const url = URL.createObjectURL(new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: "application/json" }));
		const anchor = window.document.createElement("a");
		anchor.href = url;
		anchor.download = "project-design.json";
		anchor.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	function exportSvg() {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const el of elements) {
			const b = elementBounds(el);
			minX = Math.min(minX, b.x);
			minY = Math.min(minY, b.y);
			maxX = Math.max(maxX, b.x + b.width);
			maxY = Math.max(maxY, b.y + b.height);
		}
		const pad = 32;
		const vx = Number.isFinite(minX) ? Math.floor(minX - pad) : 0;
		const vy = Number.isFinite(minY) ? Math.floor(minY - pad) : 0;
		const vw = Number.isFinite(maxX) ? Math.max(100, Math.ceil(maxX - minX + pad * 2)) : 800;
		const vh = Number.isFinite(maxY) ? Math.max(100, Math.ceil(maxY - minY + pad * 2)) : 600;
		const items = elements.map((el) => {
			const dash = elementStrokeDasharray(el.strokeStyle);
			const opacity = el.opacity ?? 1;
			if (el.type === "text") {
				const escaped = (el.text ?? "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch] ?? ch);
				return `<text x="${el.x}" y="${el.y + (el.fontSize ?? 16)}" fill="${el.stroke}" opacity="${opacity}" font-size="${el.fontSize ?? 16}" font-family="sans-serif">${escaped}</text>`;
			}
			const d = shapePath(el);
			const head = el.type === "arrow" ? `<path d="${arrowHeadPath(el)}" fill="none" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />` : "";
			return `<g transform="translate(${el.x} ${el.y})" opacity="${opacity}"><path d="${d}" fill="${el.fill}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" ${dash ? `stroke-dasharray="${dash}"` : ""} stroke-linecap="round" stroke-linejoin="round" />${head}</g>`;
		});
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}">${items.join("")}</svg>\n`;
		const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
		const anchor = window.document.createElement("a");
		anchor.href = url;
		anchor.download = "project-design.svg";
		anchor.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	const disabled = !ready || busy;
	const activeStyle: ElementStyleDefaults = primaryElement
		? {
				stroke: primaryElement.stroke,
				fill: primaryElement.fill,
				strokeWidth: primaryElement.strokeWidth,
				strokeStyle: primaryElement.strokeStyle ?? "solid",
				roughness: primaryElement.roughness ?? 1,
				opacity: primaryElement.opacity ?? 1,
				fontSize: primaryElement.fontSize ?? 16,
			}
		: style;
	const activeTypes: readonly CanvasElement["type"][] = selectedElements.length > 0
		? selectedElements.map((el) => el.type)
		: tool !== "select" && tool !== "hand"
			? [tool]
			: [];
	const showFillStyle = activeTypes.some((type) => type === "rectangle" || type === "ellipse" || type === "diamond" || type === "sticky");
	const showStrokeStyle = activeTypes.some((type) => type !== "text" && type !== "sticky");
	const showRoughnessStyle = activeTypes.some((type) => type !== "text" && type !== "sticky" && type !== "freedraw");
	const showFontSizeStyle = activeTypes.some((type) => type === "text" || type === "sticky" || type === "rectangle" || type === "ellipse" || type === "diamond");
	const strokeLabel = activeTypes.length > 0 && activeTypes.every((type) => type === "text")
		? "文字の色"
		: activeTypes.length > 0 && activeTypes.every((type) => type === "sticky")
			? "枠の色"
			: "線の色";
	const showStylePanel = ready && (tool !== "select" && tool !== "hand" || selectedElements.length > 0);
	const handleSize = 8 / view.zoom;

	return (
		<section
			className="canvas-pane"
			aria-label="プロジェクト設計キャンバス"
			aria-busy={busy}
			onKeyUp={(event) => {
				if (event.code === "Space") setSpaceHeld(false);
			}}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing) return;
				const inInput = event.target instanceof Element && !!event.target.closest("input, textarea, select");
				if (event.key === "Escape") {
					event.preventDefault();
					cancelConnection();
					setEditingElementId(undefined);
					if (editingNode) {
						window.document.getElementById(`${id}-node-${editingNode}`)?.focus();
						setEditingNode(undefined);
					} else {
						setSelection(undefined);
						setTool("select");
					}
					return;
				}
				if (inInput) return;
				if (event.code === "Space") {
					event.preventDefault();
					setSpaceHeld(true);
					return;
				}
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
					event.preventDefault();
					if (event.shiftKey) redo();
					else undo();
					return;
				}
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
					event.preventDefault();
					redo();
					return;
				}
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
					event.preventDefault();
					duplicateSelection();
					return;
				}
				if (event.key === "Delete" || event.key === "Backspace") {
					if (selection) {
						event.preventDefault();
						removeSelection();
					}
					return;
				}
				if (!event.ctrlKey && !event.metaKey && !event.altKey) {
					const mapped = SHORTCUT_TO_TOOL[event.key.toLowerCase()];
					if (mapped) {
						event.preventDefault();
						setTool(mapped);
					} else if (event.key.toLowerCase() === "n") {
						event.preventDefault();
						addNode();
					}
				}
			}}
		>
			<div className="canvas-layout">
				<div className="canvas-drawing">
					<div className="canvas-view-controls" aria-label="表示操作">
						<input className="canvas-title" aria-label="設計タイトル" value={design.title} maxLength={CANVAS_LIMITS.title} placeholder="設計のタイトル" disabled={disabled} onChange={(event) => edit((current) => ({ ...current, title: event.target.value }))} />
						<details className="canvas-properties canvas-description"><summary>概要</summary><div><label>目的・概要<textarea rows={4} value={design.description} maxLength={CANVAS_LIMITS.description} disabled={disabled} onChange={(event) => edit((current) => ({ ...current, description: event.target.value }))} /></label></div></details>
						<button type="button" className="canvas-icon-btn" aria-label="元に戻す" title="元に戻す (Ctrl+Z)" disabled={disabled || !history.current.past.length} onClick={undo}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg></button>
						<button type="button" className="canvas-icon-btn" aria-label="やり直す" title="やり直す (Ctrl+Y)" disabled={disabled || !history.current.future.length} onClick={redo}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg></button>
						<button type="button" aria-label="縮小" onClick={() => zoomTo(view.zoom / 1.2)} disabled={view.zoom <= MIN_ZOOM}><Icon name="minus" size="inline" /></button>
						<output aria-label="拡大率">{Math.round(view.zoom * 100)}%</output>
						<button type="button" aria-label="拡大" onClick={() => zoomTo(view.zoom * 1.2)} disabled={view.zoom >= MAX_ZOOM}><Icon name="plus" size="inline" /></button>
						<button type="button" onClick={fitDesign}>全体表示</button>
						<button className="canvas-add" type="button" onClick={() => addNode()} disabled={disabled}>＋ ノード</button>
						<Presence show={!!node || !!edge}><details className="canvas-properties canvas-selection"><summary>選択項目</summary><div>
							{node && <>
								<label>ノード名<input value={node.title} maxLength={CANVAS_LIMITS.title} disabled={disabled} onChange={(event) => patchNode({ title: event.target.value })} /></label>
								<label>説明<textarea rows={3} value={node.description} maxLength={CANVAS_LIMITS.description} disabled={disabled} onChange={(event) => patchNode({ description: event.target.value })} /></label>
								<div className="canvas-coordinate-fields">{(["x", "y"] as const).map((axis) => <label key={axis}>{axis.toUpperCase()} 座標<input type="number" min={-CANVAS_LIMITS.coordinate} max={CANVAS_LIMITS.coordinate} step="any" value={node[axis]} disabled={disabled} onChange={(event) => {
									const value = event.target.valueAsNumber;
									if (Number.isFinite(value) && Math.abs(value) <= CANVAS_LIMITS.coordinate) patchNode({ [axis]: value });
								}} /></label>)}</div>
							</>}
							{edge && <label>接続ラベル<input value={edge.label} maxLength={CANVAS_LIMITS.label} disabled={disabled} onChange={(event) => edit((current) => ({ ...current, edges: current.edges.map((item) => (item.id === edge.id ? { ...item, label: event.target.value } : item)) }))} /></label>}
							<button type="button" className="danger" disabled={disabled} onClick={removeSelection}>{node ? "ノードと接続を削除" : "接続を削除"}</button>
						</div></details></Presence>
						<span key={`${!!connectionSource}:${ready}:${dirty}:${notice}`} className={`canvas-toolbar-status motion-label${dirty ? " warning" : ""}`} role="status" title={connectionSource ? `${connectionSource.title || "無題"} → 接続先を選択` : notice}>{connectionSource ? `${connectionSource.title || "無題"} → 接続先を選択` : !ready ? (busy ? "読み込み中…" : "未読み込み") : dirty ? "未保存" : notice || "保存済み"}</span>
						<button type="button" onClick={() => { void perform("save"); }} disabled={disabled || !dirty}>{busy && pending === "save" ? "保存中…" : "保存"}</button>
						{destinationControl}
						<button className="canvas-use" type="button" onClick={() => { void perform("use"); }} disabled={disabled}>AI に相談する下書きへ</button>
						<details className="canvas-properties canvas-file-menu"><summary>ファイル</summary><div>
							<button type="button" onClick={() => { void perform("load"); }} disabled={busy}>保存済みを読み込む</button>
							<button type="button" onClick={exportDesign} disabled={disabled}>JSON 書き出し</button>
							<button type="button" onClick={exportSvg} disabled={disabled || !elements.length}>SVG 書き出し</button>
						</div></details>
					</div>

					<Presence show={!!error}><p className="error canvas-message" role="alert">{error}</p></Presence>

					<div
						ref={viewport}
						className={`canvas-viewport${connectionSource ? " is-connecting" : ""}`}
						data-tool={tool}
						data-space={spaceHeld || undefined}
						data-dragging={moving}
						tabIndex={0}
						role="group"
						aria-label="自由設計キャンバス。ツールバーまたはショートカット（V/H/R/O/D/A/L/P/T/S）で図形やフリーハンドを描画できます。Space+ドラッグで移動、ホイールで拡大縮小。"
						onClick={(event) => {
							if (!connectingFrom || disabled || (event.target instanceof Element && event.target.closest(".canvas-node, .canvas-edge-hit"))) return;
							const world = toWorld(event.clientX, event.clientY);
							addNode({ x: clampCoord(world.x - CARD_WIDTH / 2), y: clampCoord(world.y - CARD_HEIGHT / 2) }, connectingFrom);
						}}
						onMouseDown={(event) => {
							if (event.target instanceof Element && event.target.closest("button, input, textarea, select, a, label")) return;
							event.preventDefault();
						}}
						onDragStart={(event) => {
							if (event.target instanceof Element && event.target.closest("input, textarea")) return;
							event.preventDefault();
						}}
						onPointerDown={startViewportPointer}
						onPointerMove={movePointer}
						onPointerUp={finishPointer}
						onPointerCancel={finishPointer}
						onLostPointerCapture={finishPointer}
					>
						<div className="canvas-tool-dock" role="toolbar" aria-label="描画ツール">
							{TOOLS.map((item, index) => (
								<span key={item.id} style={{ display: "contents" }}>
									{index === 2 && <span className="canvas-tool-sep" aria-hidden="true" />}
									<button
										type="button"
										aria-label={item.label}
										title={`${item.label} (${item.key})`}
										aria-pressed={tool === item.id}
										disabled={disabled}
										onClick={() => setTool(item.id)}
									>
										{item.icon}
										<span className="canvas-tool-key" aria-hidden="true">{item.key}</span>
									</button>
								</span>
							))}
						</div>

						{showStylePanel && (
							<aside className="canvas-style-panel" aria-label="スタイル設定" onPointerDown={(event) => event.stopPropagation()}>
								<div className="canvas-style-header">
									<span className="canvas-style-label">スタイル</span>
									<button type="button" className="canvas-style-toggle" aria-label={styleOpen ? "スタイルを折りたたむ" : "スタイルを開く"} onClick={() => setStyleOpen((v) => !v)}>{styleOpen ? "−" : "＋"}</button>
								</div>
								{styleOpen && <>
								<div className="canvas-style-group">
									<span className="canvas-style-label">{strokeLabel}</span>
									<div className="canvas-swatches">
										{STROKE_PALETTE.map((color) => (
											<button
												key={color}
												type="button"
												className="canvas-swatch"
												style={{ background: color }}
												aria-label={`${strokeLabel} ${color}`}
												aria-pressed={activeStyle.stroke === color}
												onClick={() => updateStyle("stroke", color)}
											/>
										))}
										<input
											type="color"
											className="canvas-color-input"
											aria-label={`${strokeLabel}を自由に選ぶ`}
											value={activeStyle.stroke.startsWith("#") && activeStyle.stroke.length === 7 ? activeStyle.stroke : "#e8e8e8"}
											onChange={(event) => updateStyle("stroke", event.currentTarget.value)}
										/>
									</div>
								</div>

								{showFillStyle && (
									<div className="canvas-style-group">
										<span className="canvas-style-label">塗りつぶし</span>
										<div className="canvas-swatches">
											{FILL_PALETTE.map((color) => (
												<button
													key={color}
													type="button"
													className={`canvas-swatch${color === "transparent" ? " is-transparent" : ""}`}
													style={color === "transparent" ? undefined : { background: color }}
													aria-label={color === "transparent" ? "塗りつぶしなし" : `塗りつぶし ${color}`}
													aria-pressed={activeStyle.fill === color}
													onClick={() => updateStyle("fill", color)}
												/>
											))}
											<input
												type="color"
												className="canvas-color-input"
												aria-label="塗りつぶし色を自由に選ぶ"
												value={activeStyle.fill.startsWith("#") && activeStyle.fill.length === 7 ? activeStyle.fill : "#242c38"}
												onChange={(event) => updateStyle("fill", event.currentTarget.value)}
											/>
										</div>
									</div>
								)}

								{showStrokeStyle && (
									<>
										<div className="canvas-style-group">
											<span className="canvas-style-label">線の太さ</span>
											<div className="canvas-style-buttons">
												{([1.5, 2.5, 4.5] as const).map((w, i) => (
													<button key={w} type="button" aria-pressed={Math.abs(activeStyle.strokeWidth - w) < 0.6} onClick={() => updateStyle("strokeWidth", w)}>
														{["細", "中", "太"][i]}
													</button>
												))}
											</div>
										</div>

										<div className="canvas-style-group">
											<span className="canvas-style-label">線種</span>
											<div className="canvas-style-buttons">
												{(
													[
														["solid", "実線"],
														["dashed", "破線"],
														["dotted", "点線"],
													] as const
												).map(([val, label]) => (
													<button key={val} type="button" aria-pressed={activeStyle.strokeStyle === val} onClick={() => updateStyle("strokeStyle", val)}>
														{label}
													</button>
												))}
											</div>
										</div>
									</>
								)}

								{showRoughnessStyle && (
									<div className="canvas-style-group">
										<span className="canvas-style-label">描き味</span>
										<div className="canvas-style-buttons">
											<button type="button" aria-pressed={activeStyle.roughness > 0} onClick={() => updateStyle("roughness", 1)}>スケッチ</button>
											<button type="button" aria-pressed={activeStyle.roughness === 0} onClick={() => updateStyle("roughness", 0)}>クッキリ</button>
										</div>
									</div>
								)}

								{showFontSizeStyle && (
									<div className="canvas-style-group">
										<span className="canvas-style-label">文字サイズ</span>
										<div className="canvas-style-buttons">
											{([14, 18, 24, 34] as const).map((sz, i) => (
												<button key={sz} type="button" aria-pressed={activeStyle.fontSize === sz} onClick={() => updateStyle("fontSize", sz)}>
													{["S", "M", "L", "XL"][i]}
												</button>
											))}
										</div>
									</div>
								)}

								<div className="canvas-style-group">
									<label className="canvas-style-label">
										不透明度 ({Math.round(activeStyle.opacity * 100)}%)
										<input
											type="range"
											min="0.1"
											max="1"
											step="0.05"
											value={activeStyle.opacity}
											onChange={(event) => updateStyle("opacity", Number(event.currentTarget.value))}
										/>
									</label>
								</div>

								{selectedElements.length > 0 && (
									<div className="canvas-style-group">
										<span className="canvas-style-label">要素の操作</span>
										<div className="canvas-style-buttons">
											<button type="button" onClick={() => reorderSelection("front")}>最前面</button>
											<button type="button" onClick={() => reorderSelection("back")}>最背面</button>
										</div>
										<div className="canvas-style-buttons">
											<button type="button" onClick={duplicateSelection}>複製</button>
											<button type="button" className="danger" onClick={removeSelection}>削除</button>
										</div>
									</div>
								)}
								</>}
							</aside>
						)}

						<div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
							<svg className="canvas-elements-svg" aria-label="自由描画レイヤー">
								{elements.map((el) => {
									const selected = selectedElementIds.has(el.id);
									const dash = elementStrokeDasharray(el.strokeStyle);
									const d = shapePath(el);
									const isTextOnly = el.type === "text";
									const isSticky = el.type === "sticky";
									const canHaveText = isTextOnly || isSticky || el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond";
									return (
										<g
											key={el.id}
											className="canvas-element-group"
											transform={`translate(${el.x} ${el.y})`}
											opacity={el.opacity ?? 1}
											onPointerDown={(event) => startElementPointer(event, el)}
											onDoubleClick={(event) => {
												if (!canHaveText || disabled) return;
												event.preventDefault();
												event.stopPropagation();
												window.getSelection()?.removeAllRanges();
												setSelection({ kind: "elements", ids: [el.id] });
												setEditingElementId(el.id);
											}}
										>
											{!isTextOnly && (
												<>
													<path
														d={d}
														fill={el.fill}
														stroke={el.stroke}
														strokeWidth={el.strokeWidth}
														strokeDasharray={dash}
														strokeLinecap="round"
														strokeLinejoin="round"
													/>
													{el.type === "arrow" && (
														<path
															d={arrowHeadPath(el)}
															fill="none"
															stroke={el.stroke}
															strokeWidth={el.strokeWidth}
															strokeLinecap="round"
															strokeLinejoin="round"
														/>
													)}
													<path className="canvas-element-hit" d={d} />
												</>
											)}
											{isTextOnly && (
												<rect x={0} y={0} width={Math.max(40, el.width)} height={Math.max(24, el.height)} fill="transparent" />
											)}
											{canHaveText && editingElementId !== el.id && (el.text || isTextOnly) && (
												<foreignObject x={0} y={0} width={Math.max(40, el.width)} height={Math.max(24, el.height)}>
													<div
														className={`canvas-element-text-box${isTextOnly ? " is-text" : ""}${isSticky ? " is-sticky" : ""}`}
														style={{ color: isSticky ? "#1e1e2e" : el.stroke, fontSize: el.fontSize ?? 16 }}
													>
														{el.text || (isTextOnly ? "テキスト" : "")}
													</div>
												</foreignObject>
											)}
											{selected && (() => {
												const b = elementBounds(el);
												const rx = b.x - el.x - 4;
												const ry = b.y - el.y - 4;
												const rw = b.width + 8;
												const rh = b.height + 8;
												const resizable = primaryElement?.id === el.id && !el.points;
												const handles: readonly { id: ResizeHandle; cx: number; cy: number }[] = [
													{ id: "nw", cx: rx, cy: ry },
													{ id: "n", cx: rx + rw / 2, cy: ry },
													{ id: "ne", cx: rx + rw, cy: ry },
													{ id: "e", cx: rx + rw, cy: ry + rh / 2 },
													{ id: "se", cx: rx + rw, cy: ry + rh },
													{ id: "s", cx: rx + rw / 2, cy: ry + rh },
													{ id: "sw", cx: rx, cy: ry + rh },
													{ id: "w", cx: rx, cy: ry + rh / 2 },
												];
												return (
													<>
														<rect className="canvas-selection-box" x={rx} y={ry} width={rw} height={rh} />
														{resizable &&
															handles.map((h) => (
																<rect
																	key={h.id}
																	className="canvas-resize-handle"
																	data-handle={h.id}
																	x={h.cx - handleSize / 2}
																	y={h.cy - handleSize / 2}
																	width={handleSize}
																	height={handleSize}
																	onPointerDown={(event) => startResizePointer(event, el, h.id)}
																/>
															))}
													</>
												);
											})()}
										</g>
									);
								})}
								{marquee && <rect className="canvas-marquee" x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height} />}
							</svg>

							{editingElement && (
								<textarea
									ref={inlineTextRef}
									className={`canvas-inline-text${editingElement.type === "sticky" ? " is-sticky" : ""}`}
									aria-label="テキストを編集"
									value={editingElement.text ?? ""}
									style={{
										left: editingElement.x,
										top: editingElement.y,
										width: Math.max(120, editingElement.width),
										height: Math.max(40, editingElement.height),
										fontSize: editingElement.fontSize ?? 16,
										color: editingElement.type === "sticky" ? "#1e1e2e" : editingElement.stroke,
									}}
									onChange={(event) => {
										const nextText = event.currentTarget.value;
										edit(
											(current) => ({
												...current,
												elements: (current.elements ?? []).map((el) =>
													el.id === editingElement.id ? { ...el, text: nextText } : el,
												),
											}),
											false,
										);
									}}
									onBlur={(event) => {
										if (event.relatedTarget instanceof Element && event.relatedTarget.closest(".canvas-style-panel")) return;
										if (editingElement.type === "text" && !(editingElement.text ?? "").trim()) {
											edit((current) => ({ ...current, elements: (current.elements ?? []).filter((el) => el.id !== editingElement.id) }), false);
											setSelection(undefined);
										}
										setEditingElementId(undefined);
									}}
									onKeyDown={(event) => {
										if (event.key === "Escape") {
											event.stopPropagation();
											setEditingElementId(undefined);
										}
									}}
								/>
							)}

							<svg className="canvas-connections" aria-hidden="true">
								<defs><marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
								<MotionItems items={design.edges} itemKey={(item) => item.id} enabled={false}>{(item) => {
									const source = nodesById.get(item.source);
									const destination = nodesById.get(item.target);
									if (!source || !destination) return <g key={item.id} />;
									const x1 = source.x + CARD_WIDTH;
									const y1 = source.y + CARD_HEIGHT / 2;
									const x2 = destination.x;
									const y2 = destination.y + CARD_HEIGHT / 2;
									const bend = Math.max(70, Math.abs(x2 - x1) / 2);
									const self = source.id === destination.id;
									const path = self ? `M ${x1} ${y1} C ${x1 + 100} ${y1 - 220}, ${x2 - 100} ${y2 - 220}, ${x2} ${y2}` : `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
									return <g key={item.id} className={edge?.id === item.id ? "selected" : ""}>
										<path d={path} markerEnd={`url(#${id}-arrow)`} />
										<path className="canvas-edge-hit" d={path} onPointerDown={(event) => { event.stopPropagation(); window.getSelection()?.removeAllRanges(); if (!disabled) { cancelConnection(); setEditingNode(undefined); setSelection({ kind: "edge", id: item.id }); } }} />
										<text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - (self ? 165 : 10)} textAnchor="middle">{item.label.length > 32 ? `${item.label.slice(0, 32)}…` : item.label}</text>
									</g>;
								}}</MotionItems>
								<Presence show={!!connectionSource}>{connectionSource && <path className="canvas-connection-preview" d={`M ${connectionSource.x + CARD_WIDTH} ${connectionSource.y + CARD_HEIGHT / 2} C ${connectionSource.x + CARD_WIDTH + 80} ${connectionSource.y + CARD_HEIGHT / 2}, ${(connectionPointer?.x ?? connectionSource.x + CARD_WIDTH + 120) - 80} ${connectionPointer?.y ?? connectionSource.y + CARD_HEIGHT / 2}, ${connectionPointer?.x ?? connectionSource.x + CARD_WIDTH + 120} ${connectionPointer?.y ?? connectionSource.y + CARD_HEIGHT / 2}`} markerEnd={`url(#${id}-arrow)`} />}</Presence>
							</svg>

							<MotionItems items={design.nodes} itemKey={(item) => item.id} enabled={false}>{(item) => <div key={item.id} id={`${id}-node-${item.id}`} className={`canvas-node${node?.id === item.id ? " selected" : ""}${connectingFrom === item.id ? " connection-source" : ""}${editingNode === item.id ? " is-editing" : ""}`} style={{ left: item.x, top: item.y, width: CARD_WIDTH, height: CARD_HEIGHT }} role="group" tabIndex={disabled ? -1 : 0} aria-label={`${item.title || "無題のノード"}。Enter で編集、矢印キーで移動、Delete キーで削除。接続ボタンから他のノードへ接続できます。`} onClick={(event) => {
								if (event.target instanceof Element && event.target.closest("button, input, textarea")) return;
								if (connectingFrom) connectNodes(connectingFrom, item.id);
								else setSelection({ kind: "node", id: item.id });
							}} onDoubleClick={(event) => {
								if (event.target instanceof Element && event.target.closest("button, input, textarea")) return;
								event.preventDefault();
								event.stopPropagation();
								window.getSelection()?.removeAllRanges();
								editOnBoard(item);
							}} onFocus={(event) => {
								if (event.target === event.currentTarget) setSelection({ kind: "node", id: item.id });
							}} onPointerDownCapture={() => { lastTouchedNode.current = item.id; }} onFocusCapture={() => { lastTouchedNode.current = item.id; }} onPointerDown={(event) => startNodePointer(event, item)} onKeyDown={(event) => {
								if (disabled || event.target !== event.currentTarget) return;
								const step = event.shiftKey ? 40 : 10;
								if (event.key === "Enter") { event.preventDefault(); if (connectingFrom) connectNodes(connectingFrom, item.id); else editOnBoard(item); }
								else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelection(); }
								else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
									event.preventDefault();
									const x = clampCoord(item.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0));
									const y = clampCoord(item.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0));
									edit((current) => ({ ...current, nodes: current.nodes.map((value) => (value.id === item.id ? { ...value, x, y } : value)) }));
								}
							}}>
								{editingNode === item.id ? <div className="canvas-inline-editor motion-label">
									<label>ノード名<input ref={inlineTitle} value={item.title} maxLength={CANVAS_LIMITS.title} disabled={disabled} onChange={(event) => edit((current) => ({ ...current, nodes: current.nodes.map((value) => (value.id === item.id ? { ...value, title: event.target.value } : value)) }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); setEditingNode(undefined); window.document.getElementById(`${id}-node-${item.id}`)?.focus(); } }} /></label>
									<label>説明<textarea rows={2} value={item.description} maxLength={CANVAS_LIMITS.description} placeholder="役割やメモを追加" disabled={disabled} onChange={(event) => edit((current) => ({ ...current, nodes: current.nodes.map((value) => (value.id === item.id ? { ...value, description: event.target.value } : value)) }))} /></label>
									<button type="button" disabled={disabled} onClick={() => { setEditingNode(undefined); window.document.getElementById(`${id}-node-${item.id}`)?.focus(); }}>編集を完了</button>
								</div> : <><strong>{item.title || "無題のノード"}</strong>{item.description && <span className="canvas-node-description">{item.description}</span>}<div className="canvas-node-footer"><button type="button" disabled={disabled} aria-label={`${item.title || "無題のノード"}をボード上で編集`} onClick={() => editOnBoard(item)}>編集</button></div></>}
								<Presence show={!!connectionSource}><button className="canvas-connect-target" type="button" disabled={disabled} aria-label={`${item.title || "無題のノード"}へ接続${connectingFrom === item.id ? "（自身）" : ""}`} onClick={() => { if (connectionSource) connectNodes(connectionSource.id, item.id); }}>ここへ</button></Presence>
								<button className="canvas-connect-handle" type="button" disabled={disabled} aria-label={`${item.title || "無題のノード"}から接続を開始`} aria-pressed={connectingFrom === item.id} onClick={() => (connectingFrom === item.id ? cancelConnection() : startConnection(item))}>接続 <span aria-hidden="true">＋</span></button>
							</div>}</MotionItems>
						</div>

						<Presence show={ready && design.nodes.length === 0 && elements.length === 0}>
							<div className="canvas-empty">
								<h3>自由に描いて設計する</h3>
								<p>上のツールバーから四角・楕円・矢印・フリーハンド・テキスト・付箋を描画できます。</p>
							</div>
						</Presence>
					</div>
				</div>
			</div>
		</section>
	);
}
