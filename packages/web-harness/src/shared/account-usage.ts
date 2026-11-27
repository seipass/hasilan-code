import type { AccountUsage, AccountUsageMetric } from "@hasilan-code/pi-ai";

export interface ProviderAccountUsageView {
	provider: string;
	name: string;
	status: "ok" | "unsupported" | "error";
	checkedAt: number;
	usage?: AccountUsage;
	error?: string;
}

export interface RateLimitSelection {
	providerName?: string;
	session?: AccountUsageMetric;
	weekly?: AccountUsageMetric;
}

export function pickRateLimitMetrics(
	views: readonly ProviderAccountUsageView[],
	preferredProvider?: string,
): RateLimitSelection {
	const okViews = views.filter((entry) => entry.status === "ok" && entry.usage?.metrics.length);
	const chosen = okViews.find((entry) => entry.provider === preferredProvider) ?? okViews[0];
	if (!chosen?.usage) return {};
	const percentMetrics = chosen.usage.metrics.filter(
		(metric) => !metric.unlimited && metric.usedPercent !== undefined && Number.isFinite(metric.usedPercent),
	);
	if (!percentMetrics.length) return {};
	const session =
		percentMetrics.find((metric) => /5\s*h|session|short|daily|日|時間/i.test(`${metric.id} ${metric.label}`)) ??
		percentMetrics[0];
	const weekly =
		percentMetrics.find(
			(metric) => metric !== session && /week|7\s*d|long|週/i.test(`${metric.id} ${metric.label}`),
		) ?? percentMetrics.find((metric) => metric !== session);
	return { providerName: chosen.name, session, weekly };
}

export function formatRateLimitReset(resetsAt?: number, now = Date.now()): string | undefined {
	if (resetsAt === undefined || !Number.isFinite(resetsAt)) return undefined;
	const diffMs = resetsAt - now;
	if (diffMs <= 0) return "まもなくリセット";
	const totalMinutes = Math.round(diffMs / 60_000);
	if (totalMinutes < 24 * 60) {
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		return hours > 0 ? `あと ${hours}時間${minutes}分` : `あと ${minutes}分`;
	}
	const date = new Date(resetsAt);
	return date.toLocaleString("ja-JP", { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
