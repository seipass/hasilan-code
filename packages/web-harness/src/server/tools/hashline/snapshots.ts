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

/** Bounded agent-session history; viewer reads never enter this store. */
export class SnapshotStore {
	private readonly snapshots = new Map<string, HashlineSnapshot[]>();
	private readonly retained: HashlineSnapshot[] = [];
	private retainedBytes = 0;
	get(path: string): HashlineSnapshot | undefined {
		return this.snapshots.get(path)?.at(-1);
	}
	resolve(path: string, tag: string): HashlineSnapshot {
		const history = this.snapshots.get(path);
		if (!history) throw new Error("Unread file; read the file before editing");
		const matches = history.filter((snapshot) => snapshot.tag === tag);
		if (!matches.length) throw new Error("Stale snapshot: unknown or expired tag; read the file again");
		if (matches.length !== 1) throw new Error("Stale snapshot: colliding tag; read the file again");
		return matches[0];
	}
	observe(file: FileSnapshot): HashlineSnapshot {
		const history = this.snapshots.get(file.path) ?? [];
		const existing = history.find(
			(snapshot) => snapshot.revision === file.revision && snapshot.bytes.equals(file.bytes),
		);
		const snapshot = existing ?? snapshotOf(file);
		if (existing) {
			history.splice(history.indexOf(existing), 1);
			this.retained.splice(this.retained.indexOf(existing), 1);
			this.retainedBytes -= existing.bytes.length;
		}
		history.push(snapshot);
		this.snapshots.set(file.path, history);
		this.retained.push(snapshot);
		this.retainedBytes += snapshot.bytes.length;
		// Count bounds include current snapshots, so reading new paths cannot grow the store indefinitely.
		if (history.length > 8) this.evict(history[0]);
		// Keep one oversized current snapshot usable, but never amplify it with retained history.
		while (this.retained.length > 1 && (this.retained.length > 64 || this.retainedBytes > 32 * 1024 * 1024))
			this.evict(this.retained[0]);
		return snapshot;
	}
	private evict(snapshot: HashlineSnapshot): void {
		const history = this.snapshots.get(snapshot.path)!;
		history.splice(history.indexOf(snapshot), 1);
		if (!history.length) this.snapshots.delete(snapshot.path);
		this.retained.splice(this.retained.indexOf(snapshot), 1);
		this.retainedBytes -= snapshot.bytes.length;
	}
	invalidate(path: string): void {
		for (const snapshot of [...(this.snapshots.get(path) ?? [])]) this.evict(snapshot);
	}
}
