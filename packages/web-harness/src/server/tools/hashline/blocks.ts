import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

const UNSUPPORTED = "Block locator unsupported; use an explicit line range";
export interface LineRange {
	start: number;
	end: number;
}
const syntaxRanges = new WeakMap<string[], { extension: string; ranges: LineRange[] }>();
export function resolveBlock(filePath: string, lines: string[], line: number): LineRange {
	if (line < 1 || line > lines.length) throw new Error("Line is outside snapshot");
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".md" || extension === ".markdown") {
		// Ignore headings inside fenced code blocks.
		let fence: { character: string; length: number } | undefined;
		const headings: { line: number; level: number }[] = [];
		for (let index = 0; index < lines.length; index++) {
			const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index]);
			if (marker) {
				if (!fence) fence = { character: marker[1][0], length: marker[1].length };
				else if (
					marker[1][0] === fence.character &&
					marker[1].length >= fence.length &&
					/^ {0,3}(?:`+|~+)\s*$/.test(lines[index])
				)
					fence = undefined;
				continue;
			}
			if (fence) continue;
			const heading = /^ {0,3}(#{1,6})(?:\s+|$)/.exec(lines[index]);
			if (heading) headings.push({ line: index + 1, level: heading[1].length });
			else if (index > 0 && /^ {0,3}(=+|-+)\s*$/.test(lines[index]) && lines[index - 1].trim())
				headings.push({ line: index, level: lines[index].trim()[0] === "=" ? 1 : 2 });
		}
		const current = headings.find((heading) => heading.line === line);
		if (!current) throw new Error(UNSUPPORTED);
		const next = headings.find((heading) => heading.line > line && heading.level <= current.level);
		const end = next ? next.line - 1 : lines.length;
		if (end === line) throw new Error(UNSUPPORTED);
		return { start: line, end };
	}
	if (![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extension))
		throw new Error(UNSUPPORTED);
	let cached = syntaxRanges.get(lines);
	if (!cached || cached.extension !== extension) {
		// TS 7 exposes native parsing via its API, not the removed createSourceFile API.
		// Isolate source text in a virtual project; never reread a live file for locators.
		const root = path.join(process.cwd(), ".__pi_hashline_ast__").replaceAll("\\", "/");
		const file = `${root}/input${extension}`;
		const config = `${root}/tsconfig.json`;
		const virtual = createVirtualFileSystem({
			[file]: lines.join("\n"),
			[config]: JSON.stringify({
				compilerOptions: { noLib: true, allowJs: true, jsx: "preserve", noResolve: true },
				files: [`input${extension}`],
			}),
		});
		const api = new API({
			cwd: process.cwd(),
			fs: {
				...virtual,
				readFile: (name) => virtual.readFile?.(name) ?? null,
				getAccessibleEntries: (name) => virtual.getAccessibleEntries?.(name) ?? { files: [], directories: [] },
			},
		});
		try {
			const snapshot = api.updateSnapshot({ openProjects: [config] });
			const program = snapshot.getProject(config)?.program;
			const source = program?.getSourceFile(file);
			if (!source || program!.getSyntacticDiagnostics(file).length) throw new Error(UNSUPPORTED);
			const ranges: LineRange[] = [];
			const visit = (node: ts.Node): void => {
				if (
					ts.isStatement(node) ||
					ts.isMethodDeclaration(node) ||
					ts.isPropertyDeclaration(node) ||
					ts.isConstructorDeclaration(node) ||
					ts.isGetAccessorDeclaration(node) ||
					ts.isSetAccessorDeclaration(node)
				) {
					const start = source.getLineAndCharacterOfPosition(node.getStart(source, true)).line + 1;
					const end =
						source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.getEnd() - 1)).line + 1;
					if (end > start) ranges.push({ start, end });
				}
				node.forEachChild(visit);
			};
			visit(source);
			cached = { extension, ranges };
			syntaxRanges.set(lines, cached);
		} finally {
			api.close();
		}
	}
	const candidates = cached.ranges.filter((range) => range.start === line);
	if (!candidates.length) throw new Error(UNSUPPORTED);
	// The outermost declaration/statement wins, not an inner statement on its opener.
	return candidates.reduce((outer, entry) => (entry.end > outer.end ? entry : outer));
}
