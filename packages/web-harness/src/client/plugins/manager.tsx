import { useEffect, useMemo, useState } from "react";
import type { Static } from "typebox";
import { PLUGIN_MANAGER_ID, type PluginManagementEntry, type pluginManagementActionSchema } from "../../shared/plugin-profile.ts";
import { api, command, errorMessage } from "../api.ts";
import { Icon } from "../Icon.tsx";
import type { WorkspacePanel, WorkspacePanelProps } from "./workspace-panels.ts";
import "./PluginManager.css";

const URL = "/api/plugin-management";
const statusLabels = { enabled: "有効", disabled: "無効", failed: "読み込み失敗", blocked: "依存不足" };

type PluginCategory = "tools" | "workspace" | "sessions" | "core" | "external";
type FilterMode = "all" | "enabled" | "disabled" | "pending";

interface PluginMeta {
	label: string;
	description: string;
	category: Exclude<PluginCategory, "external">;
}

const CATEGORY_LABELS: Record<PluginCategory, { title: string; description: string }> = {
	external: { title: "外部・ローカルプラグイン", description: "ローカルから登録した拡張プラグイン" },
	tools: { title: "エージェントツール", description: "ファイル操作・コマンド実行・ブラウザやWeb検索などAIが使う機能" },
	workspace: { title: "ワークスペース・開発", description: "エディタ・ターミナル・Gitレビュー・キャンバスなどの作業環境" },
	sessions: { title: "会話・履歴・利用状況", description: "履歴の保存・検索・アーカイブやトークン使用量の管理" },
	core: { title: "コア・システム", description: "標準UI・テーマ・モデルプロバイダーなどの基盤機能" },
};

const CATEGORY_ORDER: readonly PluginCategory[] = ["external", "tools", "workspace", "sessions", "core"];

const BUILTIN_META: Readonly<Record<string, PluginMeta>> = {
	hashline: { label: "ファイル操作（Hashline）", description: "行ハッシュ検証付きでワークスペース内のファイルを閲覧・検索・編集します。", category: "tools" },
	"shell-process": { label: "シェルコマンド実行", description: "ワークスペース内でコマンドやスクリプトを実行・監視します。", category: "tools" },
	"web-search": { label: "Web検索", description: "検索エンジン経由で最新のWeb情報を取得します。", category: "tools" },
	"browser-tools": { label: "ブラウザ操作", description: "ヘッドレスブラウザでWebページの閲覧・操作・撮影を行います。", category: "tools" },
	"computer-tools": { label: "デスクトップ操作", description: "画面キャプチャとマウス・キーボード入力によるPC操作を行います。", category: "tools" },
	"jev-computer": { label: "デスクトップ操作（JEV）", description: "JEVバックエンド経由でデスクトップ環境を操作します。", category: "tools" },
	"team-tools": { label: "チーム・サブエージェント", description: "複数のサブエージェントを立ち上げて並行作業を管理します。", category: "tools" },
	"workspace-files": { label: "ファイルビューア・エディタ", description: "右パネルのファイルツリー・プレビュー・編集とクイックオープンを提供します。", category: "workspace" },
	terminal: { label: "統合ターミナル", description: "右パネル内にインタラクティブなシェル端末を開きます。", category: "workspace" },
	"git-review": { label: "Git差分レビュー", description: "変更差分の閲覧とレビューコメントの作成を行います。", category: "workspace" },
	canvas: { label: "設計キャンバス", description: "構成図やメモをノードで整理できるビジュアルキャンバスを提供します。", category: "workspace" },
	hyakki: { label: "百鬼夜行（スウォーム）", description: "/hyakki コマンドで自律エージェント群による大規模作業を実行します。", category: "workspace" },
	goal: { label: "目標管理（Goal）", description: "/goal コマンドで会話ごとの達成目標と進捗を管理します。", category: "workspace" },
	"text-transform": { label: "テキスト翻訳・要約", description: "ファイルタブや文章の翻訳・要約アクションを追加します。", category: "workspace" },
	"browser-adjustments": { label: "内蔵ブラウザ連携", description: "内蔵ブラウザからの注釈添付とAI支援を有効にします。", category: "workspace" },
	"workspace-router": { label: "送信先の自動ルーティング", description: "ホーム画面の入力内容から最適なワークスペースや会話を判定します。", category: "workspace" },
	"github-dashboard": { label: "GitHubダッシュボード", description: "ホーム画面にPull Requestやコントリビューション状況を表示します。", category: "workspace" },
	"session-storage": { label: "会話データの永続化", description: "会話履歴とワークスペース状態をディスクに保存・復元します。", category: "sessions" },
	"session-search": { label: "会話の全文検索", description: "サイドバーから会話タイトルとメッセージ本文を横断検索します。", category: "sessions" },
	"session-import": { label: "セッション引き継ぎ", description: "外部や既存環境から会話履歴をインポートします。", category: "sessions" },
	"session-archive": { label: "会話アーカイブ", description: "古い会話を設定画面からアーカイブ・復元します。", category: "sessions" },
	"storage-usage": { label: "ストレージ使用量", description: "設定画面で会話や添付データの容量確認と整理を行います。", category: "sessions" },
	"account-usage": { label: "アカウント利用量", description: "プロバイダーごとの使用量・クォータを設定画面に表示します。", category: "sessions" },
	"workspace-ui": { label: "ワークスペースUI", description: "Hasilan Code の標準Webインターフェースを提供します。", category: "core" },
	"model-providers": { label: "標準モデルプロバイダー", description: "組み込みAIプロバイダーと標準モデル定義を読み込みます。", category: "core" },
	"theme-default": { label: "標準テーマ", description: "カスタマイズ可能な標準ダーク・ライト配色を提供します。", category: "core" },
	"runtime-context": { label: "実行時コンテキスト", description: "進行中の目標や作業状態をエージェントの文脈に補完します。", category: "core" },
	"plugin-manager": { label: "プラグイン管理", description: "この画面からプラグインの有効化・無効化とローカル登録を行います。", category: "core" },
};

