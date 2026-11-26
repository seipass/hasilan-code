import { useEffect, useState } from "react";
import type { GithubDashboard } from "../shared/home-dashboard.ts";
import { GITHUB_DASHBOARD_ID } from "../shared/plugin-profile.ts";
import { aggregateUsage, cacheReadPercent, type DailyUsagePoint } from "../shared/usage.ts";
import { api } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { usePluginProfile } from "./plugins/profile.tsx";
import { sessionRecency } from "./session-recency.ts";
import { TokenUsageChart } from "./TokenUsageChart.tsx";
import type { SessionSummary, Workspace } from "./types.ts";
import { UsagePanel } from "./UsagePanel.tsx";
import { workspaceLabel } from "./workspace-label.ts";
import "./HomeDashboard.css";

const count = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });
const cost = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 3 });

export function HomeDashboard({ sessions, workspaces, onSession }: { sessions: SessionSummary[]; workspaces: Workspace[]; onSession: (id: string) => void }) {
	const githubEnabled = usePluginProfile()?.activeIds.includes(GITHUB_DASHBOARD_ID) ?? false;
	const [github, setGithub] = useState<GithubDashboard>();
	const [refresh, setRefresh] = useState(0);
	const [dailyUsage, setDailyUsage] = useState<DailyUsagePoint[]>([]);
	const [dailyLoading, setDailyLoading] = useState(true);
	useEffect(() => {
		const controller = new AbortController();
		setDailyLoading(true);
		void api<{ days: DailyUsagePoint[] }>("/api/usage/daily", { signal: controller.signal })
			.then((value) => { if (!controller.signal.aborted) setDailyUsage(value.days); })
			.catch(() => { if (!controller.signal.aborted) setDailyUsage([]); })
			.finally(() => { if (!controller.signal.aborted) setDailyLoading(false); });
		return () => controller.abort();
	}, [sessions.length]);
	useEffect(() => {
		if (!githubEnabled) return;
		const controller = new AbortController();
		setGithub(undefined);
		void api<GithubDashboard>("/api/home/github", { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setGithub(value); }).catch(() => {
			if (!controller.signal.aborted) setGithub({ state: "unavailable", message: "GitHubの情報を取得できませんでした。", checkedAt: new Date().toISOString() });
		});
		return () => controller.abort();
	}, [githubEnabled, refresh]);
	const recent = sessions.filter((session) => !session.parentSessionId).sort((a, b) => (b.currentRun?.startedAt ?? b.latestRun?.settledAt ?? b.latestRun?.startedAt ?? "").localeCompare(a.currentRun?.startedAt ?? a.latestRun?.settledAt ?? a.latestRun?.startedAt ?? "")).slice(0, 4);
	const usage = aggregateUsage(sessions.map((session) => session.usage ?? []));
	const total = usage.reduce((sum, model) => ({ cost: sum.cost + model.cost, responses: sum.responses + model.responses, input: sum.input + model.input, cacheRead: sum.cacheRead + model.cacheRead, cacheWrite: sum.cacheWrite + model.cacheWrite }), { cost: 0, responses: 0, input: 0, cacheRead: 0, cacheWrite: 0 });
	const hit = cacheReadPercent(total);
	const unpriced = usage.some((model) => model.provider === "devin");
	return <div className="home-dashboard" data-github={githubEnabled} aria-label="ホームのウィジェット">
		{githubEnabled && <section className="home-card home-contributions" aria-label="GitHubのコントリビューション">
			<header><span className="home-card-heading"><Icon name="graph" />GitHub</span>{github?.login ? <a href={github.profileUrl} target="_blank" rel="noreferrer">@{github.login}<Icon name="arrowUpRight" size="inline" /></a> : <button type="button" className="home-card-action" aria-label="GitHubを再読み込み" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" size="inline" /></button>}</header>
			{github?.state === "ready" && github.contributions ? <>
				<div className="home-contribution-total"><strong>{github.contributions.total.toLocaleString("ja-JP")}</strong><span>contributions in the last year</span></div>
				<div className="home-contribution-scroll"><div className="home-contribution-grid" role="img" aria-label={`過去1年のGitHubコントリビューション ${github.contributions.total.toLocaleString("ja-JP")}件`}>{github.contributions.weeks.map((week) => <div className="home-contribution-week" key={week[0]?.date}>{week.map((day) => <span key={day.date} data-level={day.level} title={`${day.date} · ${day.count} contributions`} />)}</div>)}</div></div>
				<footer><span>過去1年間</span><span className="home-contribution-legend">Less{[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}More</span></footer>
			</> : <div className="home-card-empty"><Icon name="graph" size="chrome" /><p>{github ? github.message : "GitHubの活動を読み込み中…"}</p></div>}
		</section>}
		<section className="home-card home-recent" aria-label="Recent sessions"><header><span className="home-card-heading"><Icon name="list" />Recent sessions</span><span className="home-card-count">{recent.length}</span></header>
			<div className="home-recent-list">{recent.map((session) => {
				const folder = workspaces.find((entry) => entry.workspaceId === session.workspaceId);
				const date = session.currentRun?.startedAt ?? session.latestRun?.settledAt ?? session.latestRun?.startedAt;
				return <button type="button" key={session.sessionId} onClick={() => onSession(session.sessionId)} title={session.title ?? "新しい会話"}><span className={`home-session-dot${session.currentRun ? " is-active" : ""}`} /><span><strong>{session.title ?? "新しい会話"}</strong><small>{folder ? workspaceLabel(folder.path, workspaces.map((workspace) => workspace.path)) : "会話"} · {sessionRecency(date)}</small></span><Icon name="chevronRight" size="inline" /></button>;
			})}{!recent.length && <p className="home-inline-empty">最初の会話を始めましょう。</p>}</div>
		</section>
		<section className="home-card home-usage" aria-label="Usage"><header><span className="home-card-heading"><Icon name="gauge" />Usage</span><span className="home-card-label">全ワークスペース</span></header>
			<div className="home-usage-total">{cost.format(total.cost)}{unpriced && <small>一部未計測</small>}</div>
			<dl><div><dt>応答</dt><dd>{count.format(total.responses)}</dd></div><div><dt>キャッシュヒット</dt><dd>{hit === null ? "—" : `${hit.toFixed(1)}%`}</dd></div></dl>
			<UsagePanel title="ホームの使用量" groups={[{ id: "home", label: "全体", usage }]} trigger={<span>モデル別の内訳<Icon name="arrowUpRight" size="inline" /></span>} />
		</section>
		{githubEnabled && <section className="home-card home-pulls" aria-label="Pull requests"><header><span className="home-card-heading"><Icon name="graph" />Pull requests</span><span className="home-card-label">自分の未完了PR{github?.pullRequestCount !== undefined && ` · ${github.pullRequestCount}`}</span></header>
			{github?.state === "ready" ? <div className="home-pull-list">{github.pullRequests?.map((pr) => <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer"><span className={`home-pr-icon${pr.draft ? " is-draft" : ""}`}><Icon name="graph" /></span><span><strong>{pr.title}</strong><small>{pr.repository} #{pr.number} · {pr.draft ? "Draft" : pr.review === "APPROVED" ? "Approved" : pr.review === "CHANGES_REQUESTED" ? "Changes requested" : "Open"} · {sessionRecency(pr.updatedAt)}</small></span><Icon name="arrowUpRight" size="inline" /></a>)}{!github.pullRequests?.length && <p className="home-inline-empty">未完了のPull requestはありません。</p>}</div> : <p className="home-inline-empty">{github ? github.message : "Pull requestsを読み込み中…"}</p>}
		</section>}
		<section className="home-card home-token-usage" aria-label="Token usage"><header><span className="home-card-heading"><Icon name="gauge" />Token usage</span><span className="home-card-label">日別推移</span></header>
			<TokenUsageChart days={dailyUsage} loading={dailyLoading} unpriced={unpriced} />
		</section>
	</div>;
}
