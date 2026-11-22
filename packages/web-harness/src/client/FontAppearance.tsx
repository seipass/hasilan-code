import { useEffect, useId, useState } from "react";
import { standardTheme } from "../shared/plugin-profile.ts";
import type { Appearance } from "../shared/ui-preferences.ts";
import { usePreferenceState } from "./preferences.ts";
import { readAppearance } from "./ThemeAppearance.tsx";
import "./FontAppearance.css";

const FONT_KEY = "pi-web-ui-font";
const APPEARANCE_KEY = "pi-web-appearance";
const DEFAULT_FONT = "Yu Gothic UI";
const DEFAULT_APPEARANCE: Appearance = {
	mode: "dark",
	dark: standardTheme.dark,
	light: standardTheme.light,
	codeTheme: "auto",
	contentFont: "",
	codeFont: "",
	uiSize: 13,
	codeSize: 13,
	translucentSidebar: false,
};

const GENERIC_FAMILIES = new Set([
	"system-ui",
	"sans-serif",
	"serif",
	"monospace",
	"ui-sans-serif",
	"ui-serif",
	"ui-monospace",
	"ui-rounded",
	"cursive",
	"fantasy",
	"emoji",
	"math",
	"fangsong",
	"inherit",
]);

const UI_PRESETS = [
	{ value: DEFAULT_FONT, label: "Yu Gothic UI（標準）" },
	{ value: "system-ui", label: "システム標準" },
	{ value: "Inter", label: "Inter" },
	{ value: "Noto Sans JP", label: "Noto Sans JP" },
	{ value: "BIZ UDPGothic", label: "BIZ UDPGothic" },
	{ value: "Hiragino Sans", label: "Hiragino Sans" },
	{ value: "Meiryo", label: "Meiryo" },
	{ value: "Segoe UI", label: "Segoe UI" },
];

const CONTENT_PRESETS = [
	{ value: "", label: "画面と同じ" },
	{ value: "Noto Sans JP", label: "Noto Sans JP" },
	{ value: "Noto Serif JP", label: "Noto Serif JP" },
	{ value: "BIZ UDPMincho", label: "BIZ UDPMincho" },
	{ value: "Georgia", label: "Georgia" },
	{ value: "Inter", label: "Inter" },
];

const CODE_PRESETS = [
	{ value: "", label: "標準" },
	{ value: "JetBrains Mono", label: "JetBrains Mono" },
	{ value: "UDEV Gothic", label: "UDEV Gothic" },
	{ value: "Cascadia Code", label: "Cascadia Code" },
	{ value: "Fira Code", label: "Fira Code" },
	{ value: "HackGen", label: "HackGen" },
	{ value: "Consolas", label: "Consolas" },
	{ value: "monospace", label: "monospace" },
];

