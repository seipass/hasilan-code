import path from "node:path";
import { type LineRange, resolveBlock } from "./blocks.ts";
import type { PatchFile } from "./parser.ts";
import type { HashlineSnapshot } from "./snapshots.ts";

/** Recover only exact, unique target spans with unchanged adjacent context, never fuzzy text. */
export function recoverPatch(file: PatchFile, source: HashlineSnapshot, current: HashlineSnapshot): PatchFile {
	if (
		source.tag === current.tag ||
		source.bom !== current.bom ||
		source.eol !== current.eol ||
		source.trailingNewline !== current.trailingNewline ||
		source.mixedEol !== current.mixedEol ||
		file.operations.some((operation) => operation.kind === "remove" || operation.kind === "move")
	)
		throw new Error("Stale snapshot: raw drift or whole-file operation; read the file again");

	let remapOffset: number | undefined;
	const extension = path.extname(source.path).toLowerCase();
	const structural = [".md", ".markdown", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(
		extension,
	);
	const enclosing = (snapshot: HashlineSnapshot, target: LineRange): LineRange[] => {
		const ancestors: LineRange[] = [];
		for (let line = 1; line <= target.start; line++) {
			let block: LineRange;
			try {
				block = resolveBlock(snapshot.path, snapshot.lines, line);
			} catch {
				// A non-opener is normal. No provable enclosing construct fails closed below.
				continue;
			}
			if (block.end >= target.end) ancestors.push(block);
		}
		return ancestors;
	};

	const remap = (range: LineRange): LineRange => {
		const first = Math.max(1, range.start - 1);
		const last = Math.min(source.lines.length, range.end + 1);
		const context = source.lines.slice(first - 1, last);
		const matches: number[] = [];
		for (const lines of [source.lines, current.lines]) {
			let found = -1;
			for (let index = 0; index <= lines.length - context.length; index++) {
				if (range.start === 1 && index !== 0) continue;
				if (range.end === source.lines.length && index + context.length !== lines.length) continue;
				if (!context.every((line, offset) => line === lines[index + offset])) continue;
				if (found !== -1) throw new Error("Stale snapshot: ambiguous target context; read the file again");
				found = index;
			}
			if (found === -1) throw new Error("Stale snapshot: target or context changed; read the file again");
			matches.push(found);
		}
		const start = matches[1] + 1 + range.start - first;
		const end = start + range.end - range.start;
		const offset = start - range.start;
		if (remapOffset !== undefined && remapOffset !== offset)
			throw new Error("Stale snapshot: inconsistent target shifts; read the file again");
		remapOffset = offset;
		if (structural) {
			const before = enclosing(source, range);
			const after = enclosing(current, { start, end });
			if (
				!before.length ||
				before.length !== after.length ||
				before.some((block, index) => {
					const mapped = after[index];
					if (block.start + offset !== mapped.start) return true;
					// Keep the enclosing header, including decorators/doc comments, and its prefix exact.
					// This intentionally rejects changes within the prefix instead of guessing identity.
					for (let line = block.start; line <= range.start; line++)
						if (source.lines[line - 1] !== current.lines[line + offset - 1]) return true;
					return false;
				})
			)
				throw new Error("Stale snapshot: enclosing construct changed or unproven; read the file again");
		}
		for (let line = start; line <= end; line++) current.seenLines.add(line);
		return { start, end };
	};

	// Only unchanged, unshifted seen lines retain their old numbered provenance.
	for (const line of source.seenLines)
		if (source.lines[line - 1] === current.lines[line - 1]) current.seenLines.add(line);
	const operations = file.operations.map((operation) => {
		if (operation.kind === "remove" || operation.kind === "move") throw new Error("Stale whole-file operation");
		const locator = operation.locator;
		let range: LineRange;
		if (locator.kind === "range") range = { start: locator.start, end: locator.end };
		else if (locator.kind === "block" || (locator.kind === "gap" && locator.block))
			range = resolveBlock(source.path, source.lines, locator.line);
		else if (locator.kind === "gap") range = { start: locator.line, end: locator.line };
		else {
			if (!source.lines.length)
				throw new Error("Stale snapshot: empty tail cannot be recovered; read the file again");
			range = { start: source.lines.length, end: source.lines.length };
		}
		// Validate the source, not merely the fresh mapped lines: recovery cannot bypass unread protection.
		for (let line = range.start; line <= range.end; line++)
			if (!source.seenLines.has(line)) throw new Error(`Unread line ${line}; read the file again`);
		const mapped = remap(range);
		if (locator.kind === "gap")
			return {
				...operation,
				locator: {
					kind: "gap" as const,
					side: locator.side,
					line: locator.block ? mapped.end : mapped.start,
					block: false,
				},
			};
		if (locator.kind === "tail") return operation;
		return { ...operation, locator: { kind: "range" as const, ...mapped } };
	});
	return { ...file, tag: current.tag, operations };
}
