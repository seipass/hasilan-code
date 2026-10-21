import { Type } from "typebox";
import { Check } from "typebox/value";
import { AccountUsageError, type AccountUsageMetric, type AccountUsageReader } from "../../account-usage.ts";
import { usageJson, usageNumber, usageTimestamp } from "./http.ts";

const windowSchema = Type.Object({
	used_percent: Type.Number({ minimum: 0 }),
	limit_window_seconds: Type.Optional(Type.Number({ minimum: 0 })),
	reset_at: Type.Optional(Type.Number({ minimum: 0 })),
	reset_after_seconds: Type.Optional(Type.Number({ minimum: 0 })),
});
const creditsSchema = Type.Object({
	has_credits: Type.Optional(Type.Boolean()),
	unlimited: Type.Optional(Type.Boolean()),
	balance: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
});
const rateSchema = Type.Object({
	primary_window: Type.Optional(Type.Union([windowSchema, Type.Null()])),
	secondary_window: Type.Optional(Type.Union([windowSchema, Type.Null()])),
	credits: Type.Optional(creditsSchema),
});
const usageSchema = Type.Object({
	plan_type: Type.Optional(Type.String()),
	rate_limit: Type.Optional(rateSchema),
	code_review_rate_limit: Type.Optional(Type.Union([rateSchema, Type.Null()])),
	credits: Type.Optional(creditsSchema),
});
const claimsSchema = Type.Object({
	"https://api.openai.com/auth": Type.Optional(Type.Object({ chatgpt_account_id: Type.Optional(Type.String()) })),
});

export const codexAccountUsage: AccountUsageReader = async (context) => {
	if (context.authType !== "oauth" || !context.auth.apiKey) return undefined;
	if (
		context.auth.baseUrl &&
		!["https://chatgpt.com", "https://api.openai.com"].includes(new URL(context.auth.baseUrl).origin)
	)
		return undefined;
	const headers: Record<string, string> = {
		authorization: `Bearer ${context.auth.apiKey}`,
		accept: "application/json",
	};
	for (const [key, value] of Object.entries(context.auth.headers ?? {})) {
		if (key.toLowerCase() === "chatgpt-account-id" && value) headers["ChatGPT-Account-ID"] = value;
	}
	if (!headers["ChatGPT-Account-ID"]) {
		try {
			const encoded = context.auth.apiKey.split(".")[1];
			const claims: unknown = encoded && JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
			if (Check(claimsSchema, claims)) {
				const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
				if (accountId) headers["ChatGPT-Account-ID"] = accountId;
			}
		} catch {
			/* A token without an account claim uses the account selected by the server. */
		}
	}
	const payload = await usageJson("https://chatgpt.com/backend-api/wham/usage", context, headers);
	if (!Check(usageSchema, payload)) throw new AccountUsageError("Codexの使用量データの形式が不正です。");
	const metrics: AccountUsageMetric[] = [];
	for (const [prefix, rate] of [
		["", payload.rate_limit],
		["コードレビュー · ", payload.code_review_rate_limit],
	] as const) {
		if (!rate) continue;
		for (const [key, window, fallback] of [
			["primary", rate.primary_window, "短期"],
			["secondary", rate.secondary_window, "長期"],
		] as const) {
			if (!window) continue;
			const seconds = window.limit_window_seconds;
			const label =
				seconds === 18000
					? "5時間"
					: seconds === 604800
						? "7日"
						: seconds
							? `${Math.round(seconds / 60)}分`
							: fallback;
			metrics.push({
				id: `${prefix}${key}`,
				label: `${prefix}${label}`,
				usedPercent: window.used_percent,
				resetsAt:
					usageTimestamp(window.reset_at) ??
					(window.reset_after_seconds === undefined ? undefined : Date.now() + window.reset_after_seconds * 1000),
			});
		}
	}
	const credits = payload.rate_limit?.credits ?? payload.credits;
	if (credits && credits.has_credits !== false) {
		const remaining = usageNumber(credits.balance);
		if (credits.unlimited) metrics.push({ id: "credits", label: "追加クレジット", unit: "credits", unlimited: true });
		else if (remaining !== undefined)
			metrics.push({ id: "credits", label: "追加クレジット", unit: "credits", remaining });
	}
	if (!metrics.length) throw new AccountUsageError("Codexから利用上限・残量のデータが返されませんでした。");
	return { plan: payload.plan_type, metrics };
};
