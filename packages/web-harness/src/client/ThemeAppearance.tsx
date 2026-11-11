import { useEffect, useState } from "react";
import { Check } from "typebox/value";
import { appearanceSchema, type Appearance } from "../shared/ui-preferences.ts";
import { usePreferenceState } from "./preferences.ts";
import { Select } from "./Select.tsx";
import "./ThemeAppearance.css";

const KEY = "pi-web-appearance";
const DEFAULT: Appearance = {
	mode: "dark",
	dark: { background: "#141414", foreground: "#e8e8e8", accent: "#e8e8e8", contrast: 50 },
	light: { background: "#ffffff", foreground: "#202124", accent: "#2563eb", contrast: 50 },
	codeTheme: "auto", contentFont: "", codeFont: "", uiSize: 13, codeSize: 13, translucentSidebar: false,
};
type Variant = "dark" | "light";
function readAppearance(raw: string | null): Appearance {
	try { const value: unknown = JSON.parse(raw ?? "null"); return Check(appearanceSchema, value) ? value as Appearance : DEFAULT; }
	catch { return DEFAULT; }
}
function fontFamily(value: string, fallback: string): string {
	return value.trim() ? `${JSON.stringify(value.trim())}, ${fallback}` : fallback;
}

/** Applies synchronized appearance preferences outside the settings dialog. */
export function ApplicationTheme() {
	const [settings] = usePreferenceState(KEY, DEFAULT, readAppearance);
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
		const theme = settings[variant];
		const code = settings.codeTheme === "auto" ? variant : settings.codeTheme;
		const mix = (color: string, percent: number, base = theme.background) => `color-mix(in srgb, ${color} ${percent}%, ${base})`;
		const amount = 0.65 + theme.contrast / 100;
		const colors: Record<string, string> = {
			"--surface": theme.background, "--surface-sunken": mix(variant === "dark" ? "#000" : "#fff", 18),
			"--surface-panel": mix(theme.foreground, 3 * amount), "--surface-raised": mix(theme.foreground, 5 * amount),
			"--surface-hover": mix(theme.foreground, 10 * amount), "--surface-inverse": theme.foreground,
			"--on-surface": theme.foreground, "--on-surface-secondary": mix(theme.foreground, 78),
			"--on-surface-muted": mix(theme.foreground, 62), "--on-surface-inverse": theme.background,
			"--primary": theme.accent, "--primary-hover": mix(theme.accent, 80, theme.foreground),
			"--primary-container": mix(theme.accent, 16), "--on-primary": theme.background,
			"--on-primary-container": theme.foreground, "--secondary": variant === "dark" ? "#9bbcf0" : "#245bb4",
			"--secondary-hover": variant === "dark" ? "#c0d6f6" : "#17458d",
			"--secondary-container": mix(theme.accent, 18), "--on-secondary-container": theme.foreground,
			"--success": variant === "dark" ? "#a6e3a1" : "#26723b",
			"--warning": variant === "dark" ? "#f9e2af" : "#805800",
			"--danger": variant === "dark" ? "#f38ba8" : "#b3264c",
			"--success-container": mix(variant === "dark" ? "#a6e3a1" : "#26723b", 15),
			"--warning-container": mix(variant === "dark" ? "#f9e2af" : "#805800", 15),
			"--danger-container": mix(variant === "dark" ? "#f38ba8" : "#b3264c", 15),
			"--on-success-container": variant === "dark" ? "#a6e3a1" : "#26723b",
			"--on-warning-container": variant === "dark" ? "#f9e2af" : "#805800",
			"--on-danger-container": variant === "dark" ? "#f38ba8" : "#b3264c",
			"--border-subtle": mix(theme.foreground, 6 * amount), "--border": mix(theme.foreground, 12 * amount),
			"--border-strong": mix(theme.foreground, 22 * amount), "--scroll-thumb": mix(theme.foreground, 20),
			"--scroll-thumb-hover": mix(theme.foreground, 32),
			"--font-content": fontFamily(settings.contentFont, "inherit"),
			"--font-code": fontFamily(settings.codeFont, '"JetBrains Mono", "UDEV Gothic", monospace'),
			"--text-code": `${settings.codeSize}px`, "--text-reading": `${settings.uiSize + 1}px`,
			"--text-control": `${settings.uiSize}px`, "--text-2xs": `${settings.uiSize - 2}px`,
			"--text-xs": `${settings.uiSize - 1}px`, "--text-sm": `${settings.uiSize}px`,
			"--text-md": `${settings.uiSize}px`, "--text-base": `${settings.uiSize + 1}px`,
			"--text-lg": `${settings.uiSize + 2}px`, "--text-xl": `${settings.uiSize + 4}px`,
			"--text-2xl": `${settings.uiSize + 6}px`, "--text-3xl": `${settings.uiSize + 9}px`,
			"--text-4xl": `${settings.uiSize + 15}px`,
			"--code-surface": settings.codeTheme === "auto" ? "var(--surface-sunken)" : code === "dark" ? "#111111" : "#f7f7f8",
			"--code-text": settings.codeTheme === "auto" ? "var(--on-surface)" : code === "dark" ? "#e8e8e8" : "#202124",
		};
		const syntax = code === "dark" ? ["#9ca3af", "#cba6f7", "#a6e3a1", "#fab387", "#89b4fa", "#f9e2af", "#94e2d5", "#f38ba8"] : ["#687078", "#7c3aed", "#217345", "#a14b13", "#175db4", "#80521c", "#006f74", "#b3264c"];
		["comment", "keyword", "string", "number", "function", "type", "property", "meta"].forEach((name, i) => { colors[`--syntax-${name}`] = syntax[i]; });
		for (const [name, value] of Object.entries(colors)) root.style.setProperty(name, value);
		root.style.colorScheme = variant;
		root.style.fontSize = `${settings.uiSize}px`;
		root.dataset.theme = variant;
		root.dataset.translucentSidebar = String(settings.translucentSidebar);
		return () => { for (const name of Object.keys(colors)) root.style.removeProperty(name); root.style.removeProperty("color-scheme"); root.style.removeProperty("font-size"); delete root.dataset.theme; delete root.dataset.translucentSidebar; };
	}, [settings, systemDark]);
	return null;
}

