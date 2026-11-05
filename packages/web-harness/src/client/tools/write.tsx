import { useMemo } from "react";
import { highlightLines, languageForPath } from "../highlight.tsx";
import { MetaChips, type ToolDetails, type ToolView } from "./tool-view.tsx";

/**
 * write: the file it created is the answer, so the content is shown verbatim with the
 * language of the path. Snapshot facts become chips instead of badge rows.
 */
export function writeView({ input, details }: ToolDetails): ToolView {
	const path = typeof input?.path === "string" ? input.path : undefined;
	const content = typeof input?.content === "string" ? input.content : undefined;
	const totalLines = typeof details?.totalLines === "number" ? details.totalLines : content?.split("\n").length;
	return {
		meta: (
			<MetaChips
				items={[
					path,
					typeof totalLines === "number" && `${totalLines} lines`,
					typeof details?.tag === "string" && `rev ${details.tag}`,
				]}
			/>
		),
		body: content === undefined ? undefined : <WrittenBody path={path} content={content} />,
		handlesResult: true,
	};
}

function WrittenBody({ path, content }: { path?: string; content: string }) {
	const language = languageForPath(path);
	const lines = useMemo(() => highlightLines(content, language), [content, language]);
	return (
		<pre className="tool-written files-highlight">{lines.map((line, index) => (
			<span key={index}>{line}{"\n"}</span>
		))}</pre>
	);
}
