import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { AudioMetadata } from "../../shared/media.ts";
import { mediaReady, Presence } from "../Motion.tsx";
import { registerMusic } from "../widgets/music.ts";

function timeLabel(seconds: number) {
	const value = Math.max(0, Math.floor(seconds));
	return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function AudioPreview({ path, src, metadata, visible }: {
	path: string; src: string; metadata?: AudioMetadata; visible: boolean;
}) {
	const audio = useRef<HTMLAudioElement>(null);
	const [playing, setPlaying] = useState(false);
	const [duration, setDuration] = useState(0);
	const [position, setPosition] = useState(0);
	const [error, setError] = useState<string>();
	const [coverFailed, setCoverFailed] = useState(false);
	const [volume, setVolume] = useState(1);
	const [muted, setMuted] = useState(false);
	const previousVolume = useRef(1);
	const silent = muted || volume === 0;
	const percentage = silent ? 0 : Math.round(volume * 100);
	const title = metadata?.title || path.split(/[\\/]/).at(-1) || path;
	const cover = coverFailed ? undefined : metadata?.cover;
	useEffect(() => { if (audio.current) return registerMusic(audio.current, title, metadata?.artist ?? ""); }, [src, title, metadata?.artist]);
	useEffect(() => { if (!visible) audio.current?.pause(); }, [visible]);
	useEffect(() => {
		if (audio.current) { audio.current.volume = volume; audio.current.muted = muted; }
		if (volume > 0) previousVolume.current = volume;
	}, [volume, muted]);
	return <section className="files-audio-preview" aria-label="音楽プレーヤー">
		{cover && <div className="files-audio-backdrop" style={{ backgroundImage: `url("${cover}")` }} aria-hidden="true" />}
		<audio ref={audio} src={src} preload="metadata"
			onVolumeChange={(event) => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); }}
			onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
			onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
			onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
			onError={() => setError("このブラウザーで再生できない音声形式か、ファイルが破損しています。ダウンロードして別のプレーヤーでも確認できます。")}
		><track kind="captions" /></audio>
		<div className="files-audio-player">
			<div className="files-audio-artwork">
				{cover ? <img src={cover} alt={`${title}のジャケット`} onLoad={(event) => mediaReady(event.currentTarget)} onError={() => setCoverFailed(true)} /> : <svg className="motion-label" viewBox="0 0 48 48" aria-hidden="true"><path d="M20 32V12l18-4v20M20 18l18-4" /><ellipse cx="14" cy="33" rx="6" ry="5" /><ellipse cx="32" cy="29" rx="6" ry="5" /></svg>}
			</div>
			<h2 className="files-audio-title">{title}</h2>
			<p className="files-audio-artist">{metadata?.artist || "アーティスト不明"}</p>
			<button type="button" className="files-audio-play" aria-label={playing ? "一時停止" : "再生"} disabled={!!error}
				onClick={() => {
					const element = audio.current;
					if (!element) return;
					if (!element.paused) element.pause();
					else void element.play().catch((reason: unknown) => {
						if (!(reason instanceof DOMException && reason.name === "AbortError")) setError("音声を再生できません。ファイルとブラウザーの音声設定を確認してください。");
					});
				}}>
				<svg key={String(playing)} className="motion-label" viewBox="0 0 24 24" aria-hidden="true">{playing ? <path d="M7 5h4v14H7zm6 0h4v14h-4z" /> : <path d="m9 5 11 7-11 7z" />}</svg>
			</button>
			<div className="files-audio-timeline" style={{ "--audio-progress": `${duration > 0 ? Math.min(100, position / duration * 100) : 0}%` } as CSSProperties}>
				<input className="files-audio-seek" type="range" aria-label="再生位置" min={0} max={duration || 1} step={0.1}
					value={Math.min(position, duration || 0)} disabled={!duration || !!error}
					aria-valuetext={`${timeLabel(position)} / ${duration ? timeLabel(duration) : "時間不明"}`}
					onChange={(event) => { if (audio.current) { audio.current.currentTime = Number(event.currentTarget.value); setPosition(audio.current.currentTime); } }} />
				<div className="files-audio-times" aria-hidden="true"><span>{timeLabel(position)}</span><span>{duration ? timeLabel(duration) : "–:–"}</span></div>
			</div>
			<div className="files-audio-volume">
				<button type="button" className="files-audio-mute" aria-label={silent ? "ミュート解除" : "ミュート"} aria-pressed={silent}
					onClick={() => { if (silent) { if (volume === 0) setVolume(previousVolume.current); setMuted(false); } else setMuted(true); }}>
					<svg key={silent ? "muted" : volume >= .5 ? "loud" : "quiet"} className="motion-label" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" />{silent ? <path d="m16 9 6 6m0-6-6 6" /> : <><path d="M15 8a6 6 0 0 1 0 8" />{volume >= 0.5 && <path d="M18 5a10 10 0 0 1 0 14" />}</>}</svg>
				</button>
				<input className="files-audio-seek" type="range" aria-label="音量" min={0} max={100} step={1} value={percentage} aria-valuetext={`${percentage}%`}
					style={{ "--audio-progress": `${percentage}%` } as CSSProperties}
					onChange={(event) => { setVolume(Number(event.currentTarget.value) / 100); setMuted(false); }} />
				<span className="files-audio-volume-value" aria-hidden="true">{percentage}%</span>
			</div>
			<Presence show={!!error}><div className="files-audio-error" role="alert"><p className="error">{error}</p><a href={src} download={path.split(/[\\/]/).at(-1)}>ダウンロード</a></div></Presence>
		</div>
	</section>;
}
