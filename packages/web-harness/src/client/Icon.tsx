import type { SVGProps } from "react";

/**
 * One stroke-icon set for every compact control. Text glyphs (×, ↑, ■, ☰) rendered
 * differently per font and carried no accessible name, so controls that hold only an
 * icon must pass `aria-label` on the button, not here.
 */
const paths = {
	close: "M6 6l12 12M18 6L6 18",
	plus: "M12 5v14M5 12h14",
	minus: "M5 12h14",
	check: "M5 13l4 4L19 7",
	send: "M12 19V5M5 12l7-7 7 7",
	menu: "M4 7h16M4 12h16M4 17h16",
	more: "M6 12h.01M12 12h.01M18 12h.01",
	pencil: "M4 20h4l10-10-4-4L4 16v4zM14 6l4 4",
	refresh: "M20 11a8 8 0 10-2.5 5.7M20 5v6h-6",
	search: "M11 4a7 7 0 105 11.7L20 20M11 4a7 7 0 015 11.7",
	chevronDown: "M6 9l6 6 6-6",
	chevronRight: "M9 6l6 6-6 6",
	chevronLeft: "M15 6l-6 6 6 6",
	arrowUpRight: "M7 17L17 7M9 7h8v8",
	folder: "M4 5h6l2 3h8v11H4z",
	settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
	panel: "M4 4h16v16H4zM15 4v16",
	trash: "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13",
	external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
	graph: "M12 4a2 2 0 100 4 2 2 0 000-4zM4 16a2 2 0 100 4 2 2 0 000-4zM20 16a2 2 0 100 4 2 2 0 000-4zM12 8v4M12 12L6 15M12 12l6 3",
	list: "M4 6h16M4 12h16M4 18h16",
	gauge: "M4 18a8 8 0 1116 0M12 18l4-5",
	copy: "M9 9h10v10H9zM5 15V5h10",
	undo: "M9 14L4 9l5-5M4 9h9a6 6 0 016 6v4",
	retry: "M20 11a8 8 0 10-2.5 5.7M20 5v6h-6",
	// Filled shapes are drawn as full-size squares; the path strings are unused.
	stop: "",
	stopAll: "",
} as const;

export type IconName = keyof typeof paths;

/** Filled shapes need no stroke; everything else uses the shared 1.8px line weight. */
const filled: ReadonlySet<IconName> = new Set(["stop", "stopAll"]);

export function Icon({ name, size = 16, ...props }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
	if (filled.has(name))
		return (
			<svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" {...props}>
				<rect x="7" y="7" width="10" height="10" rx="1.5" />
			</svg>
		);
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
			<path d={paths[name]} />
		</svg>
	);
}
