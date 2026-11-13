import type { BrowserControl, BrowserStyles } from "../shared/browser-adjustments.ts";

function colorHex(color: string): string {
	if (/^#[0-9a-f]{6}$/i.test(color)) return color;
	const rgb = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/.exec(color);
	return rgb ? `#${rgb.slice(1, 4).map((value) => Math.min(255, Number(value)).toString(16).padStart(2, "0")).join("")}` : "#000000";
}

export function BrowserAdjustmentControls({ controls, styles, adjusted, onChange }: {
	controls: BrowserControl[];
	styles?: BrowserStyles;
	adjusted: BrowserStyles;
	onChange: (styles: BrowserStyles) => boolean;
}) {
	const current = { ...styles, ...adjusted };
	return <fieldset className="browser-adjustments">
		<legend>見た目のプレビュー</legend>
		{controls.map((control) => {
			if ("options" in control) {
				const matches = (option: (typeof control.options)[number]) => Object.entries(option.styles).every(([key, value]) => {
					const currentValue = current[key];
					return value === currentValue || (value?.startsWith("#") && !!currentValue && colorHex(currentValue) === value.toLowerCase());
				});
				if (control.kind === "toggle") {
					const [off, on] = control.options;
					if (matches(off) || matches(on)) return <label key={control.label} className="browser-adjustment-toggle">
						<span>{control.label}</span><input type="checkbox" role="switch" checked={matches(on)}
							onChange={(event) => onChange(event.target.checked ? on.styles : off.styles)} />
						<output>{matches(on) ? on.label : off.label}</output>
					</label>;
				}
				return <div key={control.label} className="browser-adjustment-options" role="group" aria-label={control.label}>
					<span>{control.label}</span>
					<div>{control.options.map((option, index) => <button key={index} type="button" aria-pressed={matches(option)}
						onClick={() => onChange(option.styles)}>{option.label}</button>)}</div>
				</div>;
			}
			if (control.kind === "color") {
				const color = current[control.property] ?? "";
				return <label key={control.label}><span>{control.label}</span>
					<input type="color" value={colorHex(color)} onChange={(event) => onChange({ [control.property]: event.target.value })} />
					<output>{color || "—"}</output>
				</label>;
			}
			if (control.kind === "text") {
				const value = current[control.property] ?? "";
				return <label key={control.label}><span>{control.label}</span>
					<input key={value} aria-label={control.label} className="browser-adjustment-value" defaultValue={value}
						onBlur={(event) => {
							const field = event.currentTarget;
							const next = field.value.trim();
							if (next !== value && (!next || !onChange({ [control.property]: next }))) field.value = value;
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.nativeEvent.isComposing) {
								event.preventDefault();
								event.currentTarget.blur();
							}
						}} />
				</label>;
			}
			const { property, min, max, step, unit } = control;
			const initial = Number.parseFloat(current[property] ?? "");
			const value = Number.isFinite(initial) ? Math.min(max, Math.max(min, initial)) : min;
			const update = (number: number) => {
				if (Number.isFinite(number)) {
					const clamped = Math.min(max, Math.max(min, number));
					onChange({ [property]: `${Number(clamped.toFixed(6))}${unit}` });
				}
			};
			return <label key={control.label}><span>{control.label}</span>
				{control.kind === "range" ? <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => update(event.target.valueAsNumber)} /> :
					<input key={current[property] ?? ""} type="number" min={min} max={max} step={step} defaultValue={value}
						onBlur={(event) => {
							const field = event.currentTarget;
							if (field.valueAsNumber !== value && Number.isFinite(field.valueAsNumber)) update(field.valueAsNumber);
							else field.value = String(value);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.nativeEvent.isComposing) {
								event.preventDefault();
								event.currentTarget.blur();
							}
						}} />}
				<output>{current[property] || "—"}</output>
			</label>;
		})}
	</fieldset>;
}
