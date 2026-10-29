import { useEffect, useId, useRef, useState } from "react";
import { AccountUsagePanel } from "./AccountUsagePanel.tsx";
import { api, command, errorMessage } from "./api.ts";
import { HomeAppearance } from "./HomeAppearance.tsx";
import type { HomeBackground } from "./home-background.ts";
import { Presence } from "./Motion.tsx";
import { MotionSwap } from "./MotionSwap.tsx";
import "./SettingsMotion.css";
import { OAuthLogin } from "./OAuthLogin.tsx";
import type { ModelCatalog, Settings } from "./types.ts";

const TABS = [
	{ id: "providers", label: "プロバイダー" },
	{ id: "usage", label: "使用量" },
	{ id: "search", label: "検索" },
	{ id: "agents", label: "エージェント" },
	{ id: "appearance", label: "外観" },
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

export function SettingsDialog({ onClose, onSaved, homeBackground, onHomeBackgroundChange }: {
	onClose: () => void;
	onSaved: () => void;
	homeBackground?: HomeBackground;
	onHomeBackgroundChange: (next: HomeBackground | undefined) => void;
}) {
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
	const selectedJev = settings?.jev?.model;
	const jevProvider = catalog?.providers.find((provider) => provider.id === selectedJev?.provider);
	const jevProviders = catalog?.providers.filter((provider) => catalog.classifiers?.some((model) => model.provider === provider.id)) ?? [];
	const jevModels = catalog?.classifiers?.filter((model) => model.provider === selectedJev?.provider) ?? [];
	const jevChanged = selectedJev?.provider !== savedSettings?.jev?.model?.provider || selectedJev?.id !== savedSettings?.jev?.model?.id;
	const textModel = settings?.jevComputer?.textModel;
	const textModelChanged = textModel?.provider !== savedSettings?.jevComputer?.textModel.provider || textModel?.id !== savedSettings?.jevComputer?.textModel.id;

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
		}, "API キーを保存しました。", `${selectedProvider.name} のAPI キーを保存できませんでした。`);
	}}>
		<label htmlFor={keyId}>{selectedProvider.name} のAPI キー<input id={keyId} type="password" autoComplete="new-password" spellCheck={false} disabled={busy || loginActive} value={llmKey} placeholder="API キーを入力" onChange={(event) => {
			setLlmKeys((keys) => ({ ...keys, [selectedProvider.id]: event.target.value }));
			setNotice(undefined);
		}} /></label>
		<p className="settings-inline-status" role="status">{hasLlmKey ? "入力中 · 未保存" : selectedProvider.configured ? "認証設定あり" : "キー未設定"}</p>
		<p className="fine-print">サーバーに保存され、再起動後も利用できます。</p>
		<div className="settings-actions"><button type="submit" disabled={busy || loginActive || !hasLlmKey}>{busy ? "保存中…" : "API キーを保存"}</button></div>
	</form>;

	return <div className="dialog-backdrop" data-closing={closing} onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
		<section ref={dialog} className="settings-dialog" inert={closing} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} onTransitionEnd={(event) => { if (closing && event.target === event.currentTarget && event.propertyName === "opacity") onClose(); }} onTransitionCancel={(event) => { if (closing && event.target === event.currentTarget && event.propertyName === "opacity" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) onClose(); }} onKeyDown={(event) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); requestClose(); }
			if (event.key !== "Tab") return;
			const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled):not([tabindex='-1']), input:not(:disabled), select:not(:disabled), summary, a[href]") ?? [])].filter((element) => !element.matches(":disabled") && !element.closest("[inert]") && element.getClientRects().length > 0);
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
				event.preventDefault(); setTab(TABS[next].id); tabRefs.current[next]?.focus();
			}}>
				{TABS.map((entry, index) => <button key={entry.id} type="button" ref={(element) => { tabRefs.current[index] = element; }} role="tab" id={`${tabsId}-${entry.id}-tab`} aria-controls={`${tabsId}-${entry.id}-panel`} aria-selected={tab === entry.id} tabIndex={tab === entry.id ? 0 : -1} onClick={() => { if (tab !== entry.id) setTab(entry.id); }}>{entry.label}</button>)}
			</div>
			<Presence show={!!error} collapse><div className="error" role="alert"><p>{error}</p>{!settings && <button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>再読み込み</button>}</div></Presence>
			<Presence show={!!notice} collapse><p className="settings-notice" role="status">{notice}</p></Presence>
			<Presence show={!settings && !error} collapse><p role="status">設定を読み込み中…</p></Presence>
			<div className="settings-panels">
			<Presence show={tab === "appearance"} keepMounted><section className="settings-content" role="tabpanel" id={`${tabsId}-appearance-panel`} aria-labelledby={`${tabsId}-appearance-tab`}>
				<HomeAppearance background={homeBackground} onChange={onHomeBackgroundChange} />
			</section></Presence>
			{settings && <>
				<Presence show={tab === "providers"} keepMounted><section className="settings-content" role="tabpanel" id={`${tabsId}-providers-panel`} aria-labelledby={`${tabsId}-providers-tab`}>
					<h3>プロバイダーの認証</h3>
					<div className="settings-section settings-provider-section">
						<p className="settings-inline-status">認証設定あり: {catalog?.providers.filter((provider) => provider.configured).length ?? 0} / {catalog?.providers.length ?? 0} 件</p>
						<label>プロバイダーを検索<input type="search" value={providerQuery} disabled={busy || loginActive} placeholder="名前または ID で検索" onChange={(event) => setProviderQuery(event.target.value)} /></label>
						<label>プロバイダー<select value={llmProvider} disabled={busy || loginActive || !catalog?.providers.length} onChange={(event) => {
							const providerId = event.target.value;
							setLlmProvider(providerId); setNotice(undefined);
						}}>
							{!llmProvider && <option value="">プロバイダーを選択</option>}
							{selectedProvider && !matchingProviders.some((provider) => provider.id === selectedProvider.id) && <option value={selectedProvider.id}>{selectedProvider.name} · 現在の選択</option>}
							{matchingProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.configured === true ? "認証設定あり" : provider.configured === false ? "未設定" : "状態不明"}</option>)}
						</select></label>
						{providerQuery.trim() && <p className="settings-inline-status" role="status">{matchingProviders.length ? `${matchingProviders.length} 件が一致しました。` : "一致するプロバイダーはありません。"}</p>}
						{catalog?.providers.length === 0 && <p className="settings-next-action">利用できるプロバイダーがありません。サーバーのモデル設定を確認してください。</p>}
					</div>
					<MotionSwap identity={llmProvider} animateHeight>{selectedProvider && <div className="settings-section settings-provider-section">
						<h4>{selectedProvider.name}</h4>
						<p className="credential-status" data-configured={selectedProvider.configured}>{selectedProvider.configured === true ? "認証設定あり" : selectedProvider.configured === false ? "認証未設定" : "認証状態は不明"}</p>
						{!selectedProvider.oauth && !selectedProvider.apiKey && <p className="settings-next-action">auth.json / models.json または環境変数で認証を設定し、設定画面を開き直してください。</p>}
						{selectedProvider.oauth && tab === "providers" && (selectedProvider.configured === true ? <details className="settings-reconnect"><summary>アカウントを再接続</summary><OAuthLogin key={llmProvider} provider={llmProvider} label={selectedProvider.oauth.label} disabled={busy} onActiveChange={setLoginActive} onComplete={accountConnected} /></details> : <OAuthLogin key={llmProvider} provider={llmProvider} label={selectedProvider.oauth.label} disabled={busy} onActiveChange={setLoginActive} onComplete={accountConnected} />)}
						{selectedProvider.apiKey && (selectedProvider.configured === true ? <details className="settings-reconnect"><summary>API キーを変更{hasLlmKey ? " · 入力中（未反映）" : ""}</summary>{keyForm}</details> : <>
							{selectedProvider.oauth && <p className="auth-method-divider">または、API キーで接続</p>}
							{keyForm}
						</>)}
					</div>}</MotionSwap>
				</section></Presence>
				<Presence show={tab === "usage"}><section className="settings-content" role="tabpanel" id={`${tabsId}-usage-panel`} aria-labelledby={`${tabsId}-usage-tab`}>
					<AccountUsagePanel />
				</section></Presence>
				<Presence show={tab === "search"} keepMounted><section className="settings-content" role="tabpanel" id={`${tabsId}-search-panel`} aria-labelledby={`${tabsId}-search-tab`}>
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
				</section></Presence>
				<Presence show={tab === "agents"} keepMounted><section className="settings-content" role="tabpanel" id={`${tabsId}-agents-panel`} aria-labelledby={`${tabsId}-agents-tab`}>
					<h3>判断モデル · ワークスペース・会話の自動選択</h3>
					<form onSubmit={(event) => {
						event.preventDefault();
						if (busy || !jevChanged) return;
						void perform(async () => {
							const saved = await command<Settings>("/api/settings", { jev: { model: selectedJev ?? null } }, "PATCH");
							setSettings((current) => current && ({ ...current, jev: saved.jev }));
							setSavedSettings((current) => current && ({ ...current, jev: saved.jev }));
						}, "判断モデルの接続先を保存しました。", "判断モデルの接続先を保存できませんでした。");
					}}>
						<fieldset disabled={busy} className="settings-section"><legend>判断モデルの接続先</legend>
							<p>ホームで Ctrl / Cmd + Shift + Enter を押すと、作業内容からワークスペースと新規・既存の会話を選びます。曖昧な場合は入力欄の下に候補を表示します。既存の会話は履歴とモデル設定を引き継いで続行します。</p>
							<label>判断モデルのプロバイダー<select value={selectedJev?.provider ?? ""} onChange={(event) => {
								const provider = event.target.value;
								const first = catalog?.classifiers?.find((model) => model.provider === provider);
								setSettings((current) => current && ({ ...current, jev: { configured: !!catalog?.providers.find((entry) => entry.id === provider)?.configured, ...(first ? { model: { provider, id: first.id } } : {}) } }));
								setNotice(undefined);
							}}><option value="">選択してください</option>{selectedJev && !jevProviders.some((provider) => provider.id === selectedJev.provider) && <option value={selectedJev.provider}>{selectedJev.provider}（利用不可）</option>}{jevProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.configured ? "認証設定あり" : "未認証"}</option>)}</select></label>
							<label>判断モデル<select value={selectedJev?.id ?? ""} disabled={!jevModels.length} onChange={(event) => {
								if (!selectedJev) return;
								setSettings({ ...settings, jev: { ...settings.jev, configured: !!jevProvider?.configured, model: { provider: selectedJev.provider, id: event.target.value } } });
								setNotice(undefined);
							}}>{!selectedJev && <option value="">プロバイダーを選択してください</option>}{selectedJev && !jevModels.some((model) => model.id === selectedJev.id) && <option value={selectedJev.id}>{selectedJev.id}（利用不可）</option>}{jevModels.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id} · {model.id}</option>)}</select></label>
							<p className="settings-inline-status" role="status">{jevChanged ? "未保存 · " : ""}{selectedJev ? jevProvider?.configured ? "認証設定あり" : "プロバイダーの認証が必要です。" : "モデル未選択"}</p>
							<p className="fine-print">「プロバイダー」で設定した認証を共用します。</p>
							<p className="fine-print">本文・添付の名前と種類・登録フォルダーの概要・会話タイトルと直近の依頼・結果の抜粋を選択した判断モデルに送信します。添付ファイル本体は送信しません。</p>
							<div className="settings-actions"><button type="submit" disabled={!jevChanged || !!selectedJev && !jevModels.some((model) => model.id === selectedJev.id)}>接続先を保存</button>{selectedJev && <button type="button" onClick={() => { setLlmProvider(selectedJev.provider); setProviderQuery(""); setTab("providers"); }}>プロバイダーの認証設定</button>}</div>
						</fieldset>
					</form>
					<h3>判断モデルによる Computer Use</h3>
					<form onSubmit={(event) => {
						event.preventDefault();
						if (busy || !textModelChanged) return;
						void perform(async () => {
							const saved = await command<Settings>("/api/settings", { jevComputer: { textModel: textModel ?? null } }, "PATCH");
							setSettings((current) => current && ({ ...current, jevComputer: saved.jevComputer }));
							setSavedSettings((current) => current && ({ ...current, jevComputer: saved.jevComputer }));
						}, "文章生成モデルを保存しました。", "文章生成モデルを保存できませんでした。");
					}}>
						<fieldset disabled={busy} className="settings-section"><legend>入力する文章の生成</legend>
							<p>判断モデルが操作を選び、文章を作る必要があるときだけこのモデルを使います。指定された文字はそのまま入力します。</p>
							<p className="fine-print">Computer Useでは画面や操作候補を選択した判断モデルの接続先に送信します。</p>
							<label>文章生成モデル<select value={textModel ? JSON.stringify([textModel.provider, textModel.id]) : ""} onChange={(event) => {
								const selected = catalog?.models.find((model) => JSON.stringify([model.provider, model.id]) === event.target.value);
								setSettings((current) => current && ({ ...current, jevComputer: selected ? { textModel: { provider: selected.provider, id: selected.id } } : undefined }));
								setNotice(undefined);
							}}><option value="">選択してください</option>{textModel && !catalog?.models.some((model) => model.provider === textModel.provider && model.id === textModel.id) && <option value={JSON.stringify([textModel.provider, textModel.id])}>{textModel.provider} / {textModel.id}（利用不可）</option>}{catalog?.providers.map((provider) => {
								const models = catalog.models.filter((model) => model.provider === provider.id);
								return models.length ? <optgroup key={provider.id} label={provider.name}>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={JSON.stringify([model.provider, model.id])}>{model.name ?? model.id}</option>)}</optgroup> : null;
							})}</select></label>
							<p className="settings-inline-status">{textModelChanged ? "未保存 · " : ""}{textModel ? catalog?.providers.find((provider) => provider.id === textModel.provider)?.configured ? "認証設定あり" : "プロバイダーの認証が必要です。" : "文章生成モデル未選択"}</p>
							<button type="submit" disabled={!textModelChanged}>文章生成モデルを保存</button>
						</fieldset>
					</form>
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
				</section></Presence>
				<Presence show={tab === "environment"} keepMounted><section className="settings-content" role="tabpanel" id={`${tabsId}-environment-panel`} aria-labelledby={`${tabsId}-environment-tab`}>
					<h3>実行環境</h3>
					<section className="settings-section"><h4>Browser use · Playwright</h4><p className="credential-status" data-configured={settings.browser?.ready}>{settings.browser?.ready ? "Chromium を利用できます。" : "Chromium の準備が必要です。"}</p>{settings.browser?.error && <p className="error">{settings.browser.error}</p>}{!settings.browser?.ready && <><p>サーバーを起動する環境で、次のコマンドを実行してください。</p><code>npx playwright install chromium</code><p className="fine-print">インストール後、この設定を開き直して状態を確認してください。</p></>}</section>
					<section className="settings-section"><h4>Computer use · デスクトップ操作</h4>
						<p className="credential-status" data-configured={settings.computer?.ready}>{settings.computer?.ready ? "デスクトップを操作できます。" : "デスクトップ操作の準備が必要です。"}</p>
						<p>画面取得・クリック・ドラッグ・スクロール・文字入力・キー操作に対応します。操作対象はサーバーを実行しているPCです。</p>
						{settings.computer?.error && <p className="error">{settings.computer.error}</p>}
						{!settings.computer?.ready && settings.computer?.setup.map((instruction) => <p key={instruction}><code>{instruction}</code></p>)}
						<p className="fine-print">macOSは画面収録・アクセシビリティの許可が必要です。LinuxはX11に対応し、Waylandには対応していません。準備後、設定を開き直してください。</p>
					</section>
				</section></Presence>
			</>}
			</div>
		</section>
	</div>;
}
