import { useEffect, useState } from "react";
import { usePreferenceState } from "./preferences.ts";
import { Select } from "./Select.tsx";

const FONT_KEY = "pi-web-ui-font";
const DEFAULT_FONT = "Yu Gothic UI";
const FONTS = [DEFAULT_FONT, "system-ui", "Meiryo", "Noto Sans JP", "Hiragino Sans", "Segoe UI", "Arial"];

/** Mounted independently of settings so saved fonts also apply on startup and remote sync. */
export function ApplicationFont() {
	const [font] = usePreferenceState(FONT_KEY, DEFAULT_FONT);
	useEffect(() => {
		const family = font === "system-ui" ? font : JSON.stringify(font.trim() || DEFAULT_FONT);
		document.documentElement.style.fontFamily = `${family}, "Yu Gothic UI", sans-serif`;
		return () => { document.documentElement.style.removeProperty("font-family"); };
	}, [font]);
	return null;
}

export function FontAppearance() {
	const [font, setFont] = usePreferenceState(FONT_KEY, DEFAULT_FONT);
	const [custom, setCustom] = useState(false);
	const isCustom = custom || !FONTS.includes(font);
	return <section className="settings-section">
		<h3>フォント</h3>
		<label>画面のフォント<Select aria-label="画面のフォント" value={isCustom ? "custom" : font} onChange={(value) => {
			setCustom(value === "custom");
			if (value !== "custom") setFont(value);
		}}>{FONTS.map((family) => <option key={family} value={family}>{family === DEFAULT_FONT ? `${family}（標準）` : family === "system-ui" ? "システム標準" : family}</option>)}<option value="custom">フォント名を指定</option></Select></label>
		{isCustom && <label>フォント名<input maxLength={200} value={font} placeholder="例: BIZ UDPGothic" onChange={(event) => setFont(event.currentTarget.value)} /></label>}
		<p>文字の見え方を確認できます。The quick brown fox 0123456789</p>
		<p className="fine-print">変更はすぐに反映・保存されます。端末にインストールされていないフォントは標準フォントで表示します。コードと端末の等幅フォントは変更しません。</p>
	</section>;
}
