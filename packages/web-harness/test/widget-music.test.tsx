import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { controlMusic, registerMusic, useMusic } from "../src/client/widgets/music.ts";

class AudioFixture extends EventTarget {
	paused = true;
	ended = false;
	duration = 120;
	error = null;
	currentTime = 0;
	private level = 1;
	private silent = false;
	get volume() { return this.level; }
	set volume(value: number) { this.level = value; this.dispatchEvent(new Event("volumechange")); }
	get muted() { return this.silent; }
	set muted(value: boolean) { this.silent = value; this.dispatchEvent(new Event("volumechange")); }
	async play() { this.paused = false; this.dispatchEvent(new Event("play")); }
	pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
}

function Probe() { return createElement("output", null, JSON.stringify(useMusic())); }
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

it("controls the actual player and publishes its volume and playback events to React", async () => {
	const audio = new AudioFixture();
	cleanup.push(registerMusic(audio as unknown as HTMLAudioElement, "Track", "Artist"));
	await controlMusic("toggle");
	expect(audio.paused).toBe(false);
	expect(renderToStaticMarkup(createElement(Probe))).toContain("&quot;playing&quot;:true");
	await controlMusic("volume", 0.35);
	expect(audio.volume).toBe(0.35);
	expect(renderToStaticMarkup(createElement(Probe))).toContain("&quot;volume&quot;:0.35");
	await controlMusic("mute");
	expect(audio.muted).toBe(true);
	await controlMusic("volume", 2);
	expect(audio.volume).toBe(1);
	expect(audio.muted).toBe(false);
	await controlMusic("seek", 500);
	expect(audio.currentTime).toBe(120);
	await controlMusic("toggle");
	expect(audio.paused).toBe(true);
});

it("selects the latest played track and does not clear it when another viewer unmounts", async () => {
	const first = new AudioFixture();
	const second = new AudioFixture();
	const closeFirst = registerMusic(first as unknown as HTMLAudioElement, "First", "");
	cleanup.push(closeFirst, registerMusic(second as unknown as HTMLAudioElement, "Second", ""));
	await second.play();
	closeFirst();
	expect(renderToStaticMarkup(createElement(Probe))).toContain("Second");
	await controlMusic("toggle");
	expect(second.paused).toBe(true);
});

it("clears stale controls when the selected file is closed", async () => {
	const audio = new AudioFixture();
	const close = registerMusic(audio as unknown as HTMLAudioElement, "Track", "");
	close();
	expect(renderToStaticMarkup(createElement(Probe))).toBe("<output>null</output>");
	await expect(controlMusic("toggle")).rejects.toThrow("音楽を開いてください");
});
