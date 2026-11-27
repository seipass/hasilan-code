import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceGitSummary } from "../shared/pr-lifecycle.ts";
import { record } from "./Content.tsx";
import { fileChanges } from "./file-changes.ts";
import { FileIcon } from "./files/FileIcon.tsx";
import { Icon } from "./Icon.tsx";
import { userText } from "./MessageActions.tsx";
import { usePreferenceState } from "./preferences.ts";
import type { ChatMessage, SessionDetail, TeamAgent, TeamSnapshot } from "./types.ts";
import { workspaceLabel } from "./workspace-label.ts";
import "./SessionOverview.css";

type Source = { kind: "file"; path: string; label: string } | { kind: "link"; url: string; label: string };

const INITIAL_FILES = 5;
const INITIAL_AGENTS = 4;
const INITIAL_SOURCES = 4;

function sessionSources(messages: ChatMessage[]): Source[] {
	const sources = new Map<string, Source>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user" || message.contextInjection || message.importedContext) continue;
		if (Array.isArray(message.content)) {
			for (const part of message.content as unknown[]) {
				if (record(part) && part.type === "fileAttachment" && typeof part.name === "string" &&
					typeof part.path === "string" && part.path.startsWith(".hasilan-code/attachments/") && !sources.has(part.path)) {
					sources.set(part.path, { kind: "file", path: part.path, label: part.name });
				}
			}
		}
		for (const match of (userText(message) ?? "").matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
			let url: URL;
			try { url = new URL(match[0].replace(/[.,;!?。，、）」』)\]}]+$/u, "")); }
			catch { continue; }
			if (url.username || url.password || sources.has(url.href)) continue;
			sources.set(url.href, { kind: "link", url: url.href, label: `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}` });
		}
	}
	return [...sources.values()];
}

function splitFilePath(path: string): { name: string; parent: string } {
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	const name = parts.at(-1) ?? normalized;
	const parent = parts.length >= 2 ? parts.at(-2) ?? "" : "";
	return { name, parent };
}

function agentStatus(agent: TeamAgent): { tone: "running" | "completed" | "failed" | "idle"; label: string } {
	if (agent.currentRun) return { tone: "running", label: "実行中" };
	if (agent.latestRun?.status === "completed") return { tone: "completed", label: "完了" };
	if (agent.latestRun?.status === "failed" || agent.latestRun?.status === "interrupted") return { tone: "failed", label: "失敗" };
	return { tone: "idle", label: "待機中" };
}

