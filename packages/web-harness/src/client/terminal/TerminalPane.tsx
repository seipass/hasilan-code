import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalClientMessage, TerminalServerMessage, TerminalSummary } from "../../shared/terminal-protocol.ts";
import type { PaneIndex } from "../SplitLayout.tsx";
import { Presence } from "../Motion.tsx";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

export interface TerminalViewState {
	connection: "connecting" | "connected" | "disconnected";
	controller: boolean;
	title: string;
	takeControl: () => void;
	reconnect: () => void;
}

export function TerminalView({ summary, pane, visible, selected, focusRequest, onSummary, onState, onActivate, dragging, onTabDrop, id, labelledBy }: {
	summary: TerminalSummary;
	id: string;
	labelledBy: string;
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
		const emulator = new Terminal({ cols: summary.cols, rows: summary.rows, ...(summary.windowsPty ? { windowsPty: summary.windowsPty } : {}), theme: {
			background: colors.getPropertyValue("--surface-sunken").trim(), foreground: colors.getPropertyValue("--on-surface").trim(), cursor: colors.getPropertyValue("--primary").trim(), selectionBackground: "#cba6f740",
			black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
			brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#cdd6f4",
		}, fontFamily: '"UDEV Gothic", ui-monospace, monospace', fontSize: 13, scrollback: 2000, cursorBlink: true, disableStdin: true, logLevel: "off", linkHandler: {
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

	return <div hidden={!selected} className="terminal-view split-tab-body" data-pane={pane} onPointerDownCapture={onActivate} onDragOver={(event) => { if (dragging) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { if (dragging) { event.preventDefault(); onTabDrop(); } }} id={id} role="tabpanel" aria-labelledby={labelledBy}>
		<Presence show={connection !== "connected" || !controller || summary.status === "exited"}><div className="terminal-status-controls">
			<span className="terminal-status" data-connection={connection} role="status" title={title}>{connection === "disconnected" ? "切断" : connection === "connecting" ? "接続中" : summary.status === "exited" ? `終了 ${summary.exitCode ?? "?"}` : "閲覧のみ"}</span>
			{connection === "connected" && !controller && summary.status === "running" && <button type="button" onClick={takeControl}>操作権を取得</button>}
			{connection === "disconnected" && <button type="button" onClick={reconnect}>再接続</button>}
		</div></Presence>
		<Presence show={!!error}><div className="terminal-error" role="alert">{error}</div></Presence>
		<div className="terminal-emulator" ref={container} onKeyDown={(event) => event.stopPropagation()} />
	</div>;
}
