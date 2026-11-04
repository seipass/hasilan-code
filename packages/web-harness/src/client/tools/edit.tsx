import { record } from "../Content.tsx";
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
	const diff = typeof details?.diff === "string" ? details.diff : text;
	const added = (diff.match(/^\+(?!\+\+)/gm) ?? []).length;
	const removed = (diff.match(/^-(?!--)/gm) ?? []).length;
	const applied = files.filter((file) => file.status === "applied").length;
	const failed = files.filter((file) => file.status !== "applied");
	// A rejected patch has no diff: the error text is the whole result, so do not box it twice.
	const rejected = failed.some((file) => typeof file.error === "string");
	if (!diff.trim() && rejected) {
		return {
			meta: <MetaChips items={[files.length > 1 && `${files.length} files`, "rejected"]} />,
			handlesResult: true,
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
				{diff.trim() ? <pre className="tool-diff">{diff.split("\n").map((line, index) => {
					const kind = /^\+/.test(line) && !/^\+\+\+/.test(line) ? "add"
						: /^-/.test(line) && !/^---/.test(line) ? "remove"
							: /^@@/.test(line) ? "hunk"
								: /^(?:\+\+\+|---|diff --git|index )/.test(line) ? "meta" : undefined;
					return <span key={index} data-kind={kind}>{line}{"\n"}</span>;
				})}</pre> : <p className="tool-empty">No changes.</p>}
				{failed.length > 0 && <p className="tool-error">{failed.length} file(s) not applied.</p>}
			</>
		),
		handlesResult: true,
	};
}
