import type { AuthEvent } from "@earendil-works/pi-ai";
import { useEffect, useId, useRef, useState } from "react";
import type { AuthLoginPrompt, AuthLoginView } from "../shared/auth-login.ts";
import { ApiError, api, command, errorMessage } from "./api.ts";

interface LoginAttempt {
	loginId?: string;
	cancelled: boolean;
	finished: boolean;
	submitting: boolean;
	timer?: number;
	pollController?: AbortController;
	cancellation?: Promise<AuthLoginView>;
}

function stopPolling(attempt: LoginAttempt) {
	clearTimeout(attempt.timer);
	attempt.pollController?.abort();
	attempt.pollController = undefined;
}

function cancelOwnedLogin(attempt: LoginAttempt) {
	attempt.cancelled = true;
	stopPolling(attempt);
	if (!attempt.loginId || attempt.finished) return undefined;
	attempt.cancellation ??= api<AuthLoginView>(`/api/auth/login/${encodeURIComponent(attempt.loginId)}`, { method: "DELETE", keepalive: true });
	return attempt.cancellation;
}

function safeAuthUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch { return undefined; }
}

function LoginEvent({ event }: { event: AuthEvent }) {
	if (event.type === "auth_url") {
		const url = safeAuthUrl(event.url);
		return <>{event.instructions && <p>{event.instructions}</p>}{url ? <a className="oauth-auth-link" href={url} target="_blank" rel="noopener noreferrer">ログインページを開く</a> : <p className="error">安全なログイン用 URL を確認できません。</p>}</>;
	}
	if (event.type === "device_code") {
		const url = safeAuthUrl(event.verificationUri);
		return <><p>確認ページを開き、このコードを入力してください。</p><code className="oauth-device-code" aria-label="デバイスコード">{event.userCode}</code>{url ? <a className="oauth-auth-link" href={url} target="_blank" rel="noopener noreferrer">デバイスの確認ページを開く</a> : <p className="error">安全な確認用 URL を確認できません。</p>}{event.expiresInSeconds !== undefined && <p className="fine-print">コードの有効期間: {event.expiresInSeconds} 秒</p>}</>;
	}
	return <><p>{event.message}</p>{event.type === "info" && event.links?.map((link, index) => {
		const url = safeAuthUrl(link.url);
		return url ? <a key={index} href={url} target="_blank" rel="noopener noreferrer">{link.label ?? "案内ページを開く"}</a> : null;
	})}</>;
}

function LoginPrompt({ prompt, disabled, onSubmit }: { prompt: AuthLoginPrompt; disabled: boolean; onSubmit: (promptId: string, value: string) => Promise<void> }) {
	const [value, setValue] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const promptId = useId();
	useEffect(() => { input.current?.focus(); }, []);
	if (prompt.type === "select") return <fieldset className="oauth-prompt" disabled={disabled}><legend>{prompt.message}</legend>{prompt.options?.map((option) => <button type="button" className="oauth-prompt-option" key={option.id} onClick={() => { void onSubmit(prompt.id, option.id); }}><strong>{option.label}</strong>{option.description && <span className="fine-print">{option.description}</span>}</button>)}</fieldset>;
	return <form className="oauth-prompt" onSubmit={(event) => {
		event.preventDefault();
		if (disabled || !value.trim()) return;
		const entered = value;
		void onSubmit(prompt.id, entered);
	}}><label htmlFor={promptId}>{prompt.message}<input ref={input} id={promptId} type={prompt.type === "secret" ? "password" : "text"} autoComplete="off" spellCheck={false} autoCapitalize="none" value={value} placeholder={prompt.placeholder} disabled={disabled} onChange={(event) => setValue(event.target.value)} /></label>{prompt.type === "manual_code" && <p className="fine-print">ブラウザーでログインした後のコード、またはコールバック URL を入力してください。自動で受け取れた場合、この入力欄は消えます。</p>}<button type="submit" disabled={disabled || !value.trim()}>送信して続ける</button></form>;
}

