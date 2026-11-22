import { type CSSProperties, useEffect, useState } from "react";
import { Check } from "typebox/value";
import { DEFAULT_THEME_ID, standardTheme } from "../shared/plugin-profile.ts";
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
interface ThemePreset {
	id: string;
	label: string;
	dark: Appearance["dark"];
	light: Appearance["light"];
}

const THEME_PRESETS: readonly ThemePreset[] = [
	{ id: "obsidian-slate", label: "Obsidian Slate（標準）", dark: standardTheme.dark, light: standardTheme.light },
	{
		id: "classic-mono",
		label: "クラシックモノクロ",
		dark: { background: "#141414", foreground: "#e8e8e8", accent: "#e8e8e8", contrast: 50 },
		light: { background: "#ffffff", foreground: "#202124", accent: "#2563eb", contrast: 50 },
	},
	{
		id: "midnight-indigo",
		label: "Midnight Indigo",
		dark: { background: "#0d1018", foreground: "#e8edf8", accent: "#818cf8", contrast: 58 },
		light: { background: "#f5f7fc", foreground: "#0f172a", accent: "#4f46e5", contrast: 52 },
	},
	{
		id: "graphite-cyan",
		label: "Graphite Cyan",
		dark: { background: "#10171b", foreground: "#e4eff2", accent: "#38bdf8", contrast: 54 },
		light: { background: "#f4f9fb", foreground: "#0f1f24", accent: "#0284c7", contrast: 50 },
	},
];

function contrastInk(hex: string): string {
	const value = Number.parseInt(hex.slice(1), 16);
	const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
		const s = channel / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance > 0.36 ? "#0c1017" : "#f8fafc";
}

function sameVariant(a: Appearance[Variant], b: Appearance[Variant]): boolean {
	return (
		a.background.toLowerCase() === b.background.toLowerCase() &&
		a.foreground.toLowerCase() === b.foreground.toLowerCase() &&
		a.accent.toLowerCase() === b.accent.toLowerCase() &&
		a.contrast === b.contrast
	);
}

function readAppearance(raw: string | null): Appearance {
	try { const value: unknown = JSON.parse(raw ?? "null"); return Check(appearanceSchema, value) ? value as Appearance : DEFAULT; }
	catch { return DEFAULT; }
}

const initialThemes = [{ id: DEFAULT_THEME_ID, customizable: true, ...standardTheme }];

