import { useSyncExternalStore } from "react";

export interface MusicState {
	title: string;
	artist: string;
	playing: boolean;
	position: number;
	duration: number;
	volume: number;
	muted: boolean;
	error: boolean;
}

let active: HTMLAudioElement | undefined;
let state: MusicState | null = null;
const listeners = new Set<() => void>();
const events = ["play", "pause", "ended", "timeupdate", "durationchange", "volumechange", "error", "loadedmetadata"];
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
const snapshot = () => state;

export function useMusic(): MusicState | null {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Keep transport state on the real media element; both the viewer and widget observe its events. */
export function registerMusic(element: HTMLAudioElement, title: string, artist: string): () => void {
	const update = () => {
		if (active !== element) return;
		state = {
			title,
			artist,
			playing: !element.paused && !element.ended,
			position: element.currentTime,
			duration: Number.isFinite(element.duration) ? element.duration : 0,
			volume: element.volume,
			muted: element.muted,
			error: !!element.error,
		};
		for (const listener of listeners) listener();
	};
	const select = () => {
		active = element;
		update();
	};
	if (!active) select();
	for (const event of events) element.addEventListener(event, update);
	element.addEventListener("play", select);
	return () => {
		for (const event of events) element.removeEventListener(event, update);
		element.removeEventListener("play", select);
		if (active === element) {
			active = undefined;
			state = null;
			for (const listener of listeners) listener();
		}
	};
}

export async function controlMusic(command: "toggle" | "seek" | "volume" | "mute", value = 0): Promise<void> {
	if (!active) throw new Error("ファイルビューアで音楽を開いてください。");
	if (command === "toggle") {
		if (active.paused) await active.play();
		else active.pause();
	} else if (command === "mute") active.muted = !active.muted;
	else if (command === "volume" && Number.isFinite(value)) {
		active.volume = Math.max(0, Math.min(1, value));
		active.muted = false;
	} else if (command === "seek" && Number.isFinite(value) && Number.isFinite(active.duration))
		active.currentTime = Math.max(0, Math.min(active.duration, value));
}
