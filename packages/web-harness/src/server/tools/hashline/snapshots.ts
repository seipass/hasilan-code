import xxhash from "xxhashjs";
import type { FileSnapshot } from "../../workspace-files.ts";

export interface HashlineSnapshot extends FileSnapshot {
	text: string;
	lines: string[];
	tag: string;
	bom: boolean;
	eol: "\n" | "\r\n" | "\r";
	mixedEol: boolean;
	trailingNewline: boolean;
	seenLines: Set<number>;
}
export function snapshotOf(file: FileSnapshot): HashlineSnapshot {
	const bom = file.bytes.length >= 3 && file.bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bom ? file.bytes.subarray(3) : file.bytes,
		);
	} catch {
		throw new Error("Binary or non-UTF-8 file is not supported by Hashline");
	}
	if (raw.includes("\0")) throw new Error("Binary or non-UTF-8 file is not supported by Hashline");
	const endings = new Set(raw.match(/\r\n|\r|\n/g) ?? []);
	const eol = (raw.match(/\r\n|\r|\n/)?.[0] ?? "\n") as HashlineSnapshot["eol"];
	const text = raw.replace(/\r\n|\r/g, "\n");
	const trailingNewline = text.endsWith("\n");
	const lines = text === "" ? [] : text.split("\n");
	if (trailingNewline) lines.pop();
	const hashText = text.replace(/[ \t\r]+(?=\n|$)/g, "");
	const tag = (xxhash.h32(Buffer.from(hashText, "utf8"), 0).toNumber() & 0xffff)
		.toString(16)
		.toUpperCase()
		.padStart(4, "0");
	return { ...file, text, lines, tag, bom, eol, mixedEol: endings.size > 1, trailingNewline, seenLines: new Set() };
}
export function encodeLines(snapshot: HashlineSnapshot, lines: string[]): Buffer {
	const text = lines.join(snapshot.eol) + (snapshot.trailingNewline && lines.length ? snapshot.eol : "");
	return Buffer.from((snapshot.bom ? "\uFEFF" : "") + text, "utf8");
}

/** This store belongs to an agent session, never to the viewer or workspace. */
export class SnapshotStore {
	private readonly snapshots = new Map<string, HashlineSnapshot>();
	get(path: string): HashlineSnapshot | undefined {
		return this.snapshots.get(path);
	}
	observe(file: FileSnapshot): HashlineSnapshot {
		const existing = this.snapshots.get(file.path);
		if (existing?.revision === file.revision && existing.bytes.equals(file.bytes)) return existing;
		const snapshot = snapshotOf(file);
		this.snapshots.set(file.path, snapshot);
		return snapshot;
	}
	invalidate(path: string): void {
		this.snapshots.delete(path);
	}
}
