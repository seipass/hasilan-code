import { isVisionImage } from "../shared/attachments.ts";
import { Content, record } from "./Content.tsx";
import { FileIcon } from "./files/FileIcon.tsx";
import "./UserMessageContent.css";

export function UserMessageContent({ value, onFile }: { value: unknown; onFile: (path: string, line?: number) => void }) {
	if (!Array.isArray(value)) return <Content value={value} onFile={onFile} />;
	const attachments = value.filter((part) => record(part) && part.type === "fileAttachment" && typeof part.name === "string" && typeof part.path === "string" && part.path.startsWith(".hasilan-code/attachments/"));
	if (!attachments.length) return <Content value={value} onFile={onFile} />;
	const annotations: { name: string; title: string; note: string }[] = [];
	const remaining = value.filter((part) => !attachments.includes(part)).map((part) => {
		if (!record(part) || part.type !== "text" || typeof part.text !== "string") return part;
		const text = part.text.replace(/(?:^|\n\n)ブラウザ注釈 (\d+)（画像: (browser-comment-\d+\.png)）\n([^\n]+)\nコメント: ([\s\S]*?)(?=\n\nブラウザ注釈 \d+（画像: browser-comment-\d+\.png）\n|$)/g, (match, _index: string, name: string, selection: string, note: string) => {
			if (!attachments.some((item) => record(item) && item.name === name)) return match;
			try {
				const parsed: unknown = JSON.parse(selection);
				if (!record(parsed) || typeof parsed.url !== "string") return match;
				annotations.push({ name, title: typeof parsed.title === "string" && parsed.title ? parsed.title : parsed.url, note });
				return "";
			} catch { return match; }
		});
		return { ...part, text };
	});
	return <>
		<div className="sent-attachments">{attachments.map((part, index) => {
			if (!record(part) || typeof part.path !== "string" || typeof part.name !== "string") return null;
			const path = part.path;
			const annotation = annotations.find((item) => item.name === part.name);
			const image = typeof part.mimeType === "string" && isVisionImage(part.mimeType) && typeof part.url === "string" && /^\/api\/workspaces\/[^/]+\/file-content\?/.test(part.url) ? part.url : undefined;
			const size = typeof part.size === "number" ? new Intl.NumberFormat("ja-JP", { style: "unit", unit: part.size < 1048576 ? "kilobyte" : "megabyte", maximumFractionDigits: 1 }).format(part.size / (part.size < 1048576 ? 1024 : 1048576)) : "";
			return <button type="button" className="sent-attachment" key={`${path}:${index}`} onClick={() => onFile(path)}>
				{image ? <img src={image} alt="" loading="lazy" /> : <span className="sent-attachment-icon"><FileIcon name={part.name} /></span>}
				<span className="sent-attachment-info"><strong>{annotation?.title ?? part.name}</strong><small>{annotation?.note ?? size}</small></span>
			</button>;
		})}</div>
		<Content value={remaining} onFile={onFile} />
	</>;
}
