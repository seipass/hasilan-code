import { useMemo } from "react";
import { MetaChips, type ToolDetails, type ToolView } from "./tool-view.tsx";
import { record } from "../Content.tsx";
import { highlightLines, languageForPath } from "../highlight.tsx";

interface DirectoryEntry {
	name?: unknown;
	path?: unknown;
	kind?: unknown;
	size?: unknown;
}

/**
 * read: the requested lines are the payload, so the code block is the body and the
 * snapshot facts are chips above it. Line numbers double as links into the viewer.
 */
export function readView({ input, details, text, onFile }: ToolDetails): ToolView {
	const path = typeof details?.path === "string" ? details.path : typeof input?.path === "string" ? input.path : undefined;
	if (details?.kind === "directory") {
		let entries: DirectoryEntry[] = [];
		try {
			const parsed: unknown = JSON.parse(text);
			if (Array.isArray(parsed)) entries = parsed.filter((entry): entry is DirectoryEntry => record(entry));
		} catch {
			/* A non-JSON listing falls back to the plain result. */
		}
		return {
			meta: <MetaChips items={[path, `${entries.length} entries`]} />,
			body: (
				<ul className="tool-file-list">
					{entries.map((entry, index) => (
						<li key={index}>
							<button type="button" className="text-link" onClick={() => typeof entry.path === "string" && onFile(entry.path)}>
								{typeof entry.name === "string" ? entry.name : String(entry.path ?? "")}
							</button>
							<span className="tool-file-kind">
								{typeof entry.kind === "string" ? entry.kind : ""}
								{typeof entry.size === "number" ? ` · ${entry.size} B` : ""}
							</span>
						</li>
					))}
				</ul>
			),
			handlesResult: true,
		};
	}

	// The result starts with a [path#rev] banner that the chips already show.
	const lines = text
		.split("\n")
		.filter((line, index) => !(index === 0 && /^\[[^\]]+#[A-F0-9]{4}\]$/.test(line.trim())));
	const numbered = lines.some((line) => /^\d+:/.test(line));
	if (details?.kind !== "text" || !path) {
		return { meta: <MetaChips items={[typeof details?.kind === "string" && details.kind]} /> };
	}
	return {
		meta: (
			<MetaChips
				items={[
					typeof details.totalLines === "number" && `${details.totalLines} lines`,
					typeof details.tag === "string" && `rev ${details.tag}`,
					typeof input?.offset === "number" && `from ${input.offset}`,
				]}
			/>
		),
		body: <ReadBody path={path} lines={lines} numbered={numbered} onFile={onFile} />,
		handlesResult: true,
	};
}

/**
 * The lines keep their gutter, but the code itself is highlighted with the language of
 * the path so a read card reads like the file rather than like a log. Hooks live in a
 * component because the card can render before its result arrives.
 */
function ReadBody({ path, lines, numbered, onFile }: {
	path: string; lines: string[]; numbered: boolean; onFile: (path: string, line?: number) => void;
}) {
	const rows = useMemo(() => lines.map((line) => {
		const match = /^(\d+):(.*)$/.exec(line);
		return { number: match?.[1], code: match ? match[2] : line };
	}), [lines]);
	const highlighted = useMemo(() => highlightLines(rows.map((row) => row.code).join("\n"), languageForPath(path)), [rows, path]);
	return (
		<div className="tool-read files-highlight" data-numbered={numbered || undefined}>
			{rows.map((row, index) => row.number === undefined
				? <div key={index} className="tool-read-line"><code>{highlighted[index]}</code></div>
				: (
					<div key={index} className="tool-read-line">
						<button type="button" className="tool-read-number" onClick={() => onFile(path, Number(row.number))} title={`Open ${path} at line ${row.number}`}>{row.number}</button>
						<code>{highlighted[index]}</code>
					</div>
				))}
		</div>
	);
}
