import { useMemo, useState } from "react";
import { record } from "./Content.tsx";
import { FileChanges } from "./FileChanges.tsx";
import { fileChanges } from "./file-changes.ts";
import { FileIcon } from "./files/FileIcon.tsx";
import { Icon } from "./Icon.tsx";
import { userText } from "./MessageActions.tsx";
import type { ChatMessage, SessionDetail, TeamSnapshot } from "./types.ts";
import { workspaceLabel } from "./workspace-label.ts";
import "./SessionOverview.css";

type Source = { kind: "file"; path: string; label: string } | { kind: "link"; url: string; label: string };

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

export function SessionOverview({ session, team, onFile, onSession, onAttach, attachDisabled }: {
	session: SessionDetail;
	team?: TeamSnapshot;
	onFile: (path: string) => void;
	onSession: (id: string) => void;
	onAttach: () => void;
	attachDisabled: boolean;
}) {
	const [allSources, setAllSources] = useState(false);
	const [showChanges, setShowChanges] = useState(false);
	const changes = useMemo(() => fileChanges(session.toolCalls), [session.toolCalls]);
	const sources = useMemo(() => sessionSources(session.messages), [session.messages]);
	const selected = team?.agents.find((agent) => agent.sessionId === session.sessionId);
	const agents = selected ? team?.agents.filter((agent) => agent.teamId === selected.teamId && agent.parentAgentId && agent.sessionId !== session.sessionId) ?? [] : [];
	const completed = agents.filter((agent) => !agent.currentRun && agent.latestRun?.status === "completed").length;
	const active = agents.filter((agent) => agent.currentRun).length;
	const added = changes.reduce((total, file) => total + file.added, 0);
	const removed = changes.reduce((total, file) => total + file.removed, 0);
	return <aside className="session-overview" aria-label="会話の概要">
		<header title={session.cwd}><Icon name="folder" size="inline" /><span>{workspaceLabel(session.cwd, [])}</span></header>
		{changes.length > 0 && <details className="session-overview-changes" onToggle={(event) => setShowChanges(event.currentTarget.open)}>
			<summary className="session-overview-row" title="読み込み済み履歴に記録された変更">
				<Icon name="pencil" size="inline" /><span>変更</span>
				<span className="session-overview-count"><span>+{added.toLocaleString("ja-JP")}</span> <span>−{removed.toLocaleString("ja-JP")}</span>{changes.some((file) => file.truncated) && " 以上"}</span>
			</summary>
			{showChanges && <FileChanges files={changes} />}
		</details>}
		{agents.length > 0 && <details className="session-overview-agents">
			<summary><span className="session-overview-label">サブエージェント</span>
				<span className="session-overview-row"><Icon name="graph" size="inline" /><span>{completed} / {agents.length} 件完了{active > 0 && ` · ${active} 件実行中`}</span><Icon name="chevronRight" size="inline" /></span>
			</summary>
			<ul>{agents.map((agent) => <li key={agent.agentId}><button className="session-overview-row" type="button" title={agent.name} onClick={() => onSession(agent.sessionId)}>
				<Icon name={agent.currentRun ? "graph" : agent.latestRun?.status === "completed" ? "check" : "chevronRight"} size="inline" /><span>{agent.name}</span>
			</button></li>)}</ul>
		</details>}
		<section className="session-overview-sources" aria-label="ソース">
			<div className="session-overview-label">ソース<button type="button" title="ファイルを添付" aria-label="ファイルを添付" disabled={attachDisabled} onClick={onAttach}><Icon name="plus" size="inline" /></button></div>
			{sources.length === 0 && <p>添付ファイルやリンクがここに表示されます。</p>}
			<ul>{(allSources ? sources : sources.slice(0, 3)).map((source) => source.kind === "file"
				? <li key={source.path}><button type="button" className="session-overview-row" title={source.label} onClick={() => onFile(source.path)}><FileIcon name={source.label} /><span>{source.label}</span></button></li>
				: <li key={source.url}><a className="session-overview-row" href={source.url} title={source.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size="inline" /><span>{source.label}</span></a></li>)}</ul>
			{sources.length > 3 && <button type="button" className="session-overview-row" aria-expanded={allSources} onClick={() => setAllSources(!allSources)}><Icon name={allSources ? "chevronDown" : "chevronRight"} size="inline" /><span>{allSources ? "折りたたむ" : `すべて表示（${sources.length}件）`}</span></button>}
		</section>
	</aside>;
}
