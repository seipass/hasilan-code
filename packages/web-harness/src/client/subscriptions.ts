import { useEffect, useRef, useState } from "react";
import { websocketUrl } from "./api.ts";

interface Envelope<T> {
	type: "snapshot" | "event" | "error";
	subscriptionId: string;
	channel: "workspace" | "session";
	id: string;
	epoch: string;
	seq: number;
	data?: T;
	event?: { type: string; data?: T; workspaceId?: string; paths?: string[] };
	error?: string;
}

export function useChannel<T>(
	channel: "workspace" | "session",
	id: string | undefined,
	onFilesChanged?: (paths: string[]) => void,
) {
	const [data, setData] = useState<{ id: string; value: T }>();
	const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("disconnected");
	const [error, setError] = useState<string>();
	const filesCallback = useRef(onFilesChanged);
	filesCallback.current = onFilesChanged;
	useEffect(() => {
		setData(undefined);
		setError(undefined);
		if (!id) {
			setConnection("disconnected");
			return;
		}
		let disposed = false;
		let socket: WebSocket | undefined;
		let timer: number | undefined;
		let delay = 500;
		let subscriptionId = "";
		let epoch: string | undefined;
		let seq = -1;
		const subscribe = () => {
			if (socket?.readyState !== WebSocket.OPEN) return;
			if (subscriptionId) socket.send(JSON.stringify({ type: "unsubscribe", subscriptionId }));
			subscriptionId = crypto.randomUUID();
			epoch = undefined;
			seq = -1;
			socket.send(JSON.stringify({ type: "subscribe", subscriptionId, channel, id }));
		};
		const connect = () => {
			if (disposed) return;
			setConnection("connecting");
			socket = new WebSocket(websocketUrl("/api/events"));
			socket.onopen = () => {
				delay = 500;
				subscribe();
			};
			socket.onmessage = (message) => {
				if (disposed || typeof message.data !== "string") return;
				let envelope: Envelope<T>;
				try {
					envelope = JSON.parse(message.data) as Envelope<T>;
				} catch {
					return;
				}
				if (envelope.subscriptionId !== subscriptionId || envelope.channel !== channel || envelope.id !== id)
					return;
				if (envelope.type === "error") {
					setError(envelope.error ?? "購読に失敗しました");
					return;
				}
				if (envelope.type === "snapshot") {
					if (epoch !== undefined) return;
					epoch = envelope.epoch;
					seq = envelope.seq;
					if (envelope.data !== undefined) setData({ id, value: envelope.data });
					setConnection("connected");
					setError(undefined);
					return;
				}
				if (envelope.type !== "event" || envelope.seq <= seq) return;
				if (epoch !== envelope.epoch) {
					setConnection("connecting");
					subscribe();
					return;
				}
				if (envelope.seq !== seq + 1) {
					setConnection("connecting");
					subscribe();
					return;
				}
				seq = envelope.seq;
				if (envelope.event?.type === "projection" && envelope.event.data !== undefined)
					setData({ id, value: envelope.event.data });
				if (envelope.event?.type === "files_changed") filesCallback.current?.(envelope.event.paths ?? []);
			};
			socket.onerror = () => setError("接続できません。認証・サーバーの起動状態を確認してください。");
			socket.onclose = () => {
				if (disposed) return;
				setConnection("disconnected");
				timer = window.setTimeout(connect, delay);
				delay = Math.min(delay * 2, 10000);
			};
		};
		connect();
		return () => {
			disposed = true;
			window.clearTimeout(timer);
			if (socket?.readyState === WebSocket.OPEN && subscriptionId)
				socket.send(JSON.stringify({ type: "unsubscribe", subscriptionId }));
			socket?.close();
		};
	}, [channel, id]);
	return { data: data?.id === id ? data?.value : undefined, connection, error };
}
