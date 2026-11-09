import { type Static, Type } from "typebox";

const tabIdSchema = Type.String({ minLength: 1 });
const selectorSchema = Type.String({ minLength: 1 });
export const browserSchema = Type.Union([
	Type.Object(
		{ action: Type.Literal("open"), url: Type.Optional(Type.String({ minLength: 1 })) },
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("tabs") }, { additionalProperties: false }),
	Type.Object(
		{ action: Type.Literal("navigate"), tabId: tabIdSchema, url: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("read"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object(
		{ action: Type.Literal("click"), tabId: tabIdSchema, selector: selectorSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("fill"), tabId: tabIdSchema, selector: selectorSchema, value: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("press"),
			tabId: tabIdSchema,
			selector: selectorSchema,
			key: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("screenshot"), tabId: tabIdSchema, fullPage: Type.Optional(Type.Boolean()) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("evaluate"), tabId: tabIdSchema, expression: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("close"), tabId: tabIdSchema }, { additionalProperties: false }),
]);
export type BrowserInput = Static<typeof browserSchema>;
export interface BrowserToolDetails {
	action: BrowserInput["action"];
	[key: string]: unknown;
}
export interface BrowserStatus {
	ready: boolean;
	error?: string;
}
