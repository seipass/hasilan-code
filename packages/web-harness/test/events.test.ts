import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { EventHub } from "../src/server/events.ts";

class Socket extends EventEmitter {
	readyState = 1;
	bufferedAmount = 0;
	messages: Record<string, unknown>[] = [];
	closed?: number;
	send(data: string) {
		this.bufferedAmount += Buffer.byteLength(data);
		this.messages.push(JSON.parse(data) as Record<string, unknown>);
	}
	close(code: number) {
		this.closed = code;
		this.readyState = 3;
		this.emit("close");
	}
	command(data: unknown) {
		this.emit("message", Buffer.from(JSON.stringify(data)), false);
	}
}

describe("channel subscriptions", () => {
	it("cancels pending updates and notifies subscribers when a session is deleted", async () => {
		vi.useFakeTimers();
		let deleted = false;
		const hub = new EventHub(() => {
			if (deleted) throw new Error("Session not found");
			return { text: "Before deletion" };
		});
		try {
			const socket = new Socket();
			hub.attach(socket as unknown as WebSocket);
			socket.command({ type: "subscribe", subscriptionId: "s", channel: "session", id: "deleted" });
			hub.publish("session", "deleted");
			deleted = true;
			hub.removeSession("deleted");
			await vi.advanceTimersByTimeAsync(100);
			expect(socket.messages).toHaveLength(2);
			expect(socket.messages[1]).toMatchObject({
				type: "event",
				id: "deleted",
				seq: 1,
				event: { type: "session_deleted" },
			});
		} finally {
			hub.close();
			vi.useRealTimers();
		}
	});
	it("keeps each subscriber's history baseline when another subscribes during a pending update", async () => {
		vi.useFakeTimers();
		const source = {
			sessionId: "s",
			toolCalls: [],
			messages: Array.from({ length: 100 }, (_, index) => ({
				messageId: `m${index}`,
				role: "user",
				content: `Message ${index}`,
				partial: false,
			})),
		};
		const hub = new EventHub(() => source);
		try {
			const first = new Socket();
			const second = new Socket();
			hub.attach(first as unknown as WebSocket);
			first.command({ type: "subscribe", subscriptionId: "one", channel: "session", id: "s" });
			source.messages[99] = { ...source.messages[99], content: "Changed" };
			hub.publish("session", "s");
			hub.attach(second as unknown as WebSocket);
			second.command({ type: "subscribe", subscriptionId: "two", channel: "session", id: "s" });
			await vi.advanceTimersByTimeAsync(50);
			expect(first.messages[1]).toMatchObject({
				seq: 1,
				event: { type: "session_patch", patch: { messages: [{ index: 99, message: { content: "Changed" } }] } },
			});
			expect(second.messages[1]).toMatchObject({
				seq: 1,
				event: { type: "session_patch", patch: { messages: [] } },
			});
			source.messages.shift();
			hub.publish("session", "s");
			await vi.advanceTimersByTimeAsync(50);
			expect(first.messages[2]).toMatchObject({
				seq: 2,
				event: { type: "projection", data: { history: { start: 49, total: 99 } } },
			});
		} finally {
			hub.close();
			vi.useRealTimers();
		}
	});
	it("does not build unobserved projections on every token", async () => {
		vi.useFakeTimers();
		const snapshot = vi.fn(() => ({}));
		const hub = new EventHub(snapshot);
		try {
			for (let index = 0; index < 50; index++) hub.publish("session", "unselected");
			await vi.advanceTimersByTimeAsync(50);
			expect(snapshot).not.toHaveBeenCalled();
		} finally {
			hub.close();
			vi.useRealTimers();
		}
	});
	it("keeps session identities and monotonic sequences independent across selection changes", async () => {
		vi.useFakeTimers();
		try {
			const state: Record<string, string> = { a: "first", b: "second" };
			const hub = new EventHub((_channel, id) => ({ text: state[id] }));
			const socket = new Socket();
			hub.attach(socket as unknown as WebSocket);
			socket.command({ type: "subscribe", subscriptionId: "selected", channel: "session", id: "a" });
			state.a = "final-a";
			hub.publish("session", "a");
			await vi.advanceTimersByTimeAsync(50);
			socket.command({ type: "subscribe", subscriptionId: "selected", channel: "session", id: "b" });
			hub.publish("session", "a");
			state.b = "final-b";
			hub.publish("session", "b");
			await vi.advanceTimersByTimeAsync(50);
			expect(socket.messages.map((message) => [message.type, message.id, message.seq])).toEqual([
				["snapshot", "a", 0],
				["event", "a", 1],
				["snapshot", "b", 0],
				["event", "b", 1],
			]);
			expect(socket.messages[0].data).toEqual({ text: "first" });
			expect(socket.messages[3].event).toEqual({ type: "projection", data: { text: "final-b" } });
		} finally {
			vi.useRealTimers();
		}
	});
	it("disconnects only an overflowing client while another receives the same update", async () => {
		vi.useFakeTimers();
		try {
			const hub = new EventHub(() => ({ text: "result" }));
			const slow = new Socket();
			const fast = new Socket();
			for (const socket of [slow, fast]) {
				hub.attach(socket as unknown as WebSocket);
				socket.command({ type: "subscribe", subscriptionId: "s", channel: "workspace", id: "w" });
			}
			slow.bufferedAmount = 2 * 1024 * 1024 + 1;
			hub.publish("workspace", "w");
			await vi.advanceTimersByTimeAsync(50);
			expect(slow.closed).toBe(1013);
			expect(fast.messages[1].seq).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
	it("coalesces bursty projection snapshots before disconnecting a slow client", async () => {
		vi.useFakeTimers();
		try {
			let text = "x".repeat(64 * 1024);
			const hub = new EventHub(() => ({ text }));
			const slow = new Socket();
			hub.attach(slow as unknown as WebSocket);
			slow.command({ type: "subscribe", subscriptionId: "s", channel: "session", id: "session" });
			slow.bufferedAmount = 0;
			for (let index = 0; index < 40; index++) {
				text = `${index}${"x".repeat(64 * 1024)}`;
				hub.publish("session", "session");
			}
			hub.publish("session", "session", { type: "files_changed", paths: ["file.ts"] });
			expect(slow.messages).toHaveLength(2);
			expect(slow.messages[1]).toMatchObject({
				type: "event",
				seq: 1,
				event: { type: "files_changed", paths: ["file.ts"] },
			});
			await vi.advanceTimersByTimeAsync(50);
			expect(slow.closed).toBeUndefined();
			expect(slow.messages).toHaveLength(3);
			expect(slow.messages[2]).toMatchObject({
				type: "event",
				seq: 2,
				event: { type: "projection", data: { text } },
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
