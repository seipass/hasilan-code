import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "./types.ts";

export interface AttentionOptions {
	sessions: SessionSummary[];
	selectedSessionId?: string;
	selectedTitle?: string;
	notificationsEnabled: boolean;
	onSelect: (sessionId: string) => void;
}

const ACTIVE = new Set(["running", "waiting", "queued", "cancelling"]);

export function attentionTitle(running: number, unread: number, title?: string): string {
	const base = title?.replace(/\s+/g, " ").trim() || "Hasilan Code";
	const prefix = running > 0 ? `(${running}) 実行中 · ` : unread > 0 ? `(${unread}) 完了 · ` : "";
	return `${prefix}${base}`;
}

export function summarizedTitle(session: SessionSummary): string {
	return (session.title ?? "新しい会話").replace(/\s+/g, " ").trim().slice(0, 80) || "新しい会話";
}

/** Tracks active runs and settled completions so a background tab can advertise progress. */
export function useAttention({
	sessions,
	selectedSessionId,
	selectedTitle,
	notificationsEnabled,
	onSelect,
}: AttentionOptions) {
	const previous = useRef(new Map<string, boolean>());
	const [unread, setUnread] = useState<Set<string>>(() => new Set());
	const [baseline, setBaseline] = useState(false);
	const select = useRef(onSelect);
	select.current = onSelect;
	const active = sessions.filter(
		(session) =>
			!!session.currentRun ||
			(session.currentRun === undefined && !!session.latestRun && ACTIVE.has(session.latestRun.status)),
	);
	const running = sessions.filter(
		(session) => !!session.currentRun || (!!session.latestRun && ACTIVE.has(session.latestRun.status)),
	).length;

	useEffect(() => {
		const next = new Map<string, boolean>();
		const completed: SessionSummary[] = [];
		for (const session of sessions) {
			const isActive = !!session.currentRun || (!!session.latestRun && ACTIVE.has(session.latestRun.status));
			next.set(session.sessionId, isActive);
			if (baseline && previous.current.get(session.sessionId) === true && !isActive) completed.push(session);
		}
		previous.current = next;
		if (!baseline) {
			setBaseline(true);
			return;
		}
		if (!completed.length) return;
		setUnread((current) => {
			const merged = new Set(current);
			for (const session of completed) merged.add(session.sessionId);
			return merged;
		});
		if (
			!notificationsEnabled ||
			!document.hidden ||
			typeof Notification === "undefined" ||
			Notification.permission !== "granted"
		)
			return;
		for (const session of completed) {
			const failed = session.latestRun?.status === "failed" || session.latestRun?.status === "interrupted";
			const notification = new Notification(failed ? "作業が失敗しました" : "作業が完了しました", {
				body: summarizedTitle(session),
				tag: `hasilan-${session.sessionId}`,
			});
			notification.onclick = () => {
				window.focus();
				select.current(session.sessionId);
				notification.close();
			};
		}
	}, [sessions, notificationsEnabled, baseline]);

	useEffect(() => {
		if (!selectedSessionId || !unread.has(selectedSessionId) || document.hidden) return;
		setUnread((current) => {
			const next = new Set(current);
			next.delete(selectedSessionId);
			return next;
		});
	}, [selectedSessionId, unread]);

	useEffect(() => {
		const clear = () => {
			if (document.hidden) return;
			setUnread((current) => (current.size ? new Set() : current));
		};
		window.addEventListener("focus", clear);
		document.addEventListener("visibilitychange", clear);
		return () => {
			window.removeEventListener("focus", clear);
			document.removeEventListener("visibilitychange", clear);
		};
	}, []);

	useEffect(() => {
		document.title = attentionTitle(running, unread.size, selectedTitle);
	}, [running, unread, selectedTitle]);
	useEffect(() => {
		setFaviconState(running > 0 ? "running" : unread.size > 0 ? "done" : "idle");
	}, [running, unread]);
	return { running, unread: unread.size, active };
}

let faviconState: "idle" | "running" | "done" | undefined;
let iconImage: HTMLImageElement | undefined;

/** Draws a small state dot over the app icon; used as the favicon while work is active or unread. */
function setFaviconState(state: "idle" | "running" | "done"): void {
	if (faviconState === state || typeof document === "undefined") return;
	faviconState = state;
	iconImage ??= new Image();
	const render = () => {
		const size = 64;
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const context = canvas.getContext("2d");
		if (!context) return;
		context.clearRect(0, 0, size, size);
		if (iconImage?.complete && iconImage.naturalWidth > 0) context.drawImage(iconImage, 0, 0, size, size);
		if (state !== "idle") {
			context.beginPath();
			context.arc(48, 16, 14, 0, Math.PI * 2);
			context.fillStyle = state === "running" ? "#89b4fa" : "#a6e3a1";
			context.fill();
			context.lineWidth = 5;
			context.strokeStyle = "#1e1e2e";
			context.stroke();
		}
		const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement("link");
		link.rel = "icon";
		link.type = "image/png";
		link.href = canvas.toDataURL("image/png");
		if (!link.isConnected) document.head.append(link);
	};
	if (state === "idle" && iconImage?.complete) {
		// Restore the vector icon instead of a stale overlay.
		const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
		if (link) {
			link.type = "image/svg+xml";
			link.href = "/icon.svg";
		}
		return;
	}
	if (iconImage.complete) render();
	else {
		iconImage.addEventListener("load", render, { once: true });
		iconImage.src = "/icon.svg";
	}
}
