import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError } from "./http-host.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";

async function openVideo(files: WorkspaceFiles, workspaceId: string, path: string) {
	const extension = extname(path).toLowerCase();
	if (![".mp4", ".m4v", ".mov", ".webm", ".ogv"].includes(extension)) return undefined;
	const opened = await files.openRead(workspaceId, path);
	try {
		const info = await opened.handle.stat({ bigint: true });
		const header = Buffer.alloc(4096);
		const { bytesRead } = await opened.handle.read(header, 0, header.length, 0);
		const bytes = header.subarray(0, bytesRead);
		let mime: string | undefined;
		if (
			[".mp4", ".m4v", ".mov"].includes(extension) &&
			bytes.length >= 12 &&
			bytes.toString("ascii", 4, 8) === "ftyp"
		)
			mime = extension === ".mov" ? "video/quicktime" : "video/mp4";
		else if (
			extension === ".webm" &&
			bytes.length >= 4 &&
			bytes.readUInt32BE(0) === 0x1a45dfa3 &&
			bytes.includes(Buffer.from("webm"))
		)
			mime = "video/webm";
		else if (extension === ".ogv" && bytes.toString("ascii", 0, 4) === "OggS") mime = "video/ogg";
		if (!mime) {
			await opened.handle.close();
			return undefined;
		}
		return {
			...opened,
			mime,
			size: Number(info.size),
			revision: `${info.dev}-${info.ino}-${info.size}-${info.mtimeNs}-${info.ctimeNs}`,
		};
	} catch (error) {
		await opened.handle.close();
		throw error;
	}
}

export async function videoView(files: WorkspaceFiles, workspaceId: string, path: string) {
	const video = await openVideo(files, workspaceId, path);
	if (!video) return undefined;
	await video.handle.close();
	return { path: video.path, revision: video.revision, size: video.size, kind: "video" as const, mime: video.mime };
}

/** Serve single byte ranges so native video controls can seek without loading the entire file. */
export async function serveVideo(
	files: WorkspaceFiles,
	workspaceId: string,
	path: string,
	revision: string | null,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<boolean> {
	const video = await openVideo(files, workspaceId, path);
	if (!video) return false;
	try {
		if (video.revision !== revision) throw new HttpError(409, "File revision changed; refresh the viewer");
		let start = 0;
		let end = video.size - 1;
		const range = request.headers.range;
		if (range !== undefined) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (match && (match[1] || match[2])) {
				if (match[1]) {
					start = Number(match[1]);
					if (match[2]) end = Math.min(end, Number(match[2]));
				} else start = Math.max(0, video.size - Number(match[2]));
			} else start = NaN;
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				start > end ||
				start >= video.size
			) {
				response.writeHead(416, {
					"Content-Range": `bytes */${video.size}`,
					"Content-Length": 0,
					"Cache-Control": "private, no-store",
				});
				response.end();
				return true;
			}
		}
		response.writeHead(range === undefined ? 200 : 206, {
			"Content-Type": video.mime,
			"Content-Length": end - start + 1,
			"Accept-Ranges": "bytes",
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			...(range === undefined ? {} : { "Content-Range": `bytes ${start}-${end}/${video.size}` }),
		});
		if (request.method === "HEAD") response.end();
		else {
			try {
				await pipeline(video.handle.createReadStream({ start, end, autoClose: false }), response);
			} catch (error) {
				if (!response.destroyed) throw error;
			}
		}
		return true;
	} finally {
		await video.handle.close();
	}
}
