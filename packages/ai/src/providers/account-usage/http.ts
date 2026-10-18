import { type AccountUsageContext, AccountUsageError } from "../../account-usage.ts";

export async function usageJson(
	url: string,
	context: AccountUsageContext,
	headers: Record<string, string>,
): Promise<unknown> {
	const response = await (context.fetch ?? fetch)(url, { headers, signal: context.signal, redirect: "error" });
	if (!response.ok) {
		await response.body?.cancel();
		throw new AccountUsageError(`使用量APIがHTTP ${response.status}を返しました。`);
	}
	if (!response.body) throw new AccountUsageError("使用量APIの応答が空です。");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			context.signal.throwIfAborted();
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 1024 * 1024) throw new AccountUsageError("使用量APIの応答がサイズ上限を超えました。");
			parts.push(chunk.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new AccountUsageError("使用量APIの応答がJSONではありません。");
	}
}

export function usageNumber(value: unknown): number | undefined {
	const number =
		typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : undefined;
	return number !== undefined && Number.isFinite(number) ? number : undefined;
}

export function usageTimestamp(value: unknown): number | undefined {
	const number = usageNumber(value);
	const time =
		number !== undefined
			? number < 1e12
				? number * 1000
				: number
			: typeof value === "string"
				? Date.parse(value)
				: NaN;
	return Number.isFinite(time) && time > 0 && time <= 8640000000000000 ? time : undefined;
}
