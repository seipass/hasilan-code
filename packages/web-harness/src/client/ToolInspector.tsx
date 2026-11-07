import { useEffect, useState } from "react";
import { Content, record } from "./Content.tsx";
import { browserView } from "./tools/browser.tsx";
import { computerView } from "./tools/computer.tsx";
import { editView } from "./tools/edit.tsx";
import { readView } from "./tools/read.tsx";
import { searchView } from "./tools/search.tsx";
import { shellView } from "./tools/shell.tsx";
import { teamView } from "./tools/team.tsx";
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
	const [open, setOpen] = useState(expanded);
	const [visited, setVisited] = useState(expanded);
	useEffect(() => setOpen(expanded), [expanded]);
	const result = record(tool.result) ? tool.result : undefined;
	const details = result && record(result.details) ? result.details : result;
	const structured = result && record(result.structuredContent) ? result.structuredContent : undefined;
	const status = { running: "Running", success: "Success", error: "Error", cancelled: "Cancelled", incomplete: "未完了" }[tool.status];
	const input = record(tool.input) ? tool.input : undefined;
	const visual = toolVisuals[tool.name as keyof typeof toolVisuals];
	const summary = toolContext(tool.name, input);
	const resultNote = tool.name === "web_search" && Array.isArray(details?.results) ? countLabel(details.results.length, "result")
		: (tool.name === "bash" || tool.name === "terminal") && typeof structured?.exit_code === "number" ? `Exit ${structured.exit_code}`
		: tool.name === "edit" && Array.isArray(details?.files) ? countLabel(details.files.length, "file")
		: tool.name === "write" && typeof details?.totalLines === "number" ? countLabel(details.totalLines, "line") : undefined;
	return <details className={`tool-card tool-kind-${visual?.kind ?? "generic"} status-${tool.status}`} open={open} onToggle={(event) => {
		if (event.target !== event.currentTarget) return;
		setOpen(event.currentTarget.open);
		if (event.currentTarget.open) setVisited(true);
	}}>
		<summary>
			<span className="tool-heading"><strong>{visual?.label ?? tool.name}</strong></span>
			{summary && <span className="tool-summary" title={summary}>{summary}</span>}
			{resultNote && <span className="tool-result-note">{resultNote}</span>}
			<span key={tool.status} className={`badge status-${tool.status} motion-label`}>{status}</span>
		</summary>
		{(open || visited) && <ToolBody tool={tool} onFile={onFile} />}
	</details>;
}

function ToolBody({ tool, onFile }: { tool: ToolCall; onFile: (path: string, line?: number) => void }) {
	const result = record(tool.result) ? tool.result : undefined;
	const details = result && record(result.details) ? result.details : result;
	const structured = result && record(result.structuredContent) ? result.structuredContent : undefined;
	const input = record(tool.input) ? tool.input : undefined;
	const filePaths = new Set<string>();
	if (typeof input?.path === "string") filePaths.add(input.path);
	if (typeof input?.input === "string") {
		for (const match of input.input.matchAll(/^\[([^\r\n#]+)#[A-F0-9]{4}\]$/gm)) if (match[1]) filePaths.add(match[1]);
	}
	const artifact = details && record(details.artifact) && typeof details.artifact.id === "string" ? details.artifact : undefined;
	const originalContent = result && "content" in result ? result.content : tool.result;
	const content = tool.name === "write" ? writeResultContent(originalContent) : originalContent;
	const textContent = Array.isArray(content) ? content.map((part: unknown) => record(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("\n") : typeof content === "string" ? content : "";
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
								: tool.name === "team"
									? teamView(viewDetails)
									: undefined;
	return <div className="tool-body" data-view={isShell ? "shell" : tool.name === "read" ? "read" : tool.name === "edit" || tool.name === "write" ? tool.name : undefined}>
			{tool.sourceStatus && <p className="muted">元の状態: {tool.sourceStatus}</p>}
			{(tool.importedOrigin?.url || typeof result?.sourceRecord === "string") && <div className="imported-record-links">
				{tool.importedOrigin?.url && <a href={tool.importedOrigin.url} target="_blank" rel="noopener noreferrer">元の呼び出し記録</a>}
				{typeof result?.sourceRecord === "string" && <a href={result.sourceRecord} target="_blank" rel="noopener noreferrer">元の結果記録</a>}
			</div>}
			{filePaths.size > 0 && <div className="file-links">{[...filePaths].map((path) => <button key={path} className="text-link" onClick={() => onFile(path)}>{path}</button>)}</div>}
			{view?.meta}
			{view?.body}
			{tool.name === "edit" && typeof input?.input === "string" && <details className="tool-secondary"><summary>Patch</summary><pre className="tool-code">{input.input}</pre></details>}
			{tool.result !== undefined && <>
				{tool.status === "error" || tool.status === "cancelled"
					? <Content value={content} onFile={onFile} />
					: view?.handlesResult ? null
						: <>
							<h4>Result {tool.status === "running" ? "(partial)" : "(final)"}</h4>
							<Content value={artifact && Array.isArray(content) ? content.filter((part: unknown) => !record(part) || part.type !== "image") : content} onFile={onFile} />
						</>}
				{!specialized && details && <details><summary>Details</summary><pre>{JSON.stringify(details, null, 2)}</pre></details>}
			</>}
		</div>;
}

export function ToolInspector({ tools, onFile }: { tools: ToolCall[]; onFile: (path: string, line?: number) => void }) {
	return <section className="inspector">{tools.length === 0 && <p className="muted">No tool calls.</p>}{tools.map((tool) => <ToolCard key={tool.key} tool={tool} onFile={onFile} />)}</section>;
}
