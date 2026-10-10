import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { EventHub } from "../src/server/events.ts";

class Socket extends EventEmitter {
	readyState = 1;
	bufferedAmount = 0;
	messages: Record<string, unknown>[] = [];
	closed?: number;
	send(data: string) {
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
	it("keeps session identities and monotonic sequences independent across selection changes", () => {
		const state: Record<string, string> = { a: "first", b: "second" };
		const hub = new EventHub((_channel, id) => ({ text: state[id] }));
		const socket = new Socket();
		hub.attach(socket as unknown as WebSocket);
		socket.command({ type: "subscribe", subscriptionId: "selected", channel: "session", id: "a" });
		state.a = "final-a";
		hub.publish("session", "a");
		socket.command({ type: "subscribe", subscriptionId: "selected", channel: "session", id: "b" });
		hub.publish("session", "a");
		state.b = "final-b";
		hub.publish("session", "b");
		expect(socket.messages.map((message) => [message.type, message.id, message.seq])).toEqual([
			["snapshot", "a", 0],
			["event", "a", 1],
			["snapshot", "b", 0],
			["event", "b", 1],
		]);
		expect(socket.messages[0].data).toEqual({ text: "first" });
		expect(socket.messages[3].event).toEqual({ type: "projection", data: { text: "final-b" } });
	});
	it("disconnects only an overflowing client while another receives the same update", () => {
		const hub = new EventHub(() => ({ text: "result" }));
		const slow = new Socket();
		const fast = new Socket();
		for (const socket of [slow, fast]) {
			hub.attach(socket as unknown as WebSocket);
			socket.command({ type: "subscribe", subscriptionId: "s", channel: "workspace", id: "w" });
		}
		slow.bufferedAmount = 2 * 1024 * 1024 + 1;
		hub.publish("workspace", "w");
		expect(slow.closed).toBe(1013);
		expect(fast.messages[1].seq).toBe(1);
	});
});
