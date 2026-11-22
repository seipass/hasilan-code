import { type CSSProperties, useEffect, useState } from "react";
import { Check } from "typebox/value";
import { DEFAULT_THEME_ID, standardTheme, type ThemePlugin } from "../shared/plugin-profile.ts";
import { appearanceSchema, type Appearance } from "../shared/ui-preferences.ts";
import { formatFontStack } from "./FontAppearance.tsx";
import { usePluginProfile } from "./plugins/profile.tsx";
import { usePreferenceState } from "./preferences.ts";
import { Select } from "./Select.tsx";
import "./ThemeAppearance.css";

const KEY = "pi-web-appearance";
const DEFAULT: Appearance = {
	mode: "dark",
	dark: standardTheme.dark,
	light: standardTheme.light,
	codeTheme: "auto", contentFont: "", codeFont: "", uiSize: 13, codeSize: 13, translucentSidebar: false,
};
type Variant = "dark" | "light";

const LEGACY_DARK_DEFAULTS = new Set(["#141414:#e8e8e8:#e8e8e8", "#12161f:#e6edf7:#6b9eff"]);
const LEGACY_LIGHT_DEFAULTS = new Set(["#ffffff:#202124:#2563eb", "#f7f7f8:#18191b:#18191b", "#f6f8fb:#141923:#2563eb"]);

export function readAppearance(raw: string | null): Appearance {
	try {
		const value: unknown = JSON.parse(raw ?? "null");
		if (!Check(appearanceSchema, value)) return DEFAULT;
		const parsed = value as Appearance;
		if (!parsed.themeId || parsed.themeId === DEFAULT_THEME_ID) {
			const darkKey = `${parsed.dark.background}:${parsed.dark.foreground}:${parsed.dark.accent}`.toLowerCase();
			const lightKey = `${parsed.light.background}:${parsed.light.foreground}:${parsed.light.accent}`.toLowerCase();
			const migrateDark = LEGACY_DARK_DEFAULTS.has(darkKey);
			const migrateLight = LEGACY_LIGHT_DEFAULTS.has(lightKey);
			if (migrateDark || migrateLight) {
				return {
					...parsed,
					dark: migrateDark ? standardTheme.dark : parsed.dark,
					light: migrateLight ? standardTheme.light : parsed.light,
				};
			}
		}
		return parsed;
	} catch {
		return DEFAULT;
	}
}

export const BUILTIN_THEME_PRESETS: readonly (ThemePlugin & { id: string; customizable: boolean })[] = [
	{ id: DEFAULT_THEME_ID, customizable: true, ...standardTheme },
	{
		id: "theme-classic-monochrome",
		title: "クラシック・モノクローム",
		customizable: false,
		dark: { background: "#141414", foreground: "#e8e8e8", accent: "#e8e8e8", contrast: 35 },
		light: { background: "#ffffff", foreground: "#202124", accent: "#2563eb", contrast: 35 },
	},
	{
		id: "theme-legacy-agy",
		title: "Antigravity Classic",
		customizable: false,
		dark: { background: "#101010", foreground: "#cccccc", accent: "#007acc", contrast: 35 },
		light: { background: "#f9f9f9", foreground: "#101010", accent: "#007acc", contrast: 35 },
	},
	{
		id: "theme-tokyo-night",
		title: "Tokyo Night",
		customizable: false,
		dark: { background: "#1a1b26", foreground: "#a9b1d6", accent: "#7aa2f7", contrast: 35 },
		light: { background: "#f5f5f5", foreground: "#383a42", accent: "#4078f2", contrast: 35 },
	},
	{
		id: "theme-catppuccin",
		title: "Catppuccin",
		customizable: false,
		dark: { background: "#24273a", foreground: "#cad3f5", accent: "#c6a0f6", contrast: 35 },
		light: { background: "#eaecf0", foreground: "#4c4f69", accent: "#8839ef", contrast: 35 },
	},
	{
		id: "theme-vesper",
		title: "Vesper",
		customizable: false,
		dark: { background: "#101010", foreground: "#ffffff", accent: "#ffc799", contrast: 35 },
		light: { background: "#faf4e5", foreground: "#435155", accent: "#cb4b16", contrast: 35 },
	},
];

function useThemeSelection(themeId: string | undefined) {
	const profileThemes = usePluginProfile()?.themes;
	const themes = profileThemes
		? [...profileThemes, ...BUILTIN_THEME_PRESETS.filter((preset) => !profileThemes.some(({ id }) => id === preset.id))]
		: [...BUILTIN_THEME_PRESETS];
	const selectedTheme = themes.find(({ id }) => id === themeId) ?? themes.find(({ id }) => id === DEFAULT_THEME_ID);
	return { themes, selectedTheme };
}

