import { useSyncExternalStore } from "react";
import { Check } from "typebox/value";
import { type MusicPreferences, musicPreferencesSchema } from "../../shared/ui-preferences.ts";
import { preferences } from "../preferences.ts";

export function readMusicPreferences(): MusicPreferences {
	try {
		const stored: unknown = JSON.parse(preferences.getItem("pi-web-music") ?? "null");
		if (Check(musicPreferencesSchema, stored)) return stored;
	} catch {
		/* New profiles use the native media defaults. */
	}
	return { volume: 1, muted: false, positions: {} };
}

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
	const url = new URL(element.getAttribute("src") ?? "", window.location.href);
	const track = `${url.pathname}?path=${url.searchParams.get("path") ?? ""}`;
	let lastSaved = -1;
	const restoreVolume = () => {
		const saved = readMusicPreferences();
		element.volume = saved.volume;
		element.muted = saved.muted;
	};
	const restorePosition = () => {
		const position = readMusicPreferences().positions[track];
		if (position !== undefined && Number.isFinite(element.duration))
			element.currentTime = Math.min(position, Math.max(0, element.duration - 0.1));
	};
	restoreVolume();
	if (element.readyState >= 1) restorePosition();
	element.addEventListener("loadedmetadata", restorePosition);
	const unsubscribe = preferences.subscribe("pi-web-music", restoreVolume);
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
		const saved = readMusicPreferences();
		const position = Math.floor(element.currentTime);
		if (
			saved.volume !== element.volume ||
			saved.muted !== element.muted ||
			(element.readyState >= 1 &&
				(Math.abs(position - lastSaved) >= 2 || (element.paused && position !== lastSaved)))
		) {
			const positions = { ...saved.positions, ...(element.readyState >= 1 ? { [track]: element.currentTime } : {}) };
			preferences.setItem(
				"pi-web-music",
				JSON.stringify({
					volume: element.volume,
					muted: element.muted,
					positions: Object.fromEntries(Object.entries(positions).slice(-100)),
				}),
			);
			lastSaved = position;
		}
	};
	const select = () => {
		active = element;
		update();
	};
	if (!active) select();
	for (const event of events) element.addEventListener(event, update);
	element.addEventListener("play", select);
	return () => {
		update();
		unsubscribe();
		element.removeEventListener("loadedmetadata", restorePosition);
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
