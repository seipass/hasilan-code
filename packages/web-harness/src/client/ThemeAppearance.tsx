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
		const isDefault111Dark =
			variant === "dark" &&
			theme.background.toLowerCase() === "#111111" &&
			theme.foreground.toLowerCase() === "#e2e2e2" &&
			theme.accent.toLowerCase() === "#e2e2e2" &&
			theme.contrast === 50;
		// Exact dark palette, UI chrome, diff, and syntax tokens from ri0n-dev/111-theme (themes/111-theme.json, Copyright (c) 2025 Rion, MIT License).
		const colors: Record<string, string> = {
			"--surface": theme.background,
			"--surface-sunken": isDefault111Dark ? "#111111" : variant === "dark" ? mix("#000000", 35) : mix(theme.foreground, 4 * amount),
			"--surface-panel": isDefault111Dark ? "#161616" : mix(theme.foreground, 2.5 * amount),
			"--surface-raised": isDefault111Dark ? "#191919" : variant === "dark" ? mix(theme.foreground, 4 * amount) : mix("#ffffff", 82),
			"--surface-hover": isDefault111Dark ? "#2a2d2e" : mix(theme.foreground, (variant === "dark" ? 8.5 : 7) * amount),
			"--menu-hover": isDefault111Dark ? "#252525" : mix(theme.foreground, (variant === "dark" ? 7.5 : 6) * amount),
			"--list-active-bg": isDefault111Dark ? "#191919" : variant === "dark" ? mix(theme.foreground, 5 * amount) : mix(theme.foreground, 8 * amount),
			"--list-active-fg": isDefault111Dark ? "#ffffff" : theme.foreground,
			"--list-inactive-bg": isDefault111Dark ? "#1f1f1f" : variant === "dark" ? mix(theme.foreground, 6 * amount) : mix(theme.foreground, 6 * amount),
			"--list-inactive-fg": isDefault111Dark ? "#ececec" : theme.foreground,
			"--list-hover-bg": isDefault111Dark ? "#2a2d2e" : mix(theme.foreground, (variant === "dark" ? 8.5 : 6) * amount),
			"--list-hover-fg": isDefault111Dark ? "#d5d5d5" : theme.foreground,
			"--input-surface": isDefault111Dark ? "#282828" : variant === "dark" ? mix(theme.foreground, 8 * amount) : "#ffffff",
			"--input-filter-surface": isDefault111Dark ? "#262626" : variant === "dark" ? mix(theme.foreground, 7 * amount) : "#ffffff",
			"--input-fg": isDefault111Dark ? "#dbdbdb" : theme.foreground,
			"--input-placeholder": isDefault111Dark ? "#5e5e5e" : mix(theme.foreground, 45),
			"--button-bg": isDefault111Dark ? "#434343" : mix(theme.foreground, 18 * amount),
			"--button-fg": isDefault111Dark ? "#dbdbdb" : theme.foreground,
			"--button-hover-bg": isDefault111Dark ? "#323232" : mix(theme.foreground, 13 * amount),
			"--button-secondary-bg": isDefault111Dark ? "#2c2c2c" : mix(theme.foreground, 10 * amount),
			"--button-secondary-fg": isDefault111Dark ? "#bcbcbc" : mix(theme.foreground, 82),
			"--button-secondary-hover-bg": isDefault111Dark ? "#212121" : mix(theme.foreground, 7 * amount),
			"--surface-inverse": theme.foreground,
			"--on-surface": theme.foreground,
			"--on-surface-strong": isDefault111Dark ? "#f5f5f5" : theme.foreground,
			"--on-surface-sidebar": isDefault111Dark ? "#bebebe" : mix(theme.foreground, variant === "dark" ? 84 : 80),
			"--on-surface-secondary": isDefault111Dark ? "#bababa" : mix(theme.foreground, variant === "dark" ? 80 : 76),
			"--on-surface-muted": isDefault111Dark ? "#a7a7a7" : mix(theme.foreground, variant === "dark" ? 64 : 52),
			"--on-surface-dim": isDefault111Dark ? "#5e5e5e" : mix(theme.foreground, 42),
			"--on-surface-inverse": theme.background,
			"--text-primary": theme.foreground,
			"--text-secondary": `color-mix(in srgb, ${theme.foreground} ${variant === "dark" ? 76 : 74}%, transparent)`,
			"--text-tertiary": `color-mix(in srgb, ${theme.foreground} ${variant === "dark" ? 58 : 54}%, transparent)`,
			"--text-quaternary": `color-mix(in srgb, ${theme.foreground} 36%, transparent)`,
			"--icon-primary": theme.foreground,
			"--icon-secondary": `color-mix(in srgb, ${theme.foreground} 66%, transparent)`,
			"--icon-tertiary": `color-mix(in srgb, ${theme.foreground} 48%, transparent)`,
			"--icon-quaternary": `color-mix(in srgb, ${theme.foreground} 28%, transparent)`,
			"--stroke-primary": `color-mix(in srgb, ${theme.foreground} 20%, transparent)`,
			"--stroke-secondary": `color-mix(in srgb, ${theme.foreground} 12%, transparent)`,
			"--stroke-tertiary": `color-mix(in srgb, ${theme.foreground} 8%, transparent)`,
			"--stroke-quaternary": `color-mix(in srgb, ${theme.foreground} 4%, transparent)`,
			"--tint-hover": `color-mix(in srgb, ${theme.foreground} 8%, transparent)`,
			"--tint-subtle": `color-mix(in srgb, ${theme.foreground} 5%, transparent)`,
			"--titlebar-fg": isDefault111Dark ? "#d9d9d9" : mix(theme.foreground, 84),
			"--sidebar-header-fg": isDefault111Dark ? "#d7d7d7" : mix(theme.foreground, 76),
			"--tab-inactive-fg": isDefault111Dark ? "#e2e2e276" : mix(theme.foreground, 52),
			"--link-fg": isDefault111Dark ? "#e6e6e6" : variant === "dark" ? theme.foreground : "#1a1a1a",
			"--link-hover-fg": variant === "dark" ? "#ffffff" : "#000000",
			"--primary": theme.accent,
			"--primary-hover": mix(theme.accent, 82, variant === "dark" ? "#ffffff" : "#000000"),
			"--primary-container": isDefault111Dark ? "#2c2c2c" : mix(theme.accent, variant === "dark" ? 16 : 12),
			"--on-primary": contrastText(theme.accent),
			"--on-primary-container": theme.foreground,
			"--secondary": variant === "dark" ? "#75beff" : "#2472c8",
			"--secondary-hover": variant === "dark" ? "#9ad0ff" : "#1b5ca6",
			"--secondary-container": isDefault111Dark ? "#263c4f" : mix(variant === "dark" ? "#75beff" : "#2472c8", variant === "dark" ? 16 : 12),
			"--on-secondary-container": theme.foreground,
			"--success": variant === "dark" ? "#73c991" : "#0d8a55",
			"--warning": variant === "dark" ? "#cca700" : "#9a7700",
			"--danger": variant === "dark" ? "#f48771" : "#c73a34",
			"--success-container": isDefault111Dark ? "#27403b" : mix(variant === "dark" ? "#73c991" : "#0d8a55", variant === "dark" ? 15 : 11),
			"--warning-container": isDefault111Dark ? "#3b3000" : mix(variant === "dark" ? "#cca700" : "#9a7700", variant === "dark" ? 15 : 12),
			"--danger-container": isDefault111Dark ? "#452721" : mix(variant === "dark" ? "#f48771" : "#c73a34", variant === "dark" ? 15 : 11),
			"--on-success-container": variant === "dark" ? "#73c991" : "#0d8a55",
			"--on-warning-container": variant === "dark" ? "#cca700" : "#9a7700",
			"--on-danger-container": variant === "dark" ? "#f48771" : "#c73a34",
			"--border-sidebar": isDefault111Dark ? "#ffffff00" : mix(theme.foreground, 7 * amount),
			"--border-topbar": isDefault111Dark ? "#00000000" : mix(theme.foreground, 7 * amount),
			"--border-panel": isDefault111Dark ? "#2a2a2a" : mix(theme.foreground, 11 * amount),
			"--border-tab": isDefault111Dark ? "#212121" : mix(theme.foreground, 8 * amount),
			"--border-tabs-bar": isDefault111Dark ? "#191919" : mix(theme.foreground, 8 * amount),
			"--border-group": isDefault111Dark ? "#363636" : mix(theme.foreground, 14 * amount),
			"--border-subtle": isDefault111Dark ? "#212121" : mix(theme.foreground, 7 * amount),
			"--border": isDefault111Dark ? "#2c2c2c" : mix(theme.foreground, 12 * amount),
			"--border-strong": isDefault111Dark ? "#3f3f3f" : mix(theme.foreground, 20 * amount),
			"--menu-separator": isDefault111Dark ? "#bababa14" : mix(theme.foreground, 10 * amount),
			"--tree-indent-guide": isDefault111Dark ? "#8c8c8c" : mix(theme.foreground, 28),
			"--badge-bg": isDefault111Dark ? "#a7a7a730" : mix(theme.foreground, 10),
			"--badge-fg": isDefault111Dark ? "#e0e0e0" : theme.foreground,
			"--selection-fill": isDefault111Dark ? "#1f1f1f" : `color-mix(in srgb, ${theme.foreground} ${variant === "dark" ? 11 : 8}%, transparent)`,
			"--text-selection-bg": isDefault111Dark ? "#3a3a3a" : `color-mix(in srgb, ${theme.accent} 22%, transparent)`,
			"--text-selection-fg": isDefault111Dark ? "#ffffff" : theme.foreground,
			"--focus-ring": isDefault111Dark ? "#ffffff28" : `color-mix(in srgb, ${theme.foreground} ${variant === "dark" ? 30 : 30}%, transparent)`,
			"--scroll-thumb": isDefault111Dark ? "#47474766" : mix(theme.foreground, 22),
			"--scroll-thumb-hover": isDefault111Dark ? "#47474787" : mix(theme.foreground, 32),
			"--scroll-thumb-active": isDefault111Dark ? "#4747479d" : mix(theme.foreground, 42),
			"--diff-add-bg": variant === "dark" ? "#9bb95533" : "#dcfce7",
			"--diff-add-fg": variant === "dark" ? "#98c379" : "#166534",
			"--diff-remove-bg": variant === "dark" ? "#ff000033" : "#fee2e2",
			"--diff-remove-fg": variant === "dark" ? "#e06c75" : "#991b1b",
			"--diff-hunk-fg": variant === "dark" ? "#61afef" : "#1d4ed8",
			"--diff-border": isDefault111Dark ? "#444444" : mix(theme.foreground, 16 * amount),
			"--git-added": variant === "dark" ? "#81b88b" : "#15803d",
			"--git-modified": variant === "dark" ? "#e2c08d" : "#b45309",
			"--git-deleted": variant === "dark" ? "#c74e39" : "#b91c1c",
			"--git-ignored": variant === "dark" ? "#8c8c8c" : "#737373",
			"--glass-surface": variant === "dark" ? "color-mix(in srgb, var(--surface-raised) 86%, transparent)" : "color-mix(in srgb, #ffffff 80%, var(--surface))",
			"--glass-panel": variant === "dark" ? "color-mix(in srgb, var(--surface-panel) 90%, transparent)" : "color-mix(in srgb, var(--surface-panel) 84%, transparent)",
			"--glass-popup": isDefault111Dark ? "color-mix(in srgb, #191919 94%, transparent)" : variant === "dark" ? "color-mix(in srgb, var(--surface-raised) 92%, transparent)" : "color-mix(in srgb, #ffffff 90%, var(--surface))",
			"--glass-card": variant === "dark" ? "color-mix(in srgb, var(--surface-panel) 84%, transparent)" : "color-mix(in srgb, #ffffff 84%, var(--surface))",
			"--glass-pill": variant === "dark" ? "color-mix(in srgb, var(--surface-hover) 72%, transparent)" : "color-mix(in srgb, #ffffff 74%, var(--surface-hover))",
			"--glass-rim": variant === "dark" ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.9)",
			"--glass-rim-soft": variant === "dark" ? "rgba(255, 255, 255, 0.04)" : "rgba(255, 255, 255, 0.68)",
			"--glass-shadow": isDefault111Dark ? "0 10px 28px -8px #00000085" : variant === "dark" ? "0 12px 32px -12px rgba(0, 0, 0, 0.7)" : "0 10px 28px -12px rgba(20, 20, 18, 0.14)",
			"--glass-shadow-sm": isDefault111Dark ? "0 4px 14px -6px #0000005c" : variant === "dark" ? "0 4px 14px -6px rgba(0, 0, 0, 0.52)" : "0 2px 10px -4px rgba(20, 20, 18, 0.09)",
			"--glass-dialog-shadow": isDefault111Dark ? "0 20px 60px -14px #000000a6" : variant === "dark" ? "0 24px 70px -16px rgba(0, 0, 0, 0.82)" : "0 22px 58px -18px rgba(20, 20, 18, 0.22)",
			"--composer-surface": isDefault111Dark ? "#161616" : variant === "dark" ? mix(theme.foreground, 2.2 * amount) : mix("#ffffff", 45, theme.background),
			"--composer-border": isDefault111Dark ? "#2a2a2a" : mix(theme.foreground, 10 * amount),
			"--composer-shadow": "none",
			"--dialog-scrim": variant === "dark" ? "rgba(0, 0, 0, 0.58)" : "rgba(20, 20, 18, 0.34)",
			"--font-content": formatFontStack(settings.contentFont, "inherit"),
			"--font-code": formatFontStack(settings.codeFont, '"JetBrains Mono", "UDEV Gothic", monospace'),
			"--text-code": `${settings.codeSize}px`, "--text-reading": `${settings.uiSize + 1}px`,
			"--text-control": `${settings.uiSize}px`, "--text-2xs": `${settings.uiSize - 2}px`,
			"--text-xs": `${settings.uiSize - 1}px`, "--text-sm": `${settings.uiSize}px`,
			"--text-md": `${settings.uiSize}px`, "--text-base": `${settings.uiSize + 1}px`,
			"--text-lg": `${settings.uiSize + 2}px`, "--text-xl": `${settings.uiSize + 4}px`,
			"--text-2xl": `${settings.uiSize + 6}px`, "--text-3xl": `${settings.uiSize + 9}px`,
			"--text-4xl": `${settings.uiSize + 15}px`,
			"--editor-surface": settings.codeTheme === "auto" ? "var(--surface)" : code === "dark" ? "#111111" : "#f5f5f5",
			"--editor-gutter": settings.codeTheme === "auto" ? (variant === "dark" ? "var(--surface-raised)" : "var(--surface-panel)") : code === "dark" ? "#191919" : "#ebebeb",
			"--editor-line-number": code === "dark" ? "#a3a3a3" : "#737373",
			"--editor-line-number-active": code === "dark" ? "#bdbdbd" : "#1a1a1a",
			"--editor-line-highlight": code === "dark" ? "#ffffff0a" : "#00000008",
			"--editor-line-highlight-border": code === "dark" ? "#282828" : "#e5e5e5",
			"--editor-cursor": code === "dark" ? "#8e8e8e" : "#1a1a1a",
			"--editor-suggest-bg": code === "dark" ? "#252526" : "#ffffff",
			"--editor-suggest-border": code === "dark" ? "#454545" : "#d4d4d4",
			"--editor-suggest-fg": code === "dark" ? "#d4d4d4" : "#1a1a1a",
			"--editor-suggest-selected": code === "dark" ? "#062f4a" : "#e5e5e5",
			"--terminal-fg": code === "dark" ? "#cccccc" : "#1a1a1a",
			"--terminal-cursor": code === "dark" ? "#e6e6e6" : "#1a1a1a",
			"--code-surface": settings.codeTheme === "auto" ? "var(--surface-panel)" : code === "dark" ? "#161616" : "#efefef",
			"--code-text": settings.codeTheme === "auto" ? "var(--on-surface-secondary)" : code === "dark" ? "#bababa" : "#242424",
		};
		const syntax = code === "dark"
			? ["#686868", "#c678dd", "#98c379", "#d19a66", "#61afef", "#e5c07b", "#56b6c2", "#e06c75", "#bababa", "#f44747"]
			: ["#7a7a7a", "#a626a4", "#50a14f", "#986801", "#4078f2", "#c18401", "#0184bc", "#e45649", "#383a42", "#c73a34"];
		["comment", "keyword", "string", "number", "function", "type", "property", "meta", "punctuation", "invalid"].forEach((name, i) => { colors[`--syntax-${name}`] = syntax[i]; });
		for (const [name, value] of Object.entries(colors)) root.style.setProperty(name, value);
		root.style.colorScheme = variant;
		root.style.fontSize = `${settings.uiSize}px`;
		root.dataset.theme = variant;
		root.dataset.translucentSidebar = String(settings.translucentSidebar);
		return () => { for (const name of Object.keys(colors)) root.style.removeProperty(name); root.style.removeProperty("color-scheme"); root.style.removeProperty("font-size"); delete root.dataset.theme; delete root.dataset.translucentSidebar; };
	}, [settings, systemDark, selectedTheme]);
	return null;
}