function relativeLuminance(hex: string): number {
	const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
	const full = normalized.length === 3 ? normalized.split("").map((c) => c + c).join("") : normalized;
	if (!/^[0-9a-fA-F]{6}$/.test(full)) return 0.2;
	const channel = (start: number) => {
		const srgb = Number.parseInt(full.slice(start, start + 2), 16) / 255;
		return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function primaryForegroundFor(accent: string, background: string, isDark: boolean): string {
	const darkInk = isDark && /^#[0-9a-fA-F]{6}$/.test(background) ? background : "#0a0a0c";
	const lumAccent = relativeLuminance(accent);
	const whiteContrast = 1.05 / (lumAccent + 0.05);
	const darkContrast = (lumAccent + 0.05) / (relativeLuminance(darkInk) + 0.05);
	return whiteContrast >= darkContrast ? "#ffffff" : darkInk;
}

/** Applies synchronized appearance preferences outside the settings dialog. */
export function ApplicationTheme() {
	const [settings] = usePreferenceState(KEY, DEFAULT, readAppearance);
	const { selectedTheme } = useThemeSelection(settings.themeId);
	const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const change = () => setSystemDark(media.matches);
		media.addEventListener("change", change);
		return () => media.removeEventListener("change", change);
	}, []);
	useEffect(() => {
		const root = document.documentElement;
		const variant = settings.mode === "system" ? systemDark ? "dark" : "light" : settings.mode;
		const isDark = variant === "dark";
		const theme = selectedTheme?.customizable ? settings[variant] : selectedTheme?.[variant] ?? DEFAULT[variant];
		const code = settings.codeTheme === "auto" ? variant : settings.codeTheme;
		const mix = (color: string, percent: number, base = theme.background) => `color-mix(in srgb, ${color} ${percent}%, ${base})`;
		const amount = 0.65 + theme.contrast / 100;
		const onPrimary = primaryForegroundFor(theme.accent, theme.background, isDark);
		const shellSurface = isDark ? mix("#ffffff", 4) : mix("#0a0a0c", 2);
		const cardSurface = isDark ? mix("#ffffff", 4.8) : mix(theme.background, 30, "#ffffff");
		const sunkenSurface = isDark ? mix("#ffffff", 2) : mix("#0a0a0c", 3.8);
		const hoverSurface = isDark ? mix("#ffffff", 7.5) : mix("#0a0a0c", 6);
		const onyxFrame = isDark ? mix("#ffffff", 2.4) : mix("#0a0a0c", 2.4);
		const onyxWell = isDark ? mix("#ffffff", 4) : "rgb(10 10 12 / 0.055)";
		const onyxRaised = isDark ? mix("#ffffff", 5.6) : cardSurface;
		const onyxSelected = isDark ? mix("#ffffff", 9.6) : `color-mix(in srgb, ${theme.foreground} 6.5%, ${shellSurface})`;
		const onyxKey = isDark ? mix("#ffffff", 11.4) : "#ffffff";
		const colors: Record<string, string> = {
			"--surface": theme.background,
			"--surface-sunken": sunkenSurface,
			"--surface-panel": shellSurface,
			"--surface-raised": cardSurface,
			"--surface-hover": hoverSurface,
			"--surface-inverse": theme.foreground,
			"--onyx-shell": shellSurface,
			"--onyx-frame": onyxFrame,
			"--onyx-well": onyxWell,
			"--onyx-raised": onyxRaised,
			"--onyx-selected": onyxSelected,
			"--onyx-key": onyxKey,
			"--card-edge": `color-mix(in srgb, ${theme.foreground} ${isDark ? 10 : 12}%, transparent)`,
			"--glass-border": `color-mix(in srgb, ${theme.foreground} ${isDark ? 8.5 : 6.5}%, transparent)`,
			"--glass-highlight": isDark ? "rgb(255 255 255 / 0.085)" : "#ffffff",
			"--home-glow": `color-mix(in srgb, ${theme.accent} ${isDark ? 11 : 10}%, transparent)`,
			"--sidebar-muted": `color-mix(in srgb, ${theme.foreground} ${isDark ? 4.8 : 4.2}%, transparent)`,
			"--sidebar-secondary": `color-mix(in srgb, ${theme.foreground} ${isDark ? 9 : 7.5}%, transparent)`,
			"--on-surface": theme.foreground,
			"--on-surface-secondary": mix(theme.foreground, isDark ? 73 : 78),
			"--on-surface-muted": mix(theme.foreground, isDark ? 51 : 57),
			"--placeholder": mix(theme.foreground, isDark ? 37 : 45),
			"--on-surface-inverse": theme.background,
			"--primary": theme.accent,
			"--primary-hover": mix(theme.accent, 86, isDark ? "#ffffff" : "#000000"),
			"--primary-container": mix(theme.accent, isDark ? 18 : 12),
			"--on-primary": onPrimary,
			"--on-primary-container": theme.foreground,
			"--secondary": isDark ? "#6a9fcb" : "#2f75c3",
			"--secondary-hover": isDark ? "#9cbedd" : "#2560a3",
			"--secondary-container": mix(theme.accent, isDark ? 18 : 12),
			"--on-secondary-container": theme.foreground,
			"--success": isDark ? "#7aae66" : "#16a34a",
			"--warning": isDark ? "#e8975f" : "#d97706",
			"--danger": isDark ? "#de5555" : "#dc2626",
			"--success-container": mix(isDark ? "#7aae66" : "#16a34a", 16),
			"--warning-container": mix(isDark ? "#e8975f" : "#d97706", 16),
			"--danger-container": mix(isDark ? "#de5555" : "#dc2626", 16),
			"--on-success-container": isDark ? "#b0d2a3" : "#166534",
			"--on-warning-container": isDark ? "#f4c29b" : "#92400e",
			"--on-danger-container": isDark ? "#f3aeae" : "#991b1b",
			"--border-subtle": `color-mix(in srgb, ${theme.foreground} ${6 * amount}%, ${theme.background})`,
			"--border": `color-mix(in srgb, ${theme.foreground} ${8.5 * amount}%, ${theme.background})`,
			"--border-strong": `color-mix(in srgb, ${theme.foreground} ${15 * amount}%, ${theme.background})`,
			"--scroll-thumb": mix(theme.foreground, 18),
			"--scroll-thumb-hover": mix(theme.foreground, 30),
			"--font-content": formatFontStack(settings.contentFont, "inherit"),
			"--font-code": formatFontStack(settings.codeFont, '"Google Sans Code", "JetBrains Mono", "UDEV Gothic", monospace'),
			"--text-code": `${settings.codeSize}px`, "--text-reading": `${settings.uiSize + 1}px`,
			"--text-control": `${settings.uiSize}px`, "--text-2xs": `${settings.uiSize - 2}px`,
			"--text-xs": `${settings.uiSize - 1}px`, "--text-sm": `${settings.uiSize}px`,
			"--text-md": `${settings.uiSize}px`, "--text-base": `${settings.uiSize + 1}px`,
			"--text-lg": `${settings.uiSize + 2}px`, "--text-xl": `${settings.uiSize + 4}px`,
			"--text-2xl": `${settings.uiSize + 6}px`, "--text-3xl": `${settings.uiSize + 9}px`,
			"--text-4xl": `${settings.uiSize + 15}px`,
			"--code-surface": settings.codeTheme === "auto" ? "var(--surface-sunken)" : code === "dark" ? "#0c0c0f" : "#f5f5f7",
			"--code-text": settings.codeTheme === "auto" ? "var(--on-surface)" : code === "dark" ? "#f8f8f2" : "#101010",
		};
		const syntax = code === "dark"
			? ["#8292a2", "#66d9ef", "#a6e22e", "#ae81ff", "#e6db74", "#e6db74", "#f92672", "#fd971f"]
			: ["#708090", "#0077aa", "#5c8a00", "#990055", "#dd4a68", "#dd4a68", "#990055", "#ee9900"];
		["comment", "keyword", "string", "number", "function", "type", "property", "meta"].forEach((name, i) => { colors[`--syntax-${name}`] = syntax[i]; });
		for (const [name, value] of Object.entries(colors)) root.style.setProperty(name, value);
		root.style.colorScheme = variant;
		root.style.fontSize = `${settings.uiSize}px`;
		root.dataset.theme = variant;
		root.dataset.translucentSidebar = String(settings.translucentSidebar);
		return () => { for (const name of Object.keys(colors)) root.style.removeProperty(name); root.style.removeProperty("color-scheme"); root.style.removeProperty("font-size"); delete root.dataset.theme; delete root.dataset.translucentSidebar; };
	}, [settings, systemDark, selectedTheme]);
	return null;
}

