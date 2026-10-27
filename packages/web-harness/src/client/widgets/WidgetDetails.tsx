import { useEffect, useRef, useState } from "react";
import type { QuakeSnapshot, WeatherPlace, WeatherSnapshot } from "../../shared/widgets.ts";
import { api, errorMessage } from "../api.ts";
import { controlMusic, type MusicState } from "./music.ts";
import { QuakeCard } from "./QuakeCard.tsx";
import { timerElapsed, timerLabel, type WidgetTimer, weatherLabel } from "./state.ts";
import { WeatherScene } from "./WeatherScene.tsx";

export function WeatherDetails({ place, weather, busy, error, onPlace, refresh }: {
	place: WeatherPlace | null; weather?: WeatherSnapshot; busy?: boolean; error?: string;
	onPlace: (value: WeatherPlace | null) => void; refresh: () => void;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<WeatherPlace[]>();
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string>();
	const search = useRef<AbortController>(null);
	useEffect(() => () => search.current?.abort(), []);
	return <div className="widget-weather">
		{place && <><div className="widget-weather-hero">
			{weather && <WeatherScene code={weather.code} />}
			<div className="widget-weather-current"><h3>{place.name}</h3><p>{[place.region, place.country].filter(Boolean).join(" · ")}</p><strong>{weather ? `${Math.round(weather.temperature)}°` : "—"}</strong><span>{weather ? weatherLabel(weather.code) : "天気を取得中…"}</span></div>
			{weather && <dl className="widget-stats"><div><dt>最高 / 最低</dt><dd>{Math.round(weather.high)}° / {Math.round(weather.low)}°</dd></div><div><dt>風速</dt><dd>{weather.wind.toFixed(1)} <small>m/s</small></dd></div></dl>}
			</div>
			{weather && <p className="fine-print">予報時刻 {new Date(weather.time).toLocaleString("ja-JP")} · 取得 {new Date(weather.fetchedAt).toLocaleTimeString("ja-JP")}</p>}
			{error && <p role="alert" className="error">{error}{weather && " 表示中の値は前回の取得分です。"}</p>}
			<div className="widget-actions"><button type="button" disabled={busy} onClick={refresh}>{busy ? "更新中…" : "更新"}</button><button type="button" onClick={() => onPlace(null)}>地域を変更</button></div></>}
		{!place && <form className="widget-form" onSubmit={async (event) => {
			event.preventDefault(); search.current?.abort(); const controller = new AbortController(); search.current = controller;
			setSearching(true); setSearchError(undefined); setResults(undefined);
			try { const values = await api<WeatherPlace[]>(`/api/widgets/places?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal }); if (!controller.signal.aborted) setResults(values); }
			catch (reason) { if (!controller.signal.aborted) setSearchError(errorMessage(reason)); }
			finally { if (!controller.signal.aborted) setSearching(false); }
		}}><label>地域名<input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="東京、Osaka、London…" minLength={2} maxLength={80} required /></label><button type="submit" disabled={searching}>{searching ? "検索中…" : "地域を検索"}</button>
			{searchError && <p role="alert" className="error">{searchError}</p>}
			{results?.length === 0 && <p role="status">地域が見つかりません。英字の地域名でも検索できます。</p>}
			{results && <ul className="widget-place-results">{results.map((entry) => <li key={entry.id}><button type="button" onClick={() => onPlace(entry)}><strong>{entry.name}</strong><span>{[entry.region, entry.country].filter(Boolean).join(" · ")}</span></button></li>)}</ul>}
		</form>}
		<p className="fine-print">天気予報: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> · 地域検索: GeoNames · 10分ごとに更新</p>
	</div>;
}

export function QuakeDetails({ snapshot, error }: { snapshot?: QuakeSnapshot; error?: string }) {
	const latest = snapshot?.notices[0];
	return <div className="widget-earthquake">
		{error && <p role="alert" className="error">{error}{snapshot && " 以下は前回の取得分です。"}</p>}
		{!snapshot && !error && <p role="status">地震情報を取得しています…</p>}
		{snapshot?.notices.length === 0 && <p>公開中の地震情報はありません。</p>}
		{latest && <QuakeCard notice={latest} featured />}
		{snapshot && snapshot.notices.length > 1 && <ol className="widget-quakes">{snapshot.notices.slice(1).map((notice) => <li key={notice.id}><QuakeCard notice={notice} /></li>)}</ol>}
		<footer className="widget-quake-footer"><a href="https://www.jma.go.jp/bosai/quake/" target="_blank" rel="noreferrer">気象庁で詳細を見る ↗</a>{snapshot && <time dateTime={new Date(snapshot.fetchedAt).toISOString()}>{new Date(snapshot.fetchedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} 取得</time>}</footer>
	</div>;
}

export function TimerDetails({ timer, countdown, now, onChange }: { timer: WidgetTimer; countdown: boolean; now: number; onChange: (timer: WidgetTimer) => void }) {
	const [minutes, setMinutes] = useState(String(timer.duration / 60_000));
	const elapsed = timerElapsed(timer, now);
	const finished = countdown && elapsed >= timer.duration;
	const running = timer.startedAt !== null && !finished;
	return <div className="widget-timer">
		<output className="widget-timer-display" aria-label={countdown ? "残り時間" : "経過時間"}>{timerLabel(countdown ? timer.duration - elapsed : elapsed)}</output>
		<p>{finished ? "時間になりました" : running ? "計測中" : "停止中"}</p>
		<div className="widget-actions"><button type="button" className="widget-primary" onClick={() => onChange(running ? { ...timer, elapsed, startedAt: null } : { ...timer, elapsed: finished ? 0 : timer.elapsed, startedAt: Date.now() })}>{running ? "一時停止" : timer.elapsed > 0 && !finished ? "再開" : "開始"}</button><button type="button" onClick={() => onChange({ ...timer, elapsed: 0, startedAt: null })}>リセット</button></div>
		{countdown && <form className="widget-form" onSubmit={(event) => { event.preventDefault(); const duration = Number(minutes) * 60_000; if (Number.isFinite(duration) && duration >= 1000 && duration <= 7 * 86400_000) onChange({ duration, elapsed: 0, startedAt: null }); }}><label>設定時間（分）<input type="number" min={1} max={10080} step={1} value={minutes} disabled={running} onChange={(event) => setMinutes(event.currentTarget.value)} required /></label><button type="submit" disabled={running}>時間を設定</button></form>}
	</div>;
}

export function MusicDetails({ music }: { music: MusicState | null }) {
	const [error, setError] = useState<string>();
	if (!music) return <p className="widget-empty">ファイルビューアで音楽ファイルを開くと、ここで再生・音量・再生位置を操作できます。</p>;
	const control = (command: "toggle" | "seek" | "volume" | "mute", value?: number) => {
		setError(undefined);
		void controlMusic(command, value).catch(() => setError("音楽を操作できません。ファイルビューアで音楽を開き直してください。"));
	};
	return <div className="widget-music"><h3>{music.title}</h3>{music.artist && <p>{music.artist}</p>}
		<div className="widget-actions"><button type="button" className="widget-primary" disabled={music.error} onClick={() => control("toggle")}>{music.playing ? "一時停止" : "再生"}</button><button type="button" aria-pressed={music.muted} onClick={() => control("mute")}>{music.muted ? "ミュート解除" : "ミュート"}</button></div>
		<label>再生位置<input type="range" min={0} max={music.duration || 1} step={0.1} value={Math.min(music.position, music.duration)} disabled={!music.duration} aria-valuetext={`${timerLabel(music.position * 1000)} / ${timerLabel(music.duration * 1000)}`} onChange={(event) => control("seek", Number(event.currentTarget.value))} /></label>
		<div className="widget-timeline"><span>{timerLabel(music.position * 1000)}</span><span>{timerLabel(music.duration * 1000)}</span></div>
		<label>音量 {music.muted ? 0 : Math.round(music.volume * 100)}%<input type="range" min={0} max={100} step={1} value={music.muted ? 0 : Math.round(music.volume * 100)} onChange={(event) => control("volume", Number(event.currentTarget.value) / 100)} /></label>
		{(error || music.error) && <p role="alert" className="error">{error || "この音楽を再生できません。"}</p>}
	</div>;
}
