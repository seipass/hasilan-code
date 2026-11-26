import { useId, useMemo, useRef, useState } from "react";
import type { DailyUsagePoint } from "../shared/usage.ts";
import "./TokenUsageChart.css";

const moneyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatCompactTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)} K`;
	return Math.round(value).toLocaleString("ja-JP");
}

function formatDateRangeLabel(isoDate: string): string {
	const [year, month, day] = isoDate.split("-").map(Number);
	if (!year || !month || !day) return isoDate;
	const date = new Date(year, month - 1, day);
	return date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

function formatTooltipDate(isoDate: string): string {
	const [year, month, day] = isoDate.split("-").map(Number);
	if (!year || !month || !day) return isoDate;
	const date = new Date(year, month - 1, day);
	return date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });
}

interface PrefixSums {
	totalTokens: number[];
	cachedTokens: number[];
	cost: number[];
}

const CHART_WIDTH = 420;
const CHART_HEIGHT = 128;
const PAD_X = 6;
const PAD_TOP = 10;
const PAD_BOTTOM = 8;

function buildStepPath(points: readonly { x: number; y: number }[], closeBaseY?: number): string {
	if (!points.length) return "";
	let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
	for (let index = 1; index < points.length; index++) {
		const point = points[index];
		const previous = points[index - 1];
		d += ` H ${point.x.toFixed(2)} V ${point.y.toFixed(2)}`;
		if (previous.x === point.x && previous.y === point.y) continue;
	}
	if (closeBaseY !== undefined) {
		const last = points[points.length - 1];
		d += ` L ${last.x.toFixed(2)} ${closeBaseY.toFixed(2)} L ${points[0].x.toFixed(2)} ${closeBaseY.toFixed(2)} Z`;
	}
	return d;
}

export function TokenUsageChart({ days, loading = false, unpriced = false }: {
	days: DailyUsagePoint[];
	loading?: boolean;
	unpriced?: boolean;
}) {
	const clipId = useId();
	const svgRef = useRef<SVGSVGElement>(null);
	const [hoverIndex, setHoverIndex] = useState<number | null>(null);

	const { prefix, totalPoints, cachedPoints, totalPath, cachedPath, cachedAreaPath } = useMemo(() => {
		const prefixTotals: PrefixSums = { totalTokens: [], cachedTokens: [], cost: [] };
		let sumTokens = 0;
		let sumCached = 0;
		let sumCost = 0;
		let maxTokens = 1;
		for (const day of days) {
			sumTokens += day.totalTokens;
			sumCached += day.cachedTokens;
			sumCost += day.cost;
			prefixTotals.totalTokens.push(sumTokens);
			prefixTotals.cachedTokens.push(sumCached);
			prefixTotals.cost.push(sumCost);
			if (day.totalTokens > maxTokens) maxTokens = day.totalTokens;
		}
		const usableW = CHART_WIDTH - PAD_X * 2;
		const usableH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
		const baseY = CHART_HEIGHT - PAD_BOTTOM;
		const denominator = Math.max(1, days.length - 1);
		const totals = days.map((day, index) => ({
			x: PAD_X + (days.length === 1 ? usableW / 2 : (index / denominator) * usableW),
			y: baseY - (day.totalTokens / maxTokens) * usableH,
		}));
		const cached = days.map((day, index) => ({
			x: PAD_X + (days.length === 1 ? usableW / 2 : (index / denominator) * usableW),
			y: baseY - (day.cachedTokens / maxTokens) * usableH,
		}));
		return {
			prefix: prefixTotals,
			totalPoints: totals,
			cachedPoints: cached,
			totalPath: buildStepPath(totals),
			cachedPath: buildStepPath(cached),
			cachedAreaPath: buildStepPath(cached, baseY),
		};
	}, [days]);

	if (loading && days.length === 0) {
		return <div className="token-usage-chart is-empty"><p className="token-usage-empty">使用履歴を読み込んでいます…</p></div>;
	}
	if (days.length === 0) {
		return <div className="token-usage-chart is-empty"><p className="token-usage-empty">日別のトークン使用履歴はまだありません。</p></div>;
	}

	const activeIndex = hoverIndex !== null && hoverIndex >= 0 && hoverIndex < days.length ? hoverIndex : days.length - 1;
	const activeDay = days[activeIndex];
	const cumulativeTokens = prefix.totalTokens[activeIndex] ?? 0;
	const cumulativeCost = prefix.cost[activeIndex] ?? 0;
	const avgDailyTokens = cumulativeTokens / (activeIndex + 1);
	const startLabel = formatDateRangeLabel(days[0].date);
	const endLabel = formatDateRangeLabel(activeDay.date);
	const hoveredTotalPoint = hoverIndex !== null ? totalPoints[hoverIndex] : undefined;
	const hoveredCachedPoint = hoverIndex !== null ? cachedPoints[hoverIndex] : undefined;
	const splitX = hoveredTotalPoint ? hoveredTotalPoint.x : CHART_WIDTH;
	const tooltipLeftPercent = hoveredTotalPoint ? (hoveredTotalPoint.x / CHART_WIDTH) * 100 : 50;

	function updateHoverFromClientX(clientX: number) {
		const rect = svgRef.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0 || days.length === 0) return;
		const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		const nextIndex = days.length === 1 ? 0 : Math.round(ratio * (days.length - 1));
		setHoverIndex(nextIndex);
	}

	return <div className="token-usage-chart">
		<div className="token-usage-subtitle">
			<span>{startLabel} – {endLabel} の累計</span>
			<span className="token-usage-legend">
				<span><i className="token-usage-swatch is-total" />Tokens</span>
				<span><i className="token-usage-swatch is-cached" />Cached</span>
			</span>
		</div>
		<div
			className="token-usage-plot"
			tabIndex={0}
			role="slider"
			aria-label="日別トークン使用量グラフ"
			aria-valuemin={0}
			aria-valuemax={Math.max(0, days.length - 1)}
			aria-valuenow={activeIndex}
			aria-valuetext={`${formatTooltipDate(activeDay.date)}: ${formatCompactTokens(activeDay.totalTokens)} トークン`}
			onPointerMove={(event) => updateHoverFromClientX(event.clientX)}
			onPointerLeave={() => setHoverIndex(null)}
			onBlur={() => setHoverIndex(null)}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					setHoverIndex((current) => Math.max(0, (current ?? days.length - 1) - 1));
				} else if (event.key === "ArrowRight") {
					event.preventDefault();
					setHoverIndex((current) => Math.min(days.length - 1, (current ?? 0) + 1));
				} else if (event.key === "Escape") {
					setHoverIndex(null);
				}
			}}
		>
			<svg
				ref={svgRef}
				className="token-usage-svg"
				width={CHART_WIDTH}
				height={CHART_HEIGHT}
				viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<defs>
					<clipPath id={`${clipId}-left`}>
						<rect x="0" y="0" width={splitX} height={CHART_HEIGHT} />
					</clipPath>
					<clipPath id={`${clipId}-right`}>
						<rect x={splitX} y="0" width={Math.max(0, CHART_WIDTH - splitX)} height={CHART_HEIGHT} />
					</clipPath>
				</defs>
				<line className="token-usage-baseline" x1={PAD_X} y1={CHART_HEIGHT - PAD_BOTTOM} x2={CHART_WIDTH - PAD_X} y2={CHART_HEIGHT - PAD_BOTTOM} />
				<g clipPath={`url(#${clipId}-left)`}>
					{cachedAreaPath && <path className="token-usage-area" d={cachedAreaPath} />}
					{cachedPath && <path className="token-usage-line is-cached" d={cachedPath} />}
					{totalPath && <path className="token-usage-line is-total" d={totalPath} />}
				</g>
				{hoverIndex !== null && (
					<g className="token-usage-dimmed" clipPath={`url(#${clipId}-right)`}>
						{cachedAreaPath && <path className="token-usage-area" d={cachedAreaPath} />}
						{cachedPath && <path className="token-usage-line is-cached" d={cachedPath} />}
						{totalPath && <path className="token-usage-line is-total" d={totalPath} />}
					</g>
				)}
				{hoveredTotalPoint && hoveredCachedPoint && (
					<g className="token-usage-crosshair">
						<line x1={hoveredTotalPoint.x} y1={PAD_TOP} x2={hoveredTotalPoint.x} y2={CHART_HEIGHT - PAD_BOTTOM} />
						<circle className="token-usage-dot is-total" cx={hoveredTotalPoint.x} cy={hoveredTotalPoint.y} r="3.5" />
						<circle className="token-usage-dot is-cached" cx={hoveredCachedPoint.x} cy={hoveredCachedPoint.y} r="3.5" />
					</g>
				)}
			</svg>
			{hoverIndex !== null && (
				<div
					className="token-usage-tooltip"
					role="status"
					style={{
						left: `${Math.min(82, Math.max(18, tooltipLeftPercent))}%`,
					}}
				>
					<strong>{formatTooltipDate(activeDay.date)}</strong>
					<div><span><i className="token-usage-swatch is-total" />Tokens</span><span>{formatCompactTokens(activeDay.totalTokens)}</span></div>
					<div><span><i className="token-usage-swatch is-cached" />Cached</span><span>{activeDay.cachedTokens > 0 ? formatCompactTokens(activeDay.cachedTokens) : "—"}</span></div>
				</div>
			)}
		</div>
		<dl className="token-usage-kpis">
			<div><dt>累計トークン</dt><dd>{formatCompactTokens(cumulativeTokens)}</dd></div>
			<div><dt>1日平均</dt><dd>{formatCompactTokens(avgDailyTokens)}</dd></div>
			<div><dt>概算費用</dt><dd>{moneyFormat.format(cumulativeCost)}{unpriced && <small>一部未計測</small>}</dd></div>
		</dl>
	</div>;
}
