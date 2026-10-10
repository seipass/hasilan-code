import { EventEmitter } from "node:events";
import headless from "@xterm/headless";
import type { IDisposable, IPty, spawn } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalManager, type TerminalSocket } from "../src/server/terminal-manager.ts";
import type { TerminalServerMessage } from "../src/shared/terminal-protocol.ts";

// Process state is controlled here; screen parsing/serialization use the real xterm implementations.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

const HeadlessTerminal = headless.Terminal;

class TestPty implements IPty {
	pid = 123;
	cols = 80;
	rows = 24;
	process = "test-shell";
	handleFlowControl = false;
	private dataListeners = new Set<(data: string) => void>();
	private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
	readonly onData = (listener: (data: string) => void): IDisposable => {
		this.dataListeners.add(listener);
		return {
			dispose: () => {
				this.dataListeners.delete(listener);
			},
		};
	};
	readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
		this.exitListeners.add(listener);
		return {
			dispose: () => {
				this.exitListeners.delete(listener);
			},
		};
	};
	readonly write = vi.fn<(data: string | Buffer) => void>();
	readonly resize = vi.fn((cols: number, rows: number) => {
		this.cols = cols;
		this.rows = rows;
	});
	readonly clear = vi.fn<() => void>();
	readonly pause = vi.fn<() => void>();
	readonly resume = vi.fn<() => void>();
	readonly kill = vi.fn(() => {
		this.emitExit(0);
	});
	emitData(data: string) {
		for (const listener of this.dataListeners) listener(data);
	}
	emitExit(exitCode: number, signal?: number) {
		for (const listener of this.exitListeners) listener({ exitCode, signal });
	}
	get listenerCount() {
		return this.dataListeners.size + this.exitListeners.size;
	}
}

class TestSocket extends EventEmitter implements TerminalSocket {
	readyState = 1;
	bufferedAmount = 0;
	messages: TerminalServerMessage[] = [];
	closedCode?: number;
	send(data: string) {
		const message = JSON.parse(data) as TerminalServerMessage;
		this.messages.push(message);
		this.emit("sent", message);
	}
	close(code?: number) {
		this.closedCode = code;
		this.readyState = 3;
		this.emit("close");
	}
	command(message: unknown) {
		this.emit("message", Buffer.from(JSON.stringify(message)), false);
	}
	snapshot() {
		const message = this.messages.find((item) => item.type === "snapshot");
		if (!message || message.type !== "snapshot") throw new Error("No snapshot");
		return message;
	}
	ackSnapshot() {
		const snapshot = this.snapshot();
		this.command({ type: "ack", generation: snapshot.generation, seq: snapshot.seq });
	}
	waitFor(predicate: (message: TerminalServerMessage) => boolean): Promise<TerminalServerMessage> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		const completion = Promise.withResolvers<TerminalServerMessage>();
		const listener = (message: TerminalServerMessage) => {
			if (predicate(message)) {
				this.off("sent", listener);
				completion.resolve(message);
			}
		};
		this.on("sent", listener);
		return completion.promise;
	}
}

const managers: TerminalManager[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
});

function setup() {
	const processes: TestPty[] = [];
	const spawnPty = vi.fn<typeof spawn>(() => {
		const pty = new TestPty();
		processes.push(pty);
		return pty;
	});
	const manager = new TerminalManager({ getWorkspaceRoot: (id) => `/workspaces/${id}`, spawn: spawnPty });
	managers.push(manager);
	return { manager, processes, spawnPty };
}