function pluginDisplay(entry: PluginManagementEntry): { label: string; description?: string; category: PluginCategory } {
	if (entry.source === "external") return { label: entry.title, description: entry.module ? undefined : "外部プラグイン", category: "external" };
	const meta = BUILTIN_META[entry.id];
	if (meta) return meta;
	return { label: entry.title, category: "core" };
}

function PluginManager({ opened }: WorkspacePanelProps) {
	const [entries, setEntries] = useState<PluginManagementEntry[]>();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<FilterMode>("all");
	const [id, setId] = useState("");
	const [module, setModule] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [reload, setReload] = useState(0);
	useEffect(() => {
		if (!opened) return;
		const controller = new AbortController();
		void api<PluginManagementEntry[]>(URL, { signal: controller.signal })
			.then((value) => { if (!controller.signal.aborted) setEntries(value); })
			.catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, [opened, reload]);

	async function change(action: Static<typeof pluginManagementActionSchema>) {
		setBusy(true);
		setError(undefined);
		try {
			setEntries(await command<PluginManagementEntry[]>(URL, action, "PATCH"));
			if (action.op === "add") { setId(""); setModule(""); }
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(false);
		}
	}

	const summary = useMemo(() => {
		if (!entries) return { total: 0, enabled: 0, disabled: 0, pending: 0 };
		let enabled = 0;
		let pending = 0;
		for (const entry of entries) {
			if (entry.enabled) enabled++;
			if (entry.pending) pending++;
		}
		return { total: entries.length, enabled, disabled: entries.length - enabled, pending };
	}, [entries]);

	const grouped = useMemo(() => {
		if (!entries) return [];
		const normalized = query.trim().toLowerCase();
		const buckets = new Map<PluginCategory, Array<{ entry: PluginManagementEntry; label: string; description?: string }>>();
		for (const entry of entries) {
			if (filter === "enabled" && !entry.enabled) continue;
			if (filter === "disabled" && entry.enabled) continue;
			if (filter === "pending" && !entry.pending) continue;
			const info = pluginDisplay(entry);
			if (normalized) {
				const haystack = `${info.label} ${info.description ?? ""} ${entry.title} ${entry.id} ${entry.module ?? ""}`.toLowerCase();
				if (!haystack.includes(normalized)) continue;
			}
			const list = buckets.get(info.category) ?? [];
			list.push({ entry, label: info.label, description: info.description });
			buckets.set(info.category, list);
		}
		return CATEGORY_ORDER.flatMap((category) => {
			const items = buckets.get(category);
			return items?.length ? [{ category, ...CATEGORY_LABELS[category], items }] : [];
		});
	}, [entries, filter, query]);

	if (!opened) return null;
	return <section className="plugin-manager" aria-label="プラグイン管理" aria-busy={busy}>
		<div className="pm-container">
			<header className="pm-header">
				<div className="pm-header-copy">
					<h1>プラグイン</h1>
					<p>機能の有効・無効を切り替えたり、ローカルの拡張モジュールを登録できます。</p>
				</div>
				{entries && <div className="pm-summary" aria-label="プラグイン件数">
					<span>有効 {summary.enabled} / {summary.total}</span>
					{summary.pending > 0 && <span className="pm-summary-pending">未反映 {summary.pending}</span>}
				</div>}
			</header>
			{summary.pending > 0 && <p className="pm-pending-banner" role="status"><Icon name="warning" size="inline" /><span>再起動すると保存した変更が反映されます。</span></p>}
			{error && <p className="pm-error error" role="alert">{error}</p>}
			{entries ? <>
				<div className="pm-controls">
					<label className="pm-search">
						<Icon name="search" size="inline" />
						<span className="sr-only">プラグインを検索</span>
						<input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="プラグイン名・説明・IDで検索…" />
						{query && <button type="button" className="pm-search-clear" aria-label="検索をクリア" onClick={() => setQuery("")}><Icon name="close" size="inline" /></button>}
					</label>
					<div className="pm-filters" role="group" aria-label="表示フィルタ">
						<button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>すべて<span>{summary.total}</span></button>
						<button type="button" aria-pressed={filter === "enabled"} onClick={() => setFilter("enabled")}>有効<span>{summary.enabled}</span></button>
						<button type="button" aria-pressed={filter === "disabled"} onClick={() => setFilter("disabled")}>無効<span>{summary.disabled}</span></button>
						{summary.pending > 0 && <button type="button" aria-pressed={filter === "pending"} onClick={() => setFilter("pending")}>変更あり<span>{summary.pending}</span></button>}
					</div>
				</div>
				{grouped.length === 0 ? <p className="pm-empty">条件に一致するプラグインがありません。</p> : <div className="pm-groups">
					{grouped.map((group) => <section key={group.category} className="pm-group" aria-label={group.title}>
						<div className="pm-group-header">
							<h2>{group.title}</h2>
							<span>{group.description}</span>
						</div>
						<ul className="plugin-manager-list">
							{group.items.map(({ entry, label, description }) => <li key={entry.id} data-enabled={entry.enabled} data-pending={entry.pending || undefined} data-status={entry.status}>
								<div className="pm-item-body">
									<div className="pm-item-title-row">
										<span className={`pm-status-dot is-${entry.status}`} aria-hidden="true" />
										<strong>{label}</strong>
										{label !== entry.id && <code className="pm-item-id">{entry.id}</code>}
										{entry.pending && <span className="pm-pending-tag">要再起動</span>}
									</div>
									{description && <p className="pm-item-desc">{description}</p>}
									<div className="pm-item-meta">
										<span>{entry.source === "built-in" ? "組み込み" : "外部"} · {statusLabels[entry.status]}{entry.pending && ` · 次回起動時は${entry.enabled ? "有効" : "無効"}`}</span>
										{entry.module && <code className="pm-item-module">{entry.module}</code>}
									</div>
									{entry.reason && <p className="pm-item-reason">{entry.reason}</p>}
								</div>
								<div className="plugin-manager-actions">
									{entry.module && <button type="button" className="pm-remove-btn" aria-label={`${entry.title}の登録を解除`} disabled={busy} onClick={() => {
										void change({ op: "remove", id: entry.id });
									}}>登録解除</button>}
									<button type="button" className="pm-switch" data-checked={entry.enabled} aria-label={`${entry.title}を${entry.enabled ? "無効化" : "有効化"}`} title={entry.canEnable ? entry.enabled ? "クリックして無効化" : "クリックして有効化" : "依存関係またはモジュール不足のため変更できません"} disabled={busy || !entry.canEnable} onClick={() => {
										void change({ op: "enable", id: entry.id, enabled: !entry.enabled });
									}}>
										<span className="pm-switch-track" aria-hidden="true"><span className="pm-switch-thumb" /></span>
										<span className="pm-switch-label">{entry.enabled ? "有効" : "無効"}</span>
									</button>
								</div>
							</li>)}
						</ul>
					</section>)}
				</div>}
				<form className="plugin-manager-form" onSubmit={(event) => {
					event.preventDefault();
					if (!busy) void change({ op: "add", id: id.trim(), module: module.trim() });
				}}>
					<div className="pm-form-header">
						<h2>ローカルプラグインを登録</h2>
						<p>相対パスはエージェントディレクトリが基準です。同じIDで登録すると置き換わります。</p>
					</div>
					<div className="pm-form-grid">
						<label>プラグインID<input required pattern={/[a-z0-9][a-z0-9._\-]{0,127}/.source} value={id} onChange={(event) => setId(event.currentTarget.value)} placeholder="my-plugin" /></label>
						<label>モジュールのパス<input required value={module} onChange={(event) => setModule(event.currentTarget.value)} placeholder="./plugins/example.cjs" /></label>
					</div>
					<div className="pm-form-footer">
						<button type="submit" className="pm-submit-btn" disabled={busy}>登録</button>
					</div>
				</form>
			</> : error
				? <button type="button" onClick={() => { setError(undefined); setReload((previous) => previous + 1); }}>再試行</button>
				: <p className="pm-loading" role="status">プラグインを読み込んでいます…</p>}
		</div>
	</section>;
}

export const pluginManagerPanel: WorkspacePanel = {
	id: PLUGIN_MANAGER_ID,
	title: "プラグイン",
	icon: "settings",
	requiresWorkspace: false,
	View: PluginManager,
};
