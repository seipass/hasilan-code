import { useCallback, useEffect, useRef, useState } from "react";
import {
	applyHistoryPatch,
	type HistoryPatch,
	type HistorySource,
	isHistorySource,
	prependHistory,
	reconcileHistory,
} from "../shared/session-history.ts";
import { ApiError, api, errorMessage, websocketUrl } from "./api.ts";
import { nextClientId } from "./ids.ts";

interface Envelope<T> {
	type: "snapshot" | "event" | "error";
	subscriptionId: string;
	channel: "workspace" | "session";
	id: string;
	epoch: string;
	seq: number;
	data?: T;
	event?: { type: string; data?: T; patch?: HistoryPatch<T & HistorySource>; workspaceId?: string; paths?: string[] };
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
	const [historyLoading, setHistoryLoading] = useState(false);
	const [historyError, setHistoryError] = useState<string>();
	const current = useRef<{ id: string; value: T } | undefined>(undefined);
	const generation = useRef(0);
	const historyRequest = useRef<AbortController | undefined>(undefined);
	const resubscribe = useRef<(() => void) | undefined>(undefined);
	const loadOlder = useCallback(async () => {
		const selected = current.current;
		if (
			channel !== "session" ||
			!id ||
			selected?.id !== id ||
			!isHistorySource(selected.value) ||
			!selected.value.history?.before ||
			historyRequest.current
		)
			return;
		const before = selected.value.history.before;
		const revision = generation.current;
		const controller = new AbortController();
		historyRequest.current = controller;
		setHistoryLoading(true);
		setHistoryError(undefined);
		try {
			const page = await api<HistorySource>(
				`/api/sessions/${encodeURIComponent(id)}/history?before=${encodeURIComponent(before)}`,
				{ signal: controller.signal },
			);
			const latest = current.current;
			if (
				revision !== generation.current ||
				latest?.id !== id ||
				!isHistorySource(latest.value) ||
				latest.value.history?.before !== before
			)
				return;
			const value = prependHistory(latest.value, page);
			current.current = { id, value };
			setData({ id, value });
		} catch (reason) {
			if (controller.signal.aborted || revision !== generation.current) return;
			if (reason instanceof ApiError && reason.status === 409) resubscribe.current?.();
			else setHistoryError(errorMessage(reason));
		} finally {
			if (historyRequest.current === controller) {
				historyRequest.current = undefined;
				setHistoryLoading(false);
			}
		}
	}, [channel, id]);
	const filesCallback = useRef(onFilesChanged);
	filesCallback.current = onFilesChanged;
	useEffect(() => {
		current.current = undefined;
		setData(undefined);
		setError(undefined);
		setHistoryError(undefined);
		setHistoryLoading(false);
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
			generation.current++;
			historyRequest.current?.abort();
			historyRequest.current = undefined;
			setHistoryLoading(false);
			setHistoryError(undefined);
			if (subscriptionId) socket.send(JSON.stringify({ type: "unsubscribe", subscriptionId }));
			subscriptionId = nextClientId();
			epoch = undefined;
			seq = -1;
			socket.send(JSON.stringify({ type: "subscribe", subscriptionId, channel, id }));
		};
		resubscribe.current = subscribe;
		const update = (value: T) => {
			current.current = { id, value };
			setData({ id, value });
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
					if (envelope.data !== undefined) {
						const previous = current.current;
						update(
							channel === "session" &&
								previous?.id === id &&
								isHistorySource(previous.value) &&
								isHistorySource(envelope.data)
								? reconcileHistory(previous.value, envelope.data)
								: envelope.data,
						);
					}
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
				if (envelope.event?.type === "projection" && envelope.event.data !== undefined) update(envelope.event.data);
				if (
					envelope.event?.type === "session_patch" &&
					envelope.event.patch &&
					current.current?.id === id &&
					isHistorySource(current.current.value)
				)
					update(applyHistoryPatch(current.current.value, envelope.event.patch));
				if (envelope.event?.type === "files_changed") filesCallback.current?.(envelope.event.paths ?? []);
			};
			socket.onerror = () => setError("接続できません。認証・サーバーの起動状態を確認してください。");
			socket.onclose = () => {
				if (disposed) return;
				generation.current++;
				historyRequest.current?.abort();
				historyRequest.current = undefined;
				setHistoryLoading(false);
				setConnection("disconnected");
				timer = window.setTimeout(connect, delay);
				delay = Math.min(delay * 2, 10000);
			};
		};
		connect();
		return () => {
			disposed = true;
			generation.current++;
			historyRequest.current?.abort();
			historyRequest.current = undefined;
			resubscribe.current = undefined;
			window.clearTimeout(timer);
			if (socket?.readyState === WebSocket.OPEN && subscriptionId)
				socket.send(JSON.stringify({ type: "unsubscribe", subscriptionId }));
			socket?.close();
		};
	}, [channel, id]);
	return {
		data: data?.id === id ? data?.value : undefined,
		connection,
		error,
		loadOlder,
		historyLoading,
		historyError,
	};
}
