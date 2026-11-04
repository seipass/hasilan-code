import { Fragment, memo, type ReactNode, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightLines, languageForPath } from "../highlight.tsx";

export function SourceLines({ path, lines, selectedLine }: {
	path: string; lines: { number: number; text: string }[]; selectedLine?: number;
}) {
	const language = languageForPath(path);
	const highlighted = useMemo(() => highlightLines(lines.map((line) => line.text).join("\n"), language), [lines, language]);
	return <div className="files-source-lines files-highlight">{lines.map((line, index) => <div key={line.number} data-line={line.number} className={line.number === selectedLine ? "files-selected-line" : undefined}>
		<span className="files-line-number">{line.number}</span><code>{line.text ? highlighted[index] : " "}</code>
	</div>)}</div>;
}

function HighlightedCode({ text, language }: { text: string; language?: string }) {
	const lines = useMemo(() => highlightLines(text, language, language === undefined), [text, language]);
	return <>{lines.map((line, index) => <Fragment key={index}>{index > 0 ? "\n" : null}{line}</Fragment>)}</>;
}

export const FileMarkdown = memo(function FileMarkdown({ text, path, onFile }: { text: string; path: string; onFile: (path: string, line?: number) => void }) {
	return <article className="files-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
		a: ({ href, children }) => {
			if (!href) return <span>{children}</span>;
			if (/^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
			if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return <span>{children}</span>;
			if (href.startsWith("#") && !/^#L?\d+$/.test(href)) return <a href={href}>{children}</a>;
			const match = /^(.*?)(?:#L?(\d+))?$/.exec(href);
			let relative: string;
			try { relative = decodeURIComponent(match?.[1] ?? href); } catch { return <span>{children}</span>; }
			const parts = relative ? (relative.startsWith("/") ? relative.slice(1) : [...path.split(/[\\/]/).slice(0, -1), relative].join("/")).split("/") : path.split(/[\\/]/);
			const normalized: string[] = [];
			for (const part of parts) {
				if (part === "..") {
					if (normalized.length === 0) return <span>{children}</span>;
					normalized.pop();
				} else if (part && part !== ".") normalized.push(part);
			}
			if (normalized.length === 0) return <span>{children}</span>;
			return <button className="text-link" onClick={() => onFile(normalized.join("/"), match?.[2] ? Number(match[2]) : undefined)}>{children}</button>;
		},
		img: ({ src, alt }) => src && /^https?:\/\//i.test(src) ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || "画像リンク"}</a> : <span>{alt || "画像"}</span>,
		pre: ({ children }) => <pre className="files-highlight">{children}</pre>,
		code: ({ children, className, node }) => {
			const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1];
			const fenced = !!language || !!node?.position && node.position.start.line !== node.position.end.line;
			return <code className={className}>{fenced && typeof children === "string" ? <HighlightedCode text={children} language={language} /> : children}</code>;
		},
	}}>{text}</ReactMarkdown></article>;
});
