import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioMetadata } from "../../shared/media.ts";
import { api, errorMessage } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { mediaReady, Presence } from "../Motion.tsx";
import { AudioPreview } from "./AudioPreview.tsx";
import { FileMarkdown, SourceLines } from "./FileRendering.tsx";
import { FileEditor } from "./FileEditor.tsx";
import { ImagePreview } from "./ImagePreview.tsx";
import { activeHeadingIndex, type MarkdownHeading, MarkdownToc } from "./MarkdownToc.tsx";

export interface FileTab {
	path: string;
	line?: number;
	offset: number;
	mode?: "source" | "rendered";
	/** Set once a viewer reports a file it cannot edit, so the tab can say so. */
	readOnly?: boolean;
}
interface FileView {
	path: string; revision: string; kind: "text" | "image" | "video" | "audio" | "binary"; audio?: AudioMetadata; mime?: string;
	lines?: { number: number; text: string; truncated?: boolean }[]; nextOffset?: number; size: number;
}
export function FilePreview({ workspaceId, file, visible, refreshKey, id, labelledBy, onOpen, onChange, transformRequest, onTransformHandled }: {
	workspaceId: string; file?: FileTab; visible: boolean; refreshKey: string; id: string; labelledBy?: string;
	transformRequest?: { path: string; operation: "translate" | "summarize"; requestId: string };
	onTransformHandled: (requestId: string) => void;
	onOpen: (path: string, line?: number) => void; onChange: (path: string, patch: Partial<FileTab>) => void;
}) {
	const [result, setResult] = useState<{ key: string; view?: FileView; markdown?: string; error?: string }>();
	const viewer = useRef<HTMLDivElement>(null);
	const markdownBody = useRef<HTMLDivElement>(null);
	const [headings, setHeadings] = useState<MarkdownHeading[]>([]);
	const [activeHeading, setActiveHeading] = useState(0);
	const [tocPreference, setTocPreference] = useState<boolean>();
	const [viewerWidth, setViewerWidth] = useState(0);
	const [transformed, setTransformed] = useState<{ path: string; operation: "translate" | "summarize"; text?: string; error?: string; busy?: boolean }>();
	const transformController = useRef<AbortController | undefined>(undefined);
	useEffect(() => () => transformController.current?.abort(), []);
	useEffect(() => {
		if (!transformRequest || !file || transformRequest.path !== file.path) return;
		const { operation, path, requestId } = transformRequest;
		transformController.current?.abort();
		const controller = new AbortController(); transformController.current = controller;
		setTransformed({ path, operation, busy: true }); onTransformHandled(requestId);
		void api<{ text: string }>("/api/text-transform", { method: "POST", body: JSON.stringify({ operation, source: { kind: "file", workspaceId, path } }), signal: controller.signal }).then((result) => {
			if (!controller.signal.aborted) setTransformed({ path, operation, text: result.text });
		}).catch((error: unknown) => { if (!controller.signal.aborted) setTransformed({ path, operation, error: errorMessage(error) }); });
	}, [transformRequest?.requestId, file?.path, workspaceId]);
	const markdown = !!file && /\.(?:md|markdown)$/i.test(file.path);
	const rendered = markdown && (file.mode ?? (file.line === undefined ? "rendered" : "source")) === "rendered";
	const requestKey = file ? JSON.stringify([workspaceId, file.path, file.offset, rendered, refreshKey]) : undefined;
	const loaded = result?.key === requestKey ? result : undefined;
	const output = transformed?.path === file?.path ? transformed : undefined;
	useEffect(() => {
		if (!visible || !file || !requestKey) return;
		const controller = new AbortController();
		const key = requestKey;
		const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(file.path)}`;
		void (async () => {
			let offset = rendered ? 1 : file.offset;
			const view = await api<FileView>(`${endpoint}&offset=${offset}&limit=200`, { signal: controller.signal });
			let text: string | undefined;
			if (rendered && view.kind === "text") {
				const lines: string[] = [];
				let page = view;
				for (;;) {
					if (page.revision !== view.revision || page.kind !== "text") throw new Error("読み込み中にファイルが変更されました。タブを選び直してください。");
					if (page.lines?.some((line) => line.truncated)) throw new Error("64 KiB を超える行があるため Markdown 全文を取得できません。ソース表示で確認してください。");
					for (const line of page.lines ?? []) lines.push(line.text);
					if (page.nextOffset === undefined) break;
					if (page.nextOffset <= offset) throw new Error("ファイルの続きの位置が不正です。");
					offset = page.nextOffset;
					page = await api<FileView>(`${endpoint}&offset=${offset}&limit=200`, { signal: controller.signal });
				}
				text = lines.join("\n");
			}
			if (!controller.signal.aborted) setResult({ key, view, markdown: text });
		})().catch((reason: unknown) => { if (!controller.signal.aborted) setResult({ key, error: errorMessage(reason) }); });
		return () => controller.abort();
	}, [workspaceId, file?.path, file?.offset, requestKey, rendered, visible]);
	useEffect(() => { viewer.current?.scrollTo({ top: 0 }); }, [file?.path, file?.offset, rendered]);
	useEffect(() => {
		if (visible && loaded?.view && file?.line) viewer.current?.querySelector(`[data-line="${file.line}"]`)?.scrollIntoView({ block: "center", inline: "nearest" });
	}, [loaded?.view, file?.line, visible]);
	useEffect(() => {
		if (!file || !loaded?.view) return;
		const readOnly = loaded.view.kind !== "text" || loaded.view.size > 2 * 1024 * 1024;
		if (readOnly !== !!file.readOnly) onChange(file.path, { readOnly });
	}, [file?.path, file?.readOnly, loaded?.view?.kind, loaded?.view?.size]);
	useEffect(() => {
		const element = viewer.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setViewerWidth(element.clientWidth));
		observer.observe(element);
		setViewerWidth(element.clientWidth);
		return () => observer.disconnect();
	}, []);
	const showingMarkdown = !output && rendered && loaded?.view?.kind === "text" && !!loaded.markdown;
	useEffect(() => {
		if (!showingMarkdown) {
			setHeadings([]);
			setActiveHeading(0);
			return;
		}
		const root = markdownBody.current;
		if (!root) return;
		const collected: MarkdownHeading[] = [];
		root.querySelectorAll<HTMLElement>("h1, h2, h3, h4").forEach((element, index) => {
			const text = element.textContent?.trim() ?? "";
			if (!text) return;
			const depth = Number(element.tagName.slice(1)) as 1 | 2 | 3 | 4;
			collected.push({ index, depth, text, element });
		});
		setHeadings(collected);
		setActiveHeading(0);
	}, [showingMarkdown, loaded?.key]);
	useEffect(() => {
		const container = viewer.current;
		if (!container || headings.length < 2) return;
		const sync = () => {
			const containerTop = container.getBoundingClientRect().top;
			const relativeTops = headings.map((heading) => heading.element.getBoundingClientRect().top - containerTop);
			setActiveHeading(activeHeadingIndex(relativeTops, 64));
		};
		sync();
		container.addEventListener("scroll", sync, { passive: true });
		return () => container.removeEventListener("scroll", sync);
	}, [headings]);
	const wideMarkdown = viewerWidth >= 680;
	const hasToc = showingMarkdown && headings.length >= 2;
	const tocOpen = hasToc && (tocPreference ?? wideMarkdown);
	const jumpToHeading = useCallback((heading: MarkdownHeading) => {
		heading.element.scrollIntoView({ behavior: "smooth", block: "start" });
		setActiveHeading(heading.index);
		if (!wideMarkdown) setTocPreference(false);
	}, [wideMarkdown]);
	return <>
		{output ? <div className="files-view-mode text-transform-header"><strong>{output.operation === "translate" ? "翻訳" : "要約"}</strong><button type="button" onClick={() => { transformController.current?.abort(); setTransformed(undefined); }}>原文を表示</button></div> : markdown && file && <div className="files-view-mode" role="group" aria-label="Markdown の表示方法"><button aria-pressed={rendered} onClick={() => onChange(file.path, { mode: "rendered", line: undefined })}>プレビュー</button><button aria-pressed={!rendered} onClick={() => onChange(file.path, { mode: "source" })}>ソース</button>{hasToc && <button type="button" className="files-toc-toggle" aria-pressed={tocOpen} onClick={() => setTocPreference(!tocOpen)}><Icon name="list" size="inline" /><span>目次</span><span className="files-toc-count">{headings.length}</span></button>}</div>}
		<div className={`files-viewer${!output && !rendered && loaded?.view?.kind === "text" && loaded.view.size <= 2 * 1024 * 1024 ? " is-editing" : ""}`} id={id} role="tabpanel" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : "ファイルプレビュー"} ref={viewer} tabIndex={0} aria-busy={output ? !!output.busy : !!file && !loaded}>
			{output ? <div className="text-transform-result">{output.busy ? <p role="status">処理中…</p> : output.error ? <p className="error" role="alert">{output.error}</p> : file && <FileMarkdown text={output.text ?? ""} path={file.path} onFile={onOpen} />}</div> : <>
			<Presence show={!file}><p className="files-message muted">このペインで開くファイルをツリーから選択してください。</p></Presence>
			<Presence show={!!file && !loaded}><p className="files-message" role="status">読み込み中…</p></Presence>
			<Presence show={!!loaded?.error}><p role="alert" className="files-message error">{loaded?.error}</p></Presence>
			<Presence show={!!file && !!loaded?.view && !loaded.error}>{file && loaded?.view && <div className={`files-content${loaded.view.kind === "audio" ? " files-content-audio" : ""}`} key={loaded.key}>
				{loaded.view.kind === "text" && rendered && loaded.markdown !== undefined && (loaded.markdown === "" ? <p className="files-message muted">空のファイル</p> : <div className={`files-markdown-shell${tocOpen ? (wideMarkdown ? " has-docked-toc" : " has-floating-toc") : ""}`}>
					<div ref={markdownBody}><FileMarkdown text={loaded.markdown} path={file.path} onFile={onOpen} /></div>
					{tocOpen && <MarkdownToc headings={headings} activeIndex={activeHeading} floating={!wideMarkdown} onSelect={jumpToHeading} />}
				</div>)}
				{loaded.view.kind === "text" && !rendered && loaded.view.size <= 2 * 1024 * 1024 && <FileEditor workspaceId={workspaceId} path={file.path} line={file.line} visible={visible} />}
				{loaded.view.kind === "text" && !rendered && loaded.view.size > 2 * 1024 * 1024 && <>
					{loaded.view.size > 2 * 1024 * 1024 && <p className="files-message muted">2 MB を超えるファイルは閲覧のみ対応しています。</p>}
					{file.offset > 1 && <div className="files-page"><button onClick={() => onChange(file.path, { offset: Math.max(1, file.offset - 200) })}>前の行</button></div>}
					{loaded.view.lines?.length === 0 && <p className="files-message muted">空のファイル</p>}
					<SourceLines path={file.path} lines={loaded.view.lines ?? []} selectedLine={file.line} />
					{loaded.view.lines?.some((line) => line.truncated) && <p className="files-message warning">64 KiB の表示上限を超える行は先頭のみ表示しています。省略された行: {loaded.view.lines.filter((line) => line.truncated).map((line) => line.number).join(", ")}</p>}
					{loaded.view.nextOffset && <div className="files-page"><button onClick={() => onChange(file.path, { offset: loaded.view!.nextOffset! })}>次の行 ({loaded.view.nextOffset}〜)</button></div>}
				</>}
				{loaded.view.kind === "image" && <ImagePreview
					path={loaded.view.path}
					size={loaded.view.size}
					mime={loaded.view.mime}
					revision={loaded.view.revision}
					visible={visible}
					src={`/api/workspaces/${encodeURIComponent(workspaceId)}/file-content?path=${encodeURIComponent(loaded.view.path)}&revision=${encodeURIComponent(loaded.view.revision)}`}
				/>}
				{loaded.view.kind === "video" && <div className="files-video-preview"><video className="files-video" controls playsInline preload="metadata" onLoadedData={(event) => mediaReady(event.currentTarget)} aria-label={loaded.view.path} src={`/api/workspaces/${encodeURIComponent(workspaceId)}/file-content?path=${encodeURIComponent(loaded.view.path)}&revision=${encodeURIComponent(loaded.view.revision)}`} onError={() => setResult((current) => current?.key === loaded.key ? { ...current, error: "動画を再生できません。ファイルの破損、またはブラウザー非対応のコーデックを確認してください。" } : current)}>お使いのブラウザーは動画再生に対応していません。</video></div>}
				{loaded.view.kind === "audio" && <AudioPreview path={loaded.view.path} metadata={loaded.view.audio} visible={visible} src={`/api/workspaces/${encodeURIComponent(workspaceId)}/file-content?path=${encodeURIComponent(loaded.view.path)}&revision=${encodeURIComponent(loaded.view.revision)}`} />}
				{loaded.view.kind === "binary" && <p className="files-message">バイナリファイル</p>}
			</div>}</Presence></>}
		</div>
	</>;
}
