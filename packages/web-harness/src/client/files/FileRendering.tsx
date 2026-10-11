import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Fragment, memo, type ReactNode, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const highlighter = hljs.newInstance();
for (const [name, language] of Object.entries({ bash, cpp, csharp, css, diff, go, ini, java, javascript, json, markdown, powershell, python, rust, sql, typescript, xml, yaml }))
	highlighter.registerLanguage(name, language);

const extensions: Record<string, string> = {
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	json: "json", jsonc: "json", css: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml",
	py: "python", pyw: "python", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psm1: "powershell",
	md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini",
	c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp", java: "java",
	go: "go", rs: "rust", sql: "sql", diff: "diff", patch: "diff",
};

function highlightedLines(text: string, language?: string, auto = false): ReactNode[][] {
	if ((!language || !highlighter.getLanguage(language)) && !auto) return text.split("\n").map((line) => [line]);
	const result = language && highlighter.getLanguage(language)
		? highlighter.highlight(text, { language, ignoreIllegals: true })
		: highlighter.highlightAuto(text, ["javascript", "typescript", "python", "json", "bash", "css", "xml", "sql"]);
	// Only highlight.js's escaped output enters this inert document. No parsed node,
	// HTML string, or unapproved attribute is inserted into the live DOM.
	const document = new DOMParser().parseFromString(result.value, "text/html");
	const lines: ReactNode[][] = [[]];
	let key = 0;
	function collect(node: Node, classes: string[]) {
		if (node.nodeType === Node.TEXT_NODE) {
			const parts = (node.textContent ?? "").split("\n");
			for (let index = 0; index < parts.length; index++) {
				if (index > 0) lines.push([]);
				if (!parts[index]) continue;
				lines[lines.length - 1].push(classes.length > 0 ? <span key={key++} className={classes.join(" ")}>{parts[index]}</span> : parts[index]);
			}
			return;
		}
		const tokenClasses = node instanceof Element && node.tagName === "SPAN"
			? Array.from(node.classList).filter((name) => /^hljs-[a-z0-9_-]+$/i.test(name)) : [];
		for (const child of node.childNodes) collect(child, [...classes, ...tokenClasses]);
	}
	for (const node of document.body.childNodes) collect(node, []);
	return lines;
}

export function SourceLines({ path, lines, selectedLine }: {
	path: string; lines: { number: number; text: string }[]; selectedLine?: number;
}) {
	const language = extensions[path.split(".").at(-1)?.toLowerCase() ?? ""];
	const highlighted = useMemo(() => highlightedLines(lines.map((line) => line.text).join("\n"), language), [lines, language]);
	return <div className="files-source-lines files-highlight">{lines.map((line, index) => <div key={line.number} data-line={line.number} className={line.number === selectedLine ? "files-selected-line" : undefined}>
		<span className="files-line-number">{line.number}</span><code>{line.text ? highlighted[index] : " "}</code>
	</div>)}</div>;
}

function HighlightedCode({ text, language }: { text: string; language?: string }) {
	const lines = useMemo(() => highlightedLines(text, language, language === undefined), [text, language]);
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
