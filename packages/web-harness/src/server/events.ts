import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

export type Channel = "workspace" | "session";
interface Subscription {
	subscriptionId: string;
	channel: Channel;
	id: string;
}

const PROJECTION_COALESCE_MS = 50;
export class EventHub {
	readonly epoch = randomUUID();
	private sequences = new Map<string, number>();
	private clients = new Map<WebSocket, Map<string, Subscription>>();
	private pending = new Map<string, NodeJS.Timeout>();
	private snapshot: (channel: Channel, id: string) => unknown;
	constructor(snapshot: (channel: Channel, id: string) => unknown) {
		this.snapshot = snapshot;
	}
	private send(socket: WebSocket, value: unknown) {
		if (socket.readyState !== 1) return;
		if (socket.bufferedAmount > 2 * 1024 * 1024) {
			socket.close(1013, "Reconnect for a fresh snapshot");
			return;
		}
		socket.send(JSON.stringify(value));
	}
	attach(socket: WebSocket) {
		const subscriptions = new Map<string, Subscription>();
		this.clients.set(socket, subscriptions);
		socket.on("close", () => this.clients.delete(socket));
		socket.on("error", () => this.clients.delete(socket));
		socket.on("message", (raw, binary) => {
			try {
				if (binary) throw new Error("Invalid subscription");
				const text = raw.toString();
				if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Invalid subscription");
				const command = JSON.parse(text) as Record<string, unknown>;
				if (typeof command.subscriptionId !== "string" || command.subscriptionId.length > 128)
					throw new Error("Invalid subscription ID");
				if (command.type === "unsubscribe") {
					subscriptions.delete(command.subscriptionId);
					return;
				}
				if (
					command.type !== "subscribe" ||
					(command.channel !== "workspace" && command.channel !== "session") ||
					typeof command.id !== "string"
				)
					throw new Error("Invalid subscription");
				const subscription: Subscription = {
					subscriptionId: command.subscriptionId,
					channel: command.channel,
					id: command.id,
				};
				const data = structuredClone(this.snapshot(subscription.channel, subscription.id));
				const seq = this.sequences.get(`${subscription.channel}:${subscription.id}`) ?? 0;
				subscriptions.set(subscription.subscriptionId, subscription);
				this.send(socket, { type: "snapshot", ...subscription, epoch: this.epoch, seq, data });
			} catch {
				this.send(socket, { type: "error", error: "Invalid or unavailable subscription" });
			}
		});
	}
	publish(channel: Channel, id: string, event?: unknown) {
		const key = `${channel}:${id}`;
		if (event !== undefined && event !== null) {
			this.broadcast(channel, id, event);
			return;
		}
		if (this.pending.has(key)) return;
		this.pending.set(
			key,
			setTimeout(() => {
				this.pending.delete(key);
				this.broadcast(channel, id);
			}, PROJECTION_COALESCE_MS),
		);
	}
	private broadcast(channel: Channel, id: string, event?: unknown) {
		const key = `${channel}:${id}`;
		const seq = (this.sequences.get(key) ?? 0) + 1;
		this.sequences.set(key, seq);
		const payload = event ?? { type: "projection", data: structuredClone(this.snapshot(channel, id)) };
		for (const [socket, subscriptions] of this.clients)
			for (const subscription of subscriptions.values()) {
				if (subscription.channel === channel && subscription.id === id)
					this.send(socket, { type: "event", ...subscription, epoch: this.epoch, seq, event: payload });
			}
	}
	close() {
		for (const timer of this.pending.values()) clearTimeout(timer);
		this.pending.clear();
		for (const socket of this.clients.keys()) socket.close(1001, "Host shutting down");
		this.clients.clear();
	}
}
