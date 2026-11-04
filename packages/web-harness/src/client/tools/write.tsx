import { MetaChips, type ToolDetails, type ToolView } from "./tool-view.tsx";

/**
 * write: the file it created is the answer. The new content is shown verbatim with a
 * language-less code block; snapshot facts become chips instead of badge rows.
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
		body: content === undefined
			? undefined
			: (
				<pre className="tool-written">{content.split("\n").map((line, index) => (
					<span key={index}>{line}{"\n"}</span>
				))}</pre>
			),
		handlesResult: true,
	};
}
