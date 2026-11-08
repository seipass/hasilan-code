import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
	type HistoryBaseline,
	historyBaseline,
	historyPage,
	historyPatch,
	isHistorySource,
} from "../shared/session-history.ts";

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
	private histories = new WeakMap<Subscription, HistoryBaseline>();
	private releases = new WeakMap<Subscription, () => void>();
	private snapshot: (channel: Channel, id: string) => unknown;
	private retain?: (channel: Channel, id: string) => () => void;
	constructor(
		snapshot: (channel: Channel, id: string) => unknown,
		retain?: (channel: Channel, id: string) => () => void,
	) {
		this.snapshot = snapshot;
		this.retain = retain;
	}
	private release(subscription: Subscription): void {
		this.releases.get(subscription)?.();
		this.releases.delete(subscription);
		this.histories.delete(subscription);
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
		const disconnect = () => {
			for (const subscription of subscriptions.values()) this.release(subscription);
			subscriptions.clear();
			this.clients.delete(socket);
		};
		socket.on("close", disconnect);
		socket.on("error", disconnect);
		socket.on("message", (raw, binary) => {
			try {
				if (binary) throw new Error("Invalid subscription");
				const text = raw.toString();
				if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Invalid subscription");
				const command = JSON.parse(text) as Record<string, unknown>;
				if (typeof command.subscriptionId !== "string" || command.subscriptionId.length > 128)
					throw new Error("Invalid subscription ID");
				if (command.type === "unsubscribe") {
					const previous = subscriptions.get(command.subscriptionId);
					if (previous) this.release(previous);
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
				const release = this.retain?.(subscription.channel, subscription.id);
				const source = (() => {
					try {
						return this.snapshot(subscription.channel, subscription.id);
					} catch (error) {
						release?.();
						throw error;
					}
				})();
				const paged = subscription.channel === "session" && isHistorySource(source);
				const data = paged ? historyPage(source) : source;
				if (paged) this.histories.set(subscription, historyBaseline(source));
				const seq = this.sequences.get(`${subscription.channel}:${subscription.id}`) ?? 0;
				const previous = subscriptions.get(subscription.subscriptionId);
				if (previous) this.release(previous);
				if (release) this.releases.set(subscription, release);
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
		const interested = [...this.clients].flatMap(([socket, subscriptions]) =>
			[...subscriptions.values()]
				.filter((subscription) => subscription.channel === channel && subscription.id === id)
				.map((subscription) => ({ socket, subscription })),
		);
		if (!interested.length) return;
		const source = event == null ? this.snapshot(channel, id) : undefined;
		const paged = channel === "session" && isHistorySource(source);
		const nextBaseline = paged ? historyBaseline(source) : undefined;
		for (const { socket, subscription } of interested) {
			let payload = event ?? { type: "projection", data: source };
			if (paged && nextBaseline) {
				const previous = this.histories.get(subscription);
				const patch = previous && historyPatch(previous, source, nextBaseline);
				payload = patch ? { type: "session_patch", patch } : { type: "projection", data: historyPage(source) };
				this.histories.set(subscription, nextBaseline);
			}
			this.send(socket, { type: "event", ...subscription, epoch: this.epoch, seq, event: payload });
		}
	}
	removeSession(id: string): void {
		const key = `session:${id}`;
		clearTimeout(this.pending.get(key));
		this.pending.delete(key);
		this.broadcast("session", id, { type: "session_deleted" });
		for (const subscriptions of this.clients.values())
			for (const [subscriptionId, subscription] of subscriptions)
				if (subscription.channel === "session" && subscription.id === id) {
					this.release(subscription);
					subscriptions.delete(subscriptionId);
				}
	}
	close() {
		for (const timer of this.pending.values()) clearTimeout(timer);
		this.pending.clear();
		for (const [socket, subscriptions] of this.clients) {
			for (const subscription of subscriptions.values()) this.release(subscription);
			subscriptions.clear();
			socket.close(1001, "Host shutting down");
		}
		this.clients.clear();
	}
}
