import { useRef, useState } from "react";
import { ATTACHMENT_LIMITS, type AttachmentUpload, isVisionImage } from "../shared/attachments.ts";
import { FileIcon } from "./files/FileIcon.tsx";
import { nextClientId } from "./ids.ts";
import "./ComposerAttachments.css";

export interface DraftAttachment extends AttachmentUpload {
	id: string;
	size: number;
}

// File drafts survive switching conversations without putting large base64 data in localStorage.
const drafts = new Map<string, DraftAttachment[]>();

export function useComposerAttachments(draftKey: string) {
	const [attachments, setAttachments] = useState(() => drafts.get(draftKey) ?? []);
	const current = useRef(attachments);
	const [reading, setReading] = useState(false);
	const readingFiles = useRef(false);
	function update(next: DraftAttachment[]) {
		current.current = next;
		if (next.length) drafts.set(draftKey, next); else drafts.delete(draftKey);
		setAttachments(next);
	}
	async function addFiles(files: File[]) {
		if (!files.length) return;
		if (readingFiles.current) throw new Error("ファイルの読み込みが完了してから追加してください。");
		if (current.current.length + files.length > ATTACHMENT_LIMITS.files) throw new Error("添付は10ファイルまでです。");
		if (files.some((file) => file.size > ATTACHMENT_LIMITS.fileBytes)) throw new Error("添付は1ファイル10 MBまでです。");
		if ([...current.current, ...files].reduce((sum, file) => sum + file.size, 0) > ATTACHMENT_LIMITS.totalBytes)
			throw new Error("添付は合計20 MBまでです。");
		readingFiles.current = true;
		setReading(true);
		try {
			const added = await Promise.all(files.map((file) => new Promise<DraftAttachment>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					if (typeof reader.result !== "string") { reject(new Error(`${file.name}: ファイルを読み込めません。`)); return; }
					const mimeType = file.type || "application/octet-stream";
					resolve({ id: nextClientId(), name: file.name, size: file.size, mimeType, data: reader.result.slice(reader.result.indexOf(",") + 1) });
				};
				reader.onerror = reader.onabort = () => reject(new Error(`${file.name}: ファイルを読み込めません。`));
				reader.readAsDataURL(file);
			})));
			update([...current.current, ...added]);
		} finally { readingFiles.current = false; setReading(false); }
	}
	function remove(ids: string[]) {
		update(current.current.filter((attachment) => !ids.includes(attachment.id)));
	}
	return { attachments, reading, addFiles, remove };
}

export function ComposerAttachments({ attachments, disabled, onRemove }: {
	attachments: DraftAttachment[];
	disabled: boolean;
	onRemove: (id: string) => void;
}) {
	return <ul className="composer-attachments" aria-label="添付ファイル">
		{attachments.map((attachment) => <li className="composer-attachment" key={attachment.id}>
			{isVisionImage(attachment.mimeType)
				? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} />
				: <span className="composer-attachment-icon"><FileIcon name={attachment.name} /></span>}
			<span className="composer-attachment-info"><span title={attachment.name}>{attachment.name}</span><small>{new Intl.NumberFormat("ja-JP", { style: "unit", unit: attachment.size < 1024 * 1024 ? "kilobyte" : "megabyte", maximumFractionDigits: 1 }).format(attachment.size / (attachment.size < 1024 * 1024 ? 1024 : 1024 * 1024))}</small></span>
			<button type="button" aria-label={`${attachment.name}を取り外す`} title="添付を取り外す" disabled={disabled} onClick={() => onRemove(attachment.id)}>×</button>
		</li>)}
	</ul>;
}