export function OAuthLogin({ provider, label, onComplete, onActiveChange, disabled = false }: {
	provider: string;
	label: string;
	onComplete: () => Promise<void>;
	onActiveChange?: (active: boolean) => void;
	disabled?: boolean;
}) {
	const [view, setView] = useState<AuthLoginView>();
	const [starting, setStarting] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [refreshFailed, setRefreshFailed] = useState(false);
	const [error, setError] = useState<string>();
	const mounted = useRef(false);
	const attempt = useRef<LoginAttempt | undefined>(undefined);
	const completion = useRef(onComplete);
	const activeChange = useRef(onActiveChange);
	completion.current = onComplete;
	activeChange.current = onActiveChange;
	const active = starting || cancelling || view?.status === "pending";
	useEffect(() => { activeChange.current?.(active); }, [active]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (attempt.current) void cancelOwnedLogin(attempt.current)?.catch(() => {});
			activeChange.current?.(false);
		};
	}, []);

	async function complete() {
		setRefreshing(true); setRefreshFailed(false); setError(undefined);
		try { await completion.current(); }
		catch (reason: unknown) {
			if (mounted.current) {
				setRefreshFailed(true);
				setError(`ログインは完了しましたが、認証状態の更新に失敗しました。詳細: ${errorMessage(reason)}`);
			}
		} finally { if (mounted.current) setRefreshing(false); }
	}

	function schedulePoll(current: LoginAttempt) {
		if (!mounted.current || attempt.current !== current || current.cancelled || current.finished || current.submitting) return;
		clearTimeout(current.timer);
		current.timer = window.setTimeout(() => { void poll(current); }, 900);
	}

	function receive(current: LoginAttempt, snapshot: AuthLoginView) {
		if (!mounted.current || attempt.current !== current) return;
		setView(snapshot); setStarting(false); setCancelling(false); setError(undefined);
		if (snapshot.status === "pending") { schedulePoll(current); return; }
		current.finished = true;
		setSubmitting(false);
		stopPolling(current);
		if (snapshot.status === "completed") void complete();
	}

	async function poll(current: LoginAttempt) {
		if (!current.loginId || current.cancelled || current.finished || current.submitting) return;
		const controller = new AbortController();
		current.pollController = controller;
		try {
			const snapshot = await api<AuthLoginView>(`/api/auth/login/${encodeURIComponent(current.loginId)}`, { signal: controller.signal });
			if (!controller.signal.aborted && !current.cancelled && !current.finished) receive(current, snapshot);
		} catch (reason: unknown) {
			if (!controller.signal.aborted && mounted.current && attempt.current === current && !current.cancelled) {
				setError(`ログイン状況を確認できません。自動で再確認しています。詳細: ${errorMessage(reason)}`);
				schedulePoll(current);
			}
		} finally { if (current.pollController === controller) current.pollController = undefined; }
	}

	async function cancel(current = attempt.current) {
		if (!current || current.finished) return;
		setCancelling(true); setError(undefined);
		try {
			const snapshot = await cancelOwnedLogin(current);
			if (snapshot) receive(current, snapshot);
		} catch (reason: unknown) {
			current.cancellation = undefined;
			if (mounted.current && attempt.current === current) {
				setCancelling(false);
				setError(`ログインをキャンセルできませんでした。詳細: ${errorMessage(reason)}`);
			}
		}
	}

	async function start() {
		if (disabled || active || refreshing || (attempt.current && !attempt.current.finished)) return;
		const current: LoginAttempt = { cancelled: false, finished: false, submitting: false };
		attempt.current = current;
		setView(undefined); setStarting(true); setSubmitting(false); setCancelling(false); setError(undefined); setRefreshFailed(false);
		let snapshot: AuthLoginView;
		try { snapshot = await command<AuthLoginView>("/api/auth/login", { provider }); }
		catch (reason: unknown) {
			current.finished = true;
			if (mounted.current && attempt.current === current) {
				setStarting(false); setCancelling(false);
				setError(`${reason instanceof ApiError && reason.status === 409 ? "別のログインが進行中です。先にそのログインを完了またはキャンセルしてから再試行してください。" : "ログインを開始できませんでした。"} 詳細: ${errorMessage(reason)}`);
			}
			return;
		}
		current.loginId = snapshot.loginId;
		if (!mounted.current || current.cancelled) {
			if (mounted.current) { setStarting(false); setView(snapshot); await cancel(current); }
			else void cancelOwnedLogin(current)?.catch(() => {});
			return;
		}
		receive(current, snapshot);
	}

	async function submitPrompt(promptId: string, value: string) {
		const current = attempt.current;
		if (!current?.loginId || current.cancelled || current.finished || current.submitting || disabled || view?.prompt?.id !== promptId) return;
		current.submitting = true;
		stopPolling(current);
		setSubmitting(true); setError(undefined);
		try {
			const snapshot = await command<AuthLoginView>(`/api/auth/login/${encodeURIComponent(current.loginId)}/prompt`, { promptId, value });
			if (!current.cancelled) receive(current, snapshot);
		} catch (reason: unknown) {
			if (mounted.current && attempt.current === current && !current.cancelled) setError(`入力を送信できませんでした。ログイン状況を再確認します。詳細: ${errorMessage(reason)}`);
		} finally {
			current.submitting = false;
			if (mounted.current && attempt.current === current) setSubmitting(false);
			schedulePoll(current);
		}
	}

	const buttonLabel = provider === "openai" || provider === "openai-codex" ? "ChatGPTでログイン" : label;
	return <section className="oauth-login" data-provider={provider} aria-label="アカウントでログイン" aria-busy={starting || submitting || cancelling || refreshing}>
		{!active && view?.status !== "completed" && <button className="oauth-login-start" type="button" disabled={disabled || refreshing} onClick={() => { void start(); }}>{view || error ? `${buttonLabel}を再試行` : buttonLabel}</button>}
		{(starting || (view && view.status !== "failed") || cancelling || refreshing) && <p className="oauth-login-status" role="status">{cancelling ? "ログインをキャンセル中…" : starting ? "ログインを開始中…" : refreshing ? "ログイン完了 · モデル一覧に反映中…" : view?.status === "pending" ? submitting ? "入力を送信中…" : view.prompt ? "ログインの操作を選択・入力してください。" : "ブラウザーまたはデバイスでのログイン完了を待っています…" : view?.status === "completed" ? "アカウントのログインが完了しました。" : view?.status === "cancelled" ? "ログインをキャンセルしました。接続方法を選び直せます。" : ""}</p>}
		{view?.events.length ? <ol className="oauth-login-events" aria-label="ログインの手順">{view.events.map((event, index) => <li key={index}><LoginEvent event={event} /></li>)}</ol> : null}
		{view?.status === "pending" && view.prompt && !attempt.current?.cancelled && <LoginPrompt key={view.prompt.id} prompt={view.prompt} disabled={disabled || submitting || cancelling} onSubmit={submitPrompt} />}
		{view?.status === "failed" && <div className="error" role="alert"><p>ログインに失敗しました。</p>{view.error && <details><summary>エラーの詳細</summary><pre>{view.error}</pre></details>}</div>}
		{error && <p className="error" role="alert">{error}</p>}
		{active && <button className="oauth-login-cancel" type="button" disabled={cancelling} onClick={() => { void cancel(); }}>ログインをキャンセル</button>}
		{refreshFailed && <button type="button" disabled={refreshing || disabled} onClick={() => { void complete(); }}>ログイン結果をもう一度反映</button>}
	</section>;
}
