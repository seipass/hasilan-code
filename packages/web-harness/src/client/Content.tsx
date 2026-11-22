import type { Element as HastElement, ElementContent } from "hast";
import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isVisionImage } from "../shared/attachments.ts";
import { TEXT_TRANSFORM_ID } from "../shared/plugin-profile.ts";
import { api, errorMessage } from "./api.ts";
import { ColorPreviewSpan, rehypeColorPreview, splitColorPreview } from "./ColorPreview.tsx";
import { highlightLines } from "./highlight.tsx";
import { Icon } from "./Icon.tsx";
import { usePluginProfile } from "./plugins/profile.tsx";
import "./TextTransform.css";

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hastText(node: ElementContent): string {
	if (node.type === "text") return node.value;
	if (node.type === "element") return node.children.map(hastText).join("");
	return "";
}

function decoratePreview(nodes: ReactNode[], prefix: string): ReactNode[] {
	return nodes.map((part, index) => {
		if (typeof part === "string") return splitColorPreview(part, `${prefix}-${index}`);
		if (isValidElement<{ children?: ReactNode }>(part) && typeof part.props.children === "string") {
			return cloneElement(part, { key: part.key ?? `${prefix}-${index}` }, splitColorPreview(part.props.children, `${prefix}-${index}`));
		}
		return part;
	});
}

function CodeBlock({ code, language, colorPreview }: { code: string; language?: string; colorPreview: boolean }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const highlighted = useMemo(() => {
		const trimmed = code.endsWith("\n") ? code.slice(0, -1) : code;
		const lines = highlightLines(trimmed, language, !language);
		return lines.map((line, lineIndex) => {
			const items = colorPreview ? decoratePreview(line, `l${lineIndex}`) : line;
			return <span key={lineIndex} className="code-block-line">{items}{lineIndex < lines.length - 1 ? "\n" : null}</span>;
		});
	}, [code, language, colorPreview]);
	async function copyCode() {
		try {
			await navigator.clipboard.writeText(code.endsWith("\n") ? code.slice(0, -1) : code);
			setCopied(true);
			window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), 1600);
		} catch { /* Clipboard unavailable. */ }
	}
	return (
		<div className="code-block">
			<div className="code-block-header">
				<span className="code-block-lang">{language || "code"}</span>
				<button type="button" className="code-block-copy" aria-label={copied ? "コピーしました" : "コードをコピー"} onClick={() => { void copyCode(); }}>
					<Icon name={copied ? "check" : "copy"} size="inline" />
					<span>{copied ? "コピー済み" : "コピー"}</span>
				</button>
			</div>
			<pre><code>{highlighted}</code></pre>
		</div>
	);
}

