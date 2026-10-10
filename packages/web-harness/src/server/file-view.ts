import { TextDecoder } from "node:util";
import { type FileSnapshot, imageMime } from "./workspace-files.ts";

export function fileView(snapshot: FileSnapshot, offset = 1, limit = 200) {
	if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
		throw new Error("Invalid file offset or limit");
	const { path, revision, bytes } = snapshot;
	const base = { path, revision, size: bytes.length };
	const mime = imageMime(bytes);
	if (mime && mime !== "image/bmp" && bytes.length <= 10 * 1024 * 1024)
		return { ...base, kind: "image" as const, mime };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { ...base, kind: "binary" as const };
	}
	if (text.includes("\0")) return { ...base, kind: "binary" as const };
	const all = text.length === 0 ? [] : text.replace(/\r\n/g, "\n").split("\n");
	if (all.length && all[all.length - 1] === "" && text.endsWith("\n")) all.pop();
	const lines: { number: number; text: string; truncated?: boolean }[] = [];
	let size = 0;
	let index = offset - 1;
	for (; index < all.length && lines.length < limit; index++) {
		const line = all[index];
		const length = Buffer.byteLength(line, "utf8");
		if (size + length > 64 * 1024) {
			if (lines.length === 0) {
				const encoded = Buffer.from(line, "utf8");
				let end = 64 * 1024;
				while ((encoded[end] & 0xc0) === 0x80) end--;
				lines.push({ number: index + 1, text: encoded.toString("utf8", 0, end), truncated: true });
				index++;
			}
			break;
		}
		lines.push({ number: index + 1, text: line });
		size += length;
	}
	return { ...base, kind: "text" as const, lines, ...(index < all.length ? { nextOffset: index + 1 } : {}) };
}
