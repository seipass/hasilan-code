import { AccountUsageError, type AccountUsageMetric, type AccountUsageReader } from "../../account-usage.ts";
import { apiServer, blobs, decode, type Fields, integer, text, unary } from "./protocol.ts";

function number(fields: Fields, field: number, bits = 32): number | undefined {
	const value = fields.get(field)?.[0];
	if (typeof value !== "bigint") return undefined;
	const parsed = Number(BigInt.asIntN(bits, value));
	if (!Number.isSafeInteger(parsed)) throw new AccountUsageError("Devinの使用量が数値の上限を超えています。");
	return parsed;
}

export const devinAccountUsage: AccountUsageReader = async (context) => {
	if (context.authType !== "oauth" || !context.auth.apiKey) return undefined;
	const root = await unary(
		apiServer(context.auth.baseUrl),
		"/exa.seat_management_pb.SeatManagementService/GetUserStatus",
		context.auth.apiKey,
		context.signal,
		context.fetch,
	);
	const userBytes = blobs(root, 1)[0];
	const user = decode(userBytes ?? Buffer.alloc(0));
	const statusBytes = blobs(user, 13)[0];
	if (!statusBytes) throw new AccountUsageError("Devinから利用上限・残量のデータが返されませんでした。");
	const status = decode(statusBytes);
	const plan = decode(blobs(status, 1)[0] ?? blobs(root, 2)[0] ?? Buffer.alloc(0));
	const periodEnd = blobs(status, 3)[0];
	const periodSeconds = periodEnd ? number(decode(periodEnd), 1, 64) : undefined;
	const resetsAt = periodSeconds === undefined ? undefined : periodSeconds * 1000;
	const metrics: AccountUsageMetric[] = [];
	for (const [id, label, grantField, usedField, remainingField] of [
		["prompt", "月間プロンプト", 12, 6, 8],
		["flow", "月間フロー", 13, 5, 9],
		["flex", "Flex", 14, 7, 4],
	] as const) {
		const limit = number(plan, grantField);
		const remaining = number(status, remainingField);
		const used = number(status, usedField);
		if (limit === -1 || remaining === -1) {
			metrics.push({ id, label, unit: "credits", unlimited: true, resetsAt });
			continue;
		}
		if (limit === undefined && remaining === undefined && used === undefined) continue;
		if (limit === 0 && !remaining && !used) continue;
		metrics.push({
			id,
			label,
			unit: "credits",
			limit,
			used: used ?? 0,
			remaining: remaining ?? 0,
			usedPercent: limit && limit > 0 ? ((used ?? 0) / limit) * 100 : undefined,
			resetsAt,
		});
	}
	for (const [id, label, percentField, resetField, hideField] of [
		["daily", "1日", 14, 17, 36],
		["weekly", "7日", 15, 18, 37],
	] as const) {
		if (integer(plan, hideField)) continue;
		const reset = number(status, resetField, 64);
		// Proto3 omits zero percentages; a reset timestamp identifies an exhausted window.
		const remaining = number(status, percentField) ?? (reset === undefined ? undefined : 0);
		if (remaining === undefined) continue;
		if (remaining < 0 || remaining > 100) throw new AccountUsageError("Devinの使用量の割合が不正です。");
		metrics.push({
			id,
			label,
			usedPercent: 100 - remaining,
			resetsAt: reset === undefined ? undefined : reset * 1000,
		});
	}
	const overage = number(status, 16, 64);
	if (overage !== undefined && overage !== 0)
		metrics.push({ id: "overage", label: "超過利用残高", unit: "USD", remaining: overage / 1e6 });
	if (!metrics.length) throw new AccountUsageError("Devinから利用上限・残量のデータが返されませんでした。");
	return { account: text(user, 7) || text(user, 3) || undefined, plan: text(plan, 2) || undefined, metrics };
};
