import { Type } from "typebox";
import { Check } from "typebox/value";
import { AccountUsageError, type AccountUsageMetric, type AccountUsageReader } from "../../account-usage.ts";
import { usageJson, usageNumber, usageTimestamp } from "./http.ts";

const numeric = Type.Union([Type.Number(), Type.String()]);
const timestamp = Type.Union([numeric, Type.Null()]);
const windowSchema = Type.Object({ cap: numeric, used: Type.Optional(numeric), resetAt: Type.Optional(timestamp) });
const windowsSchema = Type.Object({
	fiveHour: Type.Optional(Type.Union([windowSchema, Type.Null()])),
	weekly: Type.Optional(Type.Union([windowSchema, Type.Null()])),
});
const creditsSchema = Type.Object({
	monthlyCredits: Type.Optional(numeric),
	purchasedCredits: Type.Optional(numeric),
	freeCredits: Type.Optional(numeric),
	premiumMonthlyCredits: Type.Optional(numeric),
	opensourceMonthlyCredits: Type.Optional(numeric),
	planId: Type.Optional(Type.String()),
	windowLimits: Type.Optional(windowsSchema),
});
const payloadSchema = Type.Object({
	success: Type.Optional(Type.Boolean()),
	credits: creditsSchema,
	windowLimits: Type.Optional(windowsSchema),
});
const subscriptionSchema = Type.Object({
	success: Type.Literal(true),
	data: Type.Union([
		Type.Null(),
		Type.Object({
			planId: Type.Optional(Type.String()),
			currentPeriodEnd: Type.Optional(timestamp),
		}),
	]),
});

export const commandCodeAccountUsage: AccountUsageReader = async (context) => {
	if (!context.auth.apiKey) return undefined;
	if (context.auth.baseUrl && new URL(context.auth.baseUrl).origin !== "https://api.commandcode.ai") return undefined;
	const headers: Record<string, string> = {
		authorization: `Bearer ${context.auth.apiKey}`,
		accept: "application/json",
	};
	for (const [key, value] of Object.entries(context.auth.headers ?? {})) {
		if (["authorization", "cookie"].includes(key.toLowerCase()) && value) headers[key.toLowerCase()] = value;
	}
	const [credits, subscription] = await Promise.allSettled([
		usageJson("https://api.commandcode.ai/internal/billing/credits", context, headers),
		usageJson("https://api.commandcode.ai/internal/billing/subscriptions", context, headers),
	]);
	context.signal.throwIfAborted();
	if (credits.status === "rejected") throw credits.reason;
	if (!Check(payloadSchema, credits.value) || credits.value.success === false)
		throw new AccountUsageError("CommandCodeの使用量データの形式が不正です。");
	const payload = credits.value;
	const metrics: AccountUsageMetric[] = [];
	const notices: string[] = [];
	let plan = payload.credits.planId;
	let resetsAt: number | undefined;
	if (subscription.status === "fulfilled" && Check(subscriptionSchema, subscription.value)) {
		if (subscription.value.data) {
			plan = subscription.value.data.planId ?? plan;
			resetsAt = usageTimestamp(subscription.value.data.currentPeriodEnd);
		}
	} else notices.push("契約情報を取得できないため、請求期間のリセット日時は未確認です。");
	for (const [key, label] of [
		["monthlyCredits", "月間残量"],
		["purchasedCredits", "購入分残量"],
		["freeCredits", "無料分残量"],
		["premiumMonthlyCredits", "プレミアム残量"],
		["opensourceMonthlyCredits", "オープンモデル残量"],
	] as const) {
		const remaining = usageNumber(payload.credits[key]);
		if (remaining !== undefined)
			metrics.push({
				id: key,
				label,
				unit: "credits",
				remaining,
				resetsAt: key === "monthlyCredits" || key.endsWith("MonthlyCredits") ? resetsAt : undefined,
			});
	}
	const windows = payload.windowLimits ?? payload.credits.windowLimits;
	for (const [key, label] of [
		["fiveHour", "5時間"],
		["weekly", "7日"],
	] as const) {
		const window = windows?.[key];
		if (!window) continue;
		const limit = usageNumber(window.cap);
		const used = usageNumber(window.used);
		if (limit === undefined || limit <= 0) continue;
		metrics.push({
			id: key,
			label,
			unit: "credits",
			used,
			limit,
			remaining: used === undefined ? undefined : Math.max(0, limit - used),
			usedPercent: used === undefined ? undefined : (used / limit) * 100,
			resetsAt: usageTimestamp(window.resetAt),
		});
	}
	if (!metrics.length) throw new AccountUsageError("CommandCodeから利用上限・残量のデータが返されませんでした。");
	return { plan, metrics, ...(notices.length ? { notices } : {}) };
};
