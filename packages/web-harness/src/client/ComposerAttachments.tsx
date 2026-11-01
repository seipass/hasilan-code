import { type Ref, useEffect, useRef, useState } from "react";
import { ATTACHMENT_LIMITS, type DraftAttachment, isDraftAttachments, isVisionImage } from "../shared/attachments.ts";
import { FileIcon } from "./files/FileIcon.tsx";
import { nextClientId } from "./ids.ts";
import { preferences } from "./preferences.ts";
import "./ComposerAttachments.css";

export type { DraftAttachment } from "../shared/attachments.ts";

export function useComposerAttachments(draftKey: string) {
	const key = `pi-web-attachments:${draftKey}`;
	const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
	const current = useRef(attachments);
	const [reading, setReading] = useState(true);
	const [error, setError] = useState<string>();
	const readingFiles = useRef(false);
	useEffect(() => {
		let mounted = true;
		const sync = () => {
			try {
				const value: unknown = JSON.parse(preferences.getItem(key) ?? "[]");
				if (mounted && isDraftAttachments(value)) { current.current = value; setAttachments(value); }
			} catch { /* Invalid drafts are not offered for sending. */ }
		};
		const unsubscribe = preferences.subscribe(key, sync);
		void preferences.load(key).then(() => { sync(); if (mounted) { setReading(false); setError(undefined); } }).catch(() => {
			if (mounted) { setReading(false); setError("添付の下書きを読み込めません。画面を再読み込みしてください。"); }
		});
		return () => { mounted = false; unsubscribe(); };
	}, [key]);
	function update(next: DraftAttachment[]) {
		current.current = next;
		if (next.length) preferences.setItem(key, JSON.stringify(next)); else preferences.removeItem(key);
		setAttachments(next);
	}
	async function addFiles(files: File[]) {
		if (!files.length) return;
		if (error) throw new Error(error);
		if (reading) throw new Error("添付の読み込みが完了してから追加してください。");
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
			await preferences.flush();
		} finally { readingFiles.current = false; setReading(false); }
	}
	function remove(ids: string[]) {
		update(current.current.filter((attachment) => !ids.includes(attachment.id)));
	}
	return { attachments, reading, error, addFiles, remove };
}

export function ComposerAttachments({ attachments, disabled, onRemove, ref }: {
	attachments: DraftAttachment[];
	disabled: boolean;
	onRemove: (id: string) => void;
	ref?: Ref<HTMLUListElement>;
}) {
	return <ul ref={ref} className="composer-attachments" aria-label="添付ファイル">
		{attachments.map((attachment) => <li className="composer-attachment" key={attachment.id}>
			{isVisionImage(attachment.mimeType)
				? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} />
				: <span className="composer-attachment-icon"><FileIcon name={attachment.name} /></span>}
			<span className="composer-attachment-info"><span title={attachment.name}>{attachment.name}</span><small>{new Intl.NumberFormat("ja-JP", { style: "unit", unit: attachment.size < 1024 * 1024 ? "kilobyte" : "megabyte", maximumFractionDigits: 1 }).format(attachment.size / (attachment.size < 1024 * 1024 ? 1024 : 1024 * 1024))}</small></span>
			<button type="button" aria-label={`${attachment.name}を取り外す`} title="添付を取り外す" disabled={disabled} onClick={() => onRemove(attachment.id)}>×</button>
		</li>)}
	</ul>;
}
