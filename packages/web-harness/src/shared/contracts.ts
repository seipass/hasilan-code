import { type Static, Type } from "typebox";
import { ATTACHMENT_LIMITS, attachmentUploadSchema } from "./attachments.ts";

export const workspaceCreateSchema = Type.Object(
	{ path: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
export const workspacePickerSchema = Type.Object({}, { additionalProperties: false });
export const modelSchema = Type.Object(
	{ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
export const thinkingSchema = Type.Object(
	{
		level: Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
			Type.Literal("max"),
		]),
	},
	{ additionalProperties: false },
);
export const sessionCreateSchema = Type.Object(
	{
		workspaceId: Type.String({ minLength: 1 }),
		model: Type.Optional(modelSchema),
		thinkingLevel: Type.Optional(thinkingSchema.properties.level),
	},
	{ additionalProperties: false },
);
export const promptSchema = Type.Object(
	{
		text: Type.String({ maxLength: 1024 * 1024 }),
		mode: Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")]),
		attachments: Type.Optional(Type.Array(attachmentUploadSchema, { maxItems: ATTACHMENT_LIMITS.files })),
	},
	{ additionalProperties: false },
);
export const sessionRenameSchema = Type.Object(
	{ title: Type.String({ minLength: 1, maxLength: 200 }) },
	{ additionalProperties: false },
);

export const pendingInputActionSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("edit"), text: Type.String({ minLength: 1, maxLength: 1024 * 1024 }) },
		{ additionalProperties: false },
	),
	Type.Object({ type: Type.Literal("delete") }, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("sendNow") }, { additionalProperties: false }),
]);
export type PendingInputAction = Static<typeof pendingInputActionSchema>;
export const teamMessageSchema = Type.Object(
	{
		agentId: Type.String({ minLength: 1 }),
		message: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
	},
	{ additionalProperties: false },
);
export const responsibilitySchema = Type.Object(
	{ responsibility: Type.String({ minLength: 1, maxLength: 16384 }) },
	{ additionalProperties: false },
);
export const credentialSchema = Type.Object(
	{ key: Type.String({ minLength: 1, maxLength: 16384 }) },
	{ additionalProperties: false },
);
export const terminalCreateSchema = Type.Object(
	{
		workspaceId: Type.String({ minLength: 1 }),
		cols: Type.Integer({ minimum: 1, maximum: 500 }),
		rows: Type.Integer({ minimum: 1, maximum: 200 }),
	},
	{ additionalProperties: false },
);
