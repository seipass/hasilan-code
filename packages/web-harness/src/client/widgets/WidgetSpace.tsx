import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelUsage } from "../../shared/usage.ts";
import type { NewsSnapshot, QuakeSnapshot, WeatherSnapshot } from "../../shared/widgets.ts";
import { AccountUsagePanel } from "../AccountUsagePanel.tsx";
import { MobileSheet } from "../MobileSheet.tsx";
import { MotionItems } from "../Motion.tsx";
import { UsagePanel } from "../UsagePanel.tsx";
import { useMusic } from "./music.ts";
import { NewsDetails } from "./NewsDetails.tsx";
import { parseWidgetPreferences, readWidgetPreferences, timerElapsed, timerLabel, weatherLabel, WIDGET_KEY, WIDGET_KINDS, type WidgetKind, WIDGET_LABELS, type WidgetPreferences } from "./state.ts";
import { useWidgetData } from "./use-widget-data.ts";
import { MusicDetails, QuakeDetails, TimerDetails, WeatherDetails } from "./WidgetDetails.tsx";
import { WidgetIcon } from "./WidgetIcon.tsx";
import "./WidgetSpace.css";

export function WidgetSpace({ visible, usage, usageTitle, contextPercent }: { visible: boolean; usage: ModelUsage[]; usageTitle: string; contextPercent?: number | null }) {
	const [preferences, setPreferences] = useState(readWidgetPreferences);
	const [storageError, setStorageError] = useState<string>();
	const [active, setActive] = useState<WidgetKind | "edit" | null>(null);
	const [closing, setClosing] = useState(false);
	const [now, setNow] = useState(Date.now);
	const [sheetStyle, setSheetStyle] = useState<CSSProperties>();
	const root = useRef<HTMLDivElement>(null);
	const anchor = useRef<HTMLElement>(null);
	const music = useMusic();
	const weatherPath = preferences.place ? `/api/widgets/weather?latitude=${preferences.place.latitude}&longitude=${preferences.place.longitude}` : undefined;
	const weather = useWidgetData<WeatherSnapshot>(weatherPath, visible && preferences.order.includes("weather"), 600_000);
	const earthquake = useWidgetData<QuakeSnapshot>("/api/widgets/earthquakes", visible && preferences.order.includes("earthquake"), 30_000);
	const news = useWidgetData<NewsSnapshot>("/api/widgets/news", visible && preferences.order.includes("news"), 300_000);
	const timing = visible && preferences.order.some((kind) => kind === "countdown" || kind === "countup");
	useEffect(() => {
		try { localStorage.setItem(WIDGET_KEY, JSON.stringify(preferences)); setStorageError(undefined); }
		catch { setStorageError("設定・メモをブラウザーに保存できません。空き容量と保存設定を確認してください。"); }
	}, [preferences]);
	useEffect(() => {
		const sync = (event: StorageEvent) => { if (event.key === WIDGET_KEY || event.key === null) setPreferences(parseWidgetPreferences(event.newValue)); };
		window.addEventListener("storage", sync);
		return () => window.removeEventListener("storage", sync);
	}, []);
	useEffect(() => {
		if (!timing) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [timing]);
	useEffect(() => { if (!visible) setActive(null); }, [visible]);
	const positionSheet = useCallback(() => {
		const parent = root.current?.parentElement;
		const trigger = anchor.current;
		if (!parent || !trigger) return;
		const box = trigger.getBoundingClientRect();
		const width = Math.min(480, Math.max(280, parent.getBoundingClientRect().width), window.innerWidth - 16);
		setSheetStyle({ "--widget-sheet-top": `${box.bottom + 6}px`, "--widget-sheet-left": `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`, "--widget-sheet-width": `${width}px` } as CSSProperties);
	}, []);
	const openWidget = (kind: WidgetKind | "edit", trigger: HTMLElement) => {
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
	const countdownRemaining = Math.max(0, preferences.countdown.duration - timerElapsed(preferences.countdown, now));
	const summaries: Record<WidgetKind, string> = {
		weather: !preferences.place ? "地域を設定" : weather.error ? "更新失敗" : weather.data ? `${Math.round(weather.data.temperature)}° ${weatherLabel(weather.data.code)}` : "取得中…",
		usage: contextPercent != null ? `${contextPercent.toFixed(0)}% · ${priced ? `$${cost.toFixed(3)}` : "未計測"}` : priced ? `$${cost.toFixed(3)} · ${responses}応答` : `${responses}応答 · 未計測`,
		countdown: countdownRemaining === 0 ? "終了" : timerLabel(countdownRemaining),
		countup: timerLabel(timerElapsed(preferences.countup, now)),
		earthquake: earthquake.error ? "更新失敗" : latestQuake ? `${latestQuake.place}${latestQuake.intensity ? ` · 震度${latestQuake.intensity}` : ""}` : earthquake.data ? "情報なし" : "取得中…",
		news: news.error ? "更新失敗" : news.data?.articles[0]?.title ?? (news.data ? "情報なし" : "取得中…"),
		music: music ? `${music.playing ? "再生中" : "停止中"} · ${music.title}` : "音楽を開く",
		notes: preferences.note.trim().split("\n")[0] || "メモを書く",
	};
	const change = (next: WidgetPreferences) => setPreferences(next);
	return <div className="widget-space" ref={root} hidden={!visible}>
		<div className="widget-strip" role="toolbar" aria-label="ウィジェット">
			<MotionItems items={preferences.order} itemKey={(kind) => kind}>{(kind) => <button type="button" className={`widget-chip is-${kind}`} key={kind} aria-label={`${WIDGET_LABELS[kind]}を開く`} aria-haspopup="dialog" aria-expanded={active === kind && !closing} title={summaries[kind]} onClick={(event) => openWidget(kind, event.currentTarget)}><WidgetIcon kind={kind} /><span><span className="widget-chip-label">{chipLabels[kind]}</span><strong>{summaries[kind]}</strong></span></button>}</MotionItems>
			{preferences.order.length === 0 && <span className="widget-strip-empty">ウィジェットを追加</span>}
		</div>
		<button type="button" className="widget-edit" aria-label="ウィジェットを編集" title="ウィジェットを編集" aria-haspopup="dialog" aria-expanded={active === "edit" && !closing} onClick={(event) => openWidget("edit", event.currentTarget)}><WidgetIcon kind="edit" />{storageError && <span className="widget-save-error" aria-label="保存エラー" />}</button>
		<MobileSheet open={visible && active !== null && !closing} side="top" className={`widget-top-sheet widget-sheet-${active ?? "idle"}`} style={sheetStyle} motionAnchor={anchor} title={active === "edit" ? "ウィジェットの編集" : active ? WIDGET_LABELS[active] : "ウィジェット"} headingActions={active === "earthquake" ? <button type="button" disabled={earthquake.busy} onClick={earthquake.refresh}>{earthquake.busy ? "更新中…" : "更新"}</button> : active === "news" ? <button type="button" disabled={news.busy} onClick={news.refresh}>{news.busy ? "更新中…" : "更新"}</button> : null} onClosing={() => setClosing(true)} onClose={() => { setActive(null); setClosing(false); }}>
			<div className="widget-sheet-body">
				{storageError && <p className="error" role="alert">{storageError}</p>}
				{active === "edit" && <><p className="widget-description">表示するものを組み合わせ、順番を変更できます。</p><ul className="widget-settings-list">{[...preferences.order, ...WIDGET_KINDS.filter((kind) => !preferences.order.includes(kind))].map((kind) => { const index = preferences.order.indexOf(kind); return <li key={kind}><label><input type="checkbox" checked={index >= 0} onChange={(event) => change({ ...preferences, order: event.currentTarget.checked ? [...preferences.order, kind] : preferences.order.filter((entry) => entry !== kind) })} /><WidgetIcon kind={kind} /><span>{WIDGET_LABELS[kind]}</span></label><div><button type="button" aria-label={`${WIDGET_LABELS[kind]}を前へ`} disabled={index <= 0} onClick={() => { const order = [...preferences.order]; [order[index - 1], order[index]] = [order[index], order[index - 1]]; change({ ...preferences, order }); }}>↑</button><button type="button" aria-label={`${WIDGET_LABELS[kind]}を後ろへ`} disabled={index < 0 || index === preferences.order.length - 1} onClick={() => { const order = [...preferences.order]; [order[index + 1], order[index]] = [order[index], order[index + 1]]; change({ ...preferences, order }); }}>↓</button></div></li>; })}</ul><p className="fine-print">配置・地域・タイマー・メモはこのブラウザーに保存されます。</p></>}
				{active === "notes" && <div className="widget-notes"><label className="sr-only" htmlFor="widget-notepad">メモ</label><textarea id="widget-notepad" placeholder="ここにメモ…" value={preferences.note} maxLength={50_000} onChange={(event) => change({ ...preferences, note: event.currentTarget.value })} /><p className="fine-print">このブラウザーに自動保存 · {preferences.note.length.toLocaleString("ja-JP")} / 50,000文字</p></div>}
				{active === "weather" && <WeatherDetails place={preferences.place} weather={weather.data} error={weather.error} busy={weather.busy} refresh={weather.refresh} onPlace={(place) => change({ ...preferences, place })} />}
				{active === "usage" && <><h3>{usageTitle}</h3><UsagePanel title="モデル別の内訳" groups={[{ id: "widget", label: usageTitle, usage }]} /><AccountUsagePanel /></>}
				{(active === "countdown" || active === "countup") && <TimerDetails key={active} timer={preferences[active]} countdown={active === "countdown"} now={now} onChange={(timer) => { setNow(Date.now()); change({ ...preferences, [active]: timer }); }} />}
				{active === "music" && <MusicDetails music={music} />}
				{active === "earthquake" && <QuakeDetails snapshot={earthquake.data} error={earthquake.error} />}
				{active === "news" && <NewsDetails snapshot={news.data} error={news.error} />}
			</div>
		</MobileSheet>
	</div>;
}
