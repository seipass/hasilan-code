export interface Activity {
	runs: number;
	queued: number;
	terminals: number;
}

export interface DesktopWindowState {
	maximized: boolean;
	fullscreen: boolean;
	focused: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
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

export function readBrowserHistory(
	encoded: string,
): { entries: { url: string; title: string }[]; index: number } | undefined {
	if (encoded.length > 250_000) return;
	try {
		const data = JSON.parse(decodeURIComponent(encoded)) as { entries?: unknown; index?: unknown };
		if (
			!Array.isArray(data.entries) ||
			data.entries.length > 100 ||
			typeof data.index !== "number" ||
			!Number.isInteger(data.index) ||
			data.index < 0 ||
			data.index >= data.entries.length
		)
			return;
		const entries = [];
		for (const entry of data.entries as { url?: unknown; title?: unknown }[]) {
			if (
				!entry ||
				typeof entry.url !== "string" ||
				typeof entry.title !== "string" ||
				(entry.url !== "about:blank" && (!/^https?:\/\//i.test(entry.url) || !externalLink(entry.url)))
			)
				return;
			entries.push({ url: entry.url, title: entry.title });
		}
		return { entries, index: data.index };
	} catch {
		return;
	}
}
