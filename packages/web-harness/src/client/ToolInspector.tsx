import { Content, record } from "./Content.tsx";
import { browserView } from "./tools/browser.tsx";
import { computerView } from "./tools/computer.tsx";
import { editView } from "./tools/edit.tsx";
import { readView } from "./tools/read.tsx";
import { searchView } from "./tools/search.tsx";
import { shellView } from "./tools/shell.tsx";
import { writeView } from "./tools/write.tsx";
import { flattenContent, type ToolDetails, type ToolView } from "./tools/tool-view.tsx";
import type { ToolCall } from "./types.ts";

const toolVisuals = {
	read: { label: "Read file", kind: "file" },
	edit: { label: "Edit files", kind: "edit" },
	write: { label: "Create file", kind: "write" },
	bash: { label: "Run command", kind: "terminal" },
	terminal: { label: "Terminal", kind: "terminal" },
	browser: { label: "Browser", kind: "browser" },
	computer: { label: "Computer", kind: "browser" },
	web_search: { label: "Web search", kind: "search" },
	team: { label: "Agent team", kind: "team" },
} as const;

function countLabel(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function shortText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = value.trim().split(/\r?\n/, 1)[0];
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function writeResultContent(value: unknown): unknown {
	if (typeof value === "string") return value.replace(/^(File created|Created file)\. Read it before editing\.\r?(?:\n|$)/gm, "");
	if (Array.isArray(value)) return value.map((part: unknown) => record(part) && part.type === "text" && typeof part.text === "string" ? { ...part, text: writeResultContent(part.text) } : part);
	return value;
}

function toolContext(name: string, input: Record<string, unknown> | undefined): string | undefined {
	if (!input) return undefined;
	if (name === "read") {
		const path = shortText(input.path);
		return [path, typeof input.offset === "number" ? `from line ${input.offset}` : undefined].filter(Boolean).join(" · ");
	}
	if (name === "write") return shortText(input.path);
	if (name === "edit") {
		const patch = typeof input.input === "string" ? input.input : "";
		const paths = [...patch.matchAll(/^\[([^\r\n#]+)#[A-F0-9]{4}\]$/gm)].map((match) => match[1]);
		return paths.length ? `${paths.slice(0, 2).join(", ")}${paths.length > 2 ? ` +${paths.length - 2} more` : ""}` : shortText(input.input);
	}
	if (name === "bash" || name === "terminal") return shortText(input.command);
	if (name === "web_search") return shortText(input.query);
	if (name === "browser") {
		const action = shortText(input.action);
		const target = shortText(input.url) ?? shortText(input.selector) ?? shortText(input.tabId);
		return [action, target].filter(Boolean).join(" · ");
	}
	if (name === "computer") return [shortText(input.action), typeof input.x === "number" && typeof input.y === "number" ? `${input.x}, ${input.y}` : shortText(input.key)].filter(Boolean).join(" · ");
	if (name === "team") {
		const action = shortText(input.action);
		const tasks = Array.isArray(input.tasks) ? input.tasks : undefined;
		const names = tasks?.map((task: unknown) => record(task) ? shortText(task.name) : undefined).filter(Boolean);
		const context = names?.length ? `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2} more` : ""}`
			: shortText(input.agentId) ?? (Array.isArray(input.agentIds) ? countLabel(input.agentIds.length, "agent") : undefined);
		return [action, context].filter(Boolean).join(" · ");
	}
	return [input.path, input.query, input.action, input.command].map(shortText).find(Boolean);
}

export function ToolCard({ tool, onFile, expanded = false }: {
	tool: ToolCall; onFile: (path: string, line?: number) => void; expanded?: boolean;
}) {
	const result = record(tool.result) ? tool.result : undefined;
	const details = result && record(result.details) ? result.details : result;
	const teamProfiles = result && Array.isArray(result.details) ? result.details : undefined;
	const structured = result && record(result.structuredContent) ? result.structuredContent : undefined;
	const status = { running: "Running", success: "Success", error: "Error", cancelled: "Cancelled", incomplete: "未完了" }[tool.status];
	const input = record(tool.input) ? tool.input : undefined;
	const visual = toolVisuals[tool.name as keyof typeof toolVisuals];
	const summary = toolContext(tool.name, input);
	const filePaths = new Set<string>();
	if (typeof input?.path === "string") filePaths.add(input.path);
	if (typeof input?.input === "string") {
		for (const match of input.input.matchAll(/^\[([^\r\n#]+)#[A-F0-9]{4}\]$/gm)) if (match[1]) filePaths.add(match[1]);
	}
	const searchResults: unknown[] | undefined = details && Array.isArray(details.results) ? details.results : undefined;
	const artifact = details && record(details.artifact) && typeof details.artifact.id === "string" ? details.artifact : undefined;
	const originalContent = result && "content" in result ? result.content : tool.result;
	const content = tool.name === "write" ? writeResultContent(originalContent) : originalContent;
	const displayDetails = tool.name === "write" && details && "content" in details ? { ...details, content: writeResultContent(details.content) } : details;
	const textContent = Array.isArray(content) ? content.map((part: unknown) => record(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("\n") : typeof content === "string" ? content : "";
	const exitCode = structured?.exit_code;
	const resultNote = tool.name === "web_search" && searchResults ? countLabel(searchResults.length, "result")
		: (tool.name === "bash" || tool.name === "terminal") && typeof exitCode === "number" ? `Exit ${exitCode}`
		: tool.name === "edit" && details && Array.isArray(details.files) ? countLabel(details.files.length, "file")
		: tool.name === "write" && typeof details?.totalLines === "number" ? countLabel(details.totalLines, "line") : undefined;
	const teamEntries = details && (Array.isArray(details.tasks) ? details.tasks : Array.isArray(details.agents) ? details.agents : Array.isArray(details.runs) ? details.runs : undefined);
	const isShell = tool.name === "bash" || tool.name === "terminal";
	const specialized = ["read", "write", "edit", "bash", "terminal", "browser", "computer", "web_search", "team"].includes(tool.name);
	const viewDetails: ToolDetails = { input, details, result: structured, text: textContent, content, status: tool.status, onFile };
	const view: ToolView | undefined = isShell
		? shellView(viewDetails)
		: tool.name === "read"
			? readView(viewDetails)
			: tool.name === "edit"
				? editView(viewDetails)
				: tool.name === "write"
					? writeView(viewDetails)
					: tool.name === "browser"
						? browserView(viewDetails)
						: tool.name === "computer"
							? computerView(viewDetails)
							: tool.name === "web_search"
								? searchView(viewDetails)
								: undefined;
	return <details className={`tool-card tool-kind-${visual?.kind ?? "generic"} status-${tool.status}`} open={expanded}>
		<summary>
			<span className="tool-heading"><strong>{visual?.label ?? tool.name}</strong></span>
			{summary && <span className="tool-summary" title={summary}>{summary}</span>}
			{resultNote && <span className="tool-result-note">{resultNote}</span>}
			<span key={tool.status} className={`badge status-${tool.status} motion-label`}>{status}</span>
		</summary>
		<div className="tool-body" data-view={isShell ? "shell" : tool.name === "read" ? "read" : tool.name === "edit" || tool.name === "write" ? tool.name : undefined}>
			{tool.sourceStatus && <p className="muted">元の状態: {tool.sourceStatus}</p>}
			{(tool.importedOrigin?.url || typeof result?.sourceRecord === "string") && <div className="imported-record-links">
				{tool.importedOrigin?.url && <a href={tool.importedOrigin.url} target="_blank" rel="noopener noreferrer">元の呼び出し記録</a>}
				{typeof result?.sourceRecord === "string" && <a href={result.sourceRecord} target="_blank" rel="noopener noreferrer">元の結果記録</a>}
			</div>}
			{filePaths.size > 0 && <div className="file-links">{[...filePaths].map((path) => <button key={path} className="text-link" onClick={() => onFile(path)}>{path}</button>)}</div>}


			{tool.name === "edit" && typeof input?.input === "string" && <details className="tool-secondary"><summary>Patch</summary><pre className="tool-code">{input.input}</pre></details>}
			{view?.meta}
			{view?.body}


			{tool.name === "team" && <>
				<div className="tool-meta">{typeof input?.action === "string" && <span>{input.action}</span>}{typeof details?.timedOut === "boolean" && <span>{details.timedOut ? "Timed out" : "Completed"}</span>}</div>
				{Array.isArray(input?.tasks) && <div className="tool-task-list">{input.tasks.map((item: unknown, index) => record(item) ? <article key={index}><strong>{typeof item.name === "string" ? item.name : `Task ${index + 1}`}</strong>{typeof item.task === "string" && <p>{item.task}</p>}{Array.isArray(item.dependsOn) && item.dependsOn.length > 0 && <small>Depends on: {item.dependsOn.join(", ")}</small>}</article> : null)}</div>}
				{typeof input?.message === "string" && <blockquote className="tool-message">{input.message}</blockquote>}
			</>}
			<details className="tool-raw"><summary>Call data</summary><code>{tool.callId}</code><pre>{JSON.stringify(tool.input, null, 2)}</pre></details>
			{tool.result !== undefined && <>
				{!view?.handlesResult && <h4>Result {tool.status === "running" ? "(partial)" : "(final)"}</h4>}
				{tool.status === "error" || tool.status === "cancelled" ? <Content value={content} onFile={onFile} />
					: tool.name === "web_search" || tool.name === "computer" ? null
					: tool.name === "browser" ? null
					: tool.name === "team" && teamEntries ? <div className="tool-task-list">{teamEntries.map((entry: unknown, index) => record(entry) ? <article key={index}><div className="tool-task-heading"><strong>{typeof entry.name === "string" ? entry.name : typeof entry.agentId === "string" ? entry.agentId : `Entry ${index + 1}`}</strong>{typeof entry.status === "string" && <span>{entry.status}</span>}</div>{typeof entry.result === "string" && <p>{entry.result}</p>}{typeof entry.error === "string" && <p className="tool-error">{entry.error}</p>}</article> : null)}</div>
					: tool.name === "team" && teamProfiles ? <div className="tool-task-list">{teamProfiles.map((entry: unknown, index) => record(entry) ? <article key={index}><strong>{typeof entry.name === "string" ? entry.name : `Entry ${index + 1}`}</strong>{typeof entry.description === "string" && <p>{entry.description}</p>}</article> : null)}</div>
					: tool.name === "team" && details ? <div className="tool-meta">{typeof details.runId === "string" && <span>Run {details.runId}</span>}{typeof details.disposition === "string" && <span>{details.disposition}</span>}{typeof details.status === "string" && <span>{details.status}</span>}</div>
					: <Content value={artifact && Array.isArray(content) ? content.filter((part: unknown) => !record(part) || part.type !== "image") : content} onFile={onFile} />}
				{!specialized && details && <details><summary>Details</summary><pre>{JSON.stringify(details, null, 2)}</pre></details>}
				{specialized && displayDetails && <details className="tool-secondary"><summary>Raw result</summary><pre>{JSON.stringify(displayDetails, null, 2)}</pre></details>}
			</>}
		</div>
	</details>;
}

export function ToolInspector({ tools, onFile }: { tools: ToolCall[]; onFile: (path: string, line?: number) => void }) {
	return <section className="inspector">{tools.length === 0 && <p className="muted">No tool calls.</p>}{tools.map((tool) => <ToolCard key={tool.key} tool={tool} onFile={onFile} />)}</section>;
}
