import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { AGENT_CATEGORIES } from "../shared/agent-categories.ts";
import type { WorkDiff, WorkOverviewItem } from "../shared/work-overview.ts";
import { api, errorMessage } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { sessionRecency } from "./session-recency.ts";
import { RUN_LABELS } from "./TeamPane.tsx";
import { workspaceLabel } from "./workspace-label.ts";
import "./WorkOverview.css";

const filters = { all: "すべて", running: "進行中", isolated: "分離した作業" } as const;
const worktreeLabels = { active: "分離中", adopted: "採用済み", discarded: "破棄済み" } as const;
const ACTIVE_STATUSES = new Set(["queued", "running", "waiting", "cancelling"]);

function statusLabel(status: WorkOverviewItem["status"]): string {
	return status === "idle" ? "待機中" : RUN_LABELS[status];
}

export function WorkOverview({
	onClose,
	onSession,
}: {
	onClose: () => void;
	onSession: (id: string, workspaceId: string) => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const searchInput = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);
	const title = useId();
	const [items, setItems] = useState<WorkOverviewItem[]>();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<keyof typeof filters>("all");
	const [selected, setSelected] = useState<string>();
	const [error, setError] = useState<string>();
	const [diff, setDiff] = useState<WorkDiff>();
	const [diffError, setDiffError] = useState<string>();

	useEffect(() => {
		dialog.current?.showModal();
		searchInput.current?.focus();
	}, []);

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
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, []);

	const counts = useMemo(() => {
		const list = items ?? [];
		return {
			all: list.length,
			running: list.filter((entry) => ACTIVE_STATUSES.has(entry.status)).length,
			isolated: list.filter((entry) => !!entry.worktree).length,
		};
	}, [items]);

	const matching = useMemo(() => {
		const q = query.trim().toLocaleLowerCase();
		return items?.filter((entry) => {
			if (filter === "isolated" && !entry.worktree) return false;
			if (filter === "running" && !ACTIVE_STATUSES.has(entry.status)) return false;
			if (!q) return true;
			return `${entry.name} ${entry.task ?? ""} ${entry.workspacePath}`.toLocaleLowerCase().includes(q);
		});
	}, [items, filter, query]);

	// Always keep a valid selection when matching items exist so the detail pane is immediately useful.
	useEffect(() => {
		if (!matching?.length) {
			if (selected !== undefined) setSelected(undefined);
			return;
		}
		if (!selected || !matching.some((entry) => entry.sessionId === selected)) {
			setSelected(matching[0].sessionId);
		}
	}, [matching, selected]);

	const item = matching?.find((entry) => entry.sessionId === selected);
	const workspacePaths = useMemo(() => [...new Set(items?.map((entry) => entry.workspacePath))], [items]);
	const running = !!item && ACTIVE_STATUSES.has(item.status);
	const diffId = item?.worktree && !running ? item.sessionId : undefined;

	useEffect(() => {
		setDiff(undefined);
		setDiffError(undefined);
		if (!diffId) return;
		const controller = new AbortController();
		void api<WorkDiff>(`/api/work/${encodeURIComponent(diffId)}/diff`, { signal: controller.signal }).then(
			(value) => {
				if (!controller.signal.aborted) setDiff(value);
			},
			(reason: unknown) => {
				if (!controller.signal.aborted) setDiffError(errorMessage(reason));
			},
		);
		return () => controller.abort();
	}, [diffId, item?.worktree, item?.updatedAt]);

	function selectItem(id: string) {
		setSelected(id);
		requestAnimationFrame(() => {
			listRef.current?.querySelector<HTMLButtonElement>(`button[data-session-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
		});
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
		if (!matching?.length) return;
		const currentIndex = matching.findIndex((entry) => entry.sessionId === selected);
		if (event.key === "ArrowDown") {
			event.preventDefault();
			const next = matching[(currentIndex + 1 + matching.length) % matching.length];
			selectItem(next.sessionId);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			const next = matching[(currentIndex - 1 + matching.length) % matching.length];
			selectItem(next.sessionId);
		} else if (event.key === "Enter" && item && !(event.target instanceof HTMLButtonElement)) {
			event.preventDefault();
			onSession(item.sessionId, item.workspaceId);
		}
	}

	return (
		<dialog
			className="work-overview"
			ref={dialog}
			aria-labelledby={title}
			onClose={onClose}
			onClick={(event) => {
				if (event.target === event.currentTarget) dialog.current?.close();
			}}
			onKeyDown={handleKeyDown}
		>
			<header className="work-overview-header">
				<div className="work-overview-header-left">
					<h2 id={title}>作業一覧</h2>
					{items && <span className="work-overview-total">{items.length} 件</span>}
				</div>
				<div className="work-overview-header-right">
					<span className="work-overview-hint">↑↓ 選択 · Enter 開く · Esc 閉じる</span>
					<button
						type="button"
						className="work-overview-close"
						aria-label="作業一覧を閉じる"
						onClick={() => dialog.current?.close()}
					>
						<Icon name="close" size="inline" />
						<span>閉じる</span>
					</button>
				</div>
			</header>

			<div className="work-overview-layout">
				<section className="work-overview-list" aria-label="ワークスペースの作業">
					<div className="work-overview-search">
						<Icon name="search" size="inline" />
						<input
							ref={searchInput}
							type="search"
							placeholder="作業・ワークスペースを検索"
							aria-label="作業・ワークスペースを検索"
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
						/>
						{query && (
							<button
								type="button"
								className="work-overview-search-clear"
								aria-label="検索をクリア"
								onClick={() => {
									setQuery("");
									searchInput.current?.focus();
								}}
							>
								<Icon name="close" size="inline" />
							</button>
						)}
					</div>

					<div className="work-overview-filters" role="group" aria-label="状態で絞り込む">
						{(Object.entries(filters) as [keyof typeof filters, string][]).map(([id, label]) => (
							<button
								key={id}
								type="button"
								aria-pressed={filter === id}
								onClick={() => setFilter(id)}
							>
								<span>{label}</span>
								<span className="work-overview-filter-count">{counts[id]}</span>
							</button>
						))}
					</div>

					{error && <p className="work-overview-empty is-error" role="alert">{error}</p>}
					{!items && !error && <p className="work-overview-empty" role="status">読み込み中…</p>}
					{matching?.length === 0 && <p className="work-overview-empty">該当する作業がありません。</p>}

					<ul ref={listRef} aria-label="作業の一覧">
						{matching?.map((entry) => {
							const active = entry.sessionId === selected;
							return (
								<li key={entry.sessionId}>
									<button
										type="button"
										data-session-id={entry.sessionId}
										aria-pressed={active}
										onClick={() => setSelected(entry.sessionId)}
										onDoubleClick={() => onSession(entry.sessionId, entry.workspaceId)}
									>
										<div className="work-overview-row-top">
											<span className={`status-dot status-${entry.status}`} aria-hidden="true" />
											<strong>{entry.name}</strong>
											{entry.updatedAt && (
												<time className="work-overview-row-time" dateTime={entry.updatedAt}>
													{sessionRecency(entry.updatedAt)}
												</time>
											)}
										</div>
										<div className="work-overview-row-meta">
											<span className="work-overview-row-ws">
												{workspaceLabel(entry.workspacePath, workspacePaths)}
											</span>
											<span className={`work-overview-status-tag is-${entry.status}`}>
												{statusLabel(entry.status)}
											</span>
											{entry.worktree && (
												<span className="work-overview-wt-tag">{worktreeLabels[entry.worktree]}</span>
											)}
										</div>
									</button>
								</li>
							);
						})}
					</ul>
				</section>

				<section className="work-overview-detail" aria-label="作業の詳細">
					{item ? (
						<div className="work-overview-detail-inner">
							<div className="work-overview-detail-heading">
								<div className="work-overview-detail-title-group">
									<span className={`work-overview-status-pill is-${item.status}`}>
										<span className={`status-dot status-${item.status}`} aria-hidden="true" />
										{statusLabel(item.status)}
									</span>
									<h3>{item.name}</h3>
								</div>
								<button
									type="button"
									className="work-overview-open-btn"
									onClick={() => onSession(item.sessionId, item.workspaceId)}
								>
									<span>会話を開く</span>
									<Icon name="chevronRight" size="inline" />
								</button>
							</div>

							<div className="work-overview-meta-chips">
								<span className="work-overview-meta-chip" title={item.workspacePath}>
									<Icon name="folder" size="inline" />
									<code>{item.workspacePath}</code>
								</span>
								{item.category && (
									<span className="work-overview-meta-chip">{AGENT_CATEGORIES[item.category]}</span>
								)}
								{item.worktree && (
									<span className="work-overview-meta-chip">{worktreeLabels[item.worktree]}</span>
								)}
								{item.updatedAt && (
									<span className="work-overview-meta-chip">
										更新: {new Date(item.updatedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
									</span>
								)}
							</div>

							{item.task && item.task !== item.name && (
								<div className="work-overview-section-card">
									<h4>タスク内容</h4>
									<p className="work-overview-task-body">{item.task}</p>
								</div>
							)}

							{item.worktree && (
								<div className="work-overview-section-card">
									<h4>
										変更内容 <span>{worktreeLabels[item.worktree]}</span>
									</h4>
									{running ? (
										<p className="work-overview-muted">作業が完了すると差分を確認できます。</p>
									) : diffError ? (
										<p className="work-overview-empty is-error" role="alert">{diffError}</p>
									) : !diff ? (
										<p className="work-overview-muted" role="status">差分を読み込み中…</p>
									) : diff.changed ? (
										<>
											<pre className="work-overview-diff">
												{diff.diff.split("\n").map((line, index) => {
													const kind =
														line.startsWith("+") && !line.startsWith("+++")
															? "add"
															: line.startsWith("-") && !line.startsWith("---")
																? "del"
																: line.startsWith("@@")
																	? "hunk"
																	: undefined;
													return (
														<span key={index} className={kind ? `diff-line is-${kind}` : "diff-line"}>
															{line}
														</span>
													);
												})}
											</pre>
											{diff.truncated && <p className="work-overview-muted">差分の先頭を表示しています。</p>}
										</>
									) : (
										<p className="work-overview-muted">採用待ちの変更はありません。</p>
									)}
								</div>
							)}
						</div>
					) : (
						<div className="work-overview-placeholder">
							<p>{items?.length ? "一致する作業がありません。" : "進行中・履歴の作業はまだありません。"}</p>
						</div>
					)}
				</section>
			</div>
		</dialog>
	);
}
