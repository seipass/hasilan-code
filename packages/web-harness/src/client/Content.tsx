import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function Markdown({ text, onFile }: { text: string; onFile: (path: string, line?: number) => void }) {
	return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
		a: ({ href, children }) => {
			if (!href) return <span>{children}</span>;
			if (/^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
			if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return <span>{children}</span>;
			const match = /^(.*?)(?:#L?(\d+))?$/.exec(href);
			let path: string;
			try { path = decodeURIComponent(match?.[1] ?? href); } catch { return <span>{children}</span>; }
			if (!path) return <span>{children}</span>;
			return <button className="text-link" onClick={() => onFile(path, match?.[2] ? Number(match[2]) : undefined)}>{children}</button>;
		},
		img: ({ src, alt }) => src && /^https?:\/\//i.test(src) ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || "画像リンク"}</a> : <span>{alt || "画像"}</span>,
	}}>{text}</ReactMarkdown>;
}

export function Content({ value, onFile }: { value: unknown; onFile: (path: string, line?: number) => void }) {
	if (typeof value === "string") return <Markdown text={value} onFile={onFile} />;
	if (Array.isArray(value)) return <>{value.map((part: unknown, index: number) => <Content key={index} value={part} onFile={onFile} />)}</>;
	if (!record(value)) return value === undefined || value === null ? null : <pre>{String(value)}</pre>;
	if (value.type === "text" && typeof value.text === "string") return <Markdown text={value.text} onFile={onFile} />;
	if (value.type === "thinking" && typeof value.thinking === "string") return <details className="thinking"><summary><span className="thinking-title">思考</span><span className="thinking-preview">{value.thinking.replace(/\s+/g, " ").trim().slice(0, 180)}</span></summary><Markdown text={value.thinking} onFile={onFile} /></details>;
	if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string" && /^image\/(png|jpeg|webp|gif)$/.test(value.mimeType)) return <img className="tool-image" alt="ツールによる画像" src={`data:${value.mimeType};base64,${value.data}`} />;
	if (value.type === "toolCall") return <p className="muted">ツール呼び出し: {typeof value.name === "string" ? value.name : "tool"}</p>;
	return <pre className="json-content">{JSON.stringify(value, null, 2)}</pre>;
}
