import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalClientMessage, TerminalServerMessage, TerminalSummary } from "../../shared/terminal-protocol.ts";
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
	const [error, setError] = useState("");
	const [creating, setCreating] = useState(false);
	const [closing, setClosing] = useState<string[]>([]);
	const [listFailed, setListFailed] = useState(false);
	const [listAttempt, setListAttempt] = useState(0);
	const [focusRequest, setFocusRequest] = useState(0);
	const selectionByWorkspace = useRef(new Map<string, string>());
	const dismissedTerminals = useRef(new Set<string>());
	const workspaceRef = useRef(workspaceId);
	const terminalsRef = useRef(terminals);
	const selectedRef = useRef(selectedId);
	workspaceRef.current = workspaceId;
	terminalsRef.current = terminals;
	selectedRef.current = selectedId;

	useEffect(() => {
		setTerminals([]);
		setSelectedId(undefined);
		setViewStates(new Map());
		setError("");
		setListFailed(false);
		setFocusRequest(0);
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

	const updateSummary = useCallback((terminalId: string, status: TerminalSummary["status"], exitCode?: number, signal?: number) => {
		setTerminals((items) => items.map((item) => item.terminalId === terminalId ? { ...item, status, exitCode, signal } : item));
	}, []);
	const updateViewState = useCallback((terminalId: string, state: TerminalViewState) => {
		setViewStates((states) => new Map(states).set(terminalId, state));
	}, []);

	function select(terminalId: string) {
		setSelectedId(terminalId);
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
			setTerminals((items) => items.some((existing) => existing.terminalId === item.terminalId) ? items : [...items, item]);
			select(item.terminalId);
		} catch (cause) { if (workspaceRef.current === requestWorkspace) setError(cause instanceof Error ? cause.message : "PTYを作成できません"); }
		finally { setCreating(false); }
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
			setViewStates((states) => {
				const next = new Map(states);
				next.delete(terminalId);
				return next;
			});
			if (selectedRef.current === terminalId) {
				const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.terminalId;
				setSelectedId(next);
				if (requestWorkspace) {
					if (next) selectionByWorkspace.current.set(requestWorkspace, next);
					else selectionByWorkspace.current.delete(requestWorkspace);
				}
			}
		} catch (cause) { if (workspaceRef.current === requestWorkspace) setError(cause instanceof Error ? cause.message : "PTYを終了できません"); }
		finally { setClosing((ids) => ids.filter((id) => id !== terminalId)); }
	}

	const active = terminals.find((item) => item.terminalId === selectedId);
	const state = selectedId ? viewStates.get(selectedId) : undefined;
	const connectionLabel = state?.connection === "disconnected" ? "切断" : state?.connection === "connected" ? (active?.status === "exited" ? `終了 ${active.exitCode ?? "?"}` : state.controller ? "操作中" : "閲覧のみ") : "接続中";

	return <section className="terminal-pane" hidden={!visible} aria-label="ユーザー端末">
		<header className="terminal-header">
			<div className="terminal-tabs" role="tablist" aria-label="端末一覧">
				{terminals.map((item, index) => <div className="terminal-tab-item" role="presentation" key={item.terminalId}>
					<button className="terminal-tab" type="button" role="tab" id={`terminal-tab-${item.terminalId}`} aria-controls={`terminal-screen-${item.terminalId}`} aria-selected={selectedId === item.terminalId} tabIndex={selectedId === item.terminalId ? 0 : -1} title={viewStates.get(item.terminalId)?.title || `端末 ${index + 1}`} onClick={() => select(item.terminalId)} onKeyDown={(event) => {
						let next: number;
						if (event.key === "ArrowRight") next = (index + 1) % terminals.length;
						else if (event.key === "ArrowLeft") next = (index - 1 + terminals.length) % terminals.length;
						else if (event.key === "Home") next = 0;
						else if (event.key === "End") next = terminals.length - 1;
						else return;
						event.preventDefault();
						select(terminals[next].terminalId);
					}}><span>端末 {index + 1}</span>{item.status === "exited" && <span className="terminal-tab-exit">終了 {item.exitCode ?? "?"}</span>}</button>
					<button className="terminal-tab-close" type="button" aria-label={`端末 ${index + 1} を閉じる`} title={`端末 ${index + 1} を閉じる`} disabled={closing.includes(item.terminalId)} onClick={() => { void close(item.terminalId); }}>×</button>
				</div>)}
			</div>
			<button className="terminal-new" type="button" aria-label="新しい端末を作成" title="新しい端末を作成" disabled={!workspaceId || creating} onClick={() => { void create(); }}>{creating ? "作成中…" : "+"}</button>
			{active && <div className="terminal-status-controls">
				<span className="terminal-status" data-connection={state?.connection ?? "connecting"} role="status" title={state?.connection === "disconnected" && active.status === "running" ? "接続が切れています。PTYはホストで継続します。" : state?.title}>{connectionLabel}</span>
				{state?.connection === "connected" && !state.controller && active.status === "running" && <button className="terminal-take-control" type="button" onClick={state.takeControl}>操作権を取得</button>}
				{state?.connection === "disconnected" && <button className="terminal-reconnect" type="button" onClick={state.reconnect}>再接続</button>}
			</div>}
		</header>
		{(error || listFailed) && <div className="terminal-error" role="alert">{error || "端末一覧を取得できません"}{listFailed && <button type="button" onClick={() => { setError(""); setListFailed(false); setListAttempt((value) => value + 1); }}>一覧を再取得</button>}</div>}
		{terminals.map((item) => <TerminalView key={item.terminalId} summary={item} visible={visible && selectedId === item.terminalId} selected={selectedId === item.terminalId} focusRequest={selectedId === item.terminalId ? focusRequest : 0} onSummary={updateSummary} onState={updateViewState} />)}
		{!active && <p className="terminal-empty">{workspaceId ? "＋ で新しい端末を開始" : "ワークスペースを選択してください。"}</p>}
	</section>;
}

function TerminalView({ summary, visible, selected, focusRequest, onSummary, onState }: {
	summary: TerminalSummary;
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
		const emulator = new Terminal({ cols: summary.cols, rows: summary.rows, ...(summary.windowsPty ? { windowsPty: summary.windowsPty } : {}), theme: { background: colors.getPropertyValue("--surface-sunken").trim(), foreground: colors.getPropertyValue("--on-surface").trim(), cursor: colors.getPropertyValue("--primary").trim(), selectionBackground: colors.getPropertyValue("--primary-container").trim() }, fontSize: 13, scrollback: 2000, cursorBlink: true, disableStdin: true, logLevel: "off", linkHandler: {
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

	return <div className="terminal-view" id={`terminal-screen-${terminalId}`} role="tabpanel" aria-labelledby={`terminal-tab-${terminalId}`} hidden={!selected}>
		{error && <div className="terminal-error" role="alert">{error}</div>}
		<div className="terminal-emulator" ref={container} onKeyDown={(event) => event.stopPropagation()} />
	</div>;
}
