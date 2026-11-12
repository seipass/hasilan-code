import { useEffect, useId, useRef, useState } from "react";
import { AGENT_CATEGORIES } from "../shared/agent-categories.ts";
import type { WorkDiff, WorkOverviewItem } from "../shared/work-overview.ts";
import { api, errorMessage } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { RUN_LABELS } from "./TeamPane.tsx";
import { workspaceLabel } from "./workspace-label.ts";
import "./WorkOverview.css";

const filters = { all: "すべて", running: "進行中", isolated: "分離した作業" } as const;
const worktreeLabels = { active: "分離中", adopted: "採用済み", discarded: "破棄済み" } as const;

export function WorkOverview({ onClose, onSession }: {
	onClose: () => void;
	onSession: (id: string, workspaceId: string) => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const title = useId();
	const [items, setItems] = useState<WorkOverviewItem[]>();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<keyof typeof filters>("all");
	const [selected, setSelected] = useState<string>();
	const [error, setError] = useState<string>();
	const [diff, setDiff] = useState<WorkDiff>();
	const [diffError, setDiffError] = useState<string>();
	useEffect(() => { dialog.current?.showModal(); }, []);
	useEffect(() => {
		const controller = new AbortController();
		let timer: number;
		async function refresh() {
			try {
				setItems(await api<WorkOverviewItem[]>("/api/work", { signal: controller.signal }));
				setError(undefined);
			} catch (reason) {
				if (!controller.signal.aborted) setError(errorMessage(reason));
			} finally {
				if (!controller.signal.aborted) timer = window.setTimeout(refresh, 4_000);
			}
		}
		void refresh();
		return () => { controller.abort(); window.clearTimeout(timer); };
	}, []);
	const item = items?.find((entry) => entry.sessionId === selected);
	const workspacePaths = [...new Set(items?.map((entry) => entry.workspacePath))];
	const running = item && ["queued", "running", "waiting", "cancelling"].includes(item.status);
	const diffId = item?.worktree && !running ? item.sessionId : undefined;
	useEffect(() => {
		setDiff(undefined);
		setDiffError(undefined);
		if (!diffId) return;
		const controller = new AbortController();
		void api<WorkDiff>(`/api/work/${encodeURIComponent(diffId)}/diff`, { signal: controller.signal }).then((value) => {
			if (!controller.signal.aborted) setDiff(value);
		}, (reason: unknown) => {
			if (!controller.signal.aborted) setDiffError(errorMessage(reason));
		});
		return () => controller.abort();
	}, [diffId, item?.worktree, item?.updatedAt]);
	const matching = items?.filter((entry) => {
		if (filter === "isolated" && !entry.worktree) return false;
		if (filter === "running" && !["queued", "running", "waiting", "cancelling"].includes(entry.status)) return false;
		return `${entry.name} ${entry.task ?? ""} ${entry.workspacePath}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
	});
	return <dialog className="work-overview" ref={dialog} aria-labelledby={title} onClose={onClose}>
		<header><h2 id={title}>作業一覧</h2><button type="button" onClick={() => dialog.current?.close()}>閉じる</button></header>
		<div className="work-overview-layout">
			<section className="work-overview-list" aria-label="ワークスペースの作業">
				<input type="search" placeholder="作業・ワークスペースを検索" aria-label="作業・ワークスペースを検索" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
				<div className="work-overview-filters">{Object.entries(filters).map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id as keyof typeof filters)}>{label}</button>)}</div>
				{error && <p role="alert">{error}</p>}
				{!items && !error && <p role="status">読み込み中…</p>}
				{matching?.length === 0 && <p>該当する作業がありません。</p>}
				<ul>{matching?.map((entry) => <li key={entry.sessionId}>
					<button type="button" aria-pressed={entry.sessionId === selected} onClick={() => setSelected(entry.sessionId)}>
						<strong>{entry.name}</strong><span>{workspaceLabel(entry.workspacePath, workspacePaths)} · {entry.status === "idle" ? "待機中" : RUN_LABELS[entry.status]}{entry.worktree && ` · ${worktreeLabels[entry.worktree]}`}</span>
					</button>
				</li>)}</ul>
			</section>
			<section className="work-overview-detail" aria-label="作業の詳細">
				{item ? <>
					<div className="work-overview-detail-heading"><h3>{item.name}</h3><button type="button" onClick={() => onSession(item.sessionId, item.workspaceId)}>会話を開く <Icon name="chevronRight" size="control" /></button></div>
					<p>{item.workspacePath}{item.category && ` · ${AGENT_CATEGORIES[item.category]}`}</p>
					{item.task && item.task !== item.name && <p>{item.task}</p>}
					{item.worktree && <>
						<h4>変更内容 <span>{worktreeLabels[item.worktree]}</span></h4>
						{running ? <p>作業が完了すると差分を確認できます。</p> : diffError ? <p role="alert">{diffError}</p> : !diff ? <p role="status">差分を読み込み中…</p> : diff.changed ? <><pre>{diff.diff}</pre>{diff.truncated && <p>差分の先頭を表示しています。</p>}</> : <p>採用待ちの変更はありません。</p>}
					</>}
				</> : <p>作業を選択すると詳細が表示されます。</p>}
			</section>
		</div>
	</dialog>;
}
