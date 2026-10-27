import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const ATTACHMENT_LIMITS = {
	files: 10,
	fileBytes: 10 * 1024 * 1024,
	totalBytes: 20 * 1024 * 1024,
	requestBytes: 32 * 1024 * 1024,
} as const;

export const attachmentUploadSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 255 }),
		mimeType: Type.String({ minLength: 1, maxLength: 255 }),
		data: Type.String({ maxLength: Math.ceil(ATTACHMENT_LIMITS.fileBytes / 3) * 4 }),
	},
	{ additionalProperties: false },
);
export type AttachmentUpload = Static<typeof attachmentUploadSchema>;

const promptAttachmentSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 255 }),
		path: Type.String({ pattern: "^\\.hasilan-code/attachments/[a-f0-9]{64}-[^/\\\\\\u0000-\\u001f]+$" }),
		mimeType: Type.String({ minLength: 1, maxLength: 255 }),
		size: Type.Integer({ minimum: 0, maximum: ATTACHMENT_LIMITS.fileBytes }),
		revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	},
	{ additionalProperties: false },
);
export type PromptAttachment = Static<typeof promptAttachmentSchema>;
const promptAttachmentsSchema = Type.Array(promptAttachmentSchema, { maxItems: ATTACHMENT_LIMITS.files });

export function isPromptAttachments(value: unknown): value is PromptAttachment[] {
	return Check(promptAttachmentsSchema, value);
}

export function isVisionImage(mimeType: string): boolean {
	return /^image\/(png|jpeg|gif|webp)$/.test(mimeType);
}

const attachmentStart = "\n\n<hasilan-code-attachments>\n";
const attachmentEnd = "\n</hasilan-code-attachments>";

/** Keep attachment references in SDK history so reloads and queue edits retain them. */
export function attachmentPrompt(text: string, attachments: PromptAttachment[] = []): string {
	return attachments.length ? `${text}${attachmentStart}${JSON.stringify(attachments)}${attachmentEnd}` : text;
}

export function parseAttachmentPrompt(text: string): { text: string; attachments: PromptAttachment[] } {
	const start = text.lastIndexOf(attachmentStart);
	const end = text.indexOf(attachmentEnd, start + attachmentStart.length);
	if (start < 0 || end < 0) return { text, attachments: [] };
	try {
		const attachments: unknown = JSON.parse(text.slice(start + attachmentStart.length, end));
		if (isPromptAttachments(attachments) && attachments.length)
			return { text: text.slice(0, start) + text.slice(end + attachmentEnd.length), attachments };
	} catch {
		/* A literal or incomplete block remains ordinary message text. */
	}
	return { text, attachments: [] };
}

export function attachmentImageUrl(workspaceId: string, attachment: PromptAttachment): string {
	const query = new URLSearchParams({ path: attachment.path, revision: attachment.revision });
	return `/api/workspaces/${encodeURIComponent(workspaceId)}/file-content?${query}`;
}
