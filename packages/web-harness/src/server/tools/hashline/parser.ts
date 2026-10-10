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

/** Independent parser of the documented patch format; it does not inspect files. */
export function parsePatch(input: string): PatchFile[] {
	const lines = input.replaceAll("\r\n", "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch")
		throw new Error("Patch must have Begin Patch and End Patch markers");
	const files: PatchFile[] = [];
	let file: PatchFile | undefined;
	for (let index = 1; index < lines.length - 1; index++) {
		const line = lines[index];
		const header = /^\[([^\r\n]+)#([0-9A-F]{4})\]$/.exec(line);
		if (header) {
			if (file && !file.operations.length) throw new Error("Empty file patch");
			if (files.some((entry) => entry.path === header[1])) throw new Error("Duplicate file header");
			file = { path: header[1], tag: header[2], operations: [] };
			files.push(file);
			continue;
		}
		if (!file) throw new Error("Operation requires a file header");
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
					throw new Error("Invalid quoted move destination");
				}
			}
			if (!destination) throw new Error("Missing move destination");
			file.operations.push({ kind: "move", destination });
			continue;
		}
		const cut = /^CUT (\S+)(?: @([A-Za-z0-9_-]+))?$/.exec(line);
		if (cut) {
			const target = locator(cut[1]);
			if (target.kind !== "range" && target.kind !== "block") throw new Error("CUT requires a range or block");
			file.operations.push({ kind: "cut", locator: target, register: cut[2] ?? ANONYMOUS_REGISTER });
			continue;
		}
		const putBody = /^PUT (\S+):$/.exec(line);
		if (putBody) {
			const target = locator(putBody[1]);
			const body: string[] = [];
			while (index + 1 < lines.length - 1 && lines[index + 1].startsWith("+")) body.push(lines[++index].slice(1));
			if (!body.length) throw new Error("PUT body requires at least one + line");
			file.operations.push({ kind: "put", locator: target, body });
			continue;
		}
		const putRegister = /^PUT (\S+)(?: @([A-Za-z0-9_-]+))?$/.exec(line);
		if (putRegister) {
			const target = locator(putRegister[1]);
			if (!putRegister[2] && target.kind !== "gap" && target.kind !== "tail")
				throw new Error("Range or block paste requires a named register");
			file.operations.push({ kind: "put", locator: target, register: putRegister[2] ?? ANONYMOUS_REGISTER });
			continue;
		}
		throw new Error(`Invalid patch grammar at line ${index + 1}`);
	}
	if (!files.length || files.some((entry) => !entry.operations.length)) throw new Error("Empty patch");
	return files;
}
