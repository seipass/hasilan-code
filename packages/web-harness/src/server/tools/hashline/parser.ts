export type Locator =
	| { kind: "range"; start: number; end: number }
	| { kind: "block"; line: number }
	| { kind: "gap"; side: "before" | "after"; line: number; block: boolean }
	| { kind: "tail" };
export type PatchOperation =
	| { kind: "put"; locator: Locator; body?: string[]; register?: string }
	| { kind: "cut"; locator: Locator; register: string }
	| { kind: "remove" }
	| { kind: "move"; destination: string };
export interface PatchFile {
	path: string;
	tag: string;
	operations: PatchOperation[];
}
export const ANONYMOUS_REGISTER = "__anonymous";

function locator(input: string): Locator {
	let match = /^(\d+)\.=(\d+)$/.exec(input);
	if (match) {
		const start = Number(match[1]);
		const end = Number(match[2]);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
			throw new Error("Invalid line range");
		return { kind: "range", start, end };
	}
	match = /^(\d+)\*$/.exec(input);
	if (match) {
		const line = Number(match[1]);
		if (!Number.isSafeInteger(line) || line < 1) throw new Error("Invalid block line");
		return { kind: "block", line };
	}
	match = /^([<>])(\d+)(\*)?$/.exec(input);
	if (match && !(match[1] === "<" && match[3])) {
		const line = Number(match[2]);
		if (!Number.isSafeInteger(line) || line < 1) throw new Error("Invalid gap line");
		return { kind: "gap", side: match[1] === "<" ? "before" : "after", line, block: Boolean(match[3]) };
	}
	if (input === ">$") return { kind: "tail" };
	throw new Error(`Invalid locator: ${input}`);
}

function patchError(lines: string[], index: number, message: string, correction: string): Error {
	return new Error(
		`Patch line ${index + 1}: ${message}\nContext: ${JSON.stringify(lines[index] ?? "<end of patch>")}\nCorrection: ${correction}`,
	);
}

