import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function Markdown({ text, onFile }: { text: string; onFile: (path: string, line?: number) => void }) {
	return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
		table: ({ children }) => <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="表"><table>{children}</table></div>,
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
	if (value.type === "thinking" && typeof value.thinking === "string") return <Thinking text={value.thinking} summary={typeof value.summary === "string" ? value.summary : undefined} redacted={value.redacted === true} onFile={onFile} />;
	if (value.type === "attachment") {
		const name = typeof value.name === "string" ? value.name : "添付ファイル";
		const url = typeof value.url === "string" && (/^\/api\/session-imports\/[^/]+\/assets\/[a-f0-9]{64}$/.test(value.url) || /^https?:\/\//i.test(value.url)) ? value.url : undefined;
		const local = url?.startsWith("/api/session-imports/");
		return <figure className="imported-attachment">
			{local && typeof value.mimeType === "string" && /^image\/(png|jpeg|webp|gif)$/.test(value.mimeType) && <img className="tool-image" loading="lazy" src={url} alt={name} />}
			{local && typeof value.mimeType === "string" && value.mimeType.startsWith("audio/") && <audio controls preload="none" src={url}><track kind="captions" /></audio>}
			{local && typeof value.mimeType === "string" && value.mimeType.startsWith("video/") && <video controls preload="none" src={url}><track kind="captions" /></video>}
			<figcaption>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{name}</a> : name}{typeof value.unavailable === "string" && <p className="muted">{value.unavailable}</p>}</figcaption>
		</figure>;
	}
	if (value.type === "toolResult") return <details className="context-entry"><summary>ツール結果: {typeof value.id === "string" ? value.id : "不明"}</summary><Content value={value.content} onFile={onFile} /></details>;
	if (value.type === "sourceBlock") return <p className="muted">{typeof value.label === "string" ? value.label : "元のデータ"}（原記録に保存）</p>;
	if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string" && /^image\/(png|jpeg|webp|gif)$/.test(value.mimeType)) return <img className="tool-image" alt="ツールによる画像" src={`data:${value.mimeType};base64,${value.data}`} />;
	if (value.type === "toolCall") return <p className="muted">ツール呼び出し: {typeof value.name === "string" ? value.name : "tool"}</p>;
	return <pre className="json-content">{JSON.stringify(value, null, 2)}</pre>;
}
import { useState } from "react";

function Thinking({ text, summary, redacted, onFile }: { text: string; summary?: string; redacted: boolean; onFile: (path: string, line?: number) => void }) {
	const [open, setOpen] = useState(false);
	return <details className="thinking" onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span className="thinking-title">{summary && !text ? "推論の要約" : "思考"}</span><span className="thinking-preview">{(text || summary || "").replace(/\s+/g, " ").trim().slice(0, 180) || (redacted ? "暗号化された推論（原記録に保持）" : "")}</span></summary>{open && <>{text && <Markdown text={text} onFile={onFile} />}{summary && <div className="thinking-summary"><strong>保存された要約</strong><Markdown text={summary} onFile={onFile} /></div>}{redacted && <p className="muted">暗号化された内容は復号していません。元のデータを保存しています。</p>}</>}</details>;
}
