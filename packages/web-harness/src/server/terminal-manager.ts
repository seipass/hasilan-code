import { randomUUID } from "node:crypto";
import { release } from "node:os";
import { join } from "node:path";
import serialize, { type SerializeAddon } from "@xterm/addon-serialize";
import headless, { type ITerminalAddon, type Terminal } from "@xterm/headless";
import { type IDisposable, type IPty, spawn } from "node-pty";
import type {
	TerminalClientMessage,
	TerminalServerMessage,
	TerminalStreamEvent,
	TerminalSummary,
} from "../shared/terminal-protocol.ts";

export type { TerminalSummary } from "../shared/terminal-protocol.ts";

// These packages publish CommonJS entrypoints; use the default object in native Node ESM.
const HeadlessTerminal = headless.Terminal;
const Serializer = serialize.SerializeAddon;

export interface TerminalSocket {
	readonly readyState: number;
	readonly bufferedAmount: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	on(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
	on(event: "close" | "error", listener: () => void): unknown;
	off(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
	off(event: "close" | "error", listener: () => void): unknown;
}

export interface TerminalManagerOptions {
	getWorkspaceRoot: (workspaceId: string) => string | Promise<string>;
	/** Test seam for process events; production always uses node-pty. */
	spawn?: typeof spawn;
}

interface Attachment {
	socket: TerminalSocket;
	ready: boolean;
	awaitingSnapshot: boolean;
	snapshotSeq: number;
	sentSeq: number;
	ackedSeq: number;
	units: number;
	pending: TerminalStreamEvent[];
	unacked: Map<number, number>;
	onMessage: (data: unknown, isBinary: boolean) => void;
	onClose: () => void;
}

interface ManagedTerminal {
	summary: TerminalSummary;
	pty: IPty;
	screen: Terminal;
	serializer: SerializeAddon;
	seq: number;
	queue: Promise<void>;
	attachments: Set<Attachment>;
	controller?: Attachment;
	listeners: IDisposable[];
	pendingUnits: number;
	paused: boolean;
	closing: boolean;
	exit: Promise<void>;
	resolveExit: () => void;
}

const CLIENT_LIMIT = 1024 * 1024;
const SOCKET_LIMIT = 2 * 1024 * 1024;
const PAUSE_AT = 256 * 1024;
const RESUME_AT = 64 * 1024;

function validateGeometry(cols: number, rows: number): void {
	if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 200) {
		throw new Error("Terminal dimensions require integer cols 1..500 and rows 1..200");
	}
}

function parseCommand(data: unknown, isBinary: boolean): TerminalClientMessage {
	if (isBinary) throw new Error("Terminal commands must be JSON text");
	const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : undefined;
	if (text === undefined || text.length > CLIENT_LIMIT) throw new Error("Invalid terminal command");
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object") throw new Error("Invalid terminal command");
	const command = value as Record<string, unknown>;
	if (command.type === "take_control") return { type: "take_control" };
	if (typeof command.generation !== "string") throw new Error("Terminal generation is required");
	if (
		command.type === "ack" &&
		typeof command.seq === "number" &&
		Number.isSafeInteger(command.seq) &&
		command.seq >= 0
	) {
		return { type: "ack", generation: command.generation, seq: command.seq };
	}
	if ((command.type === "input" || command.type === "binary") && typeof command.data === "string") {
		return { type: command.type, generation: command.generation, data: command.data };
	}
	if (command.type === "resize" && typeof command.cols === "number" && typeof command.rows === "number") {
		validateGeometry(command.cols, command.rows);
		return { type: "resize", generation: command.generation, cols: command.cols, rows: command.rows };
	}
	throw new Error("Invalid terminal command");
}

/** PTYs belong only to workspaces. No conversation, agent, or disk output logging. */
export class TerminalManager {
	private readonly options: TerminalManagerOptions;
	private readonly terminals = new Map<string, ManagedTerminal>();
	private shuttingDown = false;

	constructor(options: TerminalManagerOptions) {
		this.options = options;
	}

