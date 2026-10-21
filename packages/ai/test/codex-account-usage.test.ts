import { expect, it } from "vitest";
import { codexAccountUsage } from "../src/providers/account-usage/codex.ts";

it("returns subscription usage when the account has no code-review allowance", async () => {
	const usage = await codexAccountUsage({
		auth: { apiKey: "test-access-token" },
		authType: "oauth",
		signal: new AbortController().signal,
		fetch: async () =>
			Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 37, limit_window_seconds: 18000, reset_at: 1900000000 },
					secondary_window: null,
				},
				code_review_rate_limit: null,
				credits: { has_credits: false, unlimited: false, balance: "0" },
			}),
	});

	expect(usage).toEqual({
		plan: "plus",
		metrics: [{ id: "primary", label: "5時間", usedPercent: 37, resetsAt: 1900000000000 }],
	});
});
