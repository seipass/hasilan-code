export interface Activity {
	runs: number;
	queued: number;
	terminals: number;
}

export interface DesktopWindowState {
	maximized: boolean;
	fullscreen: boolean;
	focused: boolean;
}

export function readActivity(value: unknown): Activity | undefined {
	if (!value || typeof value !== "object") return undefined;
	const activity = value as Record<string, unknown>;
	if (
		![activity.runs, activity.queued, activity.terminals].every(
			(count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
		)
	)
		return undefined;
	return { runs: activity.runs as number, queued: activity.queued as number, terminals: activity.terminals as number };
}

export function localOrigin(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password)
		throw new Error("Host did not provide a loopback address");
	return url.origin;
}

export function externalLink(value: string): string | undefined {
	try {
		const url = new URL(value);
		return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

export function describeActivity(activity: Activity): string {
	return `実行中のAI作業 ${activity.runs}件、待機中の入力 ${activity.queued}件、端末 ${activity.terminals}件があります。終了すると処理を停止します。`;
}
