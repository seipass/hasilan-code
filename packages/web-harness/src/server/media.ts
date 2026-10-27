import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseFromTokenizer, selectCover } from "music-metadata";
import { FileTokenizer } from "strtok3";
import type { AudioMetadata } from "../shared/media.ts";
import { HttpError } from "./http-host.ts";
import { imageMime, type WorkspaceFiles } from "./workspace-files.ts";

const AUDIO_MIMES = new Map([
	[".mp3", "audio/mpeg"],
	[".wav", "audio/wav"],
	[".wave", "audio/wav"],
	[".flac", "audio/flac"],
	[".m4a", "audio/mp4"],
	[".m4b", "audio/mp4"],
	[".m4r", "audio/mp4"],
	[".aac", "audio/aac"],
	[".adts", "audio/aac"],
	[".ogg", "audio/ogg"],
	[".oga", "audio/ogg"],
	[".opus", "audio/ogg"],
	[".weba", "audio/webm"],
	[".aif", "audio/aiff"],
	[".aiff", "audio/aiff"],
	[".aifc", "audio/aiff"],
]);

// Reuse the validated handle so metadata can seek to end tags without reopening a path or reading the whole track.
class MediaTokenizer extends FileTokenizer {
	constructor(handle: FileHandle, size: number, mimeType: string) {
		super(handle, { fileInfo: { size, mimeType }, maxBufferSize: 8 * 1024 * 1024 });
	}
}

async function openMedia(files: WorkspaceFiles, workspaceId: string, path: string) {
	const extension = extname(path).toLowerCase();
	const audioMime = AUDIO_MIMES.get(extension);
	if (!audioMime && ![".mp4", ".m4v", ".mov", ".webm", ".ogv"].includes(extension)) return undefined;
	const opened = await files.openRead(workspaceId, path);
	try {
		const info = await opened.handle.stat({ bigint: true });
		const header = Buffer.alloc(4096);
		const { bytesRead } = await opened.handle.read(header, 0, header.length, 0);
		const bytes = header.subarray(0, bytesRead);
		let mime: string | undefined;
		if (
			([".mp4", ".m4v", ".mov"].includes(extension) || audioMime === "audio/mp4") &&
			bytes.length >= 12 &&
			bytes.toString("ascii", 4, 8) === "ftyp"
		)
			mime = audioMime ?? (extension === ".mov" ? "video/quicktime" : "video/mp4");
		else if (
			(extension === ".webm" || audioMime === "audio/webm") &&
			bytes.length >= 4 &&
			bytes.readUInt32BE(0) === 0x1a45dfa3 &&
			bytes.includes(Buffer.from("webm"))
		)
			mime = audioMime ?? "video/webm";
		else if ((extension === ".ogv" || audioMime === "audio/ogg") && bytes.toString("ascii", 0, 4) === "OggS")
			mime = audioMime ?? "video/ogg";
		else if (audioMime === "audio/flac" && bytes.toString("ascii", 0, 4) === "fLaC") mime = audioMime;
		else if (
			audioMime === "audio/wav" &&
			bytes.length >= 12 &&
			["RIFF", "RF64", "RIFX"].includes(bytes.toString("ascii", 0, 4)) &&
			bytes.toString("ascii", 8, 12) === "WAVE"
		)
			mime = audioMime;
		else if (
			audioMime === "audio/aiff" &&
			bytes.length >= 12 &&
			bytes.toString("ascii", 0, 4) === "FORM" &&
			["AIFF", "AIFC"].includes(bytes.toString("ascii", 8, 12))
		)
			mime = audioMime;
		else if (
			audioMime === "audio/aac" &&
			bytes.length >= 7 &&
			bytes[0] === 255 &&
			(bytes[1] & 0xf6) === 0xf0 &&
			(bytes[2] & 0x3c) !== 0x3c
		)
			mime = audioMime;
		else if (
			extension === ".mp3" &&
			((bytes.length >= 10 &&
				bytes.toString("ascii", 0, 3) === "ID3" &&
				bytes[3] >= 2 &&
				bytes[3] <= 4 &&
				bytes[4] !== 255 &&
				bytes.subarray(6, 10).every((value) => value < 128)) ||
				(bytes.length >= 4 &&
					bytes[0] === 255 &&
					(bytes[1] & 0xe0) === 0xe0 &&
					(bytes[1] & 0x18) !== 0x08 &&
					(bytes[1] & 0x06) === 0x02 &&
					(bytes[2] & 0xf0) !== 0xf0 &&
					(bytes[2] & 0x0c) !== 0x0c))
		)
			mime = "audio/mpeg";
		if (!mime) {
			await opened.handle.close();
			return undefined;
		}
		return {
			...opened,
			kind: mime.startsWith("audio/") ? ("audio" as const) : ("video" as const),
			mime,
			size: Number(info.size),
			revision: `${info.dev}-${info.ino}-${info.size}-${info.mtimeNs}-${info.ctimeNs}`,
		};
	} catch (error) {
		await opened.handle.close();
		throw error;
	}
}

