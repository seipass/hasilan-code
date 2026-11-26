import { SessionManager } from "@hasilan-code/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { computeContextBreakdown } from "../src/server/context-breakdown.ts";
import { SessionUsage } from "../src/server/session-usage.ts";
import { aggregateDailyUsage } from "../src/shared/usage.ts";

describe("context breakdown and daily usage", () => {
	it("splits system, skills, mcp tools, messages, reserved and free tokens", () => {
		const manager = SessionManager.inMemory("/tmp/project");
		manager.appendMessage({
			role: "system",
			content:
				"Base instructions.\n<available_skills><skill name='a'>Do A</skill><skill name='b'>Do B</skill></available_skills>\n<mcp_instructions>Use GitHub MCP carefully.</mcp_instructions>",
			timestamp: Date.now(),
		});
		manager.appendMessage({
			role: "user",
			content: "Please inspect src/app.ts and explain the layout.",
			timestamp: Date.now(),
		});
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Here is the analysis of src/app.ts." }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: {
				input: 1000,
				output: 200,
				cacheRead: 400,
				cacheWrite: 0,
				totalTokens: 1600,
				cost: { input: 0.01, output: 0.01, cacheRead: 0.001, cacheWrite: 0, total: 0.021 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const breakdown = computeContextBreakdown({
			manager,
			contextWindow: 100_000,
			reportedTotalTokens: 1600,
			reserveTokens: 16_384,
			maxContextTokens: 96_000,
			activeTools: [
				{ name: "read", description: "Read file", parameters: { type: "object" } },
				{ name: "mcp__github__list_prs", description: "List pull requests", parameters: { type: "object" } },
			],
		});

		expect(breakdown.contextWindow).toBe(100_000);
		expect(breakdown.totalTokens).toBe(1600);
		expect(breakdown.skillsCount).toBe(2);
		expect(breakdown.skillsTokens).toBeGreaterThan(0);
		expect(breakdown.mcpTokens).toBeGreaterThan(0);
		expect(breakdown.mcpServers).toEqual([{ name: "github", tokens: expect.any(Number) }]);
		expect(breakdown.mcpInstructionsTokens).toBeGreaterThan(0);
		expect(breakdown.messageCount).toBe(2);
		expect(breakdown.messageSegments).toHaveLength(2);
		expect(breakdown.reservedTokens).toBe(16_384);
		expect(breakdown.freeTokens).toBe(100_000 - 1600 - 16_384);
		expect(breakdown.untilAutoCompact).toBe(100_000 - 16_384 - 1600);
	});

	it("tracks daily usage buckets and recent window totals from session entries", () => {
		const manager = SessionManager.inMemory("/tmp/project");
		const now = Date.now();
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "First reply" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: {
				input: 500,
				output: 100,
				cacheRead: 300,
				cacheWrite: 0,
				totalTokens: 900,
				cost: { input: 0.01, output: 0.01, cacheRead: 0.002, cacheWrite: 0, total: 0.022 },
			},
			stopReason: "stop",
			timestamp: now,
		});
		const usage = new SessionUsage(manager);
		const daily = usage.dailySnapshot();
		expect(daily).toHaveLength(1);
		expect(daily[0].totalTokens).toBe(900);
		expect(daily[0].cachedTokens).toBe(300);
		expect(daily[0].cost).toBeCloseTo(0.022, 6);

		const merged = aggregateDailyUsage([
			daily,
			[{ date: daily[0].date, totalTokens: 100, cachedTokens: 50, cost: 0.01, responses: 1 }],
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0].totalTokens).toBe(1000);
		expect(merged[0].cachedTokens).toBe(350);

		const recent = usage.windowTokens(now - 60_000);
		expect(recent.totalTokens).toBe(900);
		expect(recent.byModel.size).toBe(1);
	});
});