export function ThemeAppearance() {
	const [settings, setSettings] = usePreferenceState(KEY, DEFAULT, readAppearance);
	const [selected, setSelected] = useState<Variant>(() => settings.mode === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : settings.mode);
	const [share, setShare] = useState("");
	const [message, setMessage] = useState("");
	const [showImport, setShowImport] = useState(false);
	const update = (patch: Partial<Appearance>) => setSettings((old) => ({ ...old, ...patch }));
	const updateVariant = (patch: Partial<Appearance[Variant]>) => setSettings((old) => ({ ...old, [selected]: { ...old[selected], ...patch } }));
	const variant = settings[selected];
	return <section className="settings-section theme-appearance">
		<h3>テーマ</h3>
		<div className="theme-modes" role="group" aria-label="テーマモード">{([ ["system", "システム"], ["light", "ライト"], ["dark", "ダーク"] ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={settings.mode === value} onClick={() => { update({ mode: value }); setSelected(value === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : value); }}>{label}</button>)}</div>
		<div className="theme-heading"><h4>{selected === "dark" ? "ダーク" : "ライト"}テーマ</h4><div><button type="button" onClick={() => { setMessage(""); setShowImport(!showImport); }}>読み込む</button><button type="button" onClick={() => { void navigator.clipboard.writeText(JSON.stringify({ format: "hasilan-theme-v1", variant: selected, colors: variant })).then(() => setMessage("テーマをコピーしました。"), () => setMessage("コピーできませんでした。")); }}>コピー</button></div></div>
		<div className="theme-variants" role="group" aria-label="編集するテーマ">{(["light", "dark"] as const).map((value) => <button type="button" key={value} aria-pressed={selected === value} onClick={() => setSelected(value)}>{value === "light" ? "ライト" : "ダーク"}</button>)}</div>
		{showImport && <div className="theme-import"><label>テーマの文字列<textarea value={share} onChange={(event) => setShare(event.currentTarget.value)} rows={3} /></label><button type="button" onClick={() => { try { const data: unknown = JSON.parse(share); if (!data || typeof data !== "object" || !("colors" in data) || !("format" in data) || data.format !== "hasilan-theme-v1") throw new Error(); const next = { ...settings, [selected]: data.colors }; if (!Check(appearanceSchema, next)) throw new Error(); setSettings(next); setMessage("テーマを読み込みました。"); setShowImport(false); } catch { setMessage("有効なテーマ文字列を入力してください。"); } }}>適用</button></div>}
		<div className="theme-color-grid">{([ ["background", "背景"], ["foreground", "文字"], ["accent", "アクセント"] ] as const).map(([key, label]) => <label key={key}>{label}<span><input type="color" aria-label={`${label}の色`} value={variant[key]} onChange={(event) => updateVariant({ [key]: event.currentTarget.value })} /><code>{variant[key]}</code></span></label>)}</div>
		<label className="theme-range">コントラスト <output>{variant.contrast}</output><input type="range" min="0" max="100" value={variant.contrast} onChange={(event) => updateVariant({ contrast: Number(event.currentTarget.value) })} /></label>
		<button type="button" onClick={() => updateVariant(DEFAULT[selected])}>このテーマをリセット</button>
		<label>コードのテーマ<Select aria-label="コードのテーマ" value={settings.codeTheme} onChange={(value) => update({ codeTheme: value as Appearance["codeTheme"] })}><option value="auto">画面に合わせる</option><option value="dark">ダーク</option><option value="light">ライト</option></Select></label>
		<label>本文のフォント<input value={settings.contentFont} maxLength={200} placeholder="画面のフォントに合わせる" onChange={(event) => update({ contentFont: event.currentTarget.value })} /></label>
		<label>コードのフォント<input value={settings.codeFont} maxLength={200} placeholder="JetBrains Mono" onChange={(event) => update({ codeFont: event.currentTarget.value })} /></label>
		<div className="theme-size-grid"><label>画面の文字サイズ<input type="number" min="11" max="20" value={settings.uiSize} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 11 && value <= 20) update({ uiSize: value }); }} /></label><label>コードの文字サイズ<input type="number" min="10" max="24" value={settings.codeSize} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 10 && value <= 24) update({ codeSize: value }); }} /></label></div>
		<label className="settings-toggle"><input type="checkbox" checked={settings.translucentSidebar} onChange={(event) => update({ translucentSidebar: event.currentTarget.checked })} /><span>サイドバーを半透明にする</span></label>
		<p className="fine-print">変更はすぐに反映・保存され、Web版とデスクトップ版で共有されます。テーマ文字列はHasilan Code間で共有できます。</p>
		{message && <p role="status">{message}</p>}
	</section>;
}
