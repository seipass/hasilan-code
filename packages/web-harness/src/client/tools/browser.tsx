import { record } from "../Content.tsx";
import { MetaChips, type ToolDetails, type ToolView } from "./tool-view.tsx";

interface Candidate {
	selector?: unknown;
	name?: unknown;
	text?: unknown;
}

/**
 * browser: what the page looks like decides whether the call worked, so the
 * screenshot leads and the URL, title and tab list follow. Extracted text and the
 * interactive-element list stay collapsed.
 */
export function browserView({ input, details }: ToolDetails): ToolView {
	const action = typeof input?.action === "string" ? input.action : undefined;
	const url = typeof details?.url === "string" ? details.url : undefined;
	const title = typeof details?.title === "string" ? details.title : undefined;
	const status = typeof details?.status === "number" ? details.status : undefined;
	const tabs = Array.isArray(details?.tabs) ? details.tabs.filter((tab) => record(tab)) : [];
	const candidates = Array.isArray(details?.candidates) ? (details.candidates as Candidate[]).filter((entry) => record(entry)) : [];
	const artifact = details && record(details.artifact) && typeof details.artifact.id === "string" ? details.artifact : undefined;
	const text = typeof details?.text === "string" ? details.text : undefined;
	const target = typeof input?.selector === "string" ? input.selector : undefined;
	return {
		meta: (
			<MetaChips
				items={[
					action,
					typeof details?.tabId === "string" && `tab ${details.tabId}`,
					status !== undefined && `HTTP ${status}`,
					typeof input?.key === "string" && `key ${input.key}`,
				]}
			/>
		),
		body: (
			<>
				{artifact && (
					<a className="tool-shot" href={`/api/artifacts/${encodeURIComponent(String(artifact.id))}`} target="_blank" rel="noopener noreferrer">
						<img src={`/api/artifacts/${encodeURIComponent(String(artifact.id))}`} alt={title ?? "Browser screenshot"} />
					</a>
				)}
				{url && (
					<p className="tool-page">
						{/^https?:\/\//i.test(url)
							? <a href={url} target="_blank" rel="noopener noreferrer">{title || url}</a>
							: <span>{url}</span>}
						{title && /^https?:\/\//i.test(url) && <span className="tool-page-url">{url}</span>}
					</p>
				)}
				{!url && title && <p className="tool-page"><strong>{title}</strong></p>}
				{target && <p className="tool-field"><strong>Target</strong> <code>{target}</code></p>}
				{typeof input?.value === "string" && <p className="tool-field"><strong>Input</strong> <code>{input.value}</code></p>}
				{tabs.length > 1 && (
					<ul className="tool-file-list">
						{tabs.map((tab, index) => (
							<li key={index}>
								<span>{typeof tab.title === "string" ? tab.title : `Tab ${index + 1}`}</span>
								<span className="tool-file-kind">{typeof tab.url === "string" ? tab.url : ""}</span>
							</li>
						))}
					</ul>
				)}
				{typeof input?.expression === "string" && <details className="tool-secondary"><summary>JavaScript</summary><pre className="tool-code">{input.expression}</pre></details>}
				{text && <details className="tool-secondary"><summary>Page text</summary><pre className="tool-code">{text}</pre></details>}
				{candidates.length > 0 && (
					<details className="tool-secondary">
						<summary>Interactive elements ({candidates.length})</summary>
						<ul className="tool-file-list">
							{candidates.map((candidate, index) => (
								<li key={index}>
									<code>{typeof candidate.selector === "string" ? candidate.selector : ""}</code>
									<span className="tool-file-kind">{typeof candidate.name === "string" && candidate.name ? candidate.name : typeof candidate.text === "string" ? candidate.text : ""}</span>
								</li>
							))}
						</ul>
					</details>
				)}
				{"value" in (details ?? {}) && <details className="tool-secondary"><summary>Value</summary><pre className="tool-code">{JSON.stringify(details?.value, null, 2)}</pre></details>}
			</>
		),
		handlesResult: true,
	};
}
