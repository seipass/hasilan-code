import { AccountUsageError } from "@hasilan-code/pi-ai";
import { getAccountUsageReader } from "@hasilan-code/pi-ai/providers/account-usage";
import type { ModelRuntime } from "@hasilan-code/pi-coding-agent";
import type { ProviderAccountUsageView } from "../shared/account-usage.ts";

export async function readAccountUsage(
	runtime: Pick<ModelRuntime, "getProviders" | "hasConfiguredAuth" | "getAuth" | "checkAuth">,
	signal: AbortSignal,
): Promise<ProviderAccountUsageView[]> {
	const requests: Promise<ProviderAccountUsageView>[] = [];
	for (const provider of runtime.getProviders()) {
		if (!runtime.hasConfiguredAuth(provider.id)) continue;
		const reader = getAccountUsageReader(provider);
		if (!reader) continue;
		requests.push(
			(async (): Promise<ProviderAccountUsageView> => {
				const timeout = AbortSignal.timeout(20000);
				const operationSignal = AbortSignal.any([signal, timeout]);
				try {
					const check = await runtime.checkAuth(provider.id, { signal: operationSignal });
					const resolved = await runtime.getAuth(provider.id, { signal: operationSignal });
					if (!check || !resolved) throw new AccountUsageError("認証が設定されていません。");
					const usage = await reader({
						auth: { ...resolved.auth, baseUrl: resolved.auth.baseUrl ?? provider.baseUrl },
						authType: check.type,
						signal: operationSignal,
					});
					operationSignal.throwIfAborted();
					return {
						provider: provider.id,
						name: provider.name,
						status: usage ? "ok" : "unsupported",
						checkedAt: Date.now(),
						usage,
					};
				} catch (error) {
					signal.throwIfAborted();
					return {
						provider: provider.id,
						name: provider.name,
						status: "error",
						checkedAt: Date.now(),
						error: timeout.aborted
							? "使用量の取得がタイムアウトしました。"
							: error instanceof AccountUsageError
								? error.message
								: "使用量を取得できませんでした。",
					};
				}
			})(),
		);
	}
	return Promise.all(requests);
}