export function Markdown({ text, onFile, colorPreview = false }: { text: string; onFile: (path: string, line?: number) => void; colorPreview?: boolean }) {
	return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={colorPreview ? [rehypeColorPreview] : []} skipHtml components={{
		span: ColorPreviewSpan,
		pre: ({ node, children }) => {
			const codeChild = node?.children.find((child): child is HastElement => child.type === "element" && child.tagName === "code");
			if (!codeChild) return <pre>{children}</pre>;
			const rawClass: unknown = codeChild.properties?.className;
			const classes: string[] = Array.isArray(rawClass)
				? rawClass.map(String)
				: typeof rawClass === "string"
					? rawClass.split(/\s+/)
					: [];
			const language = classes
				.map((item) => /^language-([a-z0-9_+-]+)$/i.exec(item)?.[1])
				.find(Boolean);
			const rawCode = hastText(codeChild);
			return <CodeBlock code={rawCode} language={language} colorPreview={colorPreview} />;
		},
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

export function Content({ value, onFile, activeThinking = false, colorPreview = false }: { value: unknown; onFile: (path: string, line?: number) => void; activeThinking?: boolean; colorPreview?: boolean }) {
	if (typeof value === "string") return <Markdown text={value} onFile={onFile} colorPreview={colorPreview} />;
	if (Array.isArray(value)) return <>{value.map((part: unknown, index: number) => <Content key={index} value={part} onFile={onFile} activeThinking={activeThinking && index === value.length - 1} colorPreview={colorPreview} />)}</>;
	if (!record(value)) return value === undefined || value === null ? null : <pre>{String(value)}</pre>;
	if (value.type === "text" && typeof value.text === "string") return <Markdown text={value.text} onFile={onFile} colorPreview={colorPreview} />;
	if (value.type === "thinking" && typeof value.thinking === "string") return <Thinking text={value.thinking} summary={typeof value.summary === "string" ? value.summary : undefined} redacted={value.redacted === true} onFile={onFile} initiallyOpen={activeThinking} />;
	if (value.type === "fileAttachment" && typeof value.path === "string" && value.path.startsWith(".hasilan-code/attachments/") && typeof value.name === "string") {
		const path = value.path;
		const image = typeof value.mimeType === "string" && isVisionImage(value.mimeType) && typeof value.url === "string" && /^\/api\/workspaces\/[^/]+\/file-content\?/.test(value.url) ? value.url : undefined;
		return <figure className="message-attachment">
			{image && <button type="button" aria-label={`${value.name}を開く`} onClick={() => onFile(path)}><img className="tool-image" loading="lazy" src={image} alt={value.name} /></button>}
			<figcaption><button type="button" className="text-link" onClick={() => onFile(path)}>{value.name}</button></figcaption>
		</figure>;
	}
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
function Thinking({ text, summary, redacted, onFile, initiallyOpen }: { text: string; summary?: string; redacted: boolean; onFile: (path: string, line?: number) => void; initiallyOpen: boolean }) {
	const [open, setOpen] = useState(initiallyOpen);
	const [bodyPresent, setBodyPresent] = useState(initiallyOpen);
	const [result, setResult] = useState<{ operation: "translate" | "summarize"; text?: string; source: string; error?: string }>();
	const [busy, setBusy] = useState(false);
	const pending = useRef<AbortController | undefined>(undefined);
	useEffect(() => () => pending.current?.abort(), []);
	useEffect(() => {
		if (open || !bodyPresent) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !CSS.supports("interpolate-size", "allow-keywords")) {
			setBodyPresent(false);
			return;
		}
		// Keep the body until the native closing transition finishes, then release long thoughts.
		const timeout = window.setTimeout(() => setBodyPresent(false), 300);
		return () => window.clearTimeout(timeout);
	}, [open, bodyPresent]);
	async function transform(operation: "translate" | "summarize") {
		const source = text || summary || "";
		if (!source.trim()) return;
		pending.current?.abort();
		const controller = new AbortController(); pending.current = controller;
		setOpen(true); setBusy(true); setResult({ operation, source });
		try {
			const response = await api<{ text: string }>("/api/text-transform", { method: "POST", body: JSON.stringify({ operation, source: { kind: "text", text: source } }), signal: controller.signal });
			if (!controller.signal.aborted) setResult({ operation, text: response.text, source });
		} catch (error) { if (!controller.signal.aborted) setResult({ operation, source, error: errorMessage(error) }); }
		finally { if (!controller.signal.aborted) setBusy(false); }
	}
	const source = text || summary || "";
	const tail: string[] = [];
	let space = false;
	for (let index = source.length - 1; index >= 0; index--) {
		const character = source[index];
		if (/\s/.test(character)) { if (tail.length) space = true; continue; }
		if (space) { tail.push(" "); space = false; }
		tail.push(character);
		if (tail.length > 180) break;
	}
	const transformEnabled = usePluginProfile()?.activeIds.includes(TEXT_TRANSFORM_ID) ?? true;
	const preview = tail.reverse().join("");
	const previewTail = preview.length > 180 ? `…${preview.slice(-180)}` : preview;
	return <details className="thinking" open={open} onToggle={(event) => { const next = event.currentTarget.open; if (next) setBodyPresent(true); setOpen(next); }} onTransitionEnd={(event) => { if (!open && event.target === event.currentTarget && event.propertyName === "height" && event.nativeEvent.pseudoElement === "::details-content") setBodyPresent(false); }}><summary onClick={(event) => { event.preventDefault(); if (!open) setBodyPresent(true); setOpen((current) => !current); }}><Icon name="sparkles" size="inline" className="thinking-icon" /><span className="thinking-title">{summary && !text ? "推論の要約" : "思考"}</span>{transformEnabled && <span className="thinking-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><button type="button" title="思考を翻訳" aria-label="思考を翻訳" disabled={busy || !(text || summary)} onClick={() => { void transform("translate"); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h12M9 3v3c0 5-3 8-6 9M5 9c1 3 4 5 7 6M13 20l4-10 4 10M14.5 17h5" /></svg></button><button type="button" title="思考を要約" aria-label="思考を要約" disabled={busy || !(text || summary)} onClick={() => { void transform("summarize"); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 11h16M4 16h10M4 21h7" /></svg></button></span>}<span className="thinking-preview"><span>{previewTail || (redacted ? "暗号化された推論（原記録に保持）" : "")}</span></span></summary>{bodyPresent && <>{result ? <div className="text-transform-result"><div className="text-transform-header"><strong>{result.operation === "translate" ? "翻訳" : "要約"}</strong><button type="button" onClick={() => { pending.current?.abort(); setBusy(false); setResult(undefined); }}>原文を表示</button></div>{busy ? <p role="status">処理中…</p> : result.error ? <p role="alert" className="error">{result.error}</p> : <Markdown text={result.text ?? ""} onFile={onFile} />}{result.source !== (text || summary || "") && <p className="muted">実行時の内容を表示しています。</p>}</div> : <>{text && <Markdown text={text} onFile={onFile} />}{summary && <div className="thinking-summary"><strong>保存された要約</strong><Markdown text={summary} onFile={onFile} /></div>}</>}{redacted && <p className="muted">暗号化された内容は復号していません。元のデータを保存しています。</p>}</>}</details>;
}