export function SessionOverview({ width, session, team, gitSummary, onFile, onSession, onAttach, attachDisabled, onReview }: {
	width: number;
	session: SessionDetail;
	team?: TeamSnapshot;
	gitSummary?: WorkspaceGitSummary;
	onFile: (path: string) => void;
	onSession: (id: string) => void;
	onAttach: () => void;
	attachDisabled: boolean;
	onReview?: () => void;
}) {
	const [collapsed, setCollapsed] = usePreferenceState("pi-web-session-overview-collapsed", false);
	const [allFiles, setAllFiles] = useState(false);
	const [allAgents, setAllAgents] = useState(false);
	const [allSources, setAllSources] = useState(false);
	const [copiedPath, setCopiedPath] = useState(false);
	const copyTimer = useRef<number | undefined>(undefined);
	useEffect(() => () => { if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current); }, []);

	const changes = useMemo(() => fileChanges(session.toolCalls), [session.toolCalls]);
	const duplicateNames = useMemo(() => {
		const counts = new Map<string, number>();
		for (const file of changes) {
			const { name } = splitFilePath(file.path);
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
	}, [changes]);
	const sources = useMemo(() => sessionSources(session.messages), [session.messages]);
	const selected = team?.agents.find((agent) => agent.sessionId === session.sessionId);
	const agents = selected ? team?.agents.filter((agent) => agent.teamId === selected.teamId && agent.parentAgentId && agent.sessionId !== session.sessionId) ?? [] : [];
	const completed = agents.filter((agent) => !agent.currentRun && agent.latestRun?.status === "completed").length;
	const active = agents.filter((agent) => agent.currentRun).length;
	const added = changes.reduce((total, file) => total + file.added, 0);
	const removed = changes.reduce((total, file) => total + file.removed, 0);
	const hasTruncated = changes.some((file) => file.truncated);
	const workspaceName = workspaceLabel(session.cwd, []);
	const branch = gitSummary?.branch ?? session.splitBranch;
	const hasGitChanges = !!gitSummary?.isGitRepo && (gitSummary.filesChanged > 0 || gitSummary.additions > 0 || gitSummary.deletions > 0);
	const aheadCommits = gitSummary?.aheadCommits ?? 0;
	const openPr = gitSummary?.openPr;

	async function copyWorkspacePath() {
		if (!navigator.clipboard?.writeText) return;
		try {
			await navigator.clipboard.writeText(session.cwd);
			setCopiedPath(true);
			if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
			copyTimer.current = window.setTimeout(() => { setCopiedPath(false); copyTimer.current = undefined; }, 1600);
		} catch { /* Clipboard permission denied or unavailable. */ }
	}

	if (collapsed) {
		return <aside className="session-overview is-collapsed" aria-label="会話の概要">
			<button type="button" className="session-overview-pill" aria-expanded={false} aria-label="会話の概要を開く" title={`${workspaceName} · 会話の概要を開く`} onClick={() => setCollapsed(false)}>
				<Icon name="chevronLeft" size="inline" />
				{hasGitChanges && gitSummary
					? <span className="session-overview-count"><span>+{gitSummary.additions.toLocaleString("ja-JP")}</span> <span>−{gitSummary.deletions.toLocaleString("ja-JP")}</span></span>
					: changes.length > 0
						? <span className="session-overview-count"><span>+{added.toLocaleString("ja-JP")}</span> <span>−{removed.toLocaleString("ja-JP")}</span></span>
						: active > 0
							? <><span className="session-overview-dot" data-status="running" aria-hidden="true" /><span>{active}件実行中</span></>
							: <><Icon name="folder" size="inline" /><span>{workspaceName}</span></>}
			</button>
		</aside>;
	}

	const shownFiles = allFiles ? changes : changes.slice(0, INITIAL_FILES);
	const shownAgents = allAgents ? agents : agents.slice(0, INITIAL_AGENTS);
	const shownSources = allSources ? sources : sources.slice(0, INITIAL_SOURCES);

	return <aside className="session-overview" aria-label="会話の概要" style={{ width: Math.min(256, width) }}>
		<header className="session-overview-header">
			<div className="session-overview-header-top">
				<button type="button" className={`session-overview-workspace${copiedPath ? " is-copied" : ""}`} title={copiedPath ? "パスをコピーしました" : `${session.cwd}\nクリックしてパスをコピー`} aria-label={copiedPath ? "パスをコピーしました" : `${workspaceName} のパスをコピー`} onClick={() => { void copyWorkspacePath(); }}>
					<Icon name="folder" size="inline" />
					<span className="session-overview-workspace-name">{workspaceName}</span>
					<Icon name={copiedPath ? "check" : "copy"} size="inline" className="session-overview-copy-icon" />
				</button>
				<button type="button" className="session-overview-icon-btn" aria-expanded={true} aria-label="会話の概要を折りたたむ" title="折りたたむ" onClick={() => setCollapsed(true)}>
					<Icon name="chevronRight" size="inline" />
				</button>
			</div>
			{(branch || openPr) && <div className="session-overview-git-meta">
				{branch && <span className="session-overview-branch" title={branch}>
					<Icon name="gitBranch" size="inline" />
					<code>{branch}</code>
					{aheadCommits > 0 && <span className="session-overview-ahead" title={`未プッシュ ${aheadCommits} コミット`}>↑{aheadCommits}</span>}
				</span>}
				{openPr && <a className="session-overview-pr" href={openPr.url} target="_blank" rel="noopener noreferrer" title={`PR #${openPr.number}: ${openPr.title}`}>
					<Icon name="gitPr" size="inline" />
					<span>#{openPr.number}</span>
				</a>}
			</div>}
		</header>

		{(onReview || changes.length > 0) && <section className="session-overview-section" aria-label="変更">
			{onReview && <button type="button" className={`session-overview-row session-overview-review${hasGitChanges ? " has-changes" : ""}`} title={hasGitChanges && gitSummary ? `${gitSummary.filesChanged} ファイルに変更あり` : "差分を確認・レビュー"} onClick={onReview}>
				<Icon name="pencil" size="inline" />
				<span className="session-overview-row-label">変更をレビュー</span>
				{hasGitChanges && gitSummary
					? <span className="session-overview-count"><span>+{gitSummary.additions.toLocaleString("ja-JP")}</span> <span>−{gitSummary.deletions.toLocaleString("ja-JP")}</span></span>
					: gitSummary?.isGitRepo
						? <span className="session-overview-muted">差分なし</span>
						: <Icon name="chevronRight" size="inline" className="session-overview-row-chevron" />}
			</button>}
			{changes.length > 0 && <div className="session-overview-files">
				<div className="session-overview-section-head">
					<span>編集したファイル <span className="session-overview-badge">{changes.length}</span></span>
					<span className="session-overview-count" title="読み込み済み履歴に記録された変更">
						<span>+{added.toLocaleString("ja-JP")}</span> <span>−{removed.toLocaleString("ja-JP")}</span>{hasTruncated && "+"}
					</span>
				</div>
				<ul>
					{shownFiles.map((file) => {
						const { name, parent } = splitFilePath(file.path);
						const disambiguate = duplicateNames.has(name) && parent;
						return <li key={file.path}>
							<button type="button" className="session-overview-row session-overview-file-row" title={`${file.path}（+${file.added} −${file.removed}）`} onClick={() => onFile(file.path)}>
								<FileIcon name={name} />
								<span className="session-overview-file-label">
									<span className="session-overview-file-name">{name}</span>
									{disambiguate && <span className="session-overview-file-dir">{parent}</span>}
								</span>
								<span className="session-overview-count"><span>+{file.added}</span> <span>−{file.removed}</span></span>
							</button>
						</li>;
					})}
				</ul>
				{changes.length > INITIAL_FILES && <button type="button" className="session-overview-row session-overview-more" aria-expanded={allFiles} onClick={() => setAllFiles(!allFiles)}>
					<Icon name={allFiles ? "chevronDown" : "chevronRight"} size="inline" />
					<span className="session-overview-row-label">{allFiles ? "折りたたむ" : `すべて表示（${changes.length}件）`}</span>
				</button>}
			</div>}
		</section>}

		{agents.length > 0 && <section className="session-overview-section" aria-label="サブエージェント">
			<div className="session-overview-section-head">
				<span>サブエージェント</span>
				<span className={`session-overview-agent-summary${active > 0 ? " is-active" : ""}`}>
					{active > 0 ? `${active}件実行中` : `${completed}/${agents.length}完了`}
				</span>
			</div>
			<ul>
				{shownAgents.map((agent) => {
					const status = agentStatus(agent);
					return <li key={agent.agentId}>
						<button type="button" className="session-overview-row" title={`${agent.name}（${status.label}）`} onClick={() => onSession(agent.sessionId)}>
							<span className="session-overview-dot" data-status={status.tone} aria-hidden="true" />
							<span className="session-overview-row-label">{agent.name}</span>
							<Icon name="chevronRight" size="inline" className="session-overview-row-chevron" />
						</button>
					</li>;
				})}
			</ul>
			{agents.length > INITIAL_AGENTS && <button type="button" className="session-overview-row session-overview-more" aria-expanded={allAgents} onClick={() => setAllAgents(!allAgents)}>
				<Icon name={allAgents ? "chevronDown" : "chevronRight"} size="inline" />
				<span className="session-overview-row-label">{allAgents ? "折りたたむ" : `すべて表示（${agents.length}件）`}</span>
			</button>}
		</section>}

		<section className="session-overview-section session-overview-sources" aria-label="ソース">
			<div className="session-overview-section-head">
				<span>ソース{sources.length > 0 && <span className="session-overview-badge">{sources.length}</span>}</span>
				{sources.length > 0 && <button type="button" className="session-overview-icon-btn" title="ファイルを添付" aria-label="ファイルを添付" disabled={attachDisabled} onClick={onAttach}>
					<Icon name="plus" size="inline" />
				</button>}
			</div>
			{sources.length === 0
				? <button type="button" className="session-overview-row session-overview-attach-row" disabled={attachDisabled} onClick={onAttach}>
					<Icon name="plus" size="inline" />
					<span className="session-overview-row-label">ファイルを添付</span>
				</button>
				: <>
					<ul>
						{shownSources.map((source) => source.kind === "file"
							? <li key={source.path}>
								<button type="button" className="session-overview-row" title={source.label} onClick={() => onFile(source.path)}>
									<FileIcon name={source.label} />
									<span className="session-overview-row-label">{source.label}</span>
								</button>
							</li>
							: <li key={source.url}>
								<a className="session-overview-row" href={source.url} title={source.url} target="_blank" rel="noopener noreferrer">
									<Icon name="external" size="inline" />
									<span className="session-overview-row-label">{source.label}</span>
								</a>
							</li>)}
					</ul>
					{sources.length > INITIAL_SOURCES && <button type="button" className="session-overview-row session-overview-more" aria-expanded={allSources} onClick={() => setAllSources(!allSources)}>
						<Icon name={allSources ? "chevronDown" : "chevronRight"} size="inline" />
						<span className="session-overview-row-label">{allSources ? "折りたたむ" : `すべて表示（${sources.length}件）`}</span>
					</button>}
				</>}
		</section>
	</aside>;
}
