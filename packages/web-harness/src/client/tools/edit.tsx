import { useMemo } from "react";
import { record } from "../Content.tsx";
import { highlightLines, languageForPath } from "../highlight.tsx";
import { MetaChips, type ToolDetails, type ToolView } from "./tool-view.tsx";

interface FileReport {
	path?: unknown;
	status?: unknown;
	error?: unknown;
}

/**
 * edit: the diff is the answer, so it comes first and unfurls at full width. Per-file
 * outcomes are chips on the diff header; the patch source stays collapsed.
 */
export function editView({ input, details, text }: ToolDetails): ToolView {
	const files = Array.isArray(details?.files) ? details.files.filter((file): file is FileReport => record(file)) : [];
	// A rejected patch returns its error message as the result text, which is not a diff.
	const source = typeof details?.diff === "string" ? details.diff : text;
	const diff = /^(?:\+\+\+|@@|diff --git|---)/m.test(source) ? source : "";
	const rejected = source.trim().length > 0 && diff === "";
	const primaryPath = files.map((file) => file.path).find((path): path is string => typeof path === "string") ?? (typeof input?.path === "string" ? input.path : undefined);
	const added = (diff.match(/^\+(?!\+\+)/gm) ?? []).length;
	const removed = (diff.match(/^-(?!--)/gm) ?? []).length;
	const applied = files.filter((file) => file.status === "applied").length;
	const failed = files.filter((file) => file.status !== "applied");
	if (!diff && (rejected || files.length > 0)) {
		return {
			meta: <MetaChips items={[files.length > 1 && `${files.length} files`, "rejected"]} />,
			handlesResult: false,
		};
	}
	return {
		meta: (
			<MetaChips
				items={[
					files.length > 1 && `${applied}/${files.length} files`,
					added > 0 && `+${added}`,
					removed > 0 && `-${removed}`,
					typeof input?.input === "string" && "patch",
				]}
			/>
		),
		body: (
			<>
				{files.length > 0 && (
					<ul className="tool-edit-files">
						{files.map((file, index) => (
							<li key={index} data-failed={file.status !== "applied" || undefined}>
								<span className="tool-edit-path">{typeof file.path === "string" ? file.path : `File ${index + 1}`}</span>
								<span className="tool-edit-status">{typeof file.status === "string" ? file.status : ""}</span>
								{typeof file.error === "string" && <p className="tool-error">{file.error}</p>}
							</li>
						))}
					</ul>
				)}
				{diff.trim() ? <DiffBody diff={diff} path={primaryPath} /> : <p className="tool-empty">No changes.</p>}
				{failed.length > 0 && <p className="tool-error">{failed.length} file(s) not applied.</p>}
			</>
		),
		handlesResult: true,
	};
}

/**
 * A diff is mostly code, so the added and removed lines are highlighted with the file's
 * language on top of the gutter tint. Marker characters stay plain so `+` and `-` never
 * pick up a string color from the line they prefix.
 */
function DiffBody({ diff, path }: { diff: string; path?: string }) {
	const rows = useMemo(() => diff.split("\n").map((line) => {
		const kind = /^\+/.test(line) && !/^\+\+\+/.test(line) ? "add"
			: /^-/.test(line) && !/^---/.test(line) ? "remove"
				: /^@@/.test(line) ? "hunk"
					: /^(?:\+\+\+|---|diff --git|index )/.test(line) ? "meta" : undefined;
		// The +/- marker is drawn as its own cell, so only the text after it is highlighted.
		const code = kind === "add" || kind === "remove";
		return { line, kind, marker: code ? line.slice(0, 1) : "", content: code ? line.slice(1) : line };
	}), [diff]);
	const highlighted = useMemo(() => highlightLines(rows.map((row) => row.content).join("\n"), languageForPath(path)), [rows, path]);
	return (
		<pre className="tool-diff files-highlight">{rows.map((row, index) => (
			<span key={index} data-kind={row.kind}>
				{row.kind === "hunk" || row.kind === "meta" ? row.line : <>{row.marker && <span className="tool-diff-marker">{row.marker}</span>}{highlighted[index]}</>}{"\n"}
			</span>
		))}</pre>
	);
}
