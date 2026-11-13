export const BROWSER_ADJUSTMENTS = {
	"font-size": { label: "文字サイズ", unit: "px", min: 6, max: 160, step: 1 },
	"line-height": { label: "行の高さ", unit: "px", min: 6, max: 200, step: 1 },
	"letter-spacing": { label: "文字間隔", unit: "px", min: -5, max: 20, step: 0.1 },
	"padding-top": { label: "上の余白", unit: "px", min: 0, max: 160, step: 1 },
	"padding-bottom": { label: "下の余白", unit: "px", min: 0, max: 160, step: 1 },
	"padding-left": { label: "左の余白", unit: "px", min: 0, max: 160, step: 1 },
	"padding-right": { label: "右の余白", unit: "px", min: 0, max: 160, step: 1 },
	"border-radius": { label: "角丸", unit: "px", min: 0, max: 120, step: 1 },
	gap: { label: "項目の間隔", unit: "px", min: 0, max: 120, step: 1 },
	opacity: { label: "不透明度", unit: "", min: 0, max: 1, step: 0.01 },
	width: { label: "横幅", unit: "px", min: 8, max: 2400, step: 1 },
	height: { label: "高さ", unit: "px", min: 8, max: 1600, step: 1 },
};

export type BrowserAdjustment = keyof typeof BROWSER_ADJUSTMENTS;

export function isBrowserAdjustment(value: unknown): value is BrowserAdjustment {
	return typeof value === "string" && Object.hasOwn(BROWSER_ADJUSTMENTS, value);
}