export function ThemeAppearance() {
	const [settings, setSettings] = usePreferenceState(KEY, DEFAULT, readAppearance);
	const { themes, selectedTheme } = useThemeSelection(settings.themeId);
	const [selected, setSelected] = useState<Variant>(() => settings.mode === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : settings.mode);
	const [share, setShare] = useState("");
	const [message, setMessage] = useState("");
	const [showImport, setShowImport] = useState(false);
	const update = (patch: Partial<Appearance>) => setSettings((old) => ({ ...old, ...patch }));
	const updateVariant = (patch: Partial<Appearance[Variant]>) => setSettings((old) => ({ ...old, [selected]: { ...old[selected], ...patch } }));
	const variant = settings[selected];
	return <section className="settings-section theme-appearance">
		<h3>テーマ</h3>
		{themes.some(({ customizable }) => !customizable) && <label>配色<Select aria-label="配色" value={selectedTheme?.id ?? ""} onChange={(value) => update({ themeId: value || undefined })}>
			{!themes.some(({ id }) => id === DEFAULT_THEME_ID) && <option value="">標準</option>}
			{themes.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
		</Select></label>}
		<div className="theme-modes" role="group" aria-label="テーマモード">{([ ["system", "システム"], ["light", "ライト"], ["dark", "ダーク"] ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={settings.mode === value} onClick={() => { update({ mode: value }); setSelected(value === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : value); }}>{label}</button>)}</div>
		{selectedTheme?.customizable && <>
		<div className="theme-heading"><h4>{selected === "dark" ? "ダーク" : "ライト"}テーマ</h4><div><button type="button" onClick={() => { setMessage(""); setShowImport(!showImport); }}>読み込む</button><button type="button" onClick={() => { void navigator.clipboard.writeText(JSON.stringify({ format: "hasilan-theme-v1", variant: selected, colors: variant })).then(() => setMessage("テーマをコピーしました。"), () => setMessage("コピーできませんでした。")); }}>コピー</button></div></div>
		<div className="theme-variants" role="group" aria-label="編集するテーマ">{(["light", "dark"] as const).map((value) => <button type="button" key={value} aria-pressed={selected === value} onClick={() => setSelected(value)}>{value === "light" ? "ライト" : "ダーク"}</button>)}</div>
		{showImport && <div className="theme-import"><label>テーマの文字列<textarea value={share} onChange={(event) => setShare(event.currentTarget.value)} rows={3} /></label><button type="button" onClick={() => { try { const data: unknown = JSON.parse(share); if (!data || typeof data !== "object" || !("colors" in data) || !("format" in data) || data.format !== "hasilan-theme-v1") throw new Error(); const next = { ...settings, [selected]: data.colors }; if (!Check(appearanceSchema, next)) throw new Error(); setSettings(next); setMessage("テーマを読み込みました。"); setShowImport(false); } catch { setMessage("有効なテーマ文字列を入力してください。"); } }}>適用</button></div>}
		<div className="theme-color-grid">{([ ["background", "背景"], ["foreground", "文字"], ["accent", "アクセント"] ] as const).map(([key, label]) => <label key={key}>{label}<span><input type="color" aria-label={`${label}の色`} value={variant[key]} onChange={(event) => updateVariant({ [key]: event.currentTarget.value })} /><code>{variant[key]}</code></span></label>)}</div>
		<label className="theme-range">コントラスト <output>{variant.contrast}</output><input type="range" min="0" max="100" value={variant.contrast} style={{ "--theme-range-progress": `${variant.contrast}%` } as CSSProperties} onChange={(event) => updateVariant({ contrast: Number(event.currentTarget.value) })} /></label>
		<button type="button" onClick={() => updateVariant(DEFAULT[selected])}>このテーマをリセット</button>
		</>}
		<label>コードのテーマ<Select aria-label="コードのテーマ" value={settings.codeTheme} onChange={(value) => update({ codeTheme: value as Appearance["codeTheme"] })}><option value="auto">画面に合わせる</option><option value="dark">ダーク</option><option value="light">ライト</option></Select></label>
		<label className="settings-toggle"><input type="checkbox" checked={settings.translucentSidebar} onChange={(event) => update({ translucentSidebar: event.currentTarget.checked })} /><span>サイドバーを半透明にする</span></label>
		<p className="fine-print">変更はすぐに反映・保存され、Web版とデスクトップ版で共有されます。テーマ文字列はHasilan Code間で共有できます。</p>
		{message && <p role="status">{message}</p>}
	</section>;
}
