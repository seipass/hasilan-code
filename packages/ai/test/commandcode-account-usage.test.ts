import { expect, it } from "vitest";
import { commandCodeAccountUsage } from "../src/providers/account-usage/commandcode.ts";

it("uses the API-key billing endpoints for Command Code usage", async () => {
	const paths: string[] = [];
	const usage = await commandCodeAccountUsage({
		auth: { apiKey: "test-key" },
		authType: "api_key",
		signal: new AbortController().signal,
		fetch: async (input) => {
			const url = String(input);
			paths.push(new URL(url).pathname);
			if (!url.includes("/alpha/billing/")) return new Response("", { status: 401 });
			return Response.json(
				url.endsWith("/credits") ? { credits: { monthlyCredits: 10 } } : { success: true, data: null },
			);
		},
	});
	expect(paths.sort()).toEqual(["/alpha/billing/credits", "/alpha/billing/subscriptions"]);
	expect(usage?.metrics[0].remaining).toBe(10);
});