const DARK_PRESETS = [
	{ name: "#111（標準）", colors: standardTheme.dark },
	{ name: "漆黒 OLED", colors: { background: "#000000", foreground: "#e2e2e2", accent: "#e2e2e2", contrast: 55 } },
	{ name: "スレート", colors: { background: "#111318", foreground: "#e8ecf2", accent: "#e8ecf2", contrast: 50 } },
	{ name: "ミッドナイト", colors: { background: "#0d1117", foreground: "#e6edf3", accent: "#75beff", contrast: 50 } },
] as const;

const LIGHT_PRESETS = [
	{ name: "ライト標準", colors: standardTheme.light },
	{ name: "ピュアホワイト", colors: { background: "#ffffff", foreground: "#18181b", accent: "#18181b", contrast: 50 } },
	{ name: "ウォームペーパー", colors: { background: "#f5f2eb", foreground: "#1f1d1a", accent: "#1f1d1a", contrast: 52 } },
] as const;

export function ThemeAppearance() {
	const [settings, setSettings] = usePreferenceState(KEY, DEFAULT, readAppearance);
	const { themes, selectedTheme } = useThemeSelection(settings.themeId);
	const [systemVariant, setSystemVariant] = useState<Variant>(() =>
		window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
	);
	const [share, setShare] = useState("");
	const [message, setMessage] = useState("");
	const [showImport, setShowImport] = useState(false);
	const selected: Variant = settings.mode === "system" ? systemVariant : settings.mode;
	const update = (patch: Partial<Appearance>) => setSettings((old) => ({ ...old, ...patch }));
	const updateVariant = (patch: Partial<Appearance[Variant]>) =>
		setSettings((old) => ({ ...old, [selected]: { ...old[selected], ...patch } }));
	const variant = settings[selected];
	const presets = selected === "dark" ? DARK_PRESETS : LIGHT_PRESETS;

	return (
		<section id="appearance-theme" className="appearance-card theme-appearance">
			<div className="appearance-card-header">
				<div>
					<h3>テーマ</h3>
					<p className="appearance-card-desc">配色・コントラスト・コードブロックの見た目を調整します。</p>
				</div>
				{selectedTheme?.customizable && (
					<div className="appearance-card-actions">
						<button
							type="button"
							className="appearance-ghost-btn"
							onClick={() => {
								setMessage("");
								setShowImport(!showImport);
							}}
						>
							読み込む
						</button>
						<button
							type="button"
							className="appearance-ghost-btn"
							onClick={() => {
								void navigator.clipboard
									.writeText(JSON.stringify({ format: "hasilan-theme-v1", variant: selected, colors: variant }))
									.then(
										() => setMessage("テーマをコピーしました。"),
										() => setMessage("コピーできませんでした。"),
									);
							}}
						>
							コピー
						</button>
						<button
							type="button"
							className="appearance-ghost-btn"
							onClick={() => {
								updateVariant(DEFAULT[selected]);
								setMessage("標準テーマに戻しました。");
							}}
						>
							リセット
						</button>
					</div>
				)}
			</div>

			{themes.some(({ customizable }) => !customizable) && (
				<div className="appearance-setting-row">
					<span className="appearance-row-label">配色</span>
					<Select
						aria-label="配色"
						value={selectedTheme?.id ?? ""}
						onChange={(value) => update({ themeId: value || undefined })}
					>
						{!themes.some(({ id }) => id === DEFAULT_THEME_ID) && <option value="">標準</option>}
						{themes.map(({ id, title }) => (
							<option key={id} value={id}>
								{title}
							</option>
						))}
					</Select>
				</div>
			)}

			<div className="theme-mode-bar">
				<div className="theme-modes" role="group" aria-label="テーマモード">
					{(
						[
							["system", "システム"],
							["light", "ライト"],
							["dark", "ダーク"],
						] as const
					).map(([value, label]) => (
						<button
							type="button"
							key={value}
							aria-pressed={settings.mode === value}
							onClick={() => {
								update({ mode: value });
								if (value === "system") {
									setSystemVariant(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
								}
							}}
						>
							{label}
						</button>
					))}
				</div>
				{selectedTheme?.customizable && settings.mode === "system" && (
					<div className="theme-variants" role="group" aria-label="編集するテーマ">
						{(["light", "dark"] as const).map((value) => (
							<button
								type="button"
								key={value}
								aria-pressed={selected === value}
								onClick={() => setSystemVariant(value)}
							>
								{value === "light" ? "ライト編集" : "ダーク編集"}
							</button>
						))}
					</div>
				)}
			</div>

			{selectedTheme?.customizable && (
				<>
					{showImport && (
						<div className="theme-import">
							<label>
								テーマの文字列（JSON）
								<textarea value={share} onChange={(event) => setShare(event.currentTarget.value)} rows={3} />
							</label>
							<div className="theme-import-actions">
								<button type="button" className="appearance-ghost-btn" onClick={() => setShowImport(false)}>
									キャンセル
								</button>
								<button
									type="button"
									className="appearance-primary-btn"
									onClick={() => {
										try {
											const data: unknown = JSON.parse(share);
											if (
												!data ||
												typeof data !== "object" ||
												!("colors" in data) ||
												!("format" in data) ||
												data.format !== "hasilan-theme-v1"
											)
												throw new Error();
											const next = { ...settings, [selected]: data.colors };
											if (!Check(appearanceSchema, next)) throw new Error();
											setSettings(next);
											setMessage("テーマを読み込みました。");
											setShowImport(false);
										} catch {
											setMessage("有効なテーマ文字列を入力してください。");
										}
									}}
								>
									適用
								</button>
							</div>
						</div>
					)}

					<div className="theme-presets" role="group" aria-label="配色プリセット">
						{presets.map((preset) => {
							const active =
								variant.background.toLowerCase() === preset.colors.background.toLowerCase() &&
								variant.foreground.toLowerCase() === preset.colors.foreground.toLowerCase() &&
								variant.accent.toLowerCase() === preset.colors.accent.toLowerCase();
							return (
								<button
									type="button"
									key={preset.name}
									className="theme-preset-chip"
									aria-pressed={active}
									onClick={() => updateVariant(preset.colors)}
								>
									<span className="theme-preset-dots" aria-hidden="true">
										<i style={{ background: preset.colors.background }} />
										<i style={{ background: preset.colors.accent }} />
									</span>
									<span>{preset.name}</span>
								</button>
							);
						})}
					</div>

					<div className="theme-color-grid">
						{(
							[
								["background", "背景"],
								["foreground", "文字"],
								["accent", "アクセント"],
							] as const
						).map(([key, label]) => (
							<label key={key} className="theme-color-card">
								<input
									type="color"
									aria-label={`${label}の色`}
									value={variant[key]}
									onChange={(event) => updateVariant({ [key]: event.currentTarget.value })}
								/>
								<span className="theme-color-meta">
									<strong>{label}</strong>
									<code>{variant[key]}</code>
								</span>
							</label>
						))}
					</div>

					<label className="theme-range">
						<span>コントラスト</span>
						<output>{variant.contrast}</output>
						<input
							type="range"
							min="0"
							max="100"
							value={variant.contrast}
							style={{ "--theme-range-progress": `${variant.contrast}%` } as CSSProperties}
							onChange={(event) => updateVariant({ contrast: Number(event.currentTarget.value) })}
						/>
					</label>
				</>
			)}

			<div className="appearance-divider" />

			<div className="appearance-setting-row">
				<span className="appearance-row-label">コードのテーマ</span>
				<Select
					aria-label="コードのテーマ"
					value={settings.codeTheme}
					onChange={(value) => update({ codeTheme: value as Appearance["codeTheme"] })}
				>
					<option value="auto">画面に合わせる</option>
					<option value="dark">ダーク</option>
					<option value="light">ライト</option>
				</Select>
			</div>

			<label className="settings-toggle appearance-toggle-row">
				<span className="appearance-toggle-copy">
					<strong>サイドバーを半透明にする</strong>
					<span>背景をうっすら透過させて奥行きを出します</span>
				</span>
				<input
					type="checkbox"
					checked={settings.translucentSidebar}
					onChange={(event) => update({ translucentSidebar: event.currentTarget.checked })}
				/>
			</label>

			{message && (
				<p className="appearance-status-msg" role="status">
					{message}
				</p>
			)}
		</section>
	);
}