	async create(request: { workspaceId: string; cols: number; rows: number }): Promise<TerminalSummary> {
		validateGeometry(request.cols, request.rows);
		if (this.shuttingDown) throw new Error("Terminal manager is shutting down");
		const cwd = await this.options.getWorkspaceRoot(request.workspaceId);
		if (this.shuttingDown) throw new Error("Terminal manager is shutting down");
		const windows = process.platform === "win32";
		const shell = windows
			? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
			: process.env.SHELL || "/bin/sh";
		const windowsPty = windows
			? { backend: "conpty" as const, buildNumber: Number(release().split(".")[2]) }
			: undefined;
		const screen = new HeadlessTerminal({
			cols: request.cols,
			rows: request.rows,
			scrollback: 2000,
			allowProposedApi: true,
			logLevel: "off",
			...(windowsPty ? { windowsPty } : {}),
		});
		const serializer = new Serializer();
		// The serializer works with the headless public buffer API, but its declarations reference the DOM terminal.
		screen.loadAddon(serializer as unknown as ITerminalAddon);
		let pty: IPty;
		try {
			pty = (this.options.spawn ?? spawn)(shell, windows ? ["-NoLogo"] : [], {
				cwd,
				cols: request.cols,
				rows: request.rows,
				name: "xterm-256color",
				env: { ...process.env },
			});
		} catch {
			screen.dispose();
			throw new Error(
				"PTY spawn failed. Install/rebuild node-pty; on Windows install Python 3.11/3.12 and VS2022 C++ Build Tools, Windows SDK and Spectre libraries. No pipe fallback is available.",
			);
		}
		const { promise: exit, resolve: resolveExit } = Promise.withResolvers<void>();
		const entry: ManagedTerminal = {
			summary: {
				terminalId: randomUUID(),
				workspaceId: request.workspaceId,
				generation: randomUUID(),
				cols: request.cols,
				rows: request.rows,
				status: "running",
				...(windowsPty ? { windowsPty } : {}),
			},
			pty,
			screen,
			serializer,
			seq: 0,
			queue: Promise.resolve(),
			attachments: new Set(),
			listeners: [],
			pendingUnits: 0,
			paused: false,
			closing: false,
			exit,
			resolveExit,
		};
		this.terminals.set(entry.summary.terminalId, entry);
		entry.listeners.push(
			pty.onData((data) => {
				entry.pendingUnits += data.length;
				if (!entry.paused && entry.pendingUnits > PAUSE_AT) {
					entry.paused = true;
					pty.pause();
				}
				void this.enqueue(entry, async () => {
					try {
						const parsed = Promise.withResolvers<void>();
						screen.write(data, parsed.resolve);
						await parsed.promise;
						this.publish(entry, { type: "data", generation: entry.summary.generation, seq: ++entry.seq, data });
					} finally {
						entry.pendingUnits -= data.length;
						if (entry.paused && entry.pendingUnits < RESUME_AT) {
							entry.paused = false;
							pty.resume();
						}
					}
				}).catch(() => this.fail(entry));
			}),
		);
		entry.listeners.push(
			pty.onExit(({ exitCode, signal }) => {
				// Fence input immediately; final output and exit projection remain ordered on the screen queue.
				entry.closing = true;
				void this.enqueue(entry, () => {
					entry.summary = {
						...entry.summary,
						status: "exited",
						exitCode,
						...(signal !== undefined ? { signal } : {}),
					};
					this.publish(entry, {
						type: "exit",
						generation: entry.summary.generation,
						seq: ++entry.seq,
						exitCode,
						...(signal !== undefined ? { signal } : {}),
					});
					for (const listener of entry.listeners) listener.dispose();
					entry.listeners = [];
					entry.resolveExit();
				}).catch(() => this.fail(entry));
			}),
		);
		return { ...entry.summary };
	}

	list(workspaceId: string): TerminalSummary[] {
		return [...this.terminals.values()]
			.filter((entry) => entry.summary.workspaceId === workspaceId)
			.map((entry) => ({ ...entry.summary }));
	}