/** Independent parser of the documented patch format; it does not inspect files. */
export function parsePatch(input: string): PatchFile[] {
	const lines = input.replaceAll("\r\n", "\n").split("\n");
	let start = 0;
	let end = lines.length;
	while (start < end && /^[ \t]*$/.test(lines[start])) start++;
	while (end > start && /^[ \t]*$/.test(lines[end - 1])) end--;
	if (start === end)
		throw patchError(lines, 0, "Empty patch", "Provide [PATH#TAG] followed by at least one operation.");
	if (lines[start] === "*** Begin Patch") {
		if (lines[end - 1] !== "*** End Patch")
			throw patchError(
				lines,
				start,
				"Missing matching End Patch marker",
				"Use *** Begin Patch and *** End Patch together, or omit both markers.",
			);
		start++;
		end--;
	} else if (lines[end - 1] === "*** End Patch") {
		throw patchError(
			lines,
			end - 1,
			"End Patch marker has no matching Begin Patch marker",
			"Use *** Begin Patch and *** End Patch together, or omit both markers.",
		);
	}
	const parseLocator = (text: string, index: number): Locator => {
		try {
			return locator(text);
		} catch (error) {
			throw patchError(
				lines,
				index,
				error instanceof Error ? error.message : "Invalid locator",
				"Use positive original line numbers: N.=M (M >= N), N*, <N, >N, >N*, or >$. <N* is not valid.",
			);
		}
	};
	const files: PatchFile[] = [];
	let file: PatchFile | undefined;
	let fileHeaderIndex = start;
	for (let index = start; index < end; index++) {
		const line = lines[index];
		if (line.startsWith("***"))
			throw patchError(
				lines,
				index,
				"Misplaced or mismatched patch marker",
				"Only exact *** Begin Patch and *** End Patch markers may surround the entire payload; omit both if unwrapped.",
			);
		const header = /^\[([^\r\n]+)#([0-9A-F]{4})\]$/.exec(line);
		if (header) {
			if (file && !file.operations.length)
				throw patchError(
					lines,
					fileHeaderIndex,
					"Empty file patch",
					"Add at least one operation after this header, or remove the unused header.",
				);
			if (files.some((entry) => entry.path === header[1]))
				throw patchError(
					lines,
					index,
					"Duplicate file header",
					"Group all operations for a file under one [PATH#TAG] header using its original line numbers.",
				);
			file = { path: header[1], tag: header[2], operations: [] };
			fileHeaderIndex = index;
			files.push(file);
			continue;
		}
		if (line.startsWith("["))
			throw patchError(
				lines,
				index,
				"Invalid file header",
				"Copy [PATH#TAG] exactly from the latest read or edit result; TAG is four uppercase hexadecimal characters.",
			);
		if (/^(?:diff --git(?: |$)|@@|---(?: |$)|\+\+\+(?: |$)|-)/.test(line))
			throw patchError(
				lines,
				index,
				"Unified diff syntax is not supported",
				"Use [PATH#TAG] with CUT N.=M for deletion or PUT N.=M: followed by +prefixed replacement rows; do not include diff context or hunk headers.",
			);
		if (!file)
			throw patchError(
				lines,
				index,
				"Operation requires a file header",
				"Copy the latest [PATH#TAG] header before this file's operations.",
			);
		if (line === "REM") {
			file.operations.push({ kind: "remove" });
			continue;
		}
		if (line.startsWith("MV ")) {
			let destination = line.slice(3);
			if (destination.startsWith('"')) {
				try {
					const decoded: unknown = JSON.parse(destination);
					if (typeof decoded !== "string") throw new Error();
					destination = decoded;
				} catch {
					throw patchError(
						lines,
						index,
						"Invalid quoted move destination",
						'Use MV destination, or a complete JSON string such as MV "directory/new name.ts".',
					);
				}
			}
			if (!destination)
				throw patchError(lines, index, "Missing move destination", "Use MV destination with a nonempty path.");
			file.operations.push({ kind: "move", destination });
			continue;
		}
		const cut = /^CUT (\S+)(?: @([A-Za-z0-9_-]+))?$/.exec(line);
		if (cut) {
			const target = parseLocator(cut[1], index);
			if (target.kind !== "range" && target.kind !== "block")
				throw patchError(
					lines,
					index,
					"CUT requires a range or block",
					"Use CUT N.=M or CUT N*, optionally followed by @name; gap locators are only for PUT.",
				);
			file.operations.push({ kind: "cut", locator: target, register: cut[2] ?? ANONYMOUS_REGISTER });
			continue;
		}
		const putBody = /^PUT (\S+):$/.exec(line);
		if (putBody) {
			const target = parseLocator(putBody[1], index);
			const body: string[] = [];
			while (index + 1 < end && lines[index + 1].startsWith("+")) body.push(lines[++index].slice(1));
			if (!body.length)
				throw patchError(
					lines,
					index,
					"PUT body requires at least one + line",
					"After PUT locator:, prefix every body row with + (a lone + is a blank row). Use CUT to delete; missing + prefixes are never inferred.",
				);
			file.operations.push({ kind: "put", locator: target, body });
			continue;
		}
		const putRegister = /^PUT (\S+)(?: @([A-Za-z0-9_-]+))?$/.exec(line);
		if (putRegister) {
			const target = parseLocator(putRegister[1], index);
			if (!putRegister[2] && target.kind !== "gap" && target.kind !== "tail")
				throw patchError(
					lines,
					index,
					"Range or block paste requires a named register",
					"Use PUT N.=M @name or PUT N* @name for a register paste; for literal text use PUT locator: followed by +prefixed rows.",
				);
			file.operations.push({ kind: "put", locator: target, register: putRegister[2] ?? ANONYMOUS_REGISTER });
			continue;
		}
		throw patchError(
			lines,
			index,
			"Invalid patch grammar",
			"Use PUT locator: with +prefixed rows, PUT locator @name, CUT N.=M, CUT N*, REM, or MV destination. Blank/context rows inside the payload are not allowed; literal body rows require +.",
		);
	}
	if (!files.length)
		throw patchError(lines, start, "Empty patch", "Provide [PATH#TAG] followed by at least one operation.");
	if (file && !file.operations.length)
		throw patchError(
			lines,
			fileHeaderIndex,
			"Empty file patch",
			"Add at least one operation after this header, or remove the unused header.",
		);
	return files;
}
