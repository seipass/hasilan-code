import { useEffect, useId, useRef, useState } from "react";
import { api, command, errorMessage } from "./api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { OAuthLogin } from "./OAuthLogin.tsx";
import type { Model, ModelCatalog } from "./types.ts";

export function ModelMenu({ catalog, value, onChange, onConnected, onClosingChange, onClose, disabled }: {
	catalog?: ModelCatalog;
	value?: Model;
	onChange: (selection: Model) => Promise<void>;
	onConnected: (catalog: ModelCatalog) => void;
	onClosingChange: (closing: boolean) => void;
	onClose: () => void;
	disabled: boolean;
}) {
	const [pending, setPending] = useState<Model>();
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [loginActive, setLoginActive] = useState(false);
	const [error, setError] = useState<string>();
	const [closing, setClosing] = useState(false);
	const menu = useRef<HTMLDivElement>(null);
	const keyInput = useRef<HTMLInputElement>(null);
	const titleId = useId();
	const provider = catalog?.providers.find((entry) => entry.id === pending?.provider);
	const accountProvider = catalog?.providers.find((entry) => entry.id === "openai" && entry.oauth) ?? catalog?.providers.find((entry) => entry.id === "openai-codex" && entry.oauth);
	const requestClose = () => {
		if (closing || busy) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onClose();
		else { setClosing(true); onClosingChange(true); }
	};
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (!closing && !busy && event.target instanceof Element && !menu.current?.contains(event.target) && !event.target.closest(".model-trigger")) requestClose();
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [busy, closing, onClose]);
	useEffect(() => { if (pending && !provider?.oauth) keyInput.current?.focus(); }, [pending, provider?.oauth]);

	async function choose(selection: Model) {
		if (busy || disabled || loginActive) return;
		setError(undefined);
		if (catalog?.providers.find((entry) => entry.id === selection.provider)?.configured === false) {
			setPending(selection); setKey(""); return;
		}
		setBusy(true);
		try { await onChange(selection); }
		catch (reason) { setError(errorMessage(reason)); }
		finally { setBusy(false); }
	}

	async function connect() {
		if (!pending || busy || disabled || loginActive || !provider?.apiKey || (provider.configured === false && !key.trim())) return;
		setBusy(true); setError(undefined);
		try {
			if (key.trim()) {
				await command(`/api/credentials/llm/${encodeURIComponent(pending.provider)}`, { key: key.trim() }, "PUT");
				setKey("");
				if (catalog) onConnected({ ...catalog, providers: catalog.providers.map((entry) => entry.id === pending.provider ? { ...entry, configured: true } : entry) });
			}
			onConnected(await api<ModelCatalog>("/api/models"));
			await onChange(pending);
		} catch (reason) { setError(errorMessage(reason)); }
		finally { setBusy(false); }
	}

	async function accountConnected() {
		setBusy(true); setError(undefined);
		try {
			onConnected(await api<ModelCatalog>("/api/models"));
			if (pending) await onChange(pending);
		} finally { setBusy(false); }
	}

	return <div ref={menu} className="composer-popover model-popover" data-closing={closing} inert={closing} role="dialog" aria-labelledby={titleId} aria-busy={busy || loginActive} onAnimationEnd={(event) => { if (closing && event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => {
		if (event.key !== "Escape") return;
		event.preventDefault(); event.stopPropagation();
		if (!busy) { requestClose(); document.querySelector<HTMLButtonElement>(".model-trigger")?.focus(); }
	}}>
		<header><strong id={titleId}>{pending ? `${provider?.name ?? pending.provider} に接続` : "モデルを選択"}</strong><button className="icon-button" type="button" disabled={busy || closing} aria-label="モデル選択を閉じる" onClick={() => { requestClose(); document.querySelector<HTMLButtonElement>(".model-trigger")?.focus(); }}>×</button></header>
		{pending ? <div className="model-connect">
			<p><strong>{pending.name ?? pending.id}</strong></p>
			{provider?.configured && <p className="credential-status" data-configured="true">保存済みの認証を利用できます。再入力は不要です。</p>}
			{provider?.oauth && <OAuthLogin key={provider.id} provider={provider.id} label={provider.oauth.label} disabled={busy || disabled} onActiveChange={setLoginActive} onComplete={accountConnected} />}
			{provider?.apiKey && <form className="model-key-connect" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
				{provider.oauth && <p className="auth-method-divider">または API キーで接続</p>}
				<label>API キー<input ref={keyInput} type="password" autoComplete="new-password" spellCheck={false} value={key} disabled={busy || disabled || loginActive} placeholder={provider.configured ? "空欄なら現在の認証を使う" : "API キーを入力"} onChange={(event) => setKey(event.target.value)} /></label>
				<p className="fine-print">API キーはこのサーバーの起動中だけ有効です。Hasilan Code の保存済み認証・環境変数があれば再入力は不要です。キーの有効性はモデル実行時に確認されます。</p>
				<div className="model-connect-actions"><button type="submit" disabled={busy || disabled || loginActive || (provider.configured === false && !key.trim())}>{busy ? "設定中…" : "API キーで接続して選択"}</button></div>
			</form>}
			{!provider?.oauth && !provider?.apiKey && <p className="fine-print">このプロバイダーの認証は Hasilan Code 専用の設定や環境変数で設定してください。</p>}
			<div className="model-connect-actions"><button type="button" disabled={busy} onClick={() => { setPending(undefined); setKey(""); setError(undefined); }}>モデル一覧に戻る</button></div>
		</div> : <>
			{accountProvider?.oauth && accountProvider.configured === false && <div className="model-account-entry"><OAuthLogin key={accountProvider.id} provider={accountProvider.id} label={accountProvider.oauth.label} disabled={busy || disabled} onActiveChange={setLoginActive} onComplete={accountConnected} /></div>}
			<ModelPicker catalog={catalog} value={value} onChange={(selection) => { void choose(selection); }} disabled={busy || disabled || loginActive} autoFocus />
		</>}
		{disabled && <p className="fine-print">実行が終わるとモデルを変更できます。</p>}
		{error && <p className="composer-error" role="alert">{error}</p>}
	</div>;
}
