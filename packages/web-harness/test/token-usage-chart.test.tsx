import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextWindowPopover } from "../src/client/ContextWindowPopover.tsx";
import { TokenUsageChart } from "../src/client/TokenUsageChart.tsx";

describe("TokenUsageChart and ContextWindowPopover rendering", () => {
	it("renders dual-series stepped chart and KPI totals", () => {
		const html = renderToStaticMarkup(
			<TokenUsageChart
				days={[
					{ date: "2026-10-01", totalTokens: 1_200_000, cachedTokens: 600_000, cost: 4.5, responses: 12 },
					{ date: "2026-10-02", totalTokens: 2_400_000, cachedTokens: 1_500_000, cost: 8.25, responses: 20 },
				]}
			/>,
		);
		expect(html).toContain("token-usage-svg");
		expect(html).toContain("3.60 M");
		expect(html).toContain("$12.75");
		expect(html).toContain("token-usage-line is-total");
		expect(html).toContain("token-usage-line is-cached");
	});

	it("renders context gauge trigger with percentage tooltip", () => {
		const html = renderToStaticMarkup(
			<ContextWindowPopover
				contextWindow={200_000}
				session={{
					sessionId: "s1",
					workspaceId: "w1",
					cwd: "/tmp/project",
					materialized: true,
					availability: "ready",
					pendingInput: [],
					messages: [],
					toolCalls: [],
					activity: {},
					contextUsage: { tokens: 120_000, contextWindow: 200_000, percent: 60 },
					contextBreakdown: {
						contextWindow: 200_000,
						autoCompactThreshold: 180_000,
						totalTokens: 120_000,
						percent: 60,
						systemTokens: 10_000,
						mcpTokens: 5_000,
						mcpServers: [{ name: "github", tokens: 4_000 }],
						mcpInstructionsTokens: 1_000,
						skillsTokens: 2_000,
						skillsCount: 2,
						messagesTokens: 103_000,
						messageCount: 14,
						messageSegments: [20_000, 30_000, 53_000],
						reservedTokens: 20_000,
						freeTokens: 60_000,
						untilAutoCompact: 60_000,
					},
				}}
			/>,
		);
		expect(html).toContain("cw-trigger");
		expect(html).toContain("60%");
		expect(html).toContain("120.0k");
	});
});
