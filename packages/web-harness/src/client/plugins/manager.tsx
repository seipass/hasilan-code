import { useEffect, useState } from "react";
import type { Static } from "typebox";
import { PLUGIN_MANAGER_ID, type PluginManagementEntry, type pluginManagementActionSchema } from "../../shared/plugin-profile.ts";
import { api, command, errorMessage } from "../api.ts";
import type { WorkspacePanel, WorkspacePanelProps } from "./workspace-panels.ts";
import "./PluginManager.css";

const URL = "/api/plugin-management";
const statusLabels = { enabled: "有効", disabled: "無効", failed: "読み込み失敗", blocked: "依存不足" };

function PluginManager({ opened }: WorkspacePanelProps) {
	const [entries, setEntries] = useState<PluginManagementEntry[]>();
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

	if (!opened) return null;
	return <section className="plugin-manager" aria-label="プラグイン管理" aria-busy={busy}>
		{entries?.some((entry) => entry.pending) && <p role="status">再起動すると保存した変更が反映されます。</p>}
		{error && <p className="error" role="alert">{error}</p>}
		{entries ? <>
			<ul className="plugin-manager-list">{entries.map((entry) => <li key={entry.id}>
				<div>
					<strong>{entry.title}</strong>
					<span>{entry.source === "built-in" ? "組み込み" : "外部"} · {statusLabels[entry.status]}
						{entry.pending && ` · 次回起動時は${entry.enabled ? "有効" : "無効"}`}
					</span>
					{entry.module && <code>{entry.module}</code>}
					{entry.reason && <p>{entry.reason}</p>}
				</div>
				<div className="plugin-manager-actions">
					<button type="button" aria-label={`${entry.title}を${entry.enabled ? "無効化" : "有効化"}`} disabled={busy || !entry.canEnable} onClick={() => {
						void change({ op: "enable", id: entry.id, enabled: !entry.enabled });
					}}>{entry.enabled ? "無効化" : "有効化"}</button>
					{entry.module && <button type="button" aria-label={`${entry.title}の登録を解除`} disabled={busy} onClick={() => {
						void change({ op: "remove", id: entry.id });
					}}>登録解除</button>}
				</div>
			</li>)}</ul>
			<form className="plugin-manager-form" onSubmit={(event) => {
				event.preventDefault();
				if (!busy) void change({ op: "add", id: id.trim(), module: module.trim() });
			}}>
				<h2>ローカルプラグイン</h2>
				<label>プラグインID<input required pattern={/[a-z0-9][a-z0-9._\-]{0,127}/.source} value={id} onChange={(event) => setId(event.currentTarget.value)} /></label>
				<label>モジュールのパス<input required value={module} onChange={(event) => setModule(event.currentTarget.value)} placeholder="./plugins/example.cjs" /></label>
				<p>相対パスはエージェントディレクトリが基準です。同じIDで登録すると置き換わります。</p>
				<button type="submit" disabled={busy}>登録</button>
			</form>
		</> : error
			? <button type="button" onClick={() => { setError(undefined); setReload((previous) => previous + 1); }}>再試行</button>
			: <p role="status">プラグインを読み込んでいます…</p>}
	</section>;
}

export const pluginManagerPanel: WorkspacePanel = {
	id: PLUGIN_MANAGER_ID,
	title: "プラグイン",
	icon: "settings",
	requiresWorkspace: false,
	View: PluginManager,
};
