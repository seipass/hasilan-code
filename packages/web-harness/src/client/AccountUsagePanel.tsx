import { useEffect, useState } from "react";
import type { AccountUsageMetric } from "@hasilan-code/pi-ai";
import type { ProviderAccountUsageView } from "../shared/account-usage.ts";
import { api, errorMessage } from "./api.ts";
import "./AccountUsagePanel.css";

function amount(value: number, unit?: string): string {
	const formatted = value.toLocaleString("ja-JP", { maximumFractionDigits: 6 });
	return unit === "USD" ? `$${formatted}` : unit === "credits" ? `${formatted} クレジット` : `${formatted}${unit ? ` ${unit}` : ""}`;
}

function Metric({ metric }: { metric: AccountUsageMetric }) {
	const percent = metric.usedPercent !== undefined && Number.isFinite(metric.usedPercent) ? metric.usedPercent : undefined;
	const reset = metric.resetsAt === undefined ? undefined : new Date(metric.resetsAt);
	return <div className="account-usage-metric">
		<dt>{metric.label}</dt>
		<dd>
			{metric.unlimited ? <strong>無制限</strong> : <>
				{percent !== undefined && <><span className="account-usage-percent">{percent.toLocaleString("ja-JP", { maximumFractionDigits: 1 })}% 使用</span><progress aria-label={`${metric.label}の使用率`} max={100} value={Math.max(0, Math.min(100, percent))} /></>}
				<div className="account-usage-amounts">
					{metric.used !== undefined && <span>使用 {amount(metric.used, metric.unit)}</span>}
					{metric.limit !== undefined && <span>上限 {amount(metric.limit, metric.unit)}</span>}
					{metric.remaining !== undefined && <span>残り {amount(metric.remaining, metric.unit)}</span>}
				</div>
			</>}
			{reset && Number.isFinite(reset.getTime()) && <time className="account-usage-reset" dateTime={reset.toISOString()}>リセット {reset.toLocaleString("ja-JP")}</time>}
		</dd>
	</div>;
}

export function AccountUsagePanel() {
	const [entries, setEntries] = useState<ProviderAccountUsageView[]>();
	const [error, setError] = useState<string>();
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		setEntries(undefined);
		setError(undefined);
		void api<ProviderAccountUsageView[]>("/api/account-usage", { signal: controller.signal }).then((value) => {
			if (!controller.signal.aborted) setEntries(value);
		}).catch((reason: unknown) => {
			if (!controller.signal.aborted) setError(`使用量を読み込めませんでした。詳細: ${errorMessage(reason)}`);
		});
		return () => controller.abort();
	}, [attempt]);
	const loading = !entries && !error;
	return <div className="account-usage-panel" aria-busy={loading}>
		<div className="account-usage-toolbar"><h3>アカウントの使用量</h3><button type="button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>{loading ? "取得中…" : "更新"}</button></div>
		{error && <p className="error" role="alert">{error}</p>}
		{loading && <p role="status">接続中のプロバイダーから取得しています…</p>}
		{entries?.length === 0 && <p role="status">使用量の取得に対応したプロバイダーが接続されていません。</p>}
		{entries?.map((entry) => <article key={entry.provider} className="settings-section account-usage-card" aria-label={`${entry.name}の使用量`}>
			<header><h4>{entry.name}</h4>{entry.usage?.plan && <span className="account-usage-plan">{entry.usage.plan}</span>}</header>
			{entry.usage?.account && <p className="account-usage-account">{entry.usage.account}</p>}
			{entry.status === "error" && <p className="error" role="alert">{entry.error}</p>}
			{entry.status === "unsupported" && <p>現在の認証方式では使用量を取得できません。</p>}
			{entry.status === "ok" && entry.usage && <><dl>{entry.usage.metrics.map((metric) => <Metric key={metric.id} metric={metric} />)}</dl>{entry.usage.notices?.map((notice) => <p className="fine-print" key={notice}>{notice}</p>)}</>}
			<time className="account-usage-checked" dateTime={new Date(entry.checkedAt).toISOString()}>確認 {new Date(entry.checkedAt).toLocaleString("ja-JP")}</time>
		</article>)}
	</div>;
}