async function screenText(vt: string, cols: number, rows: number) {
	const screen = new HeadlessTerminal({ cols, rows, allowProposedApi: true });
	try {
		const parsed = Promise.withResolvers<void>();
		screen.write(vt, parsed.resolve);
		await parsed.promise;
		const buffer = screen.buffer.active;
		return Array.from(
			{ length: buffer.length },
			(_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
		).join("\n");
	} finally {
		screen.dispose();
	}
}

describe("TerminalManager", () => {
	it("serializes parsed screen state, and retains a PTY after browser detach", async () => {
		const { manager, processes, spawnPty } = setup();
		const terminal = await manager.create({ workspaceId: "a", cols: 80, rows: 24 });
		expect(spawnPty.mock.calls[0]?.[2]).toMatchObject({ cwd: "/workspaces/a", cols: 80, rows: 24, env: process.env });
		processes[0].emitData("old contents\r\u001b[2Knew 日本語");
		const socket = new TestSocket();
		await manager.attach(terminal.terminalId, socket);
		const snapshot = socket.snapshot();
		const text = await screenText(snapshot.vt, snapshot.cols, snapshot.rows);
		expect(text).toContain("new 日本語");
		expect(text).not.toContain("old contents");
		socket.close();
		expect(processes[0].kill).not.toHaveBeenCalled();
		expect(manager.list("a")[0].status).toBe("running");
		expect(manager.list("b")).toEqual([]);
	});

	it("holds output until snapshot ACK and rejects acknowledgements for unsent or stale events", async () => {
		const { manager, processes } = setup();
		const terminal = await manager.create({ workspaceId: "a", cols: 80, rows: 24 });
		const socket = new TestSocket();
		await manager.attach(terminal.terminalId, socket);
		processes[0].emitData("after snapshot");
		// A second attachment is a screen barrier for all previous process output.
		await manager.attach(terminal.terminalId, new TestSocket());
		expect(socket.messages.filter((item) => item.type === "data")).toEqual([]);
		socket.command({ type: "ack", generation: terminal.generation, seq: 1 });
		expect(socket.messages.at(-1)).toMatchObject({ type: "error", message: "Invalid terminal ACK sequence" });
		socket.command({ type: "ack", generation: "old", seq: 0 });
		expect(socket.messages.at(-1)).toMatchObject({ type: "error" });
		socket.ackSnapshot();
		expect(socket.messages.at(-1)).toMatchObject({ type: "data", seq: 1, data: "after snapshot" });
		socket.command({ type: "ack", generation: terminal.generation, seq: 1 });
		socket.command({ type: "ack", generation: terminal.generation, seq: 1 });
		expect(socket.readyState).toBe(1);
	});

	it("transfers control explicitly and rejects old controller input without killing either connection", async () => {
		const { manager, processes } = setup();
		const terminal = await manager.create({ workspaceId: "a", cols: 80, rows: 24 });
		const first = new TestSocket();
		const second = new TestSocket();
		await manager.attach(terminal.terminalId, first);
		await manager.attach(terminal.terminalId, second);
		first.ackSnapshot();
		second.ackSnapshot();
		expect(first.messages).toContainEqual({ type: "control", controller: true });
		expect(second.messages).toContainEqual({ type: "control", controller: false });
		second.command({ type: "input", generation: terminal.generation, data: "denied" });
		expect(processes[0].write).not.toHaveBeenCalled();
		second.command({ type: "take_control" });
		expect(first.messages.at(-1)).toEqual({ type: "control", controller: false });
		first.command({ type: "input", generation: terminal.generation, data: "old controller" });
		second.command({ type: "input", generation: terminal.generation, data: "日本語\u0003" });
		second.command({ type: "binary", generation: terminal.generation, data: "\u00ff" });
		expect(processes[0].write.mock.calls).toEqual([["日本語\u0003"], [Buffer.from([255])]]);
		second.close();
		expect(first.messages.at(-1)).toEqual({ type: "control", controller: false });
		expect(processes[0].kill).not.toHaveBeenCalled();
	});

	it("orders resize behind screen writes, sends geometry once, and rejects invalid geometry", async () => {
		const { manager, processes } = setup();
		const terminal = await manager.create({ workspaceId: "a", cols: 80, rows: 24 });
		const socket = new TestSocket();
		await manager.attach(terminal.terminalId, socket);
		socket.ackSnapshot();
		processes[0].emitData("before resize");
		socket.command({ type: "resize", generation: terminal.generation, cols: 120, rows: 30 });
		await socket.waitFor((message) => message.type === "resized");
		const stream = socket.messages.filter((message) => message.type === "data" || message.type === "resized");
		expect(stream.map((message) => [message.type, message.seq])).toEqual([
			["data", 1],
			["resized", 2],
		]);
		expect(processes[0].resize).toHaveBeenCalledExactlyOnceWith(120, 30);
		socket.command({ type: "resize", generation: terminal.generation, cols: 120, rows: 30 });
		socket.command({ type: "resize", generation: terminal.generation, cols: 501, rows: 30 });
		socket.command({ type: "resize", generation: terminal.generation, cols: 0.5, rows: 30 });
		const reconnect = new TestSocket();
		await manager.attach(terminal.terminalId, reconnect);
		expect(reconnect.snapshot()).toMatchObject({ cols: 120, rows: 30, seq: 2 });
		expect(processes[0].resize).toHaveBeenCalledTimes(1);
		expect(socket.messages.filter((message) => message.type === "error")).toHaveLength(2);
	});

	it("drops only an overbuffered viewer while continuing screen parsing and another terminal", async () => {
		const { manager, processes } = setup();
		const a = await manager.create({ workspaceId: "a", cols: 80, rows: 24 });
		const b = await manager.create({ workspaceId: "a", cols: 80, rows: 24 });
		const slow = new TestSocket();
		const fast = new TestSocket();
		await manager.attach(a.terminalId, slow);
		slow.ackSnapshot();
		await manager.attach(b.terminalId, fast);
		fast.ackSnapshot();
		slow.bufferedAmount = 2 * 1024 * 1024 + 1;
		processes[0].emitData("retained");
		processes[1].emitData("independent");
		await fast.waitFor((message) => message.type === "data");
		const reconnect = new TestSocket();
		await manager.attach(a.terminalId, reconnect);
		expect(slow.closedCode).toBe(1013);
		expect(await screenText(reconnect.snapshot().vt, 80, 24)).toContain("retained");
		expect(processes[0].kill).not.toHaveBeenCalled();
		expect(processes[1].kill).not.toHaveBeenCalled();
	});

	it("bounds unacknowledged output and pauses only unparsed process output", async () => {
		const { manager, processes } = setup();
		const terminal = await manager.create({ workspaceId: "a", cols: 80, rows: 24 });
		const slow = new TestSocket();
		await manager.attach(terminal.terminalId, slow);
		slow.ackSnapshot();
		for (let index = 0; index < 18; index++) processes[0].emitData(`${"x".repeat(60_000)}\r`);
		expect(processes[0].pause).toHaveBeenCalledTimes(1);
		const reconnect = new TestSocket();
		await manager.attach(terminal.terminalId, reconnect);
		expect(processes[0].resume).toHaveBeenCalledTimes(1);
		expect(slow.closedCode).toBe(1013);
		expect(reconnect.snapshot().seq).toBe(18);
		expect(processes[0].kill).not.toHaveBeenCalled();
	});

	it("keeps the final parsed screen and exit code, disposes process listeners, and never respawns on attach", async () => {
		const { manager, processes, spawnPty } = setup();
		const terminal = await manager.create({ workspaceId: "a", cols: 80, rows: 24 });
		processes[0].emitData("final output");
		processes[0].emitExit(7);
		const socket = new TestSocket();
		await manager.attach(terminal.terminalId, socket);
		expect(socket.snapshot()).toMatchObject({ status: "exited", exitCode: 7, seq: 2 });
		expect(await screenText(socket.snapshot().vt, 80, 24)).toContain("final output");
		expect(processes[0].listenerCount).toBe(0);
		socket.ackSnapshot();
		socket.command({ type: "take_control" });
		expect(socket.messages.at(-1)).toMatchObject({ type: "error" });
		await manager.close(terminal.terminalId);
		expect(processes[0].kill).not.toHaveBeenCalled();
		expect(spawnPty).toHaveBeenCalledTimes(1);
	});

	it("kills explicitly with no Windows signal and closes all ownership during shutdown", async () => {
		const { manager, processes } = setup();
		const a = await manager.create({ workspaceId: "a", cols: 80, rows: 24 });
		await manager.create({ workspaceId: "b", cols: 80, rows: 24 });
		await manager.close(a.terminalId);
		expect(processes[0].kill).toHaveBeenCalledExactlyOnceWith();
		await manager.shutdown();
		expect(processes[1].kill).toHaveBeenCalledExactlyOnceWith();
		await expect(manager.create({ workspaceId: "a", cols: 80, rows: 24 })).rejects.toThrow("shutting down");
	});

	it("rejects invalid geometry before spawning and surfaces native failures without fallback", async () => {
		const { manager, spawnPty } = setup();
		await expect(manager.create({ workspaceId: "a", cols: 501, rows: 24 })).rejects.toThrow("dimensions");
		expect(spawnPty).not.toHaveBeenCalled();
		spawnPty.mockImplementationOnce(() => {
			throw new Error("native failure");
		});
		await expect(manager.create({ workspaceId: "a", cols: 80, rows: 24 })).rejects.toThrow("VS2022");
		expect(manager.list("a")).toEqual([]);
	});
});
