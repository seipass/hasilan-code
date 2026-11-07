import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { GithubDashboard } from "../shared/home-dashboard.ts";

const execute = promisify(execFile);
const query = `query {
	viewer {
		login url
		contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount contributionLevel } } } }
		pullRequests(first: 6, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
			totalCount nodes { title url number isDraft updatedAt reviewDecision repository { nameWithOwner } }
		}
	}
}`;
const levels = ["NONE", "FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"] as const;
const schema = Type.Object({
	data: Type.Object({
		viewer: Type.Object({
			login: Type.String(),
			url: Type.String(),
			contributionsCollection: Type.Object({
				contributionCalendar: Type.Object({
					totalContributions: Type.Number(),
					weeks: Type.Array(
						Type.Object({
							contributionDays: Type.Array(
								Type.Object({
									date: Type.String(),
									contributionCount: Type.Number(),
									contributionLevel: Type.Union(levels.map((level) => Type.Literal(level))),
								}),
							),
						}),
					),
				}),
			}),
			pullRequests: Type.Object({
				totalCount: Type.Number(),
				nodes: Type.Array(
					Type.Object({
						title: Type.String(),
						url: Type.String(),
						number: Type.Number(),
						isDraft: Type.Boolean(),
						updatedAt: Type.String(),
						reviewDecision: Type.Union([Type.String(), Type.Null()]),
						repository: Type.Object({ nameWithOwner: Type.String() }),
					}),
				),
			}),
		}),
	}),
});

/** Reads the existing gh login without exporting its credential to the browser. */
export class GithubDashboardReader {
	private cached?: GithubDashboard;
	private pending?: Promise<GithubDashboard>;

	read(): Promise<GithubDashboard> {
		const age = this.cached ? Date.now() - Date.parse(this.cached.checkedAt) : Infinity;
		if (this.cached && age < (this.cached.state === "ready" ? 300_000 : 30_000)) return Promise.resolve(this.cached);
		if (this.pending) return this.pending;
		this.pending = this.load()
			.then((value) => {
				this.cached = value;
				return value;
			})
			.finally(() => {
				this.pending = undefined;
			});
		return this.pending;
	}

	private async load(): Promise<GithubDashboard> {
		try {
			const { stdout } = await execute(
				"gh",
				["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`],
				{
					encoding: "utf8",
					windowsHide: true,
					timeout: 15_000,
					maxBuffer: 2 * 1024 * 1024,
					env: { ...process.env, GH_PROMPT_DISABLED: "1" },
				},
			);
			const parsed: unknown = JSON.parse(stdout);
			if (!Check(schema, parsed)) throw new Error("Unexpected GitHub response");
			const {
				data: { viewer },
			} = parsed;
			const calendar = viewer.contributionsCollection.contributionCalendar;
			return {
				state: "ready",
				login: viewer.login,
				profileUrl: viewer.url,
				contributions: {
					total: calendar.totalContributions,
					weeks: calendar.weeks.map((week) =>
						week.contributionDays.map((day) => ({
							date: day.date,
							count: day.contributionCount,
							level: levels.indexOf(day.contributionLevel),
						})),
					),
				},
				pullRequestCount: viewer.pullRequests.totalCount,
				pullRequests: viewer.pullRequests.nodes.map((pr) => ({
					title: pr.title,
					url: pr.url,
					number: pr.number,
					repository: pr.repository.nameWithOwner,
					draft: pr.isDraft,
					updatedAt: pr.updatedAt,
					review: pr.reviewDecision,
				})),
				checkedAt: new Date().toISOString(),
			};
		} catch {
			return {
				state: "unavailable",
				message:
					"GitHub CLIで gh auth login を実行すると表示できます。接続済みの場合は、認証状態とネットワークを確認してください。",
				checkedAt: new Date().toISOString(),
			};
		}
	}
}
