import { BROWSER_ADJUSTMENTS, type BrowserAdjustment } from "../shared/browser-adjustments.ts";

export function BrowserAdjustmentControls({ properties, styles, adjusted, onChange, onReset }: {
	properties: BrowserAdjustment[];
	styles?: Partial<Record<BrowserAdjustment, string>>;
	adjusted: Partial<Record<BrowserAdjustment, number>>;
	onChange: (property: BrowserAdjustment, value: number) => void;
	onReset: () => void;
}) {
	return <fieldset className="browser-adjustments">
		<legend>見た目のプレビュー</legend>
		{properties.map((property) => {
			const { label, unit, min, max, step } = BROWSER_ADJUSTMENTS[property];
			const initial = Number.parseFloat(styles?.[property] ?? "");
			const value = adjusted[property] ?? (Number.isFinite(initial) ? Math.min(max, Math.max(min, initial)) : min);
			return <label key={property}><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(property, event.target.valueAsNumber)} /><output>{adjusted[property] === undefined ? styles?.[property] || "—" : `${value}${unit}`}</output></label>;
		})}
		<button type="button" disabled={!Object.keys(adjusted).length} onClick={onReset}>元の表示に戻す</button>
	</fieldset>;
}
