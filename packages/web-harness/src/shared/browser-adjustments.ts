export type BrowserStyles = Record<string, string | null>;

export type BrowserControl =
	| { kind: "range" | "number"; label: string; property: string; min: number; max: number; step: number; unit: string }
	| { kind: "color"; label: string; property: string }
	| { kind: "text"; label: string; property: string }
	| { kind: "choices" | "toggle"; label: string; options: { label: string; styles: BrowserStyles }[] };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBrowserStyleProperty(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 256 &&
		/^(?:--[\p{L}\p{N}_\u0080-\u{10ffff}-]+|-?[a-z][a-z0-9-]*)$/iu.test(value)
	);
}

export function browserPreviewStyles(input: unknown, allowRemoval = true): BrowserStyles | undefined {
	if (!record(input)) return undefined;
	const entries = Object.entries(input);
	if (entries.length > 256) return undefined;
	for (const [property, value] of entries) {
		if (!isBrowserStyleProperty(property)) return undefined;
		if (value === null && allowRemoval) continue;
		if (typeof value !== "string" || !value.trim() || value.length > 8192 || /!\s*important\s*$/i.test(value))
			return undefined;
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
		if ((kind === "range" || kind === "number") && typeof property === "string" && isBrowserStyleProperty(property)) {
			const { min, max, step, unit } = item;
			if (
				typeof min === "number" &&
				typeof max === "number" &&
				typeof step === "number" &&
				Number.isFinite(min) &&
				Number.isFinite(max) &&
				min < max &&
				step >= 0.000001 &&
				step <= max - min &&
				typeof unit === "string" &&
				/^(?:[a-z]+|%)?$/i.test(unit)
			)
				control = { kind, label, property, min, max, step, unit };
		} else if ((kind === "color" || kind === "text") && isBrowserStyleProperty(property)) {
			control = { kind, label, property };
		} else if ((kind === "choices" || kind === "toggle") && Array.isArray(item.options)) {
			const options = item.options.slice(0, 8).flatMap((option: unknown) => {
				if (!record(option) || typeof option.label !== "string") return [];
				const name = option.label.trim().slice(0, 32);
				const styles = browserPreviewStyles(option.styles, false);
				return name && styles && Object.keys(styles).length ? [{ label: name, styles }] : [];
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