	async close(terminalId: string): Promise<void> {
		const entry = this.get(terminalId);
		if (entry.summary.status === "exited") return;
		if (!entry.closing) {
			entry.closing = true;
			try {
				entry.pty.kill();
			} catch {
				entry.closing = false;
				throw new Error("PTY could not be terminated");
			}
		}
		const deadline = Promise.withResolvers<never>();
		const timeout = setTimeout(() => deadline.reject(new Error("PTY exit was not observed after kill")), 10_000);
		try {
			await Promise.race([entry.exit, deadline.promise]);
		} finally {
			clearTimeout(timeout);
		}
	}

	async attach(terminalId: string, socket: TerminalSocket): Promise<void> {
		if (this.shuttingDown) throw new Error("Terminal manager is shutting down");
		const entry = this.get(terminalId);
		const attachment: Attachment = {
			socket,
			ready: false,
			awaitingSnapshot: true,
			snapshotSeq: 0,
			sentSeq: 0,
			ackedSeq: -1,
			units: 0,
			pending: [],
			unacked: new Map(),
			onMessage: (data, binary) => {
				try {
					this.command(entry, attachment, parseCommand(data, binary));
				} catch (error) {
					this.send(entry, attachment, {
						type: "error",
						message: error instanceof Error ? error.message : "Terminal command failed",
					});
				}
			},
			onClose: () => this.detach(entry, attachment),
		};
		socket.on("message", attachment.onMessage);
		socket.on("close", attachment.onClose);
		socket.on("error", attachment.onClose);
		await this.enqueue(entry, () => {
			if (socket.readyState !== 1 || this.shuttingDown) {
				this.detach(entry, attachment);
				return;
			}
			entry.attachments.add(attachment);
			if (!entry.controller && entry.summary.status === "running" && !entry.closing) entry.controller = attachment;
			const vt = entry.serializer.serialize({ scrollback: 2000 });
			attachment.ready = true;
			attachment.snapshotSeq = entry.seq;
			attachment.sentSeq = entry.seq;
			attachment.units = vt.length;
			attachment.unacked.set(entry.seq, vt.length);
			if (attachment.units > CLIENT_LIMIT) {
				this.detach(entry, attachment, true);
				return;
			}
			this.send(entry, attachment, { type: "snapshot", ...entry.summary, seq: entry.seq, vt });
			this.send(entry, attachment, { type: "control", controller: entry.controller === attachment });
		});
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		const entries = [...this.terminals.values()];
		const results = await Promise.allSettled(entries.map((entry) => this.close(entry.summary.terminalId)));
		for (const entry of entries) {
			for (const attachment of [...entry.attachments]) this.detach(entry, attachment, true);
			for (const listener of entry.listeners) listener.dispose();
			entry.screen.dispose();
		}
		this.terminals.clear();
		if (results.some((result) => result.status === "rejected"))
			throw new Error("One or more PTY exits were not observed during shutdown");
	}

	private get(id: string): ManagedTerminal {
		const entry = this.terminals.get(id);
		if (!entry) throw new Error("Terminal not found");
		return entry;
	}

	private enqueue(entry: ManagedTerminal, task: () => void | Promise<void>): Promise<void> {
		const result = entry.queue.then(task);
		entry.queue = result.catch(() => {});
		return result;
	}