export async function mediaView(files: WorkspaceFiles, workspaceId: string, path: string) {
	const media = await openMedia(files, workspaceId, path);
	if (!media) return undefined;
	try {
		const audio: AudioMetadata = {};
		if (media.kind === "audio") {
			try {
				const metadata = await parseFromTokenizer(new MediaTokenizer(media.handle, media.size, media.mime), {
					duration: false,
					maxMemoryAllocation: 8 * 1024 * 1024,
				});
				audio.title = metadata.common.title?.trim().slice(0, 1024) || undefined;
				audio.artist = (metadata.common.artist ?? metadata.common.albumartist)?.trim().slice(0, 1024) || undefined;
				const cover = selectCover(metadata.common.picture);
				if (cover && cover.data.length <= 2 * 1024 * 1024) {
					const bytes = Buffer.from(cover.data);
					const mime = imageMime(bytes);
					if (mime && mime !== "image/bmp") audio.cover = `data:${mime};base64,${bytes.toString("base64")}`;
				}
			} catch {
				// Missing or damaged tags must not prevent playback of the audio stream.
			}
		}
		return {
			path: media.path,
			revision: media.revision,
			size: media.size,
			kind: media.kind,
			mime: media.mime,
			...(media.kind === "audio" ? { audio } : {}),
		};
	} finally {
		await media.handle.close();
	}
}

/** Serve single byte ranges so media controls can seek without loading the entire file. */
export async function serveMedia(
	files: WorkspaceFiles,
	workspaceId: string,
	path: string,
	revision: string | null,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<boolean> {
	const media = await openMedia(files, workspaceId, path);
	if (!media) return false;
	try {
		if (media.revision !== revision) throw new HttpError(409, "File revision changed; refresh the viewer");
		let start = 0;
		let end = media.size - 1;
		const range = request.headers.range;
		if (range !== undefined) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (match && (match[1] || match[2])) {
				if (match[1]) {
					start = Number(match[1]);
					if (match[2]) end = Math.min(end, Number(match[2]));
				} else start = Math.max(0, media.size - Number(match[2]));
			} else start = NaN;
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				start > end ||
				start >= media.size
			) {
				response.writeHead(416, {
					"Content-Range": `bytes */${media.size}`,
					"Content-Length": 0,
					"Cache-Control": "private, no-store",
				});
				response.end();
				return true;
			}
		}
		response.writeHead(range === undefined ? 200 : 206, {
			"Content-Type": media.mime,
			"Content-Length": end - start + 1,
			"Accept-Ranges": "bytes",
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			...(range === undefined ? {} : { "Content-Range": `bytes ${start}-${end}/${media.size}` }),
		});
		if (request.method === "HEAD") response.end();
		else {
			try {
				await pipeline(media.handle.createReadStream({ start, end, autoClose: false }), response);
			} catch (error) {
				if (!response.destroyed) throw error;
			}
		}
		return true;
	} finally {
		await media.handle.close();
	}
}
