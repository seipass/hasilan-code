const numberRules = {
	"font-size": [6, 160, "px"],
	"line-height": [6, 240, "px"],
	"letter-spacing": [-10, 32, "px"],
	"font-weight": [100, 900, ""],
	"padding-top": [0, 240, "px"],
	"padding-bottom": [0, 240, "px"],
	"padding-left": [0, 240, "px"],
	"padding-right": [0, 240, "px"],
	"border-radius": [0, 160, "px"],
	"border-width": [0, 24, "px"],
	gap: [0, 160, "px"],
	opacity: [0, 1, ""],
	width: [8, 2400, "px"],
	height: [8, 1600, "px"],
} as const;

export const BROWSER_COLOR_PROPERTIES = ["color", "background-color", "border-color"] as const;
const choiceRules = {
	"text-align": ["start", "center", "end", "justify"],
	"text-transform": ["none", "uppercase", "lowercase", "capitalize"],
	"font-style": ["normal", "italic"],
	"white-space": ["normal", "nowrap", "pre-wrap", "break-spaces"],
	display: ["block", "inline-block", "flex", "inline-flex", "grid", "inline-grid"],
	"flex-direction": ["row", "column", "row-reverse", "column-reverse"],
	"flex-wrap": ["nowrap", "wrap"],
	"align-items": ["normal", "start", "center", "end", "stretch", "baseline"],
	"justify-content": ["normal", "start", "center", "end", "space-between", "space-around", "space-evenly"],
	"object-fit": ["fill", "contain", "cover", "none", "scale-down"],
	"border-style": ["none", "solid", "dashed", "dotted"],
} as const;

type NumericProperty = keyof typeof numberRules;
type ColorProperty = (typeof BROWSER_COLOR_PROPERTIES)[number];
export type BrowserAdjustment = NumericProperty | ColorProperty | keyof typeof choiceRules;
export type BrowserStyles = Partial<Record<BrowserAdjustment, string>>;
export const BROWSER_ADJUSTMENT_PROPERTIES = [
	...Object.keys(numberRules),
	...BROWSER_COLOR_PROPERTIES,
	...Object.keys(choiceRules),
];

export type BrowserControl =
	| {
			kind: "range" | "number";
			label: string;
			property: NumericProperty;
			min: number;
			max: number;
			step: number;
			unit: string;
	  }
	| { kind: "color"; label: string; property: ColorProperty }
	| { kind: "choices" | "toggle"; label: string; options: { label: string; styles: BrowserStyles }[] };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function browserPreviewStyles(input: unknown): BrowserStyles | undefined {
	if (!record(input)) return undefined;
	const entries = Object.entries(input);
	if (!entries.length || entries.length > 8) return undefined;
	for (const [property, value] of entries) {
		if (typeof value !== "string") return undefined;
		if (Object.hasOwn(numberRules, property)) {
			const [min, max, unit] = numberRules[property as NumericProperty];
			if (!/^-?\d+(?:\.\d+)?(?:px)?$/.test(value) || value.endsWith("px") !== (unit === "px")) return undefined;
			const number = Number.parseFloat(value);
			if (number < min || number > max) return undefined;
		} else if ((BROWSER_COLOR_PROPERTIES as readonly string[]).includes(property)) {
			if (!/^#[0-9a-f]{6}$/i.test(value) && value !== "transparent") return undefined;
		} else if (
			!Object.hasOwn(choiceRules, property) ||
			!(choiceRules[property as keyof typeof choiceRules] as readonly string[]).includes(value)
		) {
			return undefined;
		}
	}
	return input as BrowserStyles;
}

export function parseBrowserControls(input: unknown): BrowserControl[] {
	if (!Array.isArray(input)) return [];
	const controls: BrowserControl[] = [];
	const labels = new Set<string>();
	for (const item of input) {
		if (controls.length === 6) break;
		if (!record(item) || typeof item.label !== "string") continue;
		const label = item.label.trim().slice(0, 48);
		if (!label || labels.has(label)) continue;
		const { kind, property } = item;
		let control: BrowserControl | undefined;
		if (
			(kind === "range" || kind === "number") &&
			typeof property === "string" &&
			Object.hasOwn(numberRules, property)
		) {
			const numeric = property as NumericProperty;
			const [lower, upper, unit] = numberRules[numeric];
			const min = typeof item.min === "number" ? Math.max(lower, item.min) : lower;
			const max = typeof item.max === "number" ? Math.min(upper, item.max) : upper;
			const step = typeof item.step === "number" ? item.step : numeric === "opacity" ? 0.01 : 1;
			if (Number.isFinite(min) && Number.isFinite(max) && min < max && step >= 0.001 && step <= max - min)
				control = { kind, label, property: numeric, min, max, step, unit };
		} else if (kind === "color" && (BROWSER_COLOR_PROPERTIES as readonly unknown[]).includes(property)) {
			control = { kind, label, property: property as ColorProperty };
		} else if ((kind === "choices" || kind === "toggle") && Array.isArray(item.options)) {
			const options = item.options.slice(0, 8).flatMap((option: unknown) => {
				if (!record(option) || typeof option.label !== "string") return [];
				const name = option.label.trim().slice(0, 32);
				const styles = browserPreviewStyles(option.styles);
				return name && styles ? [{ label: name, styles }] : [];
			});
			// Each preset must replace the same declarations so switching never leaves stale styles behind.
			const keys = JSON.stringify(Object.keys(options[0]?.styles ?? {}).sort());
			if (
				(kind === "toggle" ? options.length === 2 : options.length >= 2) &&
				options.every(({ styles }) => JSON.stringify(Object.keys(styles).sort()) === keys)
			)
				control = { kind, label, options };
		}
		if (control) {
			labels.add(label);
			controls.push(control);
		}
	}
	return controls;
}

export const BROWSER_CONTROL_RULES = { numeric: numberRules, color: BROWSER_COLOR_PROPERTIES, choices: choiceRules };
