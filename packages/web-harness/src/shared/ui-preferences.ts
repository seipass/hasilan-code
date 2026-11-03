import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { ATTACHMENT_LIMITS, isDraftAttachments } from "./attachments.ts";

const paneSchema = Type.Union([Type.Literal(0), Type.Literal(1)]);
const tabBase = { id: Type.String({ minLength: 1, maxLength: 128 }), pane: paneSchema };
export const savedDetailTabsSchema = Type.Object(
	{
		tabs: Type.Array(
			Type.Union([
				Type.Object({ ...tabBase, kind: Type.Literal("new") }, { additionalProperties: false }),
				Type.Object(
					{
						...tabBase,
						kind: Type.Literal("file"),
						file: Type.Optional(
							Type.Object(
								{
									path: Type.String({ minLength: 1, maxLength: 4096 }),
									offset: Type.Integer({ minimum: 1 }),
									line: Type.Optional(Type.Integer({ minimum: 1 })),
									mode: Type.Optional(Type.Union([Type.Literal("source"), Type.Literal("rendered")])),
								},
								{ additionalProperties: false },
							),
						),
					},
					{ additionalProperties: false },
				),
				Type.Object(
					{
						...tabBase,
						kind: Type.Literal("terminal"),
						terminalId: Type.String({ minLength: 1, maxLength: 128 }),
						number: Type.Integer({ minimum: 1 }),
					},
					{ additionalProperties: false },
				),
			]),
			{ maxItems: 200 },
		),
		selected: Type.Array(Type.Union([Type.String({ maxLength: 128 }), Type.Null()]), { minItems: 2, maxItems: 2 }),
		focused: paneSchema,
		mode: Type.Union([Type.Literal("single"), Type.Literal("columns"), Type.Literal("rows")]),
	},
	{ additionalProperties: false },
);
export type SavedDetailTabs = Static<typeof savedDetailTabsSchema>;

export const musicPreferencesSchema = Type.Object(
	{
		volume: Type.Number({ minimum: 0, maximum: 1 }),
		muted: Type.Boolean(),
		positions: Type.Record(Type.String({ maxLength: 8192 }), Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
export type MusicPreferences = Static<typeof musicPreferencesSchema>;

const modelSelectionSchema = Type.Object(
	{
		model: Type.Optional(
			Type.Object(
				{
					provider: Type.String({ minLength: 1, maxLength: 256 }),
					id: Type.String({ minLength: 1, maxLength: 1024 }),
				},
				{ additionalProperties: false },
			),
		),
		thinkingLevel: Type.Optional(
			Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level))),
		),
	},
	{ additionalProperties: false },
);
const treePreferencesSchema = Type.Object(
	{
		width: Type.Number({ minimum: 0, maximum: 480 }),
		open: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 5000, uniqueItems: true }),
	},
	{ additionalProperties: false },
);
const keybindingsSchema = Type.Object(
	{
		"composer.send": Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })),
		"composer.followUp": Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })),
		"composer.routeWorkspace": Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })),
	},
	{ additionalProperties: false },
);

/** Keys are explicit so this store cannot become a second credentials/settings API. */
export function uiPreferenceLimit(key: string): number | undefined {
	if (key.length > 256) return undefined;
	if (key === "hasilan-home-background") return 1_402_000;
	if (key === "hasilan-widgets-v1") return 500_000;
	if (["pi-web-model-selection", "pi-web-keybindings", "pi-web-expanded-workspaces"].includes(key)) return 64_000;
	if (key === "pi-web-music") return 500_000;
	if (
		[
			"pi-web-selected-session",
			"pi-web-workspace",
			"pi-web-sidebar-open",
			"pi-web-right-open",
			"pi-web-right-tab",
			"pi-web-right-width",
			"pi-web-chat-width",
			"pi-web-notifications",
		].includes(key)
	)
		return 4096;
	if (/^pi-web-draft:(?:new:)?[a-zA-Z0-9_-]+$/.test(key)) return 1_000_000;
	if (/^pi-web-attachments:(?:new:)?[a-zA-Z0-9_-]+$/.test(key)) return ATTACHMENT_LIMITS.requestBytes - 4096;
	if (/^pi-web-(?:tabs|tree|split):[a-zA-Z0-9_-]+$/.test(key)) return 500_000;
	return undefined;
}

export function validUiPreference(key: string, value: unknown): value is string | null {
	const limit = uiPreferenceLimit(key);
	if (limit === undefined) return false;
	if (value === null) return true;
	if (typeof value !== "string" || value.length > limit) return false;
	if (key.startsWith("pi-web-draft:") || key === "pi-web-selected-session" || key === "pi-web-workspace") return true;
	try {
		const parsed: unknown = JSON.parse(value);
		if (key === "pi-web-sidebar-open" || key === "pi-web-right-open" || key === "pi-web-notifications")
			return typeof parsed === "boolean";
		if (key === "pi-web-right-width") return typeof parsed === "number" && parsed >= 320 && parsed <= 10_000;
		if (key === "pi-web-chat-width") return typeof parsed === "number" && parsed >= 320 && parsed <= 3000;
		if (key === "pi-web-right-tab") return parsed === "tabs" || parsed === "team" || parsed === "tools";
		if (key === "pi-web-model-selection") return Check(modelSelectionSchema, parsed);
		if (key === "pi-web-expanded-workspaces") return Check(Type.Record(Type.String(), Type.Boolean()), parsed);
		if (key === "pi-web-keybindings") return Check(keybindingsSchema, parsed);
		if (key.startsWith("pi-web-tree:")) return Check(treePreferencesSchema, parsed);
		if (key.startsWith("pi-web-tabs:")) return Check(savedDetailTabsSchema, parsed);
		if (key.startsWith("pi-web-attachments:")) return isDraftAttachments(parsed);
		if (key === "pi-web-music") return Check(musicPreferencesSchema, parsed);
		if (key.startsWith("pi-web-split:")) return typeof parsed === "number" && parsed >= 15 && parsed <= 85;
		return parsed !== null && typeof parsed === "object";
	} catch {
		return false;
	}
}

export const uiPreferencesPatchSchema = Type.Object(
	{
		entries: Type.Array(
			Type.Object(
				{
					key: Type.String({ minLength: 1, maxLength: 256 }),
					value: Type.Union([Type.String({ maxLength: ATTACHMENT_LIMITS.requestBytes }), Type.Null()]),
					onlyIfMissing: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 128 },
		),
	},
	{ additionalProperties: false },
);
export type UiPreferencesPatch = Static<typeof uiPreferencesPatchSchema>;

export interface UiPreferencesSnapshot {
	revision: string;
	values: Record<string, string | null>;
	/** Large attachment drafts are fetched only when their composer is opened. */
	attachments: Record<string, string>;
}