function useThemeSelection(themeId: string | undefined) {
	const themes = usePluginProfile()?.themes ?? initialThemes;
	const selectedTheme = themes.find(({ id }) => id === themeId) ?? themes.find(({ id }) => id === DEFAULT_THEME_ID);
	return { themes, selectedTheme };
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
		const theme = selectedTheme?.customizable ? settings[variant] : selectedTheme?.[variant] ?? DEFAULT[variant];
		const code = settings.codeTheme === "auto" ? variant : settings.codeTheme;
		const mix = (color: string, percent: number, base = theme.background) => `color-mix(in srgb, ${color} ${percent}%, ${base})`;
		const amount = 0.65 + theme.contrast / 100;
		const dark = variant === "dark";
		const colors: Record<string, string> = {
			"--surface": theme.background,
			"--surface-sunken": dark ? mix("#06080c", 36) : mix("#0f172a", 4.5),
			"--surface-panel": dark ? mix(theme.foreground, 2.4 * amount) : mix("#0f172a", 2.4 * amount),
			"--surface-raised": dark ? mix(theme.foreground, 5.4 * amount) : mix("#ffffff", 85),
			"--surface-hover": dark ? mix(theme.foreground, 9.5 * amount) : mix("#0f172a", 5.5 * amount),
			"--surface-inverse": theme.foreground,
			"--on-surface": theme.foreground,
			"--on-surface-secondary": mix(theme.foreground, 78),
			"--on-surface-muted": mix(theme.foreground, 58),
			"--on-surface-inverse": theme.background,
			"--primary": theme.accent,
			"--primary-hover": mix(theme.accent, 82, dark ? "#ffffff" : theme.foreground),
			"--primary-container": mix(theme.accent, dark ? 16 : 12),
			"--on-primary": contrastInk(theme.accent),
			"--on-primary-container": theme.foreground,
			"--secondary": dark ? "#8eb4ff" : "#245bb4",
			"--secondary-hover": dark ? "#b4ceff" : "#17458d",
			"--secondary-container": mix(theme.accent, dark ? 18 : 14),
			"--on-secondary-container": theme.foreground,
			"--success": dark ? "#6ee7a8" : "#1d7a46",
			"--warning": dark ? "#f7cb75" : "#8f5f00",
			"--danger": dark ? "#f5859f" : "#be224b",
			"--success-container": mix(dark ? "#6ee7a8" : "#1d7a46", 15),
			"--warning-container": mix(dark ? "#f7cb75" : "#8f5f00", 15),
			"--danger-container": mix(dark ? "#f5859f" : "#be224b", 15),
			"--on-success-container": dark ? "#6ee7a8" : "#1d7a46",
			"--on-warning-container": dark ? "#f7cb75" : "#8f5f00",
			"--on-danger-container": dark ? "#f5859f" : "#be224b",
			"--border-subtle": mix(theme.foreground, dark ? 6.5 * amount : 7 * amount),
			"--border": mix(theme.foreground, dark ? 11.5 * amount : 12 * amount),
			"--border-strong": mix(theme.foreground, dark ? 20 * amount : 22 * amount),
			"--scroll-thumb": mix(theme.foreground, 20),
			"--scroll-thumb-hover": mix(theme.foreground, 34),
			"--selection-fill": `color-mix(in srgb, ${theme.accent} ${dark ? 15 : 12}%, ${mix(theme.foreground, dark ? 5 : 4)})`,
			"--focus-ring": `color-mix(in srgb, ${theme.accent} 70%, ${theme.foreground})`,
			"--surface-specular": `inset 0 1px 0 color-mix(in srgb, #ffffff ${dark ? 7 : 80}%, transparent)`,
			"--card-shadow": dark ? "0 1px 2px rgb(0 0 0 / 28%), 0 8px 24px rgb(0 0 0 / 22%)" : "0 1px 2px rgb(15 23 42 / 5%), 0 8px 24px rgb(15 23 42 / 6%)",
			"--popup-shadow": dark ? "0 2px 6px rgb(0 0 0 / 35%), 0 16px 44px rgb(0 0 0 / 50%)" : "0 4px 12px rgb(15 23 42 / 8%), 0 18px 44px rgb(15 23 42 / 14%)",
			"--dialog-shadow": dark ? "0 8px 24px rgb(0 0 0 / 45%), 0 28px 72px rgb(0 0 0 / 62%)" : "0 8px 24px rgb(15 23 42 / 10%), 0 28px 72px rgb(15 23 42 / 18%)",
			"--font-content": formatFontStack(settings.contentFont, "inherit"),
			"--font-code": formatFontStack(settings.codeFont, '"JetBrains Mono", "UDEV Gothic", monospace'),
			"--text-code": `${settings.codeSize}px`, "--text-reading": `${settings.uiSize + 1}px`,
			"--text-control": `${settings.uiSize}px`, "--text-2xs": `${settings.uiSize - 2}px`,
			"--text-xs": `${settings.uiSize - 1}px`, "--text-sm": `${settings.uiSize}px`,
			"--text-md": `${settings.uiSize}px`, "--text-base": `${settings.uiSize + 1}px`,
			"--text-lg": `${settings.uiSize + 2}px`, "--text-xl": `${settings.uiSize + 4}px`,
			"--text-2xl": `${settings.uiSize + 6}px`, "--text-3xl": `${settings.uiSize + 9}px`,
			"--text-4xl": `${settings.uiSize + 15}px`,
			"--code-surface": settings.codeTheme === "auto" ? "var(--surface-sunken)" : code === "dark" ? "#0c0f16" : "#eef2f7",
			"--code-text": settings.codeTheme === "auto" ? "var(--on-surface)" : code === "dark" ? "#e6ecf5" : "#111827",
		};
		const syntax = code === "dark" ? ["#6e7b91", "#c792ea", "#8fd4a4", "#f5a97f", "#7aa2ff", "#f2cd7c", "#7dd3fc", "#f38ba8"] : ["#64748b", "#7c3aed", "#15803d", "#c2410c", "#1d4ed8", "#a16207", "#0e7490", "#be123c"];
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
	const activePresetId = THEME_PRESETS.find((preset) => sameVariant(settings.dark, preset.dark) && sameVariant(settings.light, preset.light))?.id;
	return <section className="settings-section theme-appearance">
		<h3>テーマ</h3>
		{themes.some(({ customizable }) => !customizable) && <label>配色<Select aria-label="配色" value={selectedTheme?.id ?? ""} onChange={(value) => update({ themeId: value || undefined })}>
			{!themes.some(({ id }) => id === DEFAULT_THEME_ID) && <option value="">標準</option>}
			{themes.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
		</Select></label>}
		<div className="theme-modes" role="group" aria-label="テーマモード">{([ ["system", "システム"], ["light", "ライト"], ["dark", "ダーク"] ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={settings.mode === value} onClick={() => { update({ mode: value }); setSelected(value === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : value); }}>{label}</button>)}</div>
		{selectedTheme?.customizable && <>
		<div className="theme-presets-block">
			<span className="theme-presets-label">プリセット</span>
			<div className="theme-presets" role="group" aria-label="テーマプリセット">
				{THEME_PRESETS.map((preset) => (
					<button type="button" key={preset.id} className="theme-preset-chip" aria-pressed={activePresetId === preset.id} onClick={() => { update({ dark: preset.dark, light: preset.light }); setMessage(`「${preset.label}」を適用しました。`); }}>
						<span className="theme-preset-swatches" aria-hidden="true">
							<i style={{ background: preset[selected].background }} />
							<i style={{ background: preset[selected].accent }} />
						</span>
						<span>{preset.label}</span>
					</button>
				))}
			</div>
		</div>
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