/** Formats a single font name or comma-separated CSS font stack safely. */
export function formatFontStack(value: string, fallback: string): string {
	const parts = value
		.split(",")
		.map((part) => part.trim().replace(/^["']+|["']+$/g, "").trim())
		.filter(Boolean)
		.map((part) => (GENERIC_FAMILIES.has(part.toLowerCase()) ? part.toLowerCase() : JSON.stringify(part)));
	if (!parts.length) return fallback;
	return `${parts.join(", ")}, ${fallback}`;
}

interface LocalFontData {
	family: string;
}

declare global {
	interface Window {
		queryLocalFonts?: () => Promise<LocalFontData[]>;
	}
}

/** Mounted independently of settings so saved fonts also apply on startup and remote sync. */
export function ApplicationFont() {
	const [font] = usePreferenceState(FONT_KEY, DEFAULT_FONT);
	useEffect(() => {
		document.documentElement.style.fontFamily = formatFontStack(
			font || DEFAULT_FONT,
			'"Inter", "Gen Interface JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", system-ui, -apple-system, sans-serif',
		);
		return () => {
			document.documentElement.style.removeProperty("font-family");
		};
	}, [font]);
	return null;
}

export function FontAppearance() {
	const listId = useId();
	const [font, setFont] = usePreferenceState(FONT_KEY, DEFAULT_FONT);
	const [appearance, setAppearance] = usePreferenceState(APPEARANCE_KEY, DEFAULT_APPEARANCE, readAppearance);
	const [localFonts, setLocalFonts] = useState<string[]>([]);
	const [loadingFonts, setLoadingFonts] = useState(false);
	const [fontNotice, setFontNotice] = useState("");
	const updateAppearance = (patch: Partial<Appearance>) => setAppearance((old) => ({ ...old, ...patch }));
	const canQueryLocal = typeof window !== "undefined" && typeof window.queryLocalFonts === "function";

	async function loadLocalFonts() {
		if (!window.queryLocalFonts || loadingFonts) return;
		setLoadingFonts(true);
		setFontNotice("");
		try {
			const entries = await window.queryLocalFonts();
			const families = [...new Set(entries.map((entry) => entry.family.trim()).filter(Boolean))].sort((a, b) =>
				a.localeCompare(b),
			);
			setLocalFonts(families);
			setFontNotice(`${families.length} 件のシステムフォントを候補に追加しました。`);
		} catch {
			setFontNotice("システムフォントの一覧を取得できませんでした。フォント名を直接入力してください。");
		} finally {
			setLoadingFonts(false);
		}
	}

	function resetFonts() {
		setFont(DEFAULT_FONT);
		updateAppearance({ contentFont: "", codeFont: "", uiSize: 13, codeSize: 13 });
		setFontNotice("フォント設定を標準に戻しました。");
	}

	const uiSuggestions = [...new Set([...UI_PRESETS.map((entry) => entry.value), ...localFonts])];
	const codeSuggestions = [...new Set([...CODE_PRESETS.map((entry) => entry.value).filter(Boolean), ...localFonts])];

	return (
		<section className="settings-section font-appearance">
			<div className="font-appearance-header">
				<h3>フォント</h3>
				<div className="font-appearance-actions">
					{canQueryLocal && (
						<button type="button" disabled={loadingFonts} onClick={() => { void loadLocalFonts(); }}>
							{loadingFonts ? "読み込み中…" : "端末のフォントを取得"}
						</button>
					)}
					<button type="button" onClick={resetFonts}>
						標準に戻す
					</button>
				</div>
			</div>

			<div className="font-field">
				<label>
					画面のフォント
					<input
						aria-label="画面のフォント"
						list={`${listId}-ui`}
						maxLength={200}
						value={font}
						placeholder="例: Inter, Noto Sans JP, sans-serif"
						onChange={(event) => setFont(event.currentTarget.value)}
					/>
				</label>
				<datalist id={`${listId}-ui`}>
					{uiSuggestions.map((family) => (
						<option key={family} value={family} />
					))}
				</datalist>
				<div className="font-presets" role="group" aria-label="画面のフォント候補">
					{UI_PRESETS.map((preset) => (
						<button
							type="button"
							key={preset.value}
							aria-pressed={font.trim() === preset.value}
							onClick={() => setFont(preset.value)}
						>
							{preset.label}
						</button>
					))}
				</div>
			</div>

			<div className="font-field">
				<label>
					本文のフォント
					<input
						aria-label="本文のフォント"
						list={`${listId}-ui`}
						maxLength={200}
						value={appearance.contentFont}
						placeholder="空欄なら画面のフォントを使用"
						onChange={(event) => updateAppearance({ contentFont: event.currentTarget.value })}
					/>
				</label>
				<div className="font-presets" role="group" aria-label="本文のフォント候補">
					{CONTENT_PRESETS.map((preset) => (
						<button
							type="button"
							key={preset.value || "inherit"}
							aria-pressed={appearance.contentFont.trim() === preset.value}
							onClick={() => updateAppearance({ contentFont: preset.value })}
						>
							{preset.label}
						</button>
					))}
				</div>
			</div>

			<div className="font-field">
				<label>
					コード・端末のフォント
					<input
						aria-label="コード・端末のフォント"
						list={`${listId}-code`}
						maxLength={200}
						value={appearance.codeFont}
						placeholder="例: JetBrains Mono, UDEV Gothic, monospace"
						onChange={(event) => updateAppearance({ codeFont: event.currentTarget.value })}
					/>
				</label>
				<datalist id={`${listId}-code`}>
					{codeSuggestions.map((family) => (
						<option key={family} value={family} />
					))}
				</datalist>
				<div className="font-presets" role="group" aria-label="コード・端末のフォント候補">
					{CODE_PRESETS.map((preset) => (
						<button
							type="button"
							key={preset.value || "default"}
							aria-pressed={appearance.codeFont.trim() === preset.value}
							onClick={() => updateAppearance({ codeFont: preset.value })}
						>
							{preset.label}
						</button>
					))}
				</div>
			</div>

			<div className="font-size-grid">
				<label className="font-size-control">
					画面の文字サイズ（px）
					<div className="font-size-row">
						<input
							type="range"
							min="11"
							max="20"
							aria-label="画面の文字サイズスライダー"
							value={appearance.uiSize}
							onChange={(event) => updateAppearance({ uiSize: Number(event.currentTarget.value) })}
						/>
						<input
							type="number"
							min="11"
							max="20"
							aria-label="画面の文字サイズ"
							value={appearance.uiSize}
							onChange={(event) => {
								const value = event.currentTarget.valueAsNumber;
								if (Number.isInteger(value) && value >= 11 && value <= 20) updateAppearance({ uiSize: value });
							}}
						/>
					</div>
				</label>
				<label className="font-size-control">
					コード・端末の文字サイズ（px）
					<div className="font-size-row">
						<input
							type="range"
							min="10"
							max="24"
							aria-label="コードの文字サイズスライダー"
							value={appearance.codeSize}
							onChange={(event) => updateAppearance({ codeSize: Number(event.currentTarget.value) })}
						/>
						<input
							type="number"
							min="10"
							max="24"
							aria-label="コードの文字サイズ"
							value={appearance.codeSize}
							onChange={(event) => {
								const value = event.currentTarget.valueAsNumber;
								if (Number.isInteger(value) && value >= 10 && value <= 24) updateAppearance({ codeSize: value });
							}}
						/>
					</div>
				</label>
			</div>

			<div className="font-preview" aria-label="フォントのプレビュー">
				<p className="font-preview-ui">画面 UI: 設定やボタンの文字の見え方 0123456789</p>
				<p className="font-preview-content">本文: 会話や Markdown の読みやすさを確認できます。The quick brown fox jumps over the lazy dog.</p>
				<pre className="font-preview-code"><code>const greeting = "こんにちは 0O1lI != === -&gt;";</code></pre>
			</div>

			{fontNotice && <p className="fine-print" role="status">{fontNotice}</p>}
			<p className="fine-print">カンマ区切りで複数のフォント（フォールバック順）も指定できます。変更はすぐに反映・保存され、新しく開く端末にも適用されます。</p>
		</section>
	);
}
