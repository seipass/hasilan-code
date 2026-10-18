import { useEffect, useId, useRef, useState } from "react";
import { AccountUsagePanel } from "./AccountUsagePanel.tsx";
import { api, command, errorMessage } from "./api.ts";
import { transitionItems } from "./item-transition.ts";
import { OAuthLogin } from "./OAuthLogin.tsx";
import type { ModelCatalog, Settings } from "./types.ts";

const TABS = [
	{ id: "providers", label: "プロバイダー" },
	{ id: "usage", label: "使用量" },
	{ id: "search", label: "検索" },
	{ id: "agents", label: "エージェント" },
	{ id: "environment", label: "環境" },
] as const;
type SettingsTab = (typeof TABS)[number]["id"];
const SEARCH_PROVIDERS = [
	{ id: "brave", label: "Brave" },
	{ id: "tavily", label: "Tavily" },
	{ id: "exa", label: "Exa" },
	{ id: "firecrawl", label: "Firecrawl" },
] as const;
type SearchProviderId = Settings["search"]["defaultProvider"];

export function SettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
	const [settings, setSettings] = useState<Settings>();
	const [savedSettings, setSavedSettings] = useState<Settings>();
	const [catalog, setCatalog] = useState<ModelCatalog>();
	const [tab, setTab] = useState<SettingsTab>("providers");
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [loginActive, setLoginActive] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [closing, setClosing] = useState(false);
	const [searchKeys, setSearchKeys] = useState<Record<SearchProviderId, string>>({ brave: "", tavily: "", exa: "", firecrawl: "" });
	const [llmProvider, setLlmProvider] = useState("");
	const [providerQuery, setProviderQuery] = useState("");
	const [llmKeys, setLlmKeys] = useState<Record<string, string>>({});
	const dialog = useRef<HTMLElement>(null);
	const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const titleId = useId();
	const tabsId = useId();
	const keyId = useId();
	const requestClose = () => {
		if (closing || busy) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onClose();
		else setClosing(true);
	};
	useEffect(() => {
		const previous = document.activeElement;
		dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
		return () => { if (previous instanceof HTMLElement) previous.focus(); };
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		setError(undefined);
		Promise.all([api<Settings>("/api/settings", { signal: controller.signal }), api<ModelCatalog>("/api/models", { signal: controller.signal })])
			.then(([value, models]) => {
				if (controller.signal.aborted) return;
				setSettings(value);
				setSavedSettings(value);
				setCatalog(models);
				setLlmProvider(models.providers.find((provider) => provider.configured)?.id ?? models.providers[0]?.id ?? "");
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(`設定を読み込めませんでした。詳細: ${errorMessage(reason)}`);
			});
		return () => controller.abort();
	}, [loadAttempt]);
	const selectedProvider = catalog?.providers.find((provider) => provider.id === llmProvider);
	const llmKey = llmKeys[llmProvider] ?? "";
	const hasLlmKey = !!selectedProvider?.apiKey && !!llmKey.trim();
	const matchingProviders = catalog?.providers.filter((provider) => `${provider.name} ${provider.id}`.toLocaleLowerCase().includes(providerQuery.trim().toLocaleLowerCase())) ?? [];
	const searchChanged = settings?.search.defaultProvider !== savedSettings?.search.defaultProvider;
	const teamsChanged = settings?.teams.maxConcurrentAgents !== savedSettings?.teams.maxConcurrentAgents || settings?.teams.maxDepth !== savedSettings?.teams.maxDepth;

	async function perform(operation: () => Promise<void>, success: string, failure: string) {
		setBusy(true); setError(undefined); setNotice(undefined);
		try { await operation(); setNotice(success); onSaved(); }
		catch (reason: unknown) { setError(`${failure} 詳細: ${errorMessage(reason)}`); }
		finally { setBusy(false); }
	}

	async function accountConnected() {
		setBusy(true); setError(undefined); setNotice(undefined);
		try {
			setCatalog(await api<ModelCatalog>("/api/models"));
			setNotice("認証を設定しました。");
			onSaved();
		} finally { setBusy(false); }
	}
	const keyForm = selectedProvider?.apiKey && <form className="settings-key-entry" onSubmit={(event) => {
		event.preventDefault();
		if (!hasLlmKey || busy || loginActive) return;
		const providerId = selectedProvider.id;
		void perform(async () => {
			await command(`/api/credentials/llm/${encodeURIComponent(providerId)}`, { key: llmKey.trim() }, "PUT");
			setCatalog((current) => current && ({ ...current, providers: current.providers.map((provider) => provider.id === providerId ? { ...provider, configured: true } : provider) }));
			setLlmKeys((keys) => ({ ...keys, [providerId]: "" }));
		}, "一時 API キーを設定しました。", `${selectedProvider.name} の一時 API キーを設定できませんでした。`);
	}}>
		<label htmlFor={keyId}>{selectedProvider.name} の一時 API キー<input id={keyId} type="password" autoComplete="new-password" spellCheck={false} disabled={busy || loginActive} value={llmKey} placeholder="API キーを入力" onChange={(event) => {
			setLlmKeys((keys) => ({ ...keys, [selectedProvider.id]: event.target.value }));
			setNotice(undefined);
		}} /></label>
		<p className="settings-inline-status" role="status">{hasLlmKey ? "入力中 · 未保存" : selectedProvider.configured ? "認証設定あり" : "キー未設定"}</p>
		<p className="fine-print">有効期間: サーバー再起動まで</p>
		<div className="settings-actions"><button type="submit" disabled={busy || loginActive || !hasLlmKey}>{busy ? "設定中…" : "一時 API キーを設定"}</button></div>
	</form>;

	return <div className="dialog-backdrop" data-closing={closing} onAnimationEnd={(event) => { if (closing && event.target === event.currentTarget) onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
		<section ref={dialog} className="settings-dialog" inert={closing} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} onKeyDown={(event) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); requestClose(); }
			if (event.key !== "Tab") return;
			const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled):not([tabindex='-1']), input:not(:disabled), select:not(:disabled), summary, a[href]") ?? [])].filter((element) => !element.matches(":disabled") && element.getClientRects().length > 0);
			const first = controls[0];
			const last = controls[controls.length - 1];
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
			if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
		}}>
			<header className="panel-heading"><h2 id={titleId}>設定</h2><button type="button" disabled={busy || closing} onClick={requestClose} aria-label="設定を閉じる">閉じる</button></header>
			<div className="settings-tabs" role="tablist" aria-label="設定のカテゴリ" onKeyDown={(event) => {
				const index = TABS.findIndex((entry) => entry.id === tab);
				let next: number;
				if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
				else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
				else if (event.key === "Home") next = 0;
				else if (event.key === "End") next = TABS.length - 1;
				else return;
				event.preventDefault(); transitionItems(() => setTab(TABS[next].id)); tabRefs.current[next]?.focus();
			}}>
				{TABS.map((entry, index) => <button key={entry.id} type="button" ref={(element) => { tabRefs.current[index] = element; }} role="tab" id={`${tabsId}-${entry.id}-tab`} aria-controls={`${tabsId}-${entry.id}-panel`} aria-selected={tab === entry.id} tabIndex={tab === entry.id ? 0 : -1} onClick={() => { if (tab !== entry.id) transitionItems(() => setTab(entry.id)); }}>{entry.label}</button>)}
			</div>
			{error && <div className="error" role="alert"><p>{error}</p>{!settings && <button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>再読み込み</button>}</div>}
			{notice && <p className="settings-notice" role="status">{notice}</p>}
			{!settings && !error && <p role="status">設定を読み込み中…</p>}
			{settings && <>
				<section className="settings-content" role="tabpanel" id={`${tabsId}-providers-panel`} aria-labelledby={`${tabsId}-providers-tab`} hidden={tab !== "providers"}>
					<h3>プロバイダーの認証</h3>
					<div className="settings-section settings-provider-section">
						<p className="settings-inline-status">認証設定あり: {catalog?.providers.filter((provider) => provider.configured).length ?? 0} / {catalog?.providers.length ?? 0} 件</p>
						<label>プロバイダーを検索<input type="search" value={providerQuery} disabled={busy || loginActive} placeholder="名前または ID で検索" onChange={(event) => setProviderQuery(event.target.value)} /></label>
						<label>プロバイダー<select value={llmProvider} disabled={busy || loginActive || !catalog?.providers.length} onChange={(event) => {
							const providerId = event.target.value;
							transitionItems(() => { setLlmProvider(providerId); setNotice(undefined); });
						}}>
							{!llmProvider && <option value="">プロバイダーを選択</option>}
							{selectedProvider && !matchingProviders.some((provider) => provider.id === selectedProvider.id) && <option value={selectedProvider.id}>{selectedProvider.name} · 現在の選択</option>}
							{matchingProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.configured === true ? "認証設定あり" : provider.configured === false ? "未設定" : "状態不明"}</option>)}
						</select></label>
						{providerQuery.trim() && <p className="settings-inline-status" role="status">{matchingProviders.length ? `${matchingProviders.length} 件が一致しました。` : "一致するプロバイダーはありません。"}</p>}
						{catalog?.providers.length === 0 && <p className="settings-next-action">利用できるプロバイダーがありません。サーバーのモデル設定を確認してください。</p>}
					</div>
					{selectedProvider && <div className="settings-section settings-provider-section">
						<h4>{selectedProvider.name}</h4>
						<p className="credential-status" data-configured={selectedProvider.configured}>{selectedProvider.configured === true ? "認証設定あり" : selectedProvider.configured === false ? "認証未設定" : "認証状態は不明"}</p>
						{!selectedProvider.oauth && !selectedProvider.apiKey && <p className="settings-next-action">auth.json / models.json または環境変数で認証を設定し、設定画面を開き直してください。</p>}
						{selectedProvider.oauth && tab === "providers" && (selectedProvider.configured === true ? <details className="settings-reconnect"><summary>アカウントを再接続</summary><OAuthLogin key={llmProvider} provider={llmProvider} label={selectedProvider.oauth.label} disabled={busy} onActiveChange={setLoginActive} onComplete={accountConnected} /></details> : <OAuthLogin key={llmProvider} provider={llmProvider} label={selectedProvider.oauth.label} disabled={busy} onActiveChange={setLoginActive} onComplete={accountConnected} />)}
						{selectedProvider.apiKey && (selectedProvider.configured === true ? <details className="settings-reconnect"><summary>一時 API キーを変更{hasLlmKey ? " · 入力中（未反映）" : ""}</summary>{keyForm}</details> : <>
							{selectedProvider.oauth && <p className="auth-method-divider">または、一時 API キーで接続</p>}
							{keyForm}
						</>)}
					</div>}
				</section>
				<section className="settings-content" role="tabpanel" id={`${tabsId}-usage-panel`} aria-labelledby={`${tabsId}-usage-tab`} hidden={tab !== "usage"}>
					{tab === "usage" && <AccountUsagePanel />}
				</section>
				<section className="settings-content" role="tabpanel" id={`${tabsId}-search-panel`} aria-labelledby={`${tabsId}-search-tab`} hidden={tab !== "search"}>
					<h3>Web 検索</h3>
					<p className="settings-state">現在の既定: {SEARCH_PROVIDERS.find((provider) => provider.id === savedSettings?.search.defaultProvider)?.label} · {settings.search.configured[savedSettings?.search.defaultProvider ?? "brave"] ? "キー設定済み" : "キー未設定"}</p>
					<form onSubmit={(event) => { event.preventDefault(); if (!searchChanged) return; const provider = settings.search.defaultProvider; void perform(async () => {
						await command("/api/settings", { search: { defaultProvider: provider } }, "PATCH");
						setSavedSettings((current) => current && ({ ...current, search: { ...current.search, defaultProvider: provider } }));
					}, "既定の検索サービスを保存しました。", "既定の検索サービスを保存できませんでした。"); }}>
						<fieldset disabled={busy} className="settings-section"><legend>既定の検索サービス</legend>
							<label>プロバイダー<select value={settings.search.defaultProvider} onChange={(event) => { setSettings({ ...settings, search: { ...settings.search, defaultProvider: event.target.value as SearchProviderId } }); setNotice(undefined); }}>{SEARCH_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
							<p className="settings-inline-status" role="status">{searchChanged ? `未保存 · ${SEARCH_PROVIDERS.find((provider) => provider.id === settings.search.defaultProvider)?.label} に切り替えます。` : "変更なし"} {settings.search.configured[settings.search.defaultProvider] ? "キー設定済み" : "検索するには下でキーを保存してください。"}</p>
							<button type="submit" disabled={!searchChanged}>既定の検索サービスを保存</button>
						</fieldset>
					</form>
					<fieldset disabled={busy} className="settings-section"><legend>検索 API キー（サーバーに保存）</legend>
						{SEARCH_PROVIDERS.map(({ id: provider, label }) => <div className="credential-row" key={provider}>
							<label>{label} · {searchKeys[provider].trim() ? "新しいキーは未保存" : settings.search.configured[provider] ? "保存済み" : "キー未設定"}<input type="password" autoComplete="new-password" spellCheck={false} value={searchKeys[provider]} placeholder="新しい API キー" onChange={(event) => { setSearchKeys({ ...searchKeys, [provider]: event.target.value }); setNotice(undefined); }} /></label>
							<button type="button" disabled={!searchKeys[provider].trim()} onClick={() => { const key = searchKeys[provider]; void perform(async () => {
								await command(`/api/credentials/search/${provider}`, { key }, "PUT");
								setSearchKeys((keys) => ({ ...keys, [provider]: "" }));
								setSettings((current) => current && ({ ...current, search: { ...current.search, configured: { ...current.search.configured, [provider]: true } } }));
							}, `${label} のキーをサーバーに保存しました。`, `${label} のキーを保存できませんでした。`); }}>キーを保存</button>
							<button type="button" disabled={!settings.search.configured[provider]} onClick={() => { void perform(async () => {
								await api(`/api/credentials/search/${provider}`, { method: "DELETE" });
								setSettings((current) => current && ({ ...current, search: { ...current.search, configured: { ...current.search.configured, [provider]: false } } }));
							}, `${label} の保存済みキーを削除しました。`, `${label} の保存済みキーを削除できませんでした。`); }}>キーを削除</button>
						</div>)}
					</fieldset>
				</section>
				<section className="settings-content" role="tabpanel" id={`${tabsId}-agents-panel`} aria-labelledby={`${tabsId}-agents-tab`} hidden={tab !== "agents"}>
					<h3>エージェントチーム</h3>
					<p className="settings-state">現在の設定: 同時実行 {savedSettings?.teams.maxConcurrentAgents} · 最大深さ {savedSettings?.teams.maxDepth}</p>
					<form onSubmit={(event) => { event.preventDefault(); if (!teamsChanged) return; const teams = { ...settings.teams }; void perform(async () => {
						await command("/api/settings", { teams }, "PATCH");
						setSavedSettings((current) => current && ({ ...current, teams }));
					}, "エージェントチームの上限を保存しました。実行中のチームにも適用されます。", "エージェントチームの上限を保存できませんでした。"); }}>
						<fieldset disabled={busy} className="settings-section"><legend>実行の上限</legend>
							<label>チームごとの同時実行数<input type="number" min={1} max={32} step={1} required value={Number.isNaN(settings.teams.maxConcurrentAgents) ? "" : settings.teams.maxConcurrentAgents} onChange={(event) => { setSettings({ ...settings, teams: { ...settings.teams, maxConcurrentAgents: event.target.valueAsNumber } }); setNotice(undefined); }} /></label>
							<label>子エージェントの最大深さ<input type="number" min={1} max={8} step={1} required value={Number.isNaN(settings.teams.maxDepth) ? "" : settings.teams.maxDepth} onChange={(event) => { setSettings({ ...settings, teams: { ...settings.teams, maxDepth: event.target.valueAsNumber } }); setNotice(undefined); }} /></label>
							<p className="fine-print">1–8。深さ 1 は直下の子まで、深さ 2 は孫まで。</p>
							<p className="settings-inline-status" role="status">{teamsChanged ? "変更は未保存です。" : "変更なし"}</p>
							<button type="submit" disabled={!teamsChanged || !Number.isInteger(settings.teams.maxConcurrentAgents) || settings.teams.maxConcurrentAgents < 1 || settings.teams.maxConcurrentAgents > 32 || !Number.isInteger(settings.teams.maxDepth) || settings.teams.maxDepth < 1 || settings.teams.maxDepth > 8}>エージェント設定を保存</button>
						</fieldset>
					</form>
				</section>
				<section className="settings-content" role="tabpanel" id={`${tabsId}-environment-panel`} aria-labelledby={`${tabsId}-environment-tab`} hidden={tab !== "environment"}>
					<h3>実行環境</h3>
					<section className="settings-section"><h4>Browser use · Playwright</h4><p className="credential-status" data-configured={settings.browser?.ready}>{settings.browser?.ready ? "Chromium を利用できます。" : "Chromium の準備が必要です。"}</p>{settings.browser?.error && <p className="error">{settings.browser.error}</p>}{!settings.browser?.ready && <><p>サーバーを起動する環境で、次のコマンドを実行してください。</p><code>npx playwright install chromium</code><p className="fine-print">インストール後、この設定を開き直して状態を確認してください。</p></>}</section>
				</section>
			</>}
		</section>
	</div>;
}
