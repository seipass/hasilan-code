import { type Static, Type } from "typebox";
import { themeVariantSchema } from "./ui-preferences.ts";

export interface ExternalPanelEntry {
	id: string;
	title: string;
	scope?: "application";
}

export interface PluginStatus {
	id: string;
	title: string;
	source: "built-in" | "external";
	status: "enabled" | "disabled" | "failed" | "blocked";
	requires: readonly string[];
	reason?: string;
}

export interface PluginProfile {
	activeIds: string[];
	panels: ExternalPanelEntry[];
	themes: (ThemePlugin & { id: string; customizable: boolean })[];
	plugins: PluginStatus[];
	application: { kind: "built-in" } | { kind: "external"; panel: ExternalPanelEntry } | null;
}

const pluginIdSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" });
const pluginPathSchema = Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" });
const pluginConfigSchema = Type.Object(
	{ enabled: Type.Boolean(), module: Type.Optional(pluginPathSchema) },
	{ additionalProperties: false },
);
export type PluginChoice = Static<typeof pluginConfigSchema>;
export const pluginChoiceSchema = Type.Union([Type.Literal(false), pluginPathSchema, pluginConfigSchema]);
export const pluginManagementActionSchema = Type.Union([
	Type.Object(
		{ op: Type.Literal("enable"), id: pluginIdSchema, enabled: Type.Boolean() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ op: Type.Literal("add"), id: pluginIdSchema, module: pluginPathSchema },
		{ additionalProperties: false },
	),
	Type.Object({ op: Type.Literal("remove"), id: pluginIdSchema }, { additionalProperties: false }),
]);

export interface PluginManagementEntry extends PluginStatus {
	enabled: boolean;
	canEnable: boolean;
	module?: string;
	pending: boolean;
}

export const PLUGIN_MANAGER_ID = "plugin-manager";
export const WORKSPACE_UI_ID = "workspace-ui";
export const GITHUB_DASHBOARD_ID = "github-dashboard";
export const WIDGET_FEEDS_ID = "widget-feeds";
export const ACCOUNT_USAGE_ID = "account-usage";

export const DEFAULT_THEME_ID = "theme-default";
export const themePluginSchema = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
		light: themeVariantSchema,
		dark: themeVariantSchema,
	},
	{ additionalProperties: false },
);
export type ThemePlugin = Static<typeof themePluginSchema>;

export const standardTheme: ThemePlugin = {
	title: "標準",
	dark: { background: "#141414", foreground: "#e8e8e8", accent: "#e8e8e8", contrast: 50 },
	light: { background: "#ffffff", foreground: "#202124", accent: "#2563eb", contrast: 50 },
};
