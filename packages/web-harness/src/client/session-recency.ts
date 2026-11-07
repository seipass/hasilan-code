const relative = new Intl.RelativeTimeFormat("ja-JP", { numeric: "auto" });

export function sessionRecency(timestamp: string | undefined, now = Date.now()): string {
	if (!timestamp) return "日時未記録";
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return "日時未記録";
	const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
	if (minutes < 1) return "たった今";
	if (minutes < 60) return relative.format(-minutes, "minute");
	if (minutes < 1440) return relative.format(-Math.floor(minutes / 60), "hour");
	const days = Math.floor(minutes / 1440);
	if (days < 7) return relative.format(-days, "day");
	if (days < 30) return relative.format(-Math.floor(days / 7), "week");
	const months = (new Date(now).getFullYear() - date.getFullYear()) * 12 + new Date(now).getMonth() - date.getMonth();
	if (months < 12) return relative.format(-Math.max(1, months), "month");
	return relative.format(-Math.floor(months / 12), "year");
}
