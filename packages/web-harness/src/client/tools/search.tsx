import { record } from "../Content.tsx";
import { MetaChips, type ToolDetails, type ToolView } from "./tool-view.tsx";

interface SearchResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
}

/**
 * web_search: a result list is the answer, ranked as returned. Query terms and the
 * provider stay as chips so the list itself keeps the full width.
 */
export function searchView({ input, details }: ToolDetails): ToolView {
	const results = Array.isArray(details?.results)
		? details.results.filter((item): item is SearchResult => record(item))
		: [];
	const provider = typeof input?.provider === "string" ? input.provider : typeof details?.provider === "string" ? details.provider : undefined;
	const query = typeof input?.query === "string" ? input.query : undefined;
	return {
		meta: (
			<MetaChips
				items={[
					query,
					provider,
					`${results.length} results`,
					typeof input?.timeRange === "string" && input.timeRange,
				]}
			/>
		),
		body: results.length === 0
			? <p className="tool-empty">No results.</p>
			: (
				<ol className="tool-results">
					{results.map((item, index) => {
						const url = typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : undefined;
						const title = typeof item.title === "string" && item.title ? item.title : url ?? `Result ${index + 1}`;
						let host = "";
						try { host = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { /* keep the raw url */ }
						return (
							<li key={index}>
								{url ? <a href={url} target="_blank" rel="noopener noreferrer">{title}</a> : <strong>{title}</strong>}
								{host && <span className="tool-result-host">{host}</span>}
								{typeof item.snippet === "string" && item.snippet && <p>{item.snippet}</p>}
							</li>
						);
					})}
				</ol>
			),
		handlesResult: true,
	};
}
