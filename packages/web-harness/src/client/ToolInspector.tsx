import { Content, record } from "./Content.tsx";
import type { ToolCall } from "./types.ts";

export function ToolCard({ tool, onFile, expanded = false }: {
	tool: ToolCall; onFile: (path: string, line?: number) => void; expanded?: boolean;
}) {
	const result = record(tool.result) ? tool.result : undefined;
	const details = result && record(result.details) ? result.details : result;
	const status = { running: "実行中", success: "成功", error: "エラー", cancelled: "キャンセル" }[tool.status];
	const filePaths = new Set<string>();
	if (record(tool.input) && typeof tool.input.path === "string") filePaths.add(tool.input.path);
	if (record(tool.input) && typeof tool.input.input === "string") {
		for (const match of tool.input.input.matchAll(/^\[([^\r\n#]+)#[A-F0-9]{4}\]$/gm)) if (match[1]) filePaths.add(match[1]);
	}
	const searchResults: unknown[] | undefined = details && Array.isArray(details.results) ? details.results : undefined;
	const artifact = details && record(details.artifact) && typeof details.artifact.id === "string" ? details.artifact : undefined;
	const content = result && "content" in result ? result.content : tool.result;
	const textContent = Array.isArray(content) ? content.map((part: unknown) => record(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("\n") : typeof content === "string" ? content : "";
	const input = record(tool.input) ? tool.input : undefined;
	const summary = [input?.path, input?.query, input?.action, input?.command].find((value) => typeof value === "string");
	return <details className={`tool-card status-${tool.status}`} open={expanded}>
		<summary><strong>{tool.name}</strong>{typeof summary === "string" && <span className="tool-summary">{summary.slice(0, 90)}</span>}<span className={`badge status-${tool.status}`}>{status}</span></summary>
		<div className="tool-body">
			<div className="file-links">{[...filePaths].map((path) => <button key={path} className="text-link" onClick={() => onFile(path)}>{path}</button>)}</div>
			<details className="tool-raw"><summary>呼び出しデータ</summary><code>{tool.callId}</code><pre>{JSON.stringify(tool.input, null, 2)}</pre></details>
			{tool.result !== undefined && <>
				<h4>結果 {tool.status === "running" ? "（部分）" : "（最終）"}</h4>
				{tool.name === "web_search" && searchResults && <div className="search-results">
					<p className="muted">{typeof details?.provider === "string" ? details.provider : ""}</p>
					{searchResults.length === 0 && <p>検索結果はありません。</p>}
					{searchResults.map((item, index) => record(item) ? <article key={index}>
						{typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? <a href={item.url} target="_blank" rel="noopener noreferrer">{typeof item.title === "string" ? item.title : item.url}</a> : <strong>{typeof item.title === "string" ? item.title : "結果"}</strong>}
						{typeof item.url === "string" && <p className="muted">{item.url}</p>}
						{typeof item.snippet === "string" && <p>{item.snippet}</p>}
					</article> : null)}
				</div>}
				{tool.name === "browser" && details && <div className="browser-result">
					{typeof details.url === "string" && <p>URL: {details.url}</p>}
					{typeof details.title === "string" && <p>{details.title}</p>}
					{typeof details.status === "number" && <p>HTTP {details.status}</p>}
					{artifact && typeof artifact.id === "string" && <a href={`/api/artifacts/${encodeURIComponent(artifact.id)}`} target="_blank" rel="noopener noreferrer"><img className="tool-image" src={`/api/artifacts/${encodeURIComponent(artifact.id)}`} alt="ブラウザーのスクリーンショット" /></a>}
				</div>}
				{tool.name === "read" && details?.kind === "text" && typeof details.path === "string" ? <pre className="hashline-read">{textContent.split("\n").map((line, index) => {
					const match = /^(\d+):(.*)$/.exec(line);
					const path = typeof details.path === "string" ? details.path : "";
					return <span key={index} className="hashline-output-line">{match ? <><button className="text-link" onClick={() => onFile(path, Number(match[1]))}>{match[1]}</button><code>:{match[2]}</code></> : <code>{line}</code>}</span>;
				})}</pre> : tool.name === "edit" && textContent ? <pre className="hashline-diff">{textContent}</pre> : <Content value={artifact && Array.isArray(content) ? content.filter((part: unknown) => !record(part) || part.type !== "image") : content} onFile={onFile} />}
				{details && <details><summary>詳細データ</summary><pre>{JSON.stringify(details, null, 2)}</pre></details>}
			</>}
			{tool.name === "edit" && <p className="fine-print">Hashline: 全文由来のタグと既読行を検証します。古いタグの自動移動は行いません。N* は Markdown / TS / JS のみ対応します。</p>}
		</div>
	</details>;
}

export function ToolInspector({ tools, onFile }: { tools: ToolCall[]; onFile: (path: string, line?: number) => void }) {
	return <section className="inspector">{tools.length === 0 && <p className="muted">ツール呼び出しはありません。</p>}{tools.map((tool) => <ToolCard key={tool.key} tool={tool} onFile={onFile} />)}</section>;
}
