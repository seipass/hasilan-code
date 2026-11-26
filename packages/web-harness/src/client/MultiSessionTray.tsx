import { useEffect, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Presence } from "./Motion.tsx";
import type { SessionSummary } from "./types.ts";
import "./MultiSessionTray.css";

function formatSessionDuration(startedAt?: string, settledAt?: string, nowMs?: number): string {
	if (!startedAt) return "";
	const start = Date.parse(startedAt);
	const end = settledAt ? Date.parse(settledAt) : (nowMs ?? Date.now());
	if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
	const sec = Math.max(0, Math.round((end - start) / 1000));
	if (sec < 60) return "<1m";
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

function sessionStateKind(session: SessionSummary): "working" | "done" | "failed" | "idle" {
	if (session.currentRun) return "working";
	if (session.latestRun?.status === "failed" || session.latestRun?.status === "interrupted") return "failed";
	if (session.latestRun?.status === "completed") return "done";
	return "idle";
}

export function MultiSessionTray({
	sessions,
	activeSessionId,
	onSelect,
}: {
	sessions: readonly SessionSummary[];
	activeSessionId?: string;
	onSelect: (sessionId: string) => void;
}) {
	const [expanded, setExpanded] = useState(true);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const hasWorking = sessions.some((session) => !!session.currentRun);

	useEffect(() => {
		if (!hasWorking) return;
		const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [hasWorking]);

	if (sessions.length < 2) return null;

	const workingCount = sessions.filter((session) => !!session.currentRun).length;
	const latestDone = [...sessions]
		.filter((session) => !session.currentRun && session.latestRun?.status === "completed")
		.sort((a, b) => String(b.latestRun?.settledAt ?? "").localeCompare(String(a.latestRun?.settledAt ?? "")))[0];

	return (
		<section className="composer-dock-tray mst-tray" aria-label="並列セッション">
			<button
				type="button"
				className="composer-dock-tray-header mst-header"
				aria-expanded={expanded}
				onClick={() => setExpanded((value) => !value)}
			>
				<span className="mst-glyphs" aria-hidden="true">
					{sessions.map((session) => {
						const kind = sessionStateKind(session);
						return (
							<span key={session.sessionId} className={`mst-mini-glyph is-${kind}`}>
								{kind === "done" && <Icon name="check" size="inline" />}
								{kind === "failed" && <Icon name="close" size="inline" />}
							</span>
						);
					})}
				</span>
				<strong className="mst-count">{sessions.length} セッション</strong>
				{workingCount > 0 ? (
					<span className="mst-summary">{workingCount} 件実行中</span>
				) : latestDone ? (
					<span className="mst-summary is-done">
						{(latestDone.title ?? "セッション").slice(0, 32)}: 完了
					</span>
				) : null}
				<span className="mst-chevron">
					<Icon name={expanded ? "chevronDown" : "chevronUp"} size="inline" />
				</span>
			</button>
			<Presence show={expanded} collapse>
				<div className="composer-dock-tray-body mst-list" role="list">
					{sessions.map((session) => {
						const kind = sessionStateKind(session);
						const active = session.sessionId === activeSessionId;
						const title = (session.title ?? "新しい会話").replace(/\s+/g, " ").slice(0, 56);
						const duration = formatSessionDuration(
							session.currentRun?.startedAt ?? session.latestRun?.startedAt,
							session.currentRun ? undefined : session.latestRun?.settledAt,
							nowMs,
						);
						const activity = session.currentRun
							? session.activeActivity ?? "作業中…"
							: kind === "done"
								? `完了${session.changedFileCount ? ` · ${session.changedFileCount} ファイル変更` : ""}`
								: kind === "failed"
									? "失敗"
									: "待機中";
						return (
							<button
								key={session.sessionId}
								type="button"
								role="listitem"
								className={`mst-row${active ? " is-active" : ""}`}
								aria-current={active ? "page" : undefined}
								onClick={() => onSelect(session.sessionId)}
							>
								<span className={`mst-row-glyph is-${kind}`} aria-hidden="true">
									{kind === "done" && <Icon name="check" size="inline" />}
									{kind === "failed" && <Icon name="close" size="inline" />}
								</span>
								<span className="mst-row-title">{title}</span>
								{session.splitBranch && <code className="mst-row-branch">{session.splitBranch}</code>}
								<span className={`mst-row-activity is-${kind}`}>{activity}</span>
								{duration && <span className="mst-row-duration">{duration}</span>}
							</button>
						);
					})}
				</div>
			</Presence>
		</section>
	);
}