	private command(entry: ManagedTerminal, attachment: Attachment, command: TerminalClientMessage): void {
		if (!attachment.ready || !entry.attachments.has(attachment)) throw new Error("Terminal attachment is not ready");
		if (command.type === "take_control") {
			if (entry.closing || entry.summary.status !== "running") throw new Error("Terminal has exited");
			entry.controller = attachment;
			for (const peer of entry.attachments)
				this.send(entry, peer, { type: "control", controller: peer === attachment });
			return;
		}
		if (command.generation !== entry.summary.generation)
			throw new Error("Stale terminal generation; reconnect for a new snapshot");
		if (command.type === "ack") {
			if (
				command.seq > attachment.sentSeq ||
				(attachment.awaitingSnapshot && command.seq !== attachment.snapshotSeq)
			)
				throw new Error("Invalid terminal ACK sequence");
			if (command.seq <= attachment.ackedSeq) return;
			attachment.ackedSeq = command.seq;
			for (const [seq, units] of attachment.unacked) {
				if (seq <= command.seq) {
					attachment.units -= units;
					attachment.unacked.delete(seq);
				}
			}
			if (attachment.awaitingSnapshot) {
				attachment.awaitingSnapshot = false;
				const pending = attachment.pending;
				attachment.pending = [];
				for (const event of pending) {
					if (!entry.attachments.has(attachment)) break;
					this.sendStream(entry, attachment, event);
				}
			}
			return;
		}
		if (entry.controller !== attachment)
			throw new Error("Terminal is view-only; take control before input or resize");
		if (entry.summary.status !== "running" || entry.closing) throw new Error("Terminal has exited or is closing");
		if (attachment.awaitingSnapshot) throw new Error("Acknowledge the terminal snapshot before input");
		if (command.type === "input" || command.type === "binary") {
			entry.pty.write(command.type === "binary" ? Buffer.from(command.data, "binary") : command.data);
			return;
		}
		void this.enqueue(entry, () => {
			// Control can change while an ordered resize waits for screen parsing.
			if (entry.controller !== attachment || entry.closing || entry.summary.status !== "running") return;
			if (entry.summary.cols === command.cols && entry.summary.rows === command.rows) return;
			entry.pty.resize(command.cols, command.rows);
			entry.screen.resize(command.cols, command.rows);
			entry.summary = { ...entry.summary, cols: command.cols, rows: command.rows };
			this.publish(entry, {
				type: "resized",
				generation: entry.summary.generation,
				seq: ++entry.seq,
				cols: command.cols,
				rows: command.rows,
			});
		}).catch(() => this.send(entry, attachment, { type: "error", message: "Terminal resize failed" }));
	}

	private publish(entry: ManagedTerminal, event: TerminalStreamEvent): void {
		for (const attachment of entry.attachments) {
			const units = event.type === "data" ? event.data.length : 64;
			attachment.units += units;
			attachment.unacked.set(event.seq, units);
			if (attachment.units > CLIENT_LIMIT || attachment.socket.bufferedAmount > SOCKET_LIMIT) {
				this.detach(entry, attachment, true);
				continue;
			}
			if (attachment.awaitingSnapshot) attachment.pending.push(event);
			else this.sendStream(entry, attachment, event);
		}
	}

	private sendStream(entry: ManagedTerminal, attachment: Attachment, event: TerminalStreamEvent): void {
		attachment.sentSeq = event.seq;
		this.send(entry, attachment, event);
	}

	private send(entry: ManagedTerminal, attachment: Attachment, message: TerminalServerMessage): void {
		if (attachment.socket.readyState !== 1 || attachment.socket.bufferedAmount > SOCKET_LIMIT) {
			this.detach(entry, attachment, true);
			return;
		}
		try {
			attachment.socket.send(JSON.stringify(message));
		} catch {
			this.detach(entry, attachment, true);
		}
	}

	private detach(entry: ManagedTerminal, attachment: Attachment, close = false): void {
		entry.attachments.delete(attachment);
		attachment.ready = false;
		attachment.pending = [];
		attachment.unacked.clear();
		attachment.socket.off("message", attachment.onMessage);
		attachment.socket.off("close", attachment.onClose);
		attachment.socket.off("error", attachment.onClose);
		if (entry.controller === attachment) {
			entry.controller = undefined;
			for (const peer of entry.attachments) this.send(entry, peer, { type: "control", controller: false });
		}
		if (close) attachment.socket.close(1013, "Reconnect for a fresh terminal snapshot");
	}

	private fail(entry: ManagedTerminal): void {
		for (const peer of entry.attachments)
			this.send(entry, peer, { type: "error", message: "Terminal screen processing failed; close this terminal" });
		if (!entry.closing && entry.summary.status === "running") {
			entry.closing = true;
			try {
				entry.pty.kill();
			} catch {
				entry.closing = false;
			}
		}
	}
}
