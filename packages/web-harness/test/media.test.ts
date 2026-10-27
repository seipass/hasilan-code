import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpHost } from "../src/server/http-host.ts";
import { mediaView, serveMedia } from "../src/server/media.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function mp3(tags = Buffer.alloc(0)) {
	const frames = Buffer.alloc(417 * 4);
	for (let offset = 0; offset < frames.length; offset += 417) frames.set([0xff, 0xfb, 0x90, 0], offset);
	return Buffer.concat([tags, frames]);
}

function id3(frames: { id: string; data: Buffer }[], version = 3) {
	const body = Buffer.concat(
		frames.map(({ id, data }) => {
			const header = Buffer.alloc(10);
			header.write(id);
			if (version === 4) {
				for (let index = 0; index < 4; index++) header[4 + index] = (data.length >>> (7 * (3 - index))) & 127;
			} else header.writeUInt32BE(data.length, 4);
			return Buffer.concat([header, data]);
		}),
	);
	const header = Buffer.from([73, 68, 51, version, 0, 0, 0, 0, 0, 0]);
	for (let index = 0; index < 4; index++) header[6 + index] = (body.length >>> (7 * (3 - index))) & 127;
	return Buffer.concat([header, body]);
}

async function fixture(name = "clip.mp4", content?: Buffer) {
	const root = await mkdtemp(join(tmpdir(), "hasilan-media-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const bytes = content ?? (name.toLowerCase().endsWith(".mp3") ? mp3() : Buffer.alloc(512));
	if (!content && name.endsWith(".mp4")) {
		bytes.write("ftyp", 4);
		bytes.write("isom", 8);
		for (let i = 16; i < bytes.length; i++) bytes[i] = i % 251;
	}
	await writeFile(join(root, name), bytes);
	const files = new WorkspaceFiles();
	const workspace = await files.register(root);
	const view = (await mediaView(files, workspace.id, name))!;
	const host = createHttpHost({
		port: 0,
		handleApi: (request, response, url) =>
			serveMedia(
				files,
				workspace.id,
				url.searchParams.get("path") ?? name,
				url.searchParams.get("revision"),
				request,
				response,
			),
	});
	const launch = await host.listen();
	cleanups.push(() => host.close());
	const auth = await fetch(launch.launchUrl, { redirect: "manual" });
	const cookie = auth.headers.get("set-cookie")!.split(";")[0];
	const url = `${launch.origin}/api/media?revision=${encodeURIComponent(view.revision)}`;
	return { root, bytes, files, workspace, view, url, cookie };
}

describe("workspace media streaming", () => {
	it.each([
		["sample.wav", "audio/wav"],
		["sample.flac", "audio/flac"],
		["sample.m4a", "audio/mp4"],
		["sample-alac.m4a", "audio/mp4"],
		["sample.aac", "audio/aac"],
		["sample.ogg", "audio/ogg"],
		["sample.opus", "audio/ogg"],
		["sample.weba", "audio/webm"],
		["sample.aiff", "audio/aiff"],
	])("recognizes and streams real audio fixture %s with its own MIME type", async (name, mime) => {
		const bytes = await readFile(new URL(`./fixtures/audio-formats/${name}`, import.meta.url));
		const f = await fixture(name, bytes);
		expect(f.view).toMatchObject({ kind: "audio", mime, size: bytes.length });
		if (name !== "sample.aac") expect(f.view.audio).toMatchObject({ title: "Audio fixture", artist: "Hasilan Code" });
		const range = await fetch(f.url, { headers: { cookie: f.cookie, range: "bytes=8-31" } });
		expect(range.status).toBe(206);
		expect(range.headers.get("content-type")).toBe(mime);
		expect(range.headers.get("content-range")).toBe(`bytes 8-31/${bytes.length}`);
		expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(8, 32));
		const head = await fetch(f.url, { method: "HEAD", headers: { cookie: f.cookie } });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe(String(bytes.length));
		expect(await head.text()).toBe("");
	});
	it.each([
		["TRACK.WAVE", "sample.wav", "audio/wav"],
		["track.m4b", "sample.m4a", "audio/mp4"],
		["track.m4r", "sample.m4a", "audio/mp4"],
		["track.adts", "sample.aac", "audio/aac"],
		["track.oga", "sample.ogg", "audio/ogg"],
		["track.aif", "sample.aiff", "audio/aiff"],
		["track.aifc", "sample.aiff", "audio/aiff"],
	])("supports audio extension alias %s", async (name, source, mime) => {
		const bytes = await readFile(new URL(`./fixtures/audio-formats/${source}`, import.meta.url));
		const f = await fixture(name, bytes);
		expect(f.view).toMatchObject({ kind: "audio", mime });
	});
	it("rejects renamed HTML and mismatched audio container signatures", async () => {
		const f = await fixture();
		for (const extension of [
			"wav",
			"wave",
			"flac",
			"m4a",
			"m4b",
			"m4r",
			"aac",
			"adts",
			"ogg",
			"oga",
			"opus",
			"weba",
			"aif",
			"aiff",
			"aifc",
		]) {
			const name = `fake.${extension}`;
			await writeFile(join(f.root, name), "<html>not audio</html>");
			expect(await mediaView(f.files, f.workspace.id, name)).toBeUndefined();
		}
		const wav = await readFile(new URL("./fixtures/audio-formats/sample.wav", import.meta.url));
		await writeFile(join(f.root, "mismatch.flac"), wav);
		expect(await mediaView(f.files, f.workspace.id, "mismatch.flac")).toBeUndefined();
	});
	it.each([
		["bytes=16-31", 16, 31],
		["bytes=500-", 500, 511],
		["bytes=-12", 500, 511],
		["bytes=500-999", 500, 511],
	] as const)("serves seek range %s with exact content boundaries", async (range, start, end) => {
		const f = await fixture();
		const response = await fetch(f.url, { headers: { cookie: f.cookie, range } });
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/512`);
		expect(response.headers.get("content-type")).toBe("video/mp4");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes.subarray(start, end + 1));
	});
	it.each(["bytes=512-", "bytes=31-16", "bytes=-0", "bytes=0-1,8-9", "bytes=-", "invalid"])(
		"rejects unsatisfiable range %s",
		async (range) => {
			const f = await fixture();
			const response = await fetch(f.url, { headers: { cookie: f.cookie, range } });
			expect(response.status).toBe(416);
			expect(response.headers.get("content-range")).toBe("bytes */512");
			expect(await response.text()).toBe("");
		},
	);
	it("supports full content and HEAD while rejecting stale revisions and unauthenticated access", async () => {
		const f = await fixture();
		const full = await fetch(f.url, { headers: { cookie: f.cookie } });
		expect(full.status).toBe(200);
		expect(full.headers.get("accept-ranges")).toBe("bytes");
		expect(Buffer.from(await full.arrayBuffer())).toEqual(f.bytes);
		const head = await fetch(f.url, { method: "HEAD", headers: { cookie: f.cookie } });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("512");
		expect(await head.text()).toBe("");
		expect((await fetch(f.url)).status).toBe(401);
		await writeFile(join(f.root, "clip.mp4"), Buffer.concat([f.bytes, Buffer.from("changed")]));
		expect((await fetch(f.url, { headers: { cookie: f.cookie } })).status).toBe(409);
	});
	it("does not classify renamed HTML as video and preserves workspace path confinement", async () => {
		const f = await fixture();
		await writeFile(join(f.root, "fake.mp4"), "<html>not a video</html>");
		expect(await mediaView(f.files, f.workspace.id, "fake.mp4")).toBeUndefined();
		await expect(mediaView(f.files, f.workspace.id, "../outside.mp4")).rejects.toThrow("Path escapes workspace");
	});
	it("serves untagged MP3 playback, seeking and HEAD through the authenticated revision-checked stream", async () => {
		const f = await fixture("TRACK.MP3");
		expect(f.view).toMatchObject({ kind: "audio", mime: "audio/mpeg", audio: {} });
		const full = await fetch(f.url, { headers: { cookie: f.cookie } });
		expect(full.status).toBe(200);
		expect(full.headers.get("content-type")).toBe("audio/mpeg");
		expect(full.headers.get("accept-ranges")).toBe("bytes");
		expect(Buffer.from(await full.arrayBuffer())).toEqual(f.bytes);
		for (const range of ["bytes=400-900", "bytes=-128"]) {
			const response = await fetch(f.url, { headers: { cookie: f.cookie, range } });
			expect(response.status).toBe(206);
			expect(Buffer.from(await response.arrayBuffer())).toEqual(
				range.startsWith("bytes=-") ? f.bytes.subarray(-128) : f.bytes.subarray(400, 901),
			);
		}
		const head = await fetch(f.url, { method: "HEAD", headers: { cookie: f.cookie } });
		expect(head.headers.get("content-length")).toBe(String(f.bytes.length));
		expect(await head.text()).toBe("");
		expect((await fetch(f.url)).status).toBe(401);
		await writeFile(join(f.root, "TRACK.MP3"), Buffer.concat([f.bytes, Buffer.from("changed")]));
		expect((await fetch(f.url, { headers: { cookie: f.cookie } })).status).toBe(409);
	});
	it.each([3, 4])("reads Japanese ID3v2.%i title, artist and embedded cover", async (version) => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FEAAAAASUVORK5CYII=",
			"base64",
		);
		const text = (value: string) =>
			version === 3
				? Buffer.concat([Buffer.from([1, 255, 254]), Buffer.from(value, "utf16le")])
				: Buffer.concat([Buffer.from([3]), Buffer.from(value)]);
		const tags = id3(
			[
				{ id: "TIT2", data: text("夜の音") },
				{ id: "TPE1", data: text("テスト作者") },
				{ id: "APIC", data: Buffer.concat([Buffer.from("\0image/png\0\x03\0", "latin1"), png]) },
			],
			version,
		);
		const f = await fixture("tagged.mp3", mp3(tags));
		expect(f.view.audio).toEqual({
			title: "夜の音",
			artist: "テスト作者",
			cover: `data:image/png;base64,${png.toString("base64")}`,
		});
	});
	it("reads ID3v1 metadata from the end of a track", async () => {
		const tag = Buffer.alloc(128);
		tag.write("TAG");
		tag.write("Night track", 3);
		tag.write("Artist", 33);
		const f = await fixture("legacy.mp3", Buffer.concat([mp3(), tag]));
		expect(f.view.audio).toMatchObject({ title: "Night track", artist: "Artist" });
	});
	it("ignores active artwork and oversized tag allocations without blocking playback", async () => {
		const tags = id3([{ id: "APIC", data: Buffer.from('\0image/svg+xml\0\x03\0<svg onload="bad()"></svg>') }]);
		const f = await fixture("artwork.mp3", mp3(tags));
		expect(f.view.kind).toBe("audio");
		expect(f.view.audio?.cover).toBeUndefined();
		await writeFile(join(f.root, "oversized.mp3"), mp3(Buffer.from([73, 68, 51, 4, 0, 0, 127, 127, 127, 127])));
		expect(await mediaView(f.files, f.workspace.id, "oversized.mp3")).toMatchObject({ kind: "audio", audio: {} });
	});
	it("does not treat renamed text or reserved MPEG header bits as MP3", async () => {
		const f = await fixture();
		for (const [name, content] of [
			["fake.mp3", Buffer.from("<html>not audio</html>")],
			["reserved.mp3", Buffer.from([255, 235, 144, 0])],
			["layer2.mp3", Buffer.from([255, 253, 144, 0])],
		] as const) {
			await writeFile(join(f.root, name), content);
			expect(await mediaView(f.files, f.workspace.id, name)).toBeUndefined();
		}
		await expect(mediaView(f.files, f.workspace.id, "../outside.mp3")).rejects.toThrow("Path escapes workspace");
	});
});
