import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, command, errorMessage } from "./api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import type { Model, ModelCatalog, Settings } from "./types.ts";

const TABS = [
	{ id: "models", label: "モデル" },
	{ id: "search", label: "検索" },
	{ id: "agents", label: "エージェント" },
	{ id: "environment", label: "環境" },
] as const;
type SettingsTab = (typeof TABS)[number]["id"];

export function SettingsDialog({ onClose, onSaved, workspaceId }: { onClose: () => void; onSaved: () => void; workspaceId?: string }) {
	const [settings, setSettings] = useState<Settings>();
	const [catalog, setCatalog] = useState<ModelCatalog>();
	const [tab, setTab] = useState<SettingsTab>("models");
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [searchKeys, setSearchKeys] = useState({ brave: "", tavily: "" });
	const [llmProvider, setLlmProvider] = useState("");
	const [llmKeys, setLlmKeys] = useState<Record<string, string>>({});
	const [modelSelection, setModelSelection] = useState<Model>();
	const dialog = useRef<HTMLElement>(null);
	const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const titleId = useId();
	const tabsId = useId();
	const keyId = useId();
	useEffect(() => {
		const previous = document.activeElement;
		dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
		return () => { if (previous instanceof HTMLElement) previous.focus(); };
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		setError(undefined);
		Promise.all([api<Settings>(`/api/settings${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`, { signal: controller.signal }), api<ModelCatalog>("/api/models", { signal: controller.signal })])
			.then(([value, models]) => {
				if (controller.signal.aborted) return;
				setSettings(value);
				setCatalog(models);
				setModelSelection(value.llm.defaultModel);
				setLlmProvider(value.llm.defaultModel?.provider ?? models.providers.find((provider) => provider.configured)?.id ?? "");
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(`設定を読み込めませんでした。サーバーへの接続を確認して、再読み込みしてください。詳細: ${errorMessage(reason)}`);
			});
		return () => controller.abort();
	}, [loadAttempt, workspaceId]);
	const providerCatalog = useMemo(() => catalog && ({
		providers: catalog.providers.filter((provider) => provider.id === llmProvider),
		models: catalog.models.filter((model) => model.provider === llmProvider),
	}), [catalog, llmProvider]);
	const selectedProvider = catalog?.providers.find((provider) => provider.id === llmProvider);
	const llmKey = llmKeys[llmProvider] ?? "";

	async function perform(operation: () => Promise<void>, success: string) {
		setBusy(true); setError(undefined); setNotice(undefined);
		try { await operation(); setNotice(success); onSaved(); }
		catch (reason: unknown) { setError(`保存・更新に失敗しました。入力は保持しています。接続と入力内容を確認して、もう一度操作してください。詳細: ${errorMessage(reason)}`); }
		finally { setBusy(false); }
	}

	return <div className="dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
		<section ref={dialog} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} onKeyDown={(event) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
			if (event.key !== "Tab") return;
			const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled):not([tabindex='-1']), input:not(:disabled), select:not(:disabled), a[href]") ?? [])].filter((element) => !element.matches(":disabled") && element.getClientRects().length > 0);
			const first = controls[0];
			const last = controls[controls.length - 1];
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
			if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
		}}>
			<header className="panel-heading"><h2 id={titleId}>設定</h2><button type="button" disabled={busy} onClick={onClose} aria-label="設定を閉じる">閉じる</button></header>
			<div className="settings-tabs" role="tablist" aria-label="設定のカテゴリ" onKeyDown={(event) => {
				const index = TABS.findIndex((entry) => entry.id === tab);
				let next: number;
				if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
				else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
				else if (event.key === "Home") next = 0;
				else if (event.key === "End") next = TABS.length - 1;
				else return;
				event.preventDefault(); setTab(TABS[next].id); tabRefs.current[next]?.focus();
			}}>
				{TABS.map((entry, index) => <button key={entry.id} type="button" ref={(element) => { tabRefs.current[index] = element; }} role="tab" id={`${tabsId}-${entry.id}-tab`} aria-controls={`${tabsId}-${entry.id}-panel`} aria-selected={tab === entry.id} tabIndex={tab === entry.id ? 0 : -1} onClick={() => setTab(entry.id)}>{entry.label}</button>)}
			</div>
			{error && <div className="error" role="alert"><p>{error}</p>{!settings && <button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>再読み込み</button>}</div>}
			{notice && <p className="settings-notice" role="status">{notice}</p>}
			{!settings && !error && <p role="status">設定を読み込み中…</p>}
			{settings && <>
				<section className="settings-content" role="tabpanel" id={`${tabsId}-models-panel`} aria-labelledby={`${tabsId}-models-tab`} hidden={tab !== "models"}>
					<h3>モデルを接続する</h3>
					<p>プロバイダーを選び、必要なら API キーを入力して、使いたいモデルを保存します。</p>
					<form className="provider-model-flow" onSubmit={(event) => {
						event.preventDefault();
						if (!llmProvider || (!modelSelection && !llmKey.trim())) return;
						void perform(async () => {
							if (llmKey.trim()) {
								await command(`/api/credentials/llm/${encodeURIComponent(llmProvider)}`, { key: llmKey }, "PUT");
								setCatalog((current) => current && ({ ...current, providers: current.providers.map((provider) => provider.id === llmProvider ? { ...provider, configured: true } : provider) }));
							}
							if (modelSelection) {
								try {
									await command("/api/settings", { llm: { defaultModel: { provider: modelSelection.provider, id: modelSelection.id } } }, "PATCH");
								} catch (reason: unknown) {
									if (llmKey.trim()) throw new Error(`API キーは現在のプロセスに設定できましたが、既定モデルは保存できませんでした。再試行してください。${errorMessage(reason)}`);
									throw reason;
								}
								setSettings((current) => current && ({ ...current, llm: { defaultModel: modelSelection } }));
							}
							setLlmKeys((keys) => ({ ...keys, [llmProvider]: "" }));
						}, modelSelection ? "既定モデルを保存しました。新しい会話で使用します。既存の会話のモデルは変更しません。" : "API キーを現在のプロセスに設定しました。既定モデルは変更していません。");
					}}>
						<fieldset disabled={busy} className="settings-section"><legend>接続と既定モデル</legend>
							<label>プロバイダー<select value={llmProvider} onChange={(event) => {
								const provider = event.target.value;
								setLlmProvider(provider);
								setModelSelection(settings.llm.defaultModel?.provider === provider ? settings.llm.defaultModel : undefined);
							}}><option value="" disabled>プロバイダーを選択</option>{catalog?.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
							{llmProvider && <>
							<p className="credential-status" data-configured={selectedProvider?.configured}>{selectedProvider?.configured === true ? "接続設定済み · 保存済み認証または環境変数を利用できます。" : selectedProvider?.configured === false ? "キー未設定 · モデルは先に選択できます。実行前に API キーを設定してください。" : "接続状態を確認できません。既存の Pi 認証がある場合、キーの再入力は不要です。"}</p>
							<label htmlFor={keyId}>{selectedProvider?.name ?? "プロバイダー"} の API キー<input id={keyId} type="password" autoComplete="new-password" spellCheck={false} value={llmKey} placeholder={selectedProvider?.configured ? "空欄なら現在の認証を使う" : "API キーを入力"} onChange={(event) => setLlmKeys((keys) => ({ ...keys, [llmProvider]: event.target.value }))} /></label>
							<p className="fine-print">ここで入力するキーは現在のサーバープロセスだけで有効です。サーバーの再起動で消えるため、継続して使う場合は Pi の auth.json / models.json / 環境変数で設定してください。既存の認証は上書き保存しません。</p>
							<ModelPicker catalog={providerCatalog} value={modelSelection} onChange={setModelSelection} disabled={busy} />
							<div className="settings-actions"><button type="submit" disabled={!llmProvider || (!modelSelection && !llmKey.trim())}>{busy ? "保存中…" : modelSelection ? "接続とモデルを保存" : "API キーを設定"}</button></div>
							</>}
						</fieldset>
					</form>
					<p className="fine-print">保存済みの既定モデル: {settings.llm.defaultModel ? `${settings.llm.defaultModel.provider} / ${settings.llm.defaultModel.id}` : "自動選択（Pi の設定を使用）"}</p>
					<button type="button" disabled={busy || !settings.llm.defaultModel} onClick={() => { void perform(async () => {
						await command("/api/settings", { llm: { defaultModel: null } }, "PATCH");
						setSettings((current) => current && ({ ...current, llm: {} }));
						setModelSelection(undefined);
					}, "Web の既定モデルを解除しました。新しい会話では Pi の設定からモデルを選びます。"); }}>既定モデルを自動選択に戻す</button>
				</section>
				<section className="settings-content" role="tabpanel" id={`${tabsId}-search-panel`} aria-labelledby={`${tabsId}-search-tab`} hidden={tab !== "search"}>
					<h3>Web 検索</h3>
					<form onSubmit={(event) => { event.preventDefault(); void perform(async () => { await command("/api/settings", { search: { defaultProvider: settings.search.defaultProvider } }, "PATCH"); }, "既定の検索プロバイダーを保存しました。"); }}>
						<fieldset disabled={busy}><legend>既定の検索サービス</legend>
							<label>プロバイダー<select value={settings.search.defaultProvider} onChange={(event) => setSettings({ ...settings, search: { ...settings.search, defaultProvider: event.target.value as "brave" | "tavily" } })}><option value="brave">Brave</option><option value="tavily">Tavily</option></select></label>
							<button type="submit">検索設定を保存</button>
						</fieldset>
					</form>
					<fieldset disabled={busy} className="settings-section"><legend>検索 API キー</legend>
						{(["brave", "tavily"] as const).map((provider) => <div className="credential-row" key={provider}>
							<label>{provider === "brave" ? "Brave" : "Tavily"} · {settings.search.configured[provider] ? "設定済み" : "未設定"}<input type="password" autoComplete="new-password" spellCheck={false} value={searchKeys[provider]} placeholder="新しい API キー" onChange={(event) => setSearchKeys({ ...searchKeys, [provider]: event.target.value })} /></label>
							<button type="button" disabled={!searchKeys[provider].trim()} onClick={() => { const key = searchKeys[provider]; void perform(async () => {
								await command(`/api/credentials/search/${provider}`, { key }, "PUT");
								setSearchKeys((keys) => ({ ...keys, [provider]: "" }));
								setSettings((current) => current && ({ ...current, search: { ...current.search, configured: { ...current.search.configured, [provider]: true } } }));
							}, `${provider} のキーを保存しました。`); }}>キーを保存</button>
							<button type="button" disabled={!settings.search.configured[provider]} onClick={() => { void perform(async () => {
								await api(`/api/credentials/search/${provider}`, { method: "DELETE" });
								setSettings((current) => current && ({ ...current, search: { ...current.search, configured: { ...current.search.configured, [provider]: false } } }));
							}, `${provider} のキーを削除しました。`); }}>保存済みキーを削除</button>
						</div>)}
						<p className="fine-print">検索キーはサーバーに保存され、再起動後も使えます。空欄では既存キーを変更しません。キーが未設定でも別の検索サービスへ自動切替はしません。</p>
					</fieldset>
				</section>
				<section className="settings-content" role="tabpanel" id={`${tabsId}-agents-panel`} aria-labelledby={`${tabsId}-agents-tab`} hidden={tab !== "agents"}>
					<h3>エージェントチーム</h3>
					<form onSubmit={(event) => { event.preventDefault(); void perform(async () => { await command("/api/settings", { teams: settings.teams }, "PATCH"); }, "エージェントの設定を保存しました。"); }}>
						<fieldset disabled={busy}><legend>実行の上限</legend>
							<label>チームごとの同時実行数<input type="number" min={1} max={32} step={1} required value={Number.isNaN(settings.teams.maxConcurrentAgents) ? "" : settings.teams.maxConcurrentAgents} onChange={(event) => setSettings({ ...settings, teams: { ...settings.teams, maxConcurrentAgents: event.target.valueAsNumber } })} /></label>
							<p className="fine-print">1–32。親エージェントも数えます。結果待ちのエージェントは実行枠を使いません。</p>
							<label>子エージェントの最大深さ<input type="number" min={1} max={8} step={1} required value={Number.isNaN(settings.teams.maxDepth) ? "" : settings.teams.maxDepth} onChange={(event) => setSettings({ ...settings, teams: { ...settings.teams, maxDepth: event.target.valueAsNumber } })} /></label>
							<p className="fine-print">1–8。深さ 1 は親から直接作る子まで、深さ 2 はその孫までを許可します。</p>
							<button type="submit">エージェント設定を保存</button>
						</fieldset>
					</form>
				</section>
				<section className="settings-content" role="tabpanel" id={`${tabsId}-environment-panel`} aria-labelledby={`${tabsId}-environment-tab`} hidden={tab !== "environment"}>
					<h3>実行環境</h3>
					<section className="settings-section"><h4>Browser use · Playwright</h4><p className="credential-status" data-configured={settings.browser?.ready}>{settings.browser?.ready ? "Chromium を利用できます。" : "Chromium の準備が必要です。"}</p>{settings.browser?.error && <p className="error">{settings.browser.error}</p>}{!settings.browser?.ready && <><p>サーバーを起動する環境で、次のコマンドを実行してください。</p><code>npx playwright install chromium</code><p className="fine-print">インストール後、この設定を開き直して状態を確認してください。</p></>}</section>
					<section className="settings-section"><h4>認証とローカル権限</h4><p>LLM は Pi の auth.json / models.json / 環境変数の認証も利用します。設定済みのキーの値は取得・表示しません。</p><p>このアプリはローカル単一ユーザー向けです。エージェントの bash、ブラウザー、ユーザー端末は起動ユーザーの権限で動作します。ファイルのパス検査はサンドボックスではありません。</p></section>
				</section>
			</>}
		</section>
	</div>;
}
