import { afterEach, expect, it, vi } from "vitest";
import { GithubDashboardReader } from "../src/server/github-dashboard.ts";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:util", () => ({ promisify: () => execute }));

afterEach(() => {
	execute.mockReset();
	vi.restoreAllMocks();
});

it("shares pending requests and caches a validated contribution calendar and pull requests", async () => {
	execute.mockResolvedValue({
		stdout: JSON.stringify({
			data: {
				viewer: {
					login: "example",
					url: "https://github.com/example",
					contributionsCollection: {
						contributionCalendar: {
							totalContributions: 3,
							weeks: [
								{
									contributionDays: [
										{ date: "2026-11-08", contributionCount: 3, contributionLevel: "THIRD_QUARTILE" },
									],
								},
							],
						},
					},
					pullRequests: {
						totalCount: 1,
						nodes: [
							{
								title: "Update",
								url: "https://github.com/example/repo/pull/1",
								number: 1,
								isDraft: false,
								updatedAt: "2026-11-08T00:00:00Z",
								reviewDecision: null,
								repository: { nameWithOwner: "example/repo" },
							},
						],
					},
				},
			},
		}),
	});
	const reader = new GithubDashboardReader();
	const [first, second] = await Promise.all([reader.read(), reader.read()]);
	expect(first).toBe(second);
	expect(first).toMatchObject({
		state: "ready",
		contributions: { total: 3, weeks: [[{ count: 3, level: 3 }]] },
		pullRequests: [{ repository: "example/repo", number: 1 }],
	});
	expect(await reader.read()).toBe(first);
	expect(execute).toHaveBeenCalledTimes(1);
});

it("returns an unavailable state without exposing command errors or credentials", async () => {
	execute.mockRejectedValue(new Error("secret token"));
	const result = await new GithubDashboardReader().read();
	expect(result.state).toBe("unavailable");
	expect(JSON.stringify(result)).not.toContain("secret token");
});

it("rejects malformed upstream results instead of displaying invented counts", async () => {
	execute.mockResolvedValue({ stdout: '{"data":{"viewer":null}}' });
	expect((await new GithubDashboardReader().read()).state).toBe("unavailable");
});
