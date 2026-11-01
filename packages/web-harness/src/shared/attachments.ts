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

const draftAttachmentsSchema = Type.Array(
	Type.Object(
		{
			...attachmentUploadSchema.properties,
			id: Type.String({ minLength: 1, maxLength: 128 }),
			size: Type.Integer({ minimum: 0, maximum: ATTACHMENT_LIMITS.fileBytes }),
		},
		{ additionalProperties: false },
	),
	{ maxItems: ATTACHMENT_LIMITS.files },
);
export type DraftAttachment = Static<typeof draftAttachmentsSchema>[number];

export function isDraftAttachments(value: unknown): value is DraftAttachment[] {
	if (!Check(draftAttachmentsSchema, value)) return false;
	return (
		new Set(value.map((item) => item.id)).size === value.length &&
		value.reduce((sum, item) => sum + item.size, 0) <= ATTACHMENT_LIMITS.totalBytes &&
		value.every(
			(item) =>
				/^[A-Za-z0-9+/]*={0,2}$/.test(item.data) &&
				item.data.length % 4 === 0 &&
				item.size === (item.data.length / 4) * 3 - (item.data.endsWith("==") ? 2 : item.data.endsWith("=") ? 1 : 0),
		)
	);
}

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
