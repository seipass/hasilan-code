export interface ExternalPanelEntry {
	id: string;
	title: string;
}

export interface PluginProfile {
	activeIds: string[];
	panels: ExternalPanelEntry[];
	themes: (ThemePlugin & { id: string; customizable: boolean })[];
}

import { type Static, Type } from "typebox";
import { themeVariantSchema } from "./ui-preferences.ts";

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
