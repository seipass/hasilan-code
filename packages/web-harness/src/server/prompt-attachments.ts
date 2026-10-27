import type { ImageContent } from "@hasilan-code/pi-ai";
import {
	ATTACHMENT_LIMITS,
	type AttachmentUpload,
	attachmentImageUrl,
	isVisionImage,
	type PromptAttachment,
	parseAttachmentPrompt,
} from "../shared/attachments.ts";
import { HttpError } from "./http-host.ts";
import { fileRevision, imageMime, type WorkspaceFiles } from "./workspace-files.ts";

export async function savePromptAttachments(
	files: WorkspaceFiles,
	workspaceId: string,
	uploads: AttachmentUpload[],
): Promise<PromptAttachment[]> {
	files.getWorkspaceRoot(workspaceId);
	if (uploads.length > ATTACHMENT_LIMITS.files) throw new HttpError(400, "添付は10ファイルまでです。");
	let total = 0;
	const prepared = uploads.map((upload) => {
		const bytes = Buffer.from(upload.data, "base64");
		if (bytes.toString("base64") !== upload.data) throw new HttpError(400, "添付ファイルのデータが不正です。");
		if (bytes.length > ATTACHMENT_LIMITS.fileBytes) throw new HttpError(413, "添付は1ファイル10 MBまでです。");
		total += bytes.length;
		if (total > ATTACHMENT_LIMITS.totalBytes) throw new HttpError(413, "添付は合計20 MBまでです。");
		const name =
			upload.name
				.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
				.replace(/[. ]+$/g, "")
				.slice(-180) || "file";
		const revision = fileRevision(bytes);
		const detectedImage = imageMime(bytes);
		const attachment: PromptAttachment = {
			name: upload.name,
			path: `.hasilan-code/attachments/${revision}-${name}`,
			mimeType: detectedImage ?? upload.mimeType,
			size: bytes.length,
			revision,
		};
		if (isVisionImage(upload.mimeType) && !isVisionImage(detectedImage ?? ""))
			throw new HttpError(400, `${upload.name}: 画像データを読み込めません。`);
		return { attachment, bytes };
	});
	for (const { attachment, bytes } of prepared) {
		try {
			await files.create(workspaceId, attachment.path, bytes);
		} catch (error) {
			// Retrying a failed send reuses the exact upload without overwriting another file.
			const existing = await files.read(workspaceId, attachment.path).catch(() => undefined);
			if (existing?.revision !== attachment.revision) throw error;
		}
	}
	return prepared.map(({ attachment }) => attachment);
}

export async function readAttachmentImages(
	files: WorkspaceFiles,
	workspaceId: string,
	attachments: PromptAttachment[],
): Promise<ImageContent[]> {
	const images: ImageContent[] = [];
	for (const attachment of attachments) {
		const snapshot = await files.read(workspaceId, attachment.path);
		if (snapshot.revision !== attachment.revision)
			throw new Error(`添付ファイルが変更されています: ${attachment.name}`);
		if (isVisionImage(attachment.mimeType)) {
			const mimeType = imageMime(snapshot.bytes);
			if (mimeType !== attachment.mimeType) throw new Error(`画像データが不正です: ${attachment.name}`);
			images.push({ type: "image", mimeType, data: snapshot.bytes.toString("base64") });
		}
	}
	return images;
}

/** Serve uploaded images separately; base64 image bytes must not fill WebSocket snapshots. */
export function projectAttachmentContent(content: unknown, workspaceId: string): unknown {
	const parts: unknown[] =
		typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
	const attachments: PromptAttachment[] = [];
	const projected = parts.map((part: unknown) => {
		if (
			!part ||
			typeof part !== "object" ||
			!("type" in part) ||
			part.type !== "text" ||
			!("text" in part) ||
			typeof part.text !== "string"
		)
			return part;
		const parsed = parseAttachmentPrompt(part.text);
		attachments.push(...parsed.attachments);
		return parsed.attachments.length ? { type: "text", text: parsed.text } : part;
	});
	if (!attachments.length) return content;
	return [
		...projected.filter((part) => !(part && typeof part === "object" && "type" in part && part.type === "image")),
		...attachments.map((attachment) => ({
			type: "fileAttachment",
			...attachment,
			url: attachmentImageUrl(workspaceId, attachment),
		})),
	];
}
