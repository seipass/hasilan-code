import type { WidgetKind } from "./state.ts";

export function WidgetIcon({ kind }: { kind: WidgetKind | "edit" }) {
	return <svg viewBox="0 0 24 24" aria-hidden="true">{
		kind === "weather" ? <><circle cx="9" cy="8" r="3" /><path d="M9 1v1M2 8H1m3-5 1 1m9-1-1 1M8 20h10a4 4 0 1 0-.6-8 5 5 0 0 0-9.6 1A3.5 3.5 0 0 0 8 20" /></> :
		kind === "usage" ? <><path d="M4 4v16h16M8 16v-4m5 4V6m5 10V9" /></> :
		kind === "countdown" ? <><path d="M7 3h10M9 3v3l3 5 3-5V3M9 21v-3l3-5 3 5v3M7 21h10" /></> :
		kind === "countup" ? <><circle cx="12" cy="13" r="8" /><path d="M9 2h6m-3 7v5l3 2m3-12 2 2" /></> :
		kind === "earthquake" ? <><path d="M2 13h4l3-8 4 14 3-10 2 4h4" /></> :
		kind === "news" ? <><path d="M5 3h15v16a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V8h3m0-5v15a1 1 0 0 0 2 0V8M10 7h7m-7 4h7m-7 4h7" /></> :
		kind === "music" ? <><path d="M9 17V5l11-2v12M9 9l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></> :
		kind === "notes" ? <><path d="M5 3h14v14l-4 4H5zM9 8h6m-6 4h6m0 9v-4h4" /></> : <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="3" width="6" height="6" rx="1" /><rect x="3" y="15" width="6" height="6" rx="1" /><path d="M18 14v8m-4-4h8" /></>
	}</svg>;
}
