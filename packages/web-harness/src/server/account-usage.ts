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
					const read = (auth: typeof resolved.auth) =>
						reader({
							auth: { ...auth, baseUrl: auth.baseUrl ?? provider.baseUrl },
							authType: check.type,
							signal: operationSignal,
						});
					let usage: Awaited<ReturnType<typeof reader>>;
					try {
						usage = await read(resolved.auth);
					} catch (error) {
						if (check.type !== "oauth" || !(error instanceof AccountUsageError) || error.status !== 401)
							throw error;
						const reauth = new AccountUsageError(
							"使用量の認証を更新できませんでした。設定のプロバイダーからアカウントを再接続してください。",
						);
						try {
							const refreshed = await runtime.getAuth(provider.id, {
								signal: operationSignal,
								rejectedOAuthAccessToken: resolved.auth.apiKey,
							});
							if (!refreshed?.auth.apiKey || refreshed.auth.apiKey === resolved.auth.apiKey) throw reauth;
							usage = await read(refreshed.auth);
						} catch (retryError) {
							if (retryError instanceof AccountUsageError && retryError.status !== 401) throw retryError;
							throw reauth;
						}
					}
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
