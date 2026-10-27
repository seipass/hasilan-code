import type { CSSProperties } from "react";
import type { QuakeNotice } from "../../shared/widgets.ts";

export function QuakeCard({ notice, featured = false }: { notice: QuakeNotice; featured?: boolean }) {
	const magnitude = notice.magnitude.trim() ? Number(notice.magnitude) : NaN;
	const depth = typeof notice.depth === "number" && Number.isFinite(notice.depth) ? notice.depth : null;
	const depthText = depth === null ? "不明" : `${depth.toLocaleString("ja-JP", { maximumFractionDigits: 1 })}km`;
	const time = new Date(notice.time).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
	const colors = {
		"--quake-magnitude-color": !Number.isFinite(magnitude) ? "#7f849c" : magnitude < 4 ? "#a6e3a1" : magnitude < 5 ? "#f9e2af" : magnitude < 6 ? "#fab387" : "#f38ba8",
		"--quake-depth-color": depth === null ? "#7f849c" : depth < 30 ? "#fab387" : depth < 100 ? "#a6e3a1" : depth < 300 ? "#94e2d5" : "#89b4fa",
	} as CSSProperties;
	const intensity = <div className="widget-intensity"><span>最大震度</span><strong>{notice.intensity || "—"}</strong></div>;
	if (!featured) return <article className="widget-quake-row" data-intensity={notice.intensity} style={colors} aria-label={`${notice.place}の地震`}>
		{intensity}<div className="widget-quake-event"><h3>{notice.place}</h3><time dateTime={notice.time}>{time}ごろ</time><div className="widget-quake-row-metrics"><span>深さ {depthText}<i className="widget-depth-mark" aria-hidden="true" /></span><span>M <strong>{notice.magnitude || "—"}</strong><i className="widget-magnitude-mark" aria-hidden="true" /></span></div></div>
	</article>;
	return <article className="widget-quake-latest" aria-label="最新の地震情報" data-intensity={notice.intensity} style={colors}>
		<div className="widget-quake-card-body">
			{intensity}
			<time dateTime={notice.time}>{time}ごろ</time><h3>{notice.place}</h3><p className="widget-quake-occurrence">で地震がありました</p>
			<dl className="widget-quake-metrics"><div><dt>マグニチュード</dt><dd><strong>{notice.magnitude || "—"}</strong><i className="widget-magnitude-mark" aria-hidden="true" /></dd></div><div><dt>深さ</dt><dd><span>{depthText}</span><i className="widget-depth-mark" aria-hidden="true" /></dd></div></dl>
			<div className="widget-quake-tsunami" data-status={notice.tsunami?.noRisk ? "none" : notice.tsunami ? "information" : "unknown"}>{notice.tsunami?.noRisk ? "津波の心配なし" : notice.tsunami?.text || "津波情報 未取得"}</div>
		</div>
	</article>;
}
