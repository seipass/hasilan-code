import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelUsage } from "../../shared/usage.ts";
import type { QuakeSnapshot, WeatherSnapshot } from "../../shared/widgets.ts";
import { AccountUsagePanel } from "../AccountUsagePanel.tsx";
import { MobileSheet } from "../MobileSheet.tsx";
import { MotionItems } from "../Motion.tsx";
import { UsagePanel } from "../UsagePanel.tsx";
import { Select } from "../Select.tsx";
import { usePreferenceState } from "../preferences.ts";
import { defaultWidgetPreferences, parseWidgetPreferences, weatherLabel, WIDGET_KEY, TOPBAR_WIDGETS, type TopbarWidget, WIDGET_LABELS, type WidgetPreferences } from "./state.ts";
import { useWidgetData } from "./use-widget-data.ts";
import { QuakeDetails, WeatherDetails } from "./WidgetDetails.tsx";
import { WidgetIcon } from "./WidgetIcon.tsx";
import "./WidgetSpace.css";

export function WidgetSpace({ visible, usage, usageTitle, contextPercent }: { visible: boolean; usage: ModelUsage[]; usageTitle: string; contextPercent?: number | null }) {
	const [preferences, setPreferences] = usePreferenceState(WIDGET_KEY, defaultWidgetPreferences, parseWidgetPreferences);
	const [active, setActive] = useState<TopbarWidget | null>(null);
	const [closing, setClosing] = useState(false);
	const [sheetStyle, setSheetStyle] = useState<CSSProperties>();
	const root = useRef<HTMLDivElement>(null);
	const anchor = useRef<HTMLElement>(null);
	const weatherPath = preferences.place ? `/api/widgets/weather?latitude=${preferences.place.latitude}&longitude=${preferences.place.longitude}` : undefined;
	const weather = useWidgetData<WeatherSnapshot>(weatherPath, visible, 600_000);
	const earthquake = useWidgetData<QuakeSnapshot>("/api/widgets/earthquakes", visible, 30_000);
	useEffect(() => { if (!visible) setActive(null); }, [visible]);
	const positionSheet = useCallback(() => {
		const parent = root.current?.parentElement;
		const trigger = anchor.current;
		if (!parent || !trigger) return;
		const box = trigger.getBoundingClientRect();
		const width = Math.min(480, Math.max(280, parent.getBoundingClientRect().width), window.innerWidth - 16);
		setSheetStyle({ "--widget-sheet-top": `${box.bottom + 6}px`, "--widget-sheet-left": `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`, "--widget-sheet-width": `${width}px` } as CSSProperties);
	}, []);
	const openWidget = (kind: TopbarWidget, trigger: HTMLElement) => {
		anchor.current = trigger;
		positionSheet();
		setClosing(false);
		setActive(kind);
	};
	useLayoutEffect(() => {
		if (!active || !visible || !root.current) return;
		const element = root.current;
		positionSheet();
		const observer = new ResizeObserver(positionSheet); observer.observe(element.parentElement!);
		window.addEventListener("resize", positionSheet);
		return () => { observer.disconnect(); window.removeEventListener("resize", positionSheet); };
	}, [active, visible, positionSheet]);
	const cost = usage.reduce((sum, entry) => sum + entry.cost, 0);
	const responses = usage.reduce((sum, entry) => sum + entry.responses, 0);
	const priced = !usage.some((entry) => entry.provider === "devin");
	const latestQuake = earthquake.data?.notices[0];
	const chipLabels = { ...WIDGET_LABELS, weather: preferences.place?.name ?? WIDGET_LABELS.weather, earthquake: latestQuake ? `地震 ${new Date(latestQuake.time).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : WIDGET_LABELS.earthquake };
	const summaries: Record<TopbarWidget, string> = {
		weather: !preferences.place ? "地域を設定" : weather.error ? "更新失敗" : weather.data ? `${Math.round(weather.data.temperature)}° ${weatherLabel(weather.data.code)}` : "取得中…",
		usage: contextPercent != null ? `${contextPercent.toFixed(0)}% · ${priced ? `$${cost.toFixed(3)}` : "未計測"}` : priced ? `$${cost.toFixed(3)} · ${responses}応答` : `${responses}応答 · 未計測`,
		earthquake: earthquake.error ? "更新失敗" : latestQuake ? `${latestQuake.place}${latestQuake.intensity ? ` · 震度${latestQuake.intensity}` : ""}` : earthquake.data ? "情報なし" : "取得中…",
		notes: preferences.note.trim().split("\n")[0] || "メモを書く",
	};
	const change = (next: WidgetPreferences) => setPreferences(next);
	return <div className="widget-space" ref={root} hidden={!visible}>
		<div className="widget-strip" role="toolbar" aria-label="ウィジェット">
			<MotionItems items={topbarOrder(preferences)} itemKey={(kind) => kind}>{(kind) => <button type="button" className={`widget-chip is-${kind}`} key={kind} data-size={preferences.display?.[kind] ?? "icon"} aria-label={`${WIDGET_LABELS[kind]}を開く`} aria-haspopup="dialog" aria-expanded={active === kind && !closing} title={summaries[kind]} onClick={(event) => openWidget(kind, event.currentTarget)}><WidgetIcon kind={kind} />{preferences.display?.[kind] === "mini" && <span><span className="widget-chip-label">{chipLabels[kind]}</span><strong>{summaries[kind]}</strong></span>}</button>}</MotionItems>
		</div>
		<MobileSheet open={visible && active !== null && !closing} side="top" className={`widget-top-sheet widget-sheet-${active ?? "idle"}`} style={sheetStyle} motionAnchor={anchor} title={active ? WIDGET_LABELS[active] : "ウィジェット"} headingActions={active === "earthquake" ? <button type="button" disabled={earthquake.busy} onClick={earthquake.refresh}>{earthquake.busy ? "更新中…" : "更新"}</button> : null} onClosing={() => setClosing(true)} onClose={() => { setActive(null); setClosing(false); }}>
			<div className="widget-sheet-body">
				{active === "notes" && <div className="widget-notes"><label className="sr-only" htmlFor="widget-notepad">メモ</label><textarea id="widget-notepad" placeholder="ここにメモ…" value={preferences.note} maxLength={50_000} onChange={(event) => change({ ...preferences, note: event.currentTarget.value })} /><p className="fine-print">Web・デスクトップで自動保存 · {preferences.note.length.toLocaleString("ja-JP")} / 50,000文字</p></div>}
				{active === "weather" && <WeatherDetails place={preferences.place} weather={weather.data} error={weather.error} busy={weather.busy} refresh={weather.refresh} onPlace={(place) => change({ ...preferences, place })} />}
				{active === "usage" && <><h3>{usageTitle}</h3><UsagePanel title="モデル別の内訳" groups={[{ id: "widget", label: usageTitle, usage }]} /><AccountUsagePanel /></>}
				{active === "earthquake" && <QuakeDetails snapshot={earthquake.data} error={earthquake.error} />}
			</div>
		</MobileSheet>
	</div>;
}

function topbarOrder(preferences: WidgetPreferences): TopbarWidget[] {
	return [...new Set([...preferences.order, ...TOPBAR_WIDGETS])].filter(
		(kind): kind is TopbarWidget => TOPBAR_WIDGETS.some((widget) => widget === kind),
	);
}

export function WidgetAppearance() {
	const [preferences, setPreferences] = usePreferenceState(WIDGET_KEY, defaultWidgetPreferences, parseWidgetPreferences);
	const order = topbarOrder(preferences);
	function move(index: number, direction: -1 | 1) {
		setPreferences((previous) => {
			const next = topbarOrder(previous);
			const target = index + direction;
			if (target < 0 || target >= next.length) return previous;
			[next[index], next[target]] = [next[target], next[index]];
			return { ...previous, order: next };
		});
	}
	return <section className="settings-section">
		<h3>右上のウィジェット</h3>
		<p>表示形式と、左から右への並び順を変更できます。</p>
		<ol className="widget-settings-list">{order.map((kind, index) => <li key={kind}>
			<span>{WIDGET_LABELS[kind]}</span>
			<Select aria-label={`${WIDGET_LABELS[kind]}の表示形式`} value={preferences.display?.[kind] ?? "icon"} onChange={(value) => {
				if (value !== "icon" && value !== "mini") return;
				setPreferences((previous) => ({ ...previous, display: { ...previous.display, [kind]: value } }));
			}}><option value="icon">アイコン</option><option value="mini">ミニ表示</option></Select>
			<div>
				<button type="button" aria-label={`${WIDGET_LABELS[kind]}を左へ`} disabled={index === 0} onClick={() => move(index, -1)}>←</button>
				<button type="button" aria-label={`${WIDGET_LABELS[kind]}を右へ`} disabled={index === order.length - 1} onClick={() => move(index, 1)}>→</button>
			</div>
		</li>)}</ol>
	</section>;
}
