import { Type } from "typebox";

export const workspaceCreateSchema = Type.Object(
	{ path: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
export const modelSchema = Type.Object(
	{ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
export const sessionCreateSchema = Type.Object(
	{ workspaceId: Type.String({ minLength: 1 }), model: Type.Optional(modelSchema) },
	{ additionalProperties: false },
);
export const promptSchema = Type.Object(
	{
		text: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
		mode: Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")]),
	},
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
