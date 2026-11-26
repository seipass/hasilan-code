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
function contrastText(hex: string): string {
	const clean = hex.replace(/^#/, "");
	if (!/^[0-9a-f]{6}$/i.test(clean)) return "#ffffff";
	const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
	const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
	const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance > 0.62 ? "#111110" : "#ffffff";
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
		const colors: Record<string, string> = {
			"--surface": theme.background,
			"--surface-sunken": variant === "dark" ? mix("#000000", 65) : mix(theme.foreground, 4 * amount),
			"--surface-panel": mix(theme.foreground, (variant === "dark" ? 3.5 : 2.5) * amount),
			"--surface-raised": variant === "dark" ? mix(theme.foreground, 6 * amount) : mix("#ffffff", 82),
			"--surface-hover": mix(theme.foreground, (variant === "dark" ? 10.5 : 7) * amount),
			"--surface-inverse": theme.foreground,
			"--on-surface": theme.foreground,
			"--on-surface-secondary": mix(theme.foreground, 76),
			"--on-surface-muted": mix(theme.foreground, 52),
			"--on-surface-inverse": theme.background,
			"--primary": theme.accent,
			"--primary-hover": mix(theme.accent, 82, variant === "dark" ? "#ffffff" : "#000000"),
			"--primary-container": mix(theme.accent, variant === "dark" ? 17 : 12),
			"--on-primary": contrastText(theme.accent),
			"--on-primary-container": theme.foreground,
			"--secondary": variant === "dark" ? "#4b8dff" : "#2563eb",
			"--secondary-hover": variant === "dark" ? "#78abff" : "#1d4ed8",
			"--secondary-container": mix(variant === "dark" ? "#4b8dff" : "#2563eb", variant === "dark" ? 16 : 12),
			"--on-secondary-container": theme.foreground,
			"--success": variant === "dark" ? "#35b779" : "#1f8f5b",
			"--warning": variant === "dark" ? "#c79240" : "#a66f19",
			"--danger": variant === "dark" ? "#e06a6a" : "#c63e49",
			"--success-container": mix(variant === "dark" ? "#35b779" : "#1f8f5b", variant === "dark" ? 15 : 11),
			"--warning-container": mix(variant === "dark" ? "#c79240" : "#a66f19", variant === "dark" ? 15 : 12),
			"--danger-container": mix(variant === "dark" ? "#e06a6a" : "#c63e49", variant === "dark" ? 15 : 11),
			"--on-success-container": variant === "dark" ? "#35b779" : "#1f8f5b",
			"--on-warning-container": variant === "dark" ? "#c79240" : "#a66f19",
			"--on-danger-container": variant === "dark" ? "#e06a6a" : "#c63e49",
			"--border-subtle": mix(theme.foreground, (variant === "dark" ? 8 : 7) * amount),
			"--border": mix(theme.foreground, (variant === "dark" ? 13 : 12) * amount),
			"--border-strong": mix(theme.foreground, (variant === "dark" ? 22 : 20) * amount),
			"--selection-fill": `color-mix(in srgb, ${theme.foreground} ${variant === "dark" ? 11 : 8}%, transparent)`,
			"--focus-ring": `color-mix(in srgb, ${theme.foreground} ${variant === "dark" ? 38 : 32}%, transparent)`,
			"--scroll-thumb": mix(theme.foreground, 20),
			"--scroll-thumb-hover": mix(theme.foreground, 32),
			"--glass-surface": variant === "dark" ? "color-mix(in srgb, var(--surface-raised) 76%, transparent)" : "color-mix(in srgb, #ffffff 80%, var(--surface))",
			"--glass-panel": variant === "dark" ? "color-mix(in srgb, var(--surface-panel) 84%, transparent)" : "color-mix(in srgb, var(--surface-panel) 84%, transparent)",
			"--glass-popup": variant === "dark" ? "color-mix(in srgb, var(--surface-raised) 86%, transparent)" : "color-mix(in srgb, #ffffff 88%, var(--surface))",
			"--glass-card": variant === "dark" ? "color-mix(in srgb, var(--surface-raised) 74%, transparent)" : "color-mix(in srgb, #ffffff 84%, var(--surface))",
			"--glass-pill": variant === "dark" ? "color-mix(in srgb, var(--surface-hover) 62%, transparent)" : "color-mix(in srgb, #ffffff 74%, var(--surface-hover))",
			"--glass-rim": variant === "dark" ? "rgba(255, 255, 255, 0.11)" : "rgba(255, 255, 255, 0.9)",
			"--glass-rim-soft": variant === "dark" ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.68)",
			"--glass-shadow": variant === "dark" ? "0 12px 32px -12px rgba(0, 0, 0, 0.72)" : "0 10px 28px -12px rgba(20, 20, 18, 0.14)",
			"--glass-shadow-sm": variant === "dark" ? "0 4px 14px -6px rgba(0, 0, 0, 0.54)" : "0 2px 10px -4px rgba(20, 20, 18, 0.09)",
			"--glass-dialog-shadow": variant === "dark" ? "0 24px 70px -16px rgba(0, 0, 0, 0.84)" : "0 22px 58px -18px rgba(20, 20, 18, 0.22)",
			"--dialog-scrim": variant === "dark" ? "rgba(0, 0, 0, 0.62)" : "rgba(20, 20, 18, 0.34)",
			"--font-content": formatFontStack(settings.contentFont, "inherit"),
			"--font-code": formatFontStack(settings.codeFont, '"JetBrains Mono", "UDEV Gothic", monospace'),
			"--text-code": `${settings.codeSize}px`, "--text-reading": `${settings.uiSize + 1}px`,
			"--text-control": `${settings.uiSize}px`, "--text-2xs": `${settings.uiSize - 2}px`,
			"--text-xs": `${settings.uiSize - 1}px`, "--text-sm": `${settings.uiSize}px`,
			"--text-md": `${settings.uiSize}px`, "--text-base": `${settings.uiSize + 1}px`,
			"--text-lg": `${settings.uiSize + 2}px`, "--text-xl": `${settings.uiSize + 4}px`,
			"--text-2xl": `${settings.uiSize + 6}px`, "--text-3xl": `${settings.uiSize + 9}px`,
			"--text-4xl": `${settings.uiSize + 15}px`,
			"--code-surface": settings.codeTheme === "auto" ? "var(--surface-sunken)" : code === "dark" ? "#050505" : "#f2f2ee",
			"--code-text": settings.codeTheme === "auto" ? "var(--on-surface)" : code === "dark" ? "#f2f2ef" : "#141412",
		};
		const syntax = code === "dark" ? ["#9ca3af", "#cba6f7", "#a6e3a1", "#fab387", "#89b4fa", "#f9e2af", "#94e2d5", "#f38ba8"] : ["#687078", "#7c3aed", "#217345", "#a14b13", "#175db4", "#80521c", "#006f74", "#b3264c"];
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
