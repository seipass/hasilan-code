import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import {
	CANVAS_LIMITS,
	type CanvasDesign,
	type CanvasDocument,
	type CanvasNode,
	emptyCanvasDocument,
	isCanvasDocument,
	serializeCanvasDesign,
} from "../shared/canvas.ts";
import { api, command, errorMessage } from "./api.ts";
import "./CanvasPane.css";

export interface CanvasPaneProps {
	workspaceId: string;
	destinationControl: ReactNode;
	onComposeDesign: (text: string) => void;
	onDirtyChange?: (dirty: boolean) => void;
}

const CARD_WIDTH = 240;
const CARD_HEIGHT = 176;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

type Selection = { kind: "node" | "edge"; id: string } | undefined;
type Gesture = {
	pointer: number;
	clientX: number;
	clientY: number;
	x: number;
	y: number;
	nodeId?: string;
};

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
	const [view, setView] = useState({ x: 40, y: 40, zoom: 1 });
	const [editingNode, setEditingNode] = useState<string>();
	const [connectingFrom, setConnectingFrom] = useState<string>();
	const [connectionPointer, setConnectionPointer] = useState<{ x: number; y: number }>();
	const inlineTitle = useRef<HTMLInputElement>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const gesture = useRef<Gesture | undefined>(undefined);
	const busyRef = useRef(true);
	const mounted = useRef(false);
	const dirtyCallback = useRef(onDirtyChange);
	dirtyCallback.current = onDirtyChange;
	const design = document.design;
	const serialized = useMemo(() => JSON.stringify(design), [design]);
	const dirty = ready && serialized !== baseline;
	const node = selection?.kind === "node" ? design.nodes.find((item) => item.id === selection.id) : undefined;
	const edge = selection?.kind === "edge" ? design.edges.find((item) => item.id === selection.id) : undefined;
	const nodesById = useMemo(() => new Map(design.nodes.map((item) => [item.id, item])), [design.nodes]);
	const connectionSource = connectingFrom ? nodesById.get(connectingFrom) : undefined;
	const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/canvas`;

	useEffect(() => {
		mounted.current = true;
		const controller = new AbortController();
		void api<unknown>(endpoint, { signal: controller.signal }).then((loaded) => {
			if (!isCanvasDocument(loaded)) throw new Error("サーバーから届いた設計データが不正です。");
			if (!controller.signal.aborted) {
				setDocument(loaded);
				setBaseline(JSON.stringify(loaded.design));
				setReady(true);
			}
		}).catch((reason: unknown) => {
			if (!controller.signal.aborted) setError(errorMessage(reason));
		}).finally(() => {
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
				return { zoom, x: x - (x - current.x) * zoom / current.zoom, y: y - (y - current.y) * zoom / current.zoom };
			});
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, []);

	function edit(change: (current: CanvasDesign) => CanvasDesign) {
		if (!ready || busyRef.current) return;
		setDocument((current) => ({ ...current, design: change(current.design) }));
		setNotice("");
	}

	function patchNode(patch: Partial<Omit<CanvasNode, "id">>) {
		if (!node) return;
		edit((current) => ({ ...current, nodes: current.nodes.map((item) => item.id === node.id ? { ...item, ...patch } : item) }));
	}

	function editOnBoard(item: CanvasNode) {
		if (!ready || busyRef.current) return;
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
		setEditingNode(undefined);
		setSelection({ kind: "node", id: item.id });
		setConnectingFrom(item.id);
		setConnectionPointer(undefined);
	}

	function connectNodes(source: string, destination: string) {
		if (!ready || busyRef.current || !nodesById.has(source) || !nodesById.has(destination)) return;
		const newEdge = { id: crypto.randomUUID(), source, target: destination, label: "" };
		edit((current) => ({ ...current, edges: [...current.edges, newEdge] }));
		setSelection({ kind: "edge", id: newEdge.id });
		setEditingNode(undefined);
		cancelConnection();
		setNotice("");
	}

	async function perform(action: "load" | "save" | "use") {
		if (busyRef.current) return;
		if (action === "load" && dirty && !window.confirm("未保存の変更を破棄して、保存済みの設計を読み直しますか？")) return;
		busyRef.current = true;
		setBusy(true);
		setPending(action);
		setError(undefined);
		setNotice("");
		gesture.current = undefined;
		setEditingNode(undefined);
		cancelConnection();
		try {
			if (action === "use") {
				onComposeDesign(serializeCanvasDesign(design));
				if (mounted.current) setNotice("現在の設計を AI への下書きに追加しました。送信先と内容を確認してから送信してください。設計の保存は別操作です。");
			} else {
				const result = action === "load" ? await api<unknown>(endpoint) : await command<unknown>(endpoint, document, "PUT");
				if (!isCanvasDocument(result)) throw new Error("サーバーから届いた設計データが不正です。");
				if (!mounted.current) return;
				setDocument(result);
				setBaseline(JSON.stringify(result.design));
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

	function addNode() {
		if (!ready || busyRef.current) return;
		const bounds = viewport.current?.getBoundingClientRect();
		const centerX = ((bounds?.width ?? 600) / 2 - view.x) / view.zoom - CARD_WIDTH / 2;
		const centerY = ((bounds?.height ?? 400) / 2 - view.y) / view.zoom - CARD_HEIGHT / 2;
		let x = centerX;
		let y = centerY;
		for (let index = 0; index <= design.nodes.length; index++) {
			x = Math.round(Math.max(-CANVAS_LIMITS.coordinate, Math.min(CANVAS_LIMITS.coordinate, centerX + (index % 3) * (CARD_WIDTH + 64))));
			y = Math.round(Math.max(-CANVAS_LIMITS.coordinate, Math.min(CANVAS_LIMITS.coordinate, centerY + Math.floor(index / 3) * (CARD_HEIGHT + 48))));
			if (!design.nodes.some((item) => Math.abs(item.x - x) < CARD_WIDTH + 24 && Math.abs(item.y - y) < CARD_HEIGHT + 24)) break;
		}
		const newNode: CanvasNode = { id: crypto.randomUUID(), title: `ノード ${design.nodes.length + 1}`, description: "", x, y };
		edit((current) => ({ ...current, nodes: [...current.nodes, newNode] }));
		setView((current) => ({ ...current, x: (bounds?.width ?? 600) / 2 - (x + CARD_WIDTH / 2) * current.zoom, y: (bounds?.height ?? 400) / 2 - (y + CARD_HEIGHT / 2) * current.zoom }));
		editOnBoard(newNode);
	}

	function removeSelection() {
		if (!selection || !ready || busyRef.current) return;
		edit((current) => selection.kind === "node"
			? { ...current, nodes: current.nodes.filter((item) => item.id !== selection.id), edges: current.edges.filter((item) => item.source !== selection.id && item.target !== selection.id) }
			: { ...current, edges: current.edges.filter((item) => item.id !== selection.id) });
		setSelection(undefined);
		setEditingNode(undefined);
		cancelConnection();
	}

	function beginGesture(event: ReactPointerEvent<HTMLElement>, item?: CanvasNode) {
		if (event.button !== 0 || busyRef.current || !ready) return;
		if (event.target instanceof Element && event.target.closest("button, input, textarea, select, a")) return;
		event.stopPropagation();
		if (item && (connectingFrom || editingNode === item.id)) return;
		setEditingNode(undefined);
		event.currentTarget.focus();
		event.currentTarget.setPointerCapture(event.pointerId);
		if (item) setSelection({ kind: "node", id: item.id });
		else if (!connectingFrom) setSelection(undefined);
		gesture.current = {
			pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY,
			x: item?.x ?? view.x, y: item?.y ?? view.y, nodeId: item?.id,
		};
	}

	function moveGesture(event: ReactPointerEvent<HTMLElement>) {
		if (connectingFrom) {
			const bounds = viewport.current?.getBoundingClientRect();
			if (bounds) setConnectionPointer({ x: (event.clientX - bounds.left - view.x) / view.zoom, y: (event.clientY - bounds.top - view.y) / view.zoom });
		}
		const current = gesture.current;
		if (!current || current.pointer !== event.pointerId || busyRef.current) return;
		const dx = event.clientX - current.clientX;
		const dy = event.clientY - current.clientY;
		if (current.nodeId) {
			const x = Math.round(Math.max(-CANVAS_LIMITS.coordinate, Math.min(CANVAS_LIMITS.coordinate, current.x + dx / view.zoom)));
			const y = Math.round(Math.max(-CANVAS_LIMITS.coordinate, Math.min(CANVAS_LIMITS.coordinate, current.y + dy / view.zoom)));
			edit((value) => ({ ...value, nodes: value.nodes.map((item) => item.id === current.nodeId ? { ...item, x, y } : item) }));
		} else setView((value) => ({ ...value, x: current.x + dx, y: current.y + dy }));
	}

	function zoomTo(zoom: number, anchorX?: number, anchorY?: number) {
		const bounds = viewport.current?.getBoundingClientRect();
		const x = anchorX ?? (bounds?.width ?? 600) / 2;
		const y = anchorY ?? (bounds?.height ?? 400) / 2;
		setView((current) => {
			const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
			return { zoom: next, x: x - (x - current.x) * next / current.zoom, y: y - (y - current.y) * next / current.zoom };
		});
	}

	function fitDesign() {
		const bounds = viewport.current?.getBoundingClientRect();
		if (!bounds || !design.nodes.length) { setView({ x: 40, y: 40, zoom: 1 }); return; }
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
		const width = maxX - minX;
		const height = maxY - minY;
		const zoom = Math.max(MIN_ZOOM, Math.min(1, (bounds.width - 64) / width, (bounds.height - 64) / height));
		setView({ zoom, x: (bounds.width - width * zoom) / 2 - minX * zoom, y: (bounds.height - height * zoom) / 2 - minY * zoom });
	}

	function exportDesign() {
		const url = URL.createObjectURL(new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: "application/json" }));
		const anchor = window.document.createElement("a");
		anchor.href = url;
		anchor.download = "project-design.json";
		anchor.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	const disabled = !ready || busy;
	return <section className="canvas-pane" aria-label="プロジェクト設計キャンバス" aria-busy={busy} onKeyDown={(event) => {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			cancelConnection();
			if (editingNode) {
				window.document.getElementById(`${id}-node-${editingNode}`)?.focus();
				setEditingNode(undefined);
			}
		}
	}}>
		<div className="canvas-layout">
			<div className="canvas-drawing">
				<div className="canvas-view-controls" aria-label="表示操作">
					<input className="canvas-title" aria-label="設計タイトル" value={design.title} maxLength={CANVAS_LIMITS.title} placeholder="設計のタイトル" disabled={disabled} onChange={(event) => edit((current) => ({ ...current, title: event.target.value }))} />
					<details className="canvas-properties canvas-description"><summary>概要</summary><div><label>目的・概要<textarea rows={4} value={design.description} maxLength={CANVAS_LIMITS.description} disabled={disabled} onChange={(event) => edit((current) => ({ ...current, description: event.target.value }))} /></label></div></details>
					<button type="button" aria-label="縮小" onClick={() => zoomTo(view.zoom / 1.2)} disabled={view.zoom <= MIN_ZOOM}>−</button>
					<output aria-label="拡大率">{Math.round(view.zoom * 100)}%</output>
					<button type="button" aria-label="拡大" onClick={() => zoomTo(view.zoom * 1.2)} disabled={view.zoom >= MAX_ZOOM}>＋</button>
					<button type="button" onClick={fitDesign}>全体表示</button>
					<button className="canvas-add" type="button" onClick={addNode} disabled={disabled}>＋ ノード</button>
					{selection && <details className="canvas-properties canvas-selection"><summary>選択項目</summary><div>
						{node && <>
							<label>ノード名<input value={node.title} maxLength={CANVAS_LIMITS.title} disabled={disabled} onChange={(event) => patchNode({ title: event.target.value })} /></label>
							<label>説明<textarea rows={3} value={node.description} maxLength={CANVAS_LIMITS.description} disabled={disabled} onChange={(event) => patchNode({ description: event.target.value })} /></label>
							<div className="canvas-coordinate-fields">{(["x", "y"] as const).map((axis) => <label key={axis}>{axis.toUpperCase()} 座標<input type="number" min={-CANVAS_LIMITS.coordinate} max={CANVAS_LIMITS.coordinate} step="any" value={node[axis]} disabled={disabled} onChange={(event) => {
								const value = event.target.valueAsNumber;
								if (Number.isFinite(value) && Math.abs(value) <= CANVAS_LIMITS.coordinate) patchNode({ [axis]: value });
							}} /></label>)}</div>
						</>}
						{edge && <label>接続ラベル<input value={edge.label} maxLength={CANVAS_LIMITS.label} disabled={disabled} onChange={(event) => edit((current) => ({ ...current, edges: current.edges.map((item) => item.id === edge.id ? { ...item, label: event.target.value } : item) }))} /></label>}
						<button type="button" className="danger" disabled={disabled} onClick={removeSelection}>{node ? "ノードと接続を削除" : "接続を削除"}</button>
					</div></details>}
					<span className={`canvas-toolbar-status${dirty ? " warning" : ""}`} role="status" title={connectionSource ? `${connectionSource.title || "無題"} → 接続先を選択` : notice}>{connectionSource ? `${connectionSource.title || "無題"} → 接続先を選択` : !ready ? (busy ? "読み込み中…" : "未読み込み") : dirty ? "未保存" : notice || "保存済み"}</span>
					<button className="canvas-clear" type="button" disabled={!selection && !connectionSource} onClick={() => { setSelection(undefined); setEditingNode(undefined); cancelConnection(); }}>{connectionSource ? "接続中止" : "選択解除"}</button>
					<button type="button" onClick={() => { void perform("save"); }} disabled={disabled || !dirty}>{busy && pending === "save" ? "保存中…" : "保存"}</button>
					{destinationControl}
					<button className="canvas-use" type="button" onClick={() => { void perform("use"); }} disabled={disabled}>AI に相談する下書きへ</button>
					<details className="canvas-properties canvas-file-menu"><summary>ファイル</summary><div>
						<button type="button" onClick={() => { void perform("load"); }} disabled={busy}>保存済みを読み込む</button>
						<button type="button" onClick={exportDesign} disabled={disabled}>JSON 書き出し</button>
					</div></details>
				</div>
				{error && <p className="error canvas-message" role="alert">{error}</p>}
				<div ref={viewport} className={`canvas-viewport${connectionSource ? " is-connecting" : ""}`} tabIndex={0} role="group" aria-label="設計図。Tab でノードを選択、Enter で編集、矢印キーで移動。空白をドラッグして表示を移動、ホイールで拡大縮小。" onPointerDown={(event) => beginGesture(event)} onPointerMove={moveGesture} onPointerUp={() => { gesture.current = undefined; }} onPointerCancel={() => { gesture.current = undefined; }} onLostPointerCapture={() => { gesture.current = undefined; }}>
					<div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
						<svg className="canvas-connections" aria-hidden="true">
							<defs><marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
							{design.edges.map((item) => {
								const source = nodesById.get(item.source);
								const destination = nodesById.get(item.target);
								if (!source || !destination) return null;
								const x1 = source.x + CARD_WIDTH;
								const y1 = source.y + CARD_HEIGHT / 2;
								const x2 = destination.x;
								const y2 = destination.y + CARD_HEIGHT / 2;
								const bend = Math.max(70, Math.abs(x2 - x1) / 2);
								const self = source.id === destination.id;
								const path = self ? `M ${x1} ${y1} C ${x1 + 100} ${y1 - 220}, ${x2 - 100} ${y2 - 220}, ${x2} ${y2}` : `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
								return <g key={item.id} className={edge?.id === item.id ? "selected" : ""}>
									<path d={path} markerEnd={`url(#${id}-arrow)`} />
									<path className="canvas-edge-hit" d={path} onPointerDown={(event) => { event.stopPropagation(); if (!disabled) { cancelConnection(); setEditingNode(undefined); setSelection({ kind: "edge", id: item.id }); } }} />
									<text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - (self ? 165 : 10)} textAnchor="middle">{item.label.length > 32 ? `${item.label.slice(0, 32)}…` : item.label}</text>
								</g>;
							})}
							{connectionSource && <path className="canvas-connection-preview" d={`M ${connectionSource.x + CARD_WIDTH} ${connectionSource.y + CARD_HEIGHT / 2} C ${connectionSource.x + CARD_WIDTH + 80} ${connectionSource.y + CARD_HEIGHT / 2}, ${(connectionPointer?.x ?? connectionSource.x + CARD_WIDTH + 120) - 80} ${connectionPointer?.y ?? connectionSource.y + CARD_HEIGHT / 2}, ${connectionPointer?.x ?? connectionSource.x + CARD_WIDTH + 120} ${connectionPointer?.y ?? connectionSource.y + CARD_HEIGHT / 2}`} markerEnd={`url(#${id}-arrow)`} />}
						</svg>
						{design.nodes.map((item) => <div key={item.id} id={`${id}-node-${item.id}`} className={`canvas-node${node?.id === item.id ? " selected" : ""}${connectingFrom === item.id ? " connection-source" : ""}${editingNode === item.id ? " is-editing" : ""}`} style={{ left: item.x, top: item.y, width: CARD_WIDTH, height: CARD_HEIGHT }} role="group" tabIndex={disabled ? -1 : 0} aria-label={`${item.title || "無題のノード"}。Enter で編集、矢印キーで移動、Delete キーで削除。接続ボタンから他のノードへ接続できます。`} onClick={(event) => {
							if (event.target instanceof Element && event.target.closest("button, input, textarea")) return;
							if (connectingFrom) connectNodes(connectingFrom, item.id);
							else setSelection({ kind: "node", id: item.id });
						}} onDoubleClick={(event) => {
							if (event.target instanceof Element && event.target.closest("button, input, textarea")) return;
							editOnBoard(item);
						}} onFocus={(event) => {
							if (event.target === event.currentTarget) setSelection({ kind: "node", id: item.id });
						}} onPointerDown={(event) => beginGesture(event, item)} onKeyDown={(event) => {
							if (disabled || event.target !== event.currentTarget) return;
							const step = event.shiftKey ? 40 : 10;
							if (event.key === "Enter") { event.preventDefault(); if (connectingFrom) connectNodes(connectingFrom, item.id); else editOnBoard(item); }
							else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelection(); }
							else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
								event.preventDefault();
								const x = Math.max(-CANVAS_LIMITS.coordinate, Math.min(CANVAS_LIMITS.coordinate, item.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0)));
								const y = Math.max(-CANVAS_LIMITS.coordinate, Math.min(CANVAS_LIMITS.coordinate, item.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)));
								edit((current) => ({ ...current, nodes: current.nodes.map((value) => value.id === item.id ? { ...value, x, y } : value) }));
							}
						}}>
							{editingNode === item.id ? <div className="canvas-inline-editor">
								<label>ノード名<input ref={inlineTitle} value={item.title} maxLength={CANVAS_LIMITS.title} disabled={disabled} onChange={(event) => edit((current) => ({ ...current, nodes: current.nodes.map((value) => value.id === item.id ? { ...value, title: event.target.value } : value) }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); setEditingNode(undefined); window.document.getElementById(`${id}-node-${item.id}`)?.focus(); } }} /></label>
								<label>説明<textarea rows={2} value={item.description} maxLength={CANVAS_LIMITS.description} placeholder="役割やメモを追加" disabled={disabled} onChange={(event) => edit((current) => ({ ...current, nodes: current.nodes.map((value) => value.id === item.id ? { ...value, description: event.target.value } : value) }))} /></label>
								<button type="button" disabled={disabled} onClick={() => { setEditingNode(undefined); window.document.getElementById(`${id}-node-${item.id}`)?.focus(); }}>編集を完了</button>
							</div> : <><strong>{item.title || "無題のノード"}</strong>{item.description && <span className="canvas-node-description">{item.description}</span>}<div className="canvas-node-footer"><button type="button" disabled={disabled} aria-label={`${item.title || "無題のノード"}をボード上で編集`} onClick={() => editOnBoard(item)}>編集</button></div></>}
							{connectionSource && <button className="canvas-connect-target" type="button" disabled={disabled} aria-label={`${item.title || "無題のノード"}へ接続${connectingFrom === item.id ? "（自身）" : ""}`} onClick={() => connectNodes(connectionSource.id, item.id)}>ここへ</button>}
							<button className="canvas-connect-handle" type="button" disabled={disabled} aria-label={`${item.title || "無題のノード"}から接続を開始`} aria-pressed={connectingFrom === item.id} onClick={() => connectingFrom === item.id ? cancelConnection() : startConnection(item)}>接続 <span aria-hidden="true">＋</span></button>
						</div>)}
					</div>
					{ready && design.nodes.length === 0 && <div className="canvas-empty"><span className="canvas-empty-eyebrow">アイデアを、つながる設計に</span><h3>最初のノードを置きましょう</h3><p>機能・画面・課題などを並べて、関係を線でつなぎます。<br />できた設計は AI への相談の下書きにできます。</p><button className="canvas-add" type="button" disabled={disabled} onClick={addNode}>＋ 最初のノードを追加</button></div>}
				</div>
			</div>
		</div>
	</section>;
}
