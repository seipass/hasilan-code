import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalClientMessage, TerminalServerMessage, TerminalSummary } from "../../shared/terminal-protocol.ts";
import { type PaneIndex, SplitActions, type SplitEdge, SplitLayout, type SplitMode } from "../SplitLayout.tsx";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

export interface TerminalPaneProps {
	workspaceId?: string;
	visible?: boolean;
}

interface TerminalViewState {
	connection: "connecting" | "connected" | "disconnected";
	controller: boolean;
	title: string;
	takeControl: () => void;
	reconnect: () => void;
}

async function terminalRequest<T>(path: string, options?: RequestInit): Promise<T> {
	const response = await fetch(path, { credentials: "same-origin", ...options });
	if (!response.ok) {
		const text = await response.text();
		throw new Error(text || `Terminal request failed (${response.status})`);
	}
	if (response.status === 204) return undefined as T;
	return await response.json() as T;
}

/** Disposing this panel only detaches its browser emulators, never the PTYs. */
export function TerminalPane({ workspaceId, visible = true }: TerminalPaneProps) {
	const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string>();
	const [viewStates, setViewStates] = useState(() => new Map<string, TerminalViewState>());
	const [paneSelections, setPaneSelections] = useState<[string | undefined, string | undefined]>([undefined, undefined]);
	const [assignments, setAssignments] = useState<Record<string, PaneIndex>>({});
	const [focusedPane, setFocusedPane] = useState<PaneIndex>(0);
	const [mode, setMode] = useState<SplitMode>("single");
	const [error, setError] = useState("");
	const [creating, setCreating] = useState(false);
	const [closing, setClosing] = useState<string[]>([]);
	const [listFailed, setListFailed] = useState(false);
	const [listAttempt, setListAttempt] = useState(0);
	const [focusRequest, setFocusRequest] = useState(0);
	const [draggingId, setDraggingId] = useState<string>();
	const [dropTarget, setDropTarget] = useState<{ terminalId: string; edge: "before" | "after" }>();
	const draggedTerminal = useRef<string | undefined>(undefined);
	const selectionByWorkspace = useRef(new Map<string, string>());
	const dismissedTerminals = useRef(new Set<string>());
	const workspaceRef = useRef(workspaceId);
	const terminalsRef = useRef(terminals);
	const selectedRef = useRef(selectedId);
	const modeRef = useRef(mode);
	const assignmentsRef = useRef(assignments);
	workspaceRef.current = workspaceId;
	terminalsRef.current = terminals;
	selectedRef.current = selectedId;
	modeRef.current = mode;
	assignmentsRef.current = assignments;

	useEffect(() => {
		setTerminals([]);
		setSelectedId(undefined);
		setViewStates(new Map());
		setPaneSelections([undefined, undefined]);
		setAssignments({});
		setFocusedPane(0);
		setMode("single");
		setError("");
		setListFailed(false);
		setFocusRequest(0);
		draggedTerminal.current = undefined;
		setDraggingId(undefined);
		setDropTarget(undefined);
	}, [workspaceId]);

	useEffect(() => {
		let cancelled = false;
		if (workspaceId) {
			void terminalRequest<TerminalSummary[]>(`/api/terminals?workspaceId=${encodeURIComponent(workspaceId)}`).then((items) => {
				if (cancelled) return;
				const listed = items.filter((item) => !dismissedTerminals.current.has(item.terminalId));
				// A user may create a terminal while the initial list is in flight.
				setTerminals((current) => [...listed, ...current.filter((item) => !listed.some((entry) => entry.terminalId === item.terminalId))]);
				const previous = selectionByWorkspace.current.get(workspaceId);
				setSelectedId((current) => current ?? (listed.some((item) => item.terminalId === previous) ? previous : listed[0]?.terminalId));
				setListFailed(false);
			}).catch((cause: unknown) => {
				if (!cancelled) {
					setError(cause instanceof Error ? cause.message : "端末一覧を取得できません");
					setListFailed(true);
				}
			});
		}
		return () => { cancelled = true; };
	}, [workspaceId, listAttempt]);
	useEffect(() => {
		if (!selectedId) return;
		const group = assignments[selectedId] ?? 0;
		setPaneSelections((previous) => {
			if (previous[group] === selectedId) return previous;
			const next: [string | undefined, string | undefined] = [...previous];
			next[group] = selectedId;
			return next;
		});
	}, [selectedId, assignments]);

	const updateSummary = useCallback((terminalId: string, status: TerminalSummary["status"], exitCode?: number, signal?: number) => {
		setTerminals((items) => items.map((item) => item.terminalId === terminalId ? { ...item, status, exitCode, signal } : item));
	}, []);
	const updateViewState = useCallback((terminalId: string, state: TerminalViewState) => {
		setViewStates((states) => new Map(states).set(terminalId, state));
	}, []);

	function select(terminalId: string) {
		setSelectedId(terminalId);
		setFocusedPane(assignments[terminalId] ?? 0);
		setFocusRequest((value) => value + 1);
		if (workspaceId) selectionByWorkspace.current.set(workspaceId, terminalId);
	}

	async function create() {
		if (!workspaceId || creating) return;
		const requestWorkspace = workspaceId;
		setCreating(true);
		setError("");
		try {
			const item = await terminalRequest<TerminalSummary>("/api/terminals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, cols: 80, rows: 24 }) });
			if (workspaceRef.current !== requestWorkspace) return;
			const destination = modeRef.current === "single" ? 0 : focusedPane;
			setTerminals((items) => items.some((existing) => existing.terminalId === item.terminalId) ? items : [...items, item]);
			setAssignments((previous) => ({ ...previous, [item.terminalId]: destination }));
			setSelectedId(item.terminalId);
			setPaneSelections((previous) => destination === 0 ? [item.terminalId, previous[1]] : [previous[0], item.terminalId]);
			setFocusedPane(destination);
			setFocusRequest((value) => value + 1);
			selectionByWorkspace.current.set(requestWorkspace, item.terminalId);
		} catch (cause) { if (workspaceRef.current === requestWorkspace) setError(cause instanceof Error ? cause.message : "PTYを作成できません"); }
		finally { setCreating(false); }
	}
	function mergeTerminals(activeId?: string) {
		setAssignments({});
		setPaneSelections([activeId, undefined]);
		setSelectedId(activeId);
		setFocusedPane(0);
		setMode("single");
		setFocusRequest((value) => value + 1);
		if (workspaceId && activeId) selectionByWorkspace.current.set(workspaceId, activeId);
	}

	async function close(terminalId: string) {
		if (closing.includes(terminalId)) return;
		const requestWorkspace = workspaceId;
		setClosing((ids) => [...ids, terminalId]);
		setError("");
		try {
			await terminalRequest<unknown>(`/api/terminals/${encodeURIComponent(terminalId)}`, { method: "DELETE" });
			dismissedTerminals.current.add(terminalId);
			if (workspaceRef.current !== requestWorkspace) return;
			const current = terminalsRef.current;
			const index = current.findIndex((item) => item.terminalId === terminalId);
			const remaining = current.filter((item) => item.terminalId !== terminalId);
			setTerminals(remaining);
			const currentAssignments = assignmentsRef.current;
			const group = currentAssignments[terminalId] ?? 0;
			const replacement = remaining.find((item) => (currentAssignments[item.terminalId] ?? 0) === group)?.terminalId;
			if (modeRef.current !== "single" && !replacement) {
				mergeTerminals(remaining.some((item) => item.terminalId === selectedRef.current) ? selectedRef.current : remaining[0]?.terminalId);
			} else {
				setPaneSelections((previous) => {
					const next: [string | undefined, string | undefined] = [...previous];
					if (next[group] === terminalId) next[group] = replacement;
					return next;
				});
				setAssignments((previous) => { const next = { ...previous }; delete next[terminalId]; return next; });
			}
			setViewStates((states) => {
				const next = new Map(states);
				next.delete(terminalId);
				return next;
			});
			if (selectedRef.current === terminalId) {
				const next = replacement ?? remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.terminalId;
				setSelectedId(next);
				if (requestWorkspace) {
					if (next) selectionByWorkspace.current.set(requestWorkspace, next);
					else selectionByWorkspace.current.delete(requestWorkspace);
				}
			}
		} catch (cause) { if (workspaceRef.current === requestWorkspace) setError(cause instanceof Error ? cause.message : "PTYを終了できません"); }
		finally { setClosing((ids) => ids.filter((id) => id !== terminalId)); }
	}

	const groups = [
		terminals.filter((item) => (assignments[item.terminalId] ?? 0) === 0),
		terminals.filter((item) => assignments[item.terminalId] === 1),
	];
	const shownIds = groups.map((items, group) => items.find((item) => item.terminalId === paneSelections[group])?.terminalId ?? items[0]?.terminalId);
	function moveTerminal(terminalId: string, destination: PaneIndex) {
		if (closing.includes(terminalId) || !terminals.some((item) => item.terminalId === terminalId)) return;
		const source = assignments[terminalId] ?? 0;
		if (mode !== "single" && source !== destination && groups[source].length === 1) {
			mergeTerminals(terminalId);
			return;
		}
		if (destination === 1 && mode === "single") setMode("columns");
		setAssignments((previous) => ({ ...previous, [terminalId]: destination }));
		setPaneSelections((previous) => {
			const next: [string | undefined, string | undefined] = [...previous];
			if (source !== destination && next[source] === terminalId) next[source] = groups[source].find((item) => item.terminalId !== terminalId)?.terminalId;
			next[destination] = terminalId;
			return next;
		});
		setSelectedId(terminalId);
		setFocusedPane(destination);
		setFocusRequest((value) => value + 1);
	}
	function dropTerminal(destination: PaneIndex) {
		const source = draggedTerminal.current;
		if (!source) return;
		moveTerminal(source, destination);
		draggedTerminal.current = undefined;
		setDraggingId(undefined);
		setDropTarget(undefined);
	}
	function changeSplit(next: SplitMode) {
		if (next === "single") {
			mergeTerminals(shownIds[focusedPane] ?? shownIds[0] ?? shownIds[1]);
		} else if (mode === "single" && terminals.length > 1 && shownIds[0]) moveTerminal(shownIds[0], 1);
		setMode(next);
	}
	function splitTerminalAt(edge: SplitEdge) {
		const source = draggedTerminal.current;
		if (!source || terminals.length < 2 || closing.includes(source) || !terminals.some((item) => item.terminalId === source)) return;
		const destination: PaneIndex = edge === "left" || edge === "top" ? 0 : 1;
		const other = shownIds[destination === 0 ? 1 : 0];
		const remaining = other !== source && other ? other : terminals.find((item) => item.terminalId !== source)?.terminalId;
		const next: Record<string, PaneIndex> = {};
		for (const item of terminals) next[item.terminalId] = item.terminalId === source ? destination : destination === 0 ? 1 : 0;
		setAssignments(next);
		setPaneSelections(destination === 0 ? [source, remaining] : [remaining, source]);
		setSelectedId(source);
		setFocusedPane(destination);
		setMode(edge === "left" || edge === "right" ? "columns" : "rows");
		setFocusRequest((value) => value + 1);
		draggedTerminal.current = undefined;
		setDraggingId(undefined);
		setDropTarget(undefined);
	}

	return <section className="terminal-pane" hidden={!visible} aria-label="ユーザー端末">
		{(error || listFailed) && <div className="terminal-error" role="alert">{error || "端末一覧を取得できません"}{listFailed && <button type="button" onClick={() => { setError(""); setListFailed(false); setListAttempt((value) => value + 1); }}>一覧を再取得</button>}</div>}
		<SplitLayout mode={mode} label="端末" dragging={!!draggingId && terminals.length > 1} onEdgeDrop={splitTerminalAt}>
		{([0, 1] as const).map((group) => {
			const items = groups[group];
			const active = items.find((item) => item.terminalId === shownIds[group]);
			const state = active ? viewStates.get(active.terminalId) : undefined;
			const connectionLabel = state?.connection === "disconnected" ? "切断" : state?.connection === "connected" ? (active?.status === "exited" ? `終了 ${active.exitCode ?? "?"}` : state.controller ? undefined : "閲覧のみ") : "接続中";
			return <header key={group} className="terminal-header split-tab-header" data-pane={group} data-focused={focusedPane === group} hidden={group === 1 && mode === "single"} onPointerDownCapture={() => setFocusedPane(group)} onFocusCapture={() => setFocusedPane(group)} onDragOver={(event) => { if (draggedTerminal.current) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { if (draggedTerminal.current) { event.preventDefault(); dropTerminal(group); } }}>
			<div className="terminal-tabs" role="tablist" aria-label={`端末 ペイン ${group + 1}`}>
				{items.map((item, index) => <div className="terminal-tab-item" role="presentation" key={item.terminalId} data-terminal-id={item.terminalId} data-dragging={draggingId === item.terminalId || undefined} data-drop-edge={dropTarget?.terminalId === item.terminalId ? dropTarget.edge : undefined} onMouseDown={(event) => {
					if (event.button === 1) event.preventDefault();
				}} onAuxClick={(event) => {
					if (event.button !== 1) return;
					event.preventDefault();
					void close(item.terminalId);
				}} onDragOver={(event) => {
					const sourceId = draggedTerminal.current;
					if (!sourceId || sourceId === item.terminalId || !terminals.some((terminal) => terminal.terminalId === sourceId)) return;
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "move";
					const bounds = event.currentTarget.getBoundingClientRect();
					setDropTarget({ terminalId: item.terminalId, edge: event.clientX < bounds.left + bounds.width / 2 ? "before" : "after" });
				}} onDragLeave={(event) => {
					if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
					setDropTarget((target) => target?.terminalId === item.terminalId ? undefined : target);
				}} onDrop={(event) => {
					const sourceId = draggedTerminal.current;
					if (!sourceId || sourceId === item.terminalId) return;
					event.preventDefault();
					event.stopPropagation();
					if ((assignments[sourceId] ?? 0) !== group) moveTerminal(sourceId, group);
					const bounds = event.currentTarget.getBoundingClientRect();
					const after = event.clientX >= bounds.left + bounds.width / 2;
					// Only change display order. Stable terminal keys retain sockets, emulators and selection.
					setTerminals((items) => {
						const source = items.find((terminal) => terminal.terminalId === sourceId);
						if (!source || !items.some((terminal) => terminal.terminalId === item.terminalId)) return items;
						const reordered = items.filter((terminal) => terminal.terminalId !== sourceId);
						const targetIndex = reordered.findIndex((terminal) => terminal.terminalId === item.terminalId);
						reordered.splice(targetIndex + (after ? 1 : 0), 0, source);
						return reordered;
					});
					draggedTerminal.current = undefined;
					setDraggingId(undefined);
					setDropTarget(undefined);
				}}>
					<button className="terminal-tab" type="button" role="tab" id={`terminal-tab-${item.terminalId}`} aria-controls={`terminal-screen-${item.terminalId}`} aria-selected={shownIds[group] === item.terminalId} tabIndex={shownIds[group] === item.terminalId ? 0 : -1} title={viewStates.get(item.terminalId)?.title || `端末 ${terminals.indexOf(item) + 1}`} draggable={!closing.includes(item.terminalId)} onDragStart={(event) => {
						draggedTerminal.current = item.terminalId;
						setDraggingId(item.terminalId);
						setDropTarget(undefined);
						event.dataTransfer.effectAllowed = "move";
						event.dataTransfer.setData("application/x-hasilan-terminal", item.terminalId);
					}} onDragEnd={() => {
						draggedTerminal.current = undefined;
						setDraggingId(undefined);
						setDropTarget(undefined);
					}} onClick={() => select(item.terminalId)} onKeyDown={(event) => {
						let next: number;
						if (event.key === "ArrowRight") next = (index + 1) % items.length;
						else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
						else if (event.key === "Home") next = 0;
						else if (event.key === "End") next = items.length - 1;
						else return;
						event.preventDefault();
						select(items[next].terminalId);
					}}><span>端末 {terminals.indexOf(item) + 1}</span>{item.status === "exited" && <span className="terminal-tab-exit">終了 {item.exitCode ?? "?"}</span>}</button>
					<button className="split-tab-move" type="button" aria-label={`端末 ${terminals.indexOf(item) + 1} を別のペインへ移動`} title="別のペインへ移動" disabled={closing.includes(item.terminalId)} onClick={() => moveTerminal(item.terminalId, group === 0 ? 1 : 0)}>⇄</button>
					<button className="terminal-tab-close" type="button" aria-label={`端末 ${terminals.indexOf(item) + 1} を閉じる`} title={`端末 ${terminals.indexOf(item) + 1} を閉じる`} disabled={closing.includes(item.terminalId)} onClick={() => { void close(item.terminalId); }}>×</button>
				</div>)}
			</div>
			<button className="terminal-new" type="button" aria-label={`ペイン ${group + 1}に新しい端末を作成`} title="このペインに新しい端末を作成" disabled={!workspaceId || creating} onClick={() => { void create(); }}>{creating ? "作成中…" : "+"}</button>
			<SplitActions label={`端末 ペイン ${group + 1}`} mode={mode} onChange={changeSplit} />
			{active && <div className="terminal-status-controls">
				{connectionLabel && <span className="terminal-status" data-connection={state?.connection ?? "connecting"} role="status" title={state?.connection === "disconnected" && active.status === "running" ? "接続が切れています。PTYはホストで継続します。" : state?.title}>{connectionLabel}</span>}
				{state?.connection === "connected" && !state.controller && active.status === "running" && <button className="terminal-take-control" type="button" onClick={state.takeControl}>操作権を取得</button>}
				{state?.connection === "disconnected" && <button className="terminal-reconnect" type="button" onClick={state.reconnect}>再接続</button>}
			</div>}
			</header>;
		})}
		{terminals.map((item) => {
			const group = assignments[item.terminalId] ?? 0;
			const selected = shownIds[group] === item.terminalId && (group === 0 || mode !== "single");
			return <TerminalView key={item.terminalId} summary={item} pane={group} visible={visible && selected} selected={selected} focusRequest={selectedId === item.terminalId ? focusRequest : 0} onSummary={updateSummary} onState={updateViewState} onActivate={() => { setFocusedPane(group); setSelectedId(item.terminalId); }} dragging={!!draggingId} onTabDrop={() => dropTerminal(group)} />;
		})}
		{([0, 1] as const).map((group) => !shownIds[group] && <p key={`empty-${group}`} className="terminal-empty split-tab-body" data-pane={group} hidden={group === 1 && mode === "single"} onPointerDown={() => setFocusedPane(group)} onDragOver={(event) => { if (draggedTerminal.current) event.preventDefault(); }} onDrop={(event) => { if (draggedTerminal.current) { event.preventDefault(); dropTerminal(group); } }}>{workspaceId ? "このペインを選択して ＋ で端末を開始、またはタブを移動" : "ワークスペースを選択してください。"}</p>)}
		</SplitLayout>
	</section>;
}

function TerminalView({ summary, pane, visible, selected, focusRequest, onSummary, onState, onActivate, dragging, onTabDrop }: {
	summary: TerminalSummary;
	pane: PaneIndex;
	onActivate: () => void;
	dragging: boolean;
	onTabDrop: () => void;
	visible: boolean;
	selected: boolean;
	focusRequest: number;
	onSummary: (terminalId: string, status: TerminalSummary["status"], exitCode?: number, signal?: number) => void;
	onState: (terminalId: string, state: TerminalViewState) => void;
}) {
	const { terminalId } = summary;
	const container = useRef<HTMLDivElement>(null);
	const emulatorRef = useRef<Terminal | undefined>(undefined);
	const fitAddonRef = useRef<FitAddon | undefined>(undefined);
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	const previousVisible = useRef(visible);
	const previousFocusRequest = useRef(0);
	const pendingFocus = useRef(false);
	const readyRef = useRef(false);
	const fitRef = useRef<() => void>(() => {});
	const sendRef = useRef<(message: TerminalClientMessage) => void>(() => {});
	const [connection, setConnection] = useState<TerminalViewState["connection"]>("connecting");
	const [controller, setController] = useState(false);
	const [title, setTitle] = useState("");
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);

	const focusPending = useCallback(() => {
		const element = container.current;
		if (!pendingFocus.current || !readyRef.current || !visibleRef.current || !element?.clientWidth || !element.clientHeight) return;
		pendingFocus.current = false;
		emulatorRef.current?.focus();
	}, []);
	const takeControl = useCallback(() => { pendingFocus.current = true; sendRef.current({ type: "take_control" }); }, []);
	const reconnect = useCallback(() => { pendingFocus.current = true; setAttempt((value) => value + 1); }, []);

	useEffect(() => { onState(terminalId, { connection, controller, title, takeControl, reconnect }); }, [terminalId, connection, controller, title, takeControl, reconnect, onState]);

	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const colors = getComputedStyle(document.documentElement);
		const emulator = new Terminal({ cols: summary.cols, rows: summary.rows, ...(summary.windowsPty ? { windowsPty: summary.windowsPty } : {}), theme: { background: colors.getPropertyValue("--surface-sunken").trim(), foreground: colors.getPropertyValue("--on-surface").trim(), cursor: colors.getPropertyValue("--primary").trim(), selectionBackground: colors.getPropertyValue("--primary-container").trim() }, fontFamily: '"UDEV Gothic", ui-monospace, monospace', fontSize: 13, scrollback: 2000, cursorBlink: true, disableStdin: true, logLevel: "off", linkHandler: {
			activate: (event, text) => {
				if (!event.isTrusted) return;
				try { const target = new URL(text); if (target.protocol === "https:" || target.protocol === "http:") window.open(target.href, "_blank", "noopener,noreferrer"); } catch { /* Non-URL OSC links are not navigable. */ }
			},
		} });
		const fit = new FitAddon();
		emulator.loadAddon(fit);
		emulator.parser.registerOscHandler(52, () => true);
		emulator.onTitleChange(setTitle);
		emulator.open(element);
		emulatorRef.current = emulator;
		fitAddonRef.current = fit;
		return () => { emulatorRef.current = undefined; fitAddonRef.current = undefined; emulator.dispose(); };
		// Geometry comes from snapshots and ordered resize events, not summary renders.
	}, [terminalId]);

	useEffect(() => {
		const element = container.current;
		const emulator = emulatorRef.current;
		const fit = fitAddonRef.current;
		if (!element || !emulator || !fit) return;
		let disposed = false;
		let generation: string | undefined;
		let seq = -1;
		let controlling = false;
		let running = false;
		let snapshotApplied = false;
		let requestedSize = "";
		let incomingUnits = 0;
		let chain = Promise.resolve();
		let animationFrame = 0;
		const url = new URL(`/api/terminals/${encodeURIComponent(terminalId)}/events`, window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(url);
		readyRef.current = false;
		emulator.options.disableStdin = true;
		setConnection("connecting");
		setController(false);
		setError("");

		function send(message: TerminalClientMessage) {
			if (!disposed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
		}
		sendRef.current = send;

		const fitVisible = () => {
			if (disposed || !visibleRef.current || !snapshotApplied || element.clientWidth === 0 || element.clientHeight === 0) return;
			if (controlling && running && generation) {
				const dimensions = fit.proposeDimensions();
				if (dimensions) {
					const cols = Math.max(2, Math.min(500, dimensions.cols));
					const rows = Math.max(1, Math.min(200, dimensions.rows));
					const size = `${cols}:${rows}`;
					// Never resize locally before the host's ordered event: queued ANSI uses host geometry.
					if ((emulator.cols !== cols || emulator.rows !== rows) && size !== requestedSize) {
						requestedSize = size;
						send({ type: "resize", generation, cols, rows });
					}
				}
			}
			focusPending();
		};
		function scheduleFit() {
			cancelAnimationFrame(animationFrame);
			animationFrame = requestAnimationFrame(fitVisible);
		}
		fitRef.current = scheduleFit;
		const observer = new ResizeObserver(scheduleFit);
		observer.observe(element);
		// Initial font measurement may occur while this tab is hidden or before fonts finish loading.
		void document.fonts.ready.then(() => { if (!disposed) scheduleFit(); });
		const input = emulator.onData((data) => { if (generation && snapshotApplied && controlling && running && socket.readyState === WebSocket.OPEN) send({ type: "input", generation, data }); });
		const binary = emulator.onBinary((data) => { if (generation && snapshotApplied && controlling && running && socket.readyState === WebSocket.OPEN) send({ type: "binary", generation, data }); });

		const apply = async (message: TerminalServerMessage) => {
			if (disposed) return;
			if (message.type === "error") { setError(message.message); return; }
			if (message.type === "control") {
				controlling = message.controller && socket.readyState === WebSocket.OPEN;
				requestedSize = "";
				setController(controlling);
				emulator.options.disableStdin = !snapshotApplied || !controlling || !running;
				scheduleFit();
				return;
			}
			if (message.type === "snapshot") {
				if (message.terminalId !== terminalId) throw new Error("Unexpected terminal snapshot");
				generation = message.generation;
				seq = message.seq;
				running = message.status === "running";
				snapshotApplied = false;
				emulator.reset();
				emulator.resize(message.cols, message.rows);
				setTitle("");
				const parsed = Promise.withResolvers<void>();
				emulator.write(message.vt, parsed.resolve);
				await parsed.promise;
				if (disposed) return;
				snapshotApplied = true;
				readyRef.current = true;
				emulator.options.disableStdin = !controlling || !running || socket.readyState !== WebSocket.OPEN;
				onSummary(terminalId, message.status, message.exitCode, message.signal);
				setConnection(socket.readyState === WebSocket.OPEN ? "connected" : "disconnected");
				send({ type: "ack", generation, seq });
				scheduleFit();
				return;
			}
			if (!snapshotApplied || message.generation !== generation) throw new Error("端末ストリームが古くなりました。再接続してください。");
			if (message.seq <= seq) return;
			if (message.seq !== seq + 1) throw new Error("端末の出力が欠落しました。再接続してください。");
			if (message.type === "data") {
				const parsed = Promise.withResolvers<void>();
				emulator.write(message.data, parsed.resolve);
				await parsed.promise;
			} else if (message.type === "resized") {
				emulator.resize(message.cols, message.rows);
				requestedSize = "";
			} else {
				running = false;
				emulator.options.disableStdin = true;
				onSummary(terminalId, "exited", message.exitCode, message.signal);
			}
			if (disposed) return;
			seq = message.seq;
			send({ type: "ack", generation: message.generation, seq });
			if (message.type === "resized") scheduleFit();
		};

		socket.onmessage = (event) => {
			if (disposed || typeof event.data !== "string") { socket.close(); return; }
			const text = event.data;
			incomingUnits += text.length;
			if (incomingUnits > 1024 * 1024) { setError("端末の受信が遅れています。再接続してください。"); socket.close(); return; }
			chain = chain.then(async () => {
				try { await apply(JSON.parse(text) as TerminalServerMessage); }
				finally { incomingUnits -= text.length; }
			}).catch((cause: unknown) => { if (!disposed) { setError(cause instanceof Error ? cause.message : "端末ストリームを復元できません"); socket.close(); } });
		};
		socket.onclose = () => {
			if (!disposed) {
				setConnection("disconnected");
				setController(false);
				controlling = false;
				emulator.options.disableStdin = true;
			}
		};
		socket.onerror = () => { if (!disposed) setError("端末に接続できません。認証とホスト接続を確認してください。"); };
		return () => {
			disposed = true;
			readyRef.current = false;
			emulator.options.disableStdin = true;
			observer.disconnect();
			cancelAnimationFrame(animationFrame);
			input.dispose();
			binary.dispose();
			fitRef.current = () => {};
			sendRef.current = () => {};
			socket.close();
		};
	}, [terminalId, attempt, onSummary, focusPending]);

	useEffect(() => {
		if (visible && (!previousVisible.current || focusRequest > previousFocusRequest.current)) pendingFocus.current = true;
		if (!visible) pendingFocus.current = false;
		previousVisible.current = visible;
		previousFocusRequest.current = focusRequest;
		if (visible) fitRef.current();
	}, [visible, focusRequest]);

	return <div className="terminal-view split-tab-body" data-pane={pane} onPointerDownCapture={onActivate} onDragOver={(event) => { if (dragging) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { if (dragging) { event.preventDefault(); onTabDrop(); } }} id={`terminal-screen-${terminalId}`} role="tabpanel" aria-labelledby={`terminal-tab-${terminalId}`} hidden={!selected}>
		{error && <div className="terminal-error" role="alert">{error}</div>}
		<div className="terminal-emulator" ref={container} onKeyDown={(event) => event.stopPropagation()} />
	</div>;
}
