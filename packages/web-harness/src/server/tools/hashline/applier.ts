import type { FileChange } from "../../workspace-files.ts";
import { type LineRange, resolveBlock } from "./blocks.ts";
import type { Locator, PatchFile } from "./parser.ts";
import { encodeLines, type HashlineSnapshot } from "./snapshots.ts";

export interface PreparedPatch {
	change: FileChange;
	lines: string[];
	snapshot: HashlineSnapshot;
}
function requireSeen(snapshot: HashlineSnapshot, start: number, end: number): void {
	if (start < 1 || end > snapshot.lines.length || end < start) throw new Error("Line range is outside snapshot");
	for (let line = start; line <= end; line++)
		if (!snapshot.seenLines.has(line)) throw new Error(`Unread line ${line}; read the file again`);
}
function rangeOf(snapshot: HashlineSnapshot, locator: Locator): LineRange {
	if (locator.kind === "range") return { start: locator.start, end: locator.end };
	if (locator.kind === "block") return resolveBlock(snapshot.path, snapshot.lines, locator.line);
	throw new Error("Expected destructive range or block");
}
/** Resolve all operations against original line positions, without touching the filesystem. */
export function preparePatch(
	file: PatchFile,
	snapshot: HashlineSnapshot,
	registers: Map<string, string[]>,
): PreparedPatch {
	if (file.tag !== snapshot.tag) throw new Error("Stale snapshot; read the file again");
	if (snapshot.mixedEol) throw new Error("Mixed line endings; normalize the file before editing");
	const removals: LineRange[] = [];
	const insertions = new Map<number, { lines: string[]; destructive: boolean }[]>();
	let operation: FileChange["operation"] = "update";
	let moveDest: string | undefined;
	const add = (slot: number, lines: string[], destructive: boolean): void => {
		const at = insertions.get(slot) ?? [];
		at.push({ lines, destructive });
		insertions.set(slot, at);
	};
	for (const hunk of file.operations) {
		if (hunk.kind === "remove") {
			if (file.operations.length !== 1) throw new Error("REM cannot overlap other operations");
			if (snapshot.lines.length) requireSeen(snapshot, 1, snapshot.lines.length);
			operation = "delete";
			continue;
		}
		if (hunk.kind === "move") {
			if (moveDest) throw new Error("Multiple move operations");
			if (snapshot.lines.length) requireSeen(snapshot, 1, snapshot.lines.length);
			operation = "move";
			moveDest = hunk.destination;
			continue;
		}
		const target = hunk.locator;
		if (hunk.kind === "cut" || target.kind === "range" || target.kind === "block") {
			const range = rangeOf(snapshot, target);
			requireSeen(snapshot, range.start, range.end);
			if (removals.some((entry) => range.start <= entry.end && entry.start <= range.end))
				throw new Error("Overlapping destructive hunks");
			removals.push(range);
			if (hunk.kind === "cut") registers.set(hunk.register, snapshot.lines.slice(range.start - 1, range.end));
			else {
				const body = hunk.body ?? registers.get(hunk.register!);
				if (!body) throw new Error(`Undefined register: ${hunk.register}`);
				add(range.start - 1, body, true);
			}
			continue;
		}
		const body = hunk.body ?? registers.get(hunk.register!);
		if (!body) throw new Error(`Undefined register: ${hunk.register}`);
		let slot: number;
		if (target.kind === "tail") {
			slot = snapshot.lines.length;
			if (slot) requireSeen(snapshot, slot, slot);
		} else if (target.kind === "gap") {
			let anchor = target.line;
			if (target.block) {
				const block = resolveBlock(snapshot.path, snapshot.lines, target.line);
				requireSeen(snapshot, block.start, block.end);
				anchor = block.end;
			} else requireSeen(snapshot, anchor, anchor);
			slot = target.side === "before" ? anchor - 1 : anchor;
		} else throw new Error("Invalid insertion locator");
		add(slot, body, false);
	}
	for (const [slot, additions] of insertions) {
		if (
			additions.some((entry) => !entry.destructive) &&
			removals.some((entry) => slot > entry.start - 1 && slot < entry.end)
		)
			throw new Error("Insertion overlaps a destructive hunk");
	}
	const removed = new Set<number>();
	for (const range of removals) for (let line = range.start; line <= range.end; line++) removed.add(line);
	const lines: string[] = [];
	for (let slot = 0; slot <= snapshot.lines.length; slot++) {
		for (const addition of insertions.get(slot) ?? []) lines.push(...addition.lines);
		if (slot < snapshot.lines.length && !removed.has(slot + 1)) lines.push(snapshot.lines[slot]);
	}
	return {
		snapshot,
		lines,
		change: {
			path: snapshot.path,
			beforeBytes: snapshot.bytes,
			afterBytes: encodeLines(snapshot, lines),
			expectedRevision: snapshot.revision,
			operation,
			moveDest,
		},
	};
}

export function patchDiff(path: string, before: string[], after: string[]): string {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - suffix - 1] === after[after.length - suffix - 1]
	)
		suffix++;
	const oldEnd = before.length - suffix;
	const newEnd = after.length - suffix;
	const output = [
		`--- ${path}`,
		`+++ ${path}`,
		`@@ -${prefix + 1},${oldEnd - prefix} +${prefix + 1},${newEnd - prefix} @@`,
	];
	let bytes = Buffer.byteLength(output.join("\n"));
	for (const [marker, lines, end] of [
		["-", before, oldEnd],
		["+", after, newEnd],
	] as const) {
		for (let line = prefix; line < end; line++) {
			const row = marker + lines[line];
			bytes += Buffer.byteLength(row) + 1;
			if (bytes > 60 * 1024) return `${output.join("\n")}\n[Diff truncated]`;
			output.push(row);
		}
	}
	return output.join("\n");
}
