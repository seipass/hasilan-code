import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import { type BrowserControl, type BrowserStyles, browserPreviewStyles } from "../shared/browser-adjustments.ts";
import { BROWSER_ADJUSTMENTS_ID } from "../shared/plugin-profile.ts";
import { usePluginProfile } from "./plugins/profile.tsx";
import { api, errorMessage } from "./api.ts";
import { BrowserAdjustmentControls } from "./BrowserAdjustmentControls.tsx";
import { BrowserCssEditor } from "./BrowserCssEditor.tsx";
import { browserCommentPosition } from "./browser-comment-position.ts";
import { Icon } from "./Icon.tsx";
import { usePreferenceState } from "./preferences.ts";
import type { Model } from "./types.ts";
import "./BrowserPane.css";

export interface BrowserSelection {
	kind: "element" | "text" | "region";
	url: string;
	title: string;
	viewport: { width: number; height: number };
	rect: { x: number; y: number; width: number; height: number };
	selector?: string;
	label?: string;
	text?: string;
	adjustmentId?: number;
	styles?: BrowserStyles;
	inlineStyles?: BrowserStyles;
	tag?: string;
	parentLayout?: string;
	children?: number;
}
export interface BrowserAnnotation { selection: BrowserSelection; image: string; note: string }
export interface BrowserAnnotationDelivery { annotation: BrowserAnnotation; accepted: boolean }

function addressCandidate(input: string) {
	const value = input.trim();
	if (!value) return undefined;
	const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?:[:/?#]|$)/i.test(value);
	const explicit = /^(?:https?:|[a-z][a-z\d+.-]*:\/\/)/i.test(value);
	const authority = value.split(/[/?#]/, 1)[0];
	const looksLikeHost = local || (!/\s/.test(authority) && /[.。．｡]|:\d+$|^\[/.test(authority));
	try {
		if (explicit || looksLikeHost || value.startsWith("//")) {
			const url = new URL(explicit ? value : `${local ? "http" : "https"}://${value.replace(/^\/\//, "")}`);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
			return { url: url.href, label: url.href, detail: "ウェブサイトを開く", icon: "arrowUpRight" as const };
		}
		return { url: `https://duckduckgo.com/?q=${encodeURIComponent(value)}`, label: value, detail: "DuckDuckGo で検索", icon: "search" as const };
	} catch {
		return undefined;
	}
}

export function BrowserPane({ initialUrl, visible, model }: { initialUrl?: string; visible: boolean; model?: Model }) {
	const pane = useRef<HTMLElement>(null);
	const container = useRef<HTMLDivElement>(null);
	const commentForm = useRef<HTMLFormElement>(null);
	const selectionEpoch = useRef(0);
	const browser = useRef<WebviewTag>(null);
	const addressInput = useRef<HTMLInputElement>(null);
	const historyListId = useId();
	const [pageAddress, setPageAddress] = useState(initialUrl ?? "");
	const [draftAddress, setDraftAddress] = useState<string>();
	const [addressFocused, setAddressFocused] = useState(false);
	const [activeSuggestion, setActiveSuggestion] = useState(0);
	const address = draftAddress ?? pageAddress;
	const [ready, setReady] = useState(false);
	const [annotating, setAnnotating] = useState(false);
	const [selection, setSelection] = useState<BrowserSelection>();
	const [anchor, setAnchor] = useState<{ id: number; rect: BrowserSelection["rect"]; viewport: BrowserSelection["viewport"] }>();
	const [commentSize, setCommentSize] = useState<{ area: BrowserSelection["viewport"]; bubble: BrowserSelection["viewport"] }>();
	const [image, setImage] = useState("");
	const [note, setNote] = useState("");
	const [controls, setControls] = useState<BrowserControl[]>();
	const [adjusted, setAdjusted] = useState<BrowserStyles>({});
	const adjustedRef = useRef<BrowserStyles>({});
	const adjustmentsEnabled = usePluginProfile()?.activeIds.includes(BROWSER_ADJUSTMENTS_ID) ?? true;
	const [intent, setIntent] = useState("");
	const [suggesting, setSuggesting] = useState(false);
	const suggestionRequest = useRef<AbortController | undefined>(undefined);
	function resetAdjustments() {
		selectionEpoch.current++;
		setAnchor(undefined);
		setCommentSize(undefined);
		suggestionRequest.current?.abort();
		suggestionRequest.current = undefined;
		setControls(undefined);
		adjustedRef.current = {};
		setAdjusted({});
		setIntent("");
		setSuggesting(false);
	}
	const commentOpen = !!selection && !!image;
	useLayoutEffect(() => {
		const form = commentForm.current;
		const content = container.current;
		if (!commentOpen || !form || !content) return;
		const measure = () => setCommentSize({
			area: { width: content.clientWidth, height: content.clientHeight },
			bubble: { width: form.offsetWidth, height: form.offsetHeight },
		});
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(content);
		observer.observe(form);
		return () => observer.disconnect();
	}, [commentOpen]);
	const commentAnchor = anchor ?? selection;
	const commentPosition = commentSize && commentAnchor
		? browserCommentPosition(commentAnchor, commentSize.area, commentSize.bubble)
		: undefined;
	useEffect(() => () => suggestionRequest.current?.abort(), []);
	const [error, setError] = useState("");
	const [history, setHistory] = usePreferenceState<{ url: string; title: string; visitedAt: number }[]>("pi-web-browser-history", []);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyQuery, setHistoryQuery] = useState("");
	const [navigation, setNavigation] = useState({ back: false, forward: false, loading: false });
	const [sleeping, setSleeping] = useState(false);
	const suspended = useRef<{ encoded: string; url: string; x: number; y: number } | undefined>(undefined);
	const canSuspend = !visible && ready && !annotating && !selection && !image && !note && !navigation.loading;
	const canSuspendRef = useRef(canSuspend);
	canSuspendRef.current = canSuspend;
	const query = draftAddress?.trim().toLowerCase() ?? "";
	const primary = addressCandidate(query ? draftAddress ?? "" : "");
	const suggestions = query ? [
		...(primary ? [primary] : []),
		...history
			.filter((entry) => entry.url !== primary?.url && `${entry.title} ${entry.url}`.toLowerCase().includes(query))
			.slice(0, 5)
			.map((entry) => ({ url: entry.url, label: entry.title, detail: entry.url, icon: "arrowUpRight" as const })),
	] : [];
	const selectedSuggestion = Math.min(activeSuggestion, suggestions.length - 1);
	const suggestionsOpen = ready && addressFocused && suggestions.length > 0;
	useEffect(() => {
		const navigateHistory = (event: Event) => {
			const view = browser.current;
			if (!visible || !ready || !view || !pane.current?.contains(document.activeElement)) return;
			const direction = (event as CustomEvent<unknown>).detail;
			if (direction === "browser-backward" && view.canGoBack()) view.goBack();
			else if (direction === "browser-forward" && view.canGoForward()) view.goForward();
		};
		window.addEventListener("hasilan:browser-side-navigation", navigateHistory);
		return () => window.removeEventListener("hasilan:browser-side-navigation", navigateHistory);
	}, [visible, ready]);
	useEffect(() => {
		if (visible && sleeping) setSleeping(false);
	}, [visible, sleeping]);
	useEffect(() => {
		if (!canSuspend) return;
		const timer = window.setTimeout(() => browser.current?.send("hasilan:browser-suspend"), 5 * 60_000);
		return () => window.clearTimeout(timer);
	}, [canSuspend, pageAddress]);
	useEffect(() => {
		const host = container.current;
		if (!host || sleeping) return;
		const restore = suspended.current;
		suspended.current = undefined;
		const view = document.createElement("webview") as WebviewTag;
		view.setAttribute("src", restore ? `about:blank#resume=${restore.encoded}` : "about:blank");
		view.setAttribute("partition", "persist:hasilan-browser");
		view.className = "browser-webview";
		browser.current = view;
		let initial = restore ? undefined : initialUrl;
		let restoreScroll = !!restore;
		const ready = () => {
			setReady(true);
			if (initial) { const url = initial; initial = undefined; void view.loadURL(url).catch(() => setError("ページを開けませんでした。")); }
		};
		const updateNavigation = () => setNavigation({ back: view.canGoBack(), forward: view.canGoForward(), loading: view.isLoading() });
		const navigate = (event: Electron.DidNavigateEvent | Electron.DidNavigateInPageEvent) => {
			if ("isMainFrame" in event && !event.isMainFrame) return;
			setPageAddress(event.url === "about:blank" ? "" : event.url);
			updateNavigation();
			view.send("hasilan:browser-clear");
			resetAdjustments(); setAnnotating(false); setSelection(undefined); setImage(""); setNote(""); setError("");
		};
		const loaded = () => {
			updateNavigation();
			const url = view.getURL();
			if (!/^https?:\/\//i.test(url)) return;
			if (restore && restoreScroll) {
				restoreScroll = false;
				if (url === restore.url) void view.executeJavaScript(`scrollTo(${restore.x}, ${restore.y})`).catch(() => undefined);
			}
			setHistory((previous) => [{ url: url.slice(0, 8192), title: (view.getTitle() || url).slice(0, 512), visitedAt: Date.now() }, ...previous.filter((entry) => entry.url !== url)].slice(0, 200));
		};
		const message = (event: Electron.IpcMessageEvent) => {
			if (event.channel === "hasilan:browser-snapshot") {
				const [encoded, url, x, y] = event.args as [string, string, number, number];
				if (!canSuspendRef.current || view.isLoading() || view.isCurrentlyAudible() || url !== view.getURL() ||
					!/^https?:\/\//i.test(url) || !Number.isFinite(x) || !Number.isFinite(y)) return;
				suspended.current = { encoded, url, x, y };
				setReady(false);
				setSleeping(true);
				return;
			}
			if (event.channel === "hasilan:browser-focus-address") { addressInput.current?.focus(); addressInput.current?.select(); return; }
			if (event.channel === "hasilan:browser-cancel") { setAnnotating(false); return; }
			if (event.channel === "hasilan:browser-adjustment-stale") { resetAdjustments(); setSelection(undefined); setImage(""); setNote(""); setError("要素が変わりました。もう一度選択してください。"); return; }
			if (event.channel === "hasilan:browser-selection-position") {
				const [id, rect, viewport] = event.args as [number, BrowserSelection["rect"], BrowserSelection["viewport"]];
				setAnchor((current) => current?.id === id ? { id, rect, viewport } : current);
				return;
			}
			if (event.channel !== "hasilan:browser-selection") return;
			const selected = event.args[0] as BrowserSelection & { id: number };
			const epoch = ++selectionEpoch.current;
			setAnchor({ id: selected.id, rect: selected.rect, viewport: selected.viewport });
			setAnnotating(false); setError("");
			void view.capturePage().then((capture) => {
				if (epoch !== selectionEpoch.current || browser.current !== view) return;
				if (view.getURL() !== selected.url) throw new Error("Page changed");
				setSelection(selected); setImage(capture.toDataURL());
			}).catch(() => {
				if (epoch === selectionEpoch.current && browser.current === view)
					setError("スクリーンショットを取得できませんでした。もう一度選択してください。");
			});
		};
		view.addEventListener("dom-ready", ready);
		view.addEventListener("did-navigate", navigate);
		view.addEventListener("did-navigate-in-page", navigate);
		view.addEventListener("ipc-message", message);
		view.addEventListener("did-start-loading", updateNavigation);
		view.addEventListener("did-stop-loading", updateNavigation);
		view.addEventListener("did-finish-load", loaded);
		host.append(view);
		return () => { browser.current = null; view.remove(); };
	}, [sleeping]);
	function navigate(destination = address) {
		const view = browser.current;
		const value = destination.trim();
		if (!ready || !view || !value) return;
		try {
			const candidate = addressCandidate(value);
			if (!candidate) throw new Error();
			view.send("hasilan:browser-clear");
			resetAdjustments(); setSelection(undefined); setImage(""); setNote(""); setAnnotating(false); setError("");
			setPageAddress(candidate.url);
			setDraftAddress(undefined);
			addressInput.current?.blur();
			view.focus();
			void view.loadURL(candidate.url).catch((reason: unknown) => {
				if (!(reason instanceof Error && reason.message.includes("ERR_ABORTED"))) setError("ページを開けませんでした。");
			});
		} catch { setError("有効なURLを入力してください。"); }
	}
	function toggleAnnotation() {
		if (!ready) return;
		resetAdjustments(); setSelection(undefined); setImage(""); setNote(""); setError("");
		setAnnotating(!annotating);
		if (annotating) browser.current?.send("hasilan:browser-clear");
		else {
			browser.current?.send("hasilan:browser-select", "inspect");
			browser.current?.focus();
		}
	}
	async function suggestAdjustments() {
		if (!model || !selection?.adjustmentId || suggestionRequest.current) return;
		const controller = new AbortController();
		suggestionRequest.current = controller;
		setSuggesting(true); setError("");
		try {
			const { styles, inlineStyles, tag, parentLayout, children } = selection;
			const elementContext = {
				tag, label: selection.label?.slice(0, 240), selector: selection.selector?.slice(0, 240),
				rect: selection.rect, styles: {} as BrowserStyles, parentLayout, children,
			};
			const relevant = Object.entries(styles ?? {}).filter(([key]) =>
				/^(display$|position$|(?:align|justify|flex|grid|padding|margin|font|border|background|text)-|color$|opacity$|.*gap$|box-shadow$|transform$)/.test(key));
			const candidates = { ...inlineStyles, ...adjusted, ...Object.fromEntries(relevant.filter(([key]) =>
				!Object.hasOwn(inlineStyles ?? {}, key) && !Object.hasOwn(adjusted, key))) };
			let element = JSON.stringify(elementContext);
			for (const [key, value] of Object.entries(candidates)) {
				elementContext.styles[key] = value?.slice(0, 160) ?? null;
				const next = JSON.stringify(elementContext);
				if (next.length > 4000) break;
				element = next;
			}
			const result = await api<{ controls: BrowserControl[] }>("/api/browser-adjustments", {
				method: "POST", body: JSON.stringify({ provider: model.provider, id: model.id, element, intent: intent.trim() }), signal: controller.signal,
			});
			if (!controller.signal.aborted) setControls(result.controls);
		} catch (reason) {
			if (!controller.signal.aborted) setError(errorMessage(reason));
		} finally {
			if (suggestionRequest.current === controller) { suggestionRequest.current = undefined; setSuggesting(false); }
		}
	}
	function updatePreview(next: BrowserStyles): boolean {
		if (selection?.adjustmentId === undefined) return false;
		if (!browserPreviewStyles(next) || Object.entries(next).some(([property, value]) => value !== null && !CSS.supports(property, value))) {
			setError("このCSSプロパティと値の組み合わせは適用できません。");
			return false;
		}
		browser.current?.send("hasilan:browser-adjustment", selection.adjustmentId, next);
		adjustedRef.current = next;
		setAdjusted(next);
		setError("");
		return true;
	}
	function closeComment() {
		browser.current?.send("hasilan:browser-clear");
		resetAdjustments();
		setSelection(undefined);
		setImage("");
		setNote("");
		setError("");
		browser.current?.focus();
	}
	return <section ref={pane} className="browser-pane" aria-label="ブラウザ" onKeyDown={(event) => {
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
			event.preventDefault();
			addressInput.current?.focus();
			addressInput.current?.select();
		}
	}}>
		<form className="browser-toolbar" onSubmit={(event) => { event.preventDefault(); navigate(suggestionsOpen ? suggestions[selectedSuggestion]?.url : address); }}>
			<button type="button" aria-label="戻る" title="戻る" disabled={!ready || !navigation.back} onClick={() => browser.current?.goBack()}><Icon name="chevronLeft" size="control" /></button>
			<button type="button" aria-label="進む" title="進む" disabled={!ready || !navigation.forward} onClick={() => browser.current?.goForward()}><Icon name="chevronRight" size="control" /></button>
			<button type="button" aria-label={navigation.loading ? "読み込みを中止" : "再読み込み"} title={navigation.loading ? "読み込みを中止" : "再読み込み"} disabled={!ready} onClick={() => navigation.loading ? browser.current?.stop() : browser.current?.reload()}><Icon name={navigation.loading ? "close" : "refresh"} size="control" /></button>
			<button type="button" aria-pressed={annotating} title="クリックで要素、ドラッグで範囲、Shiftを押しながらドラッグでテキスト" disabled={!ready || !pageAddress} onClick={toggleAnnotation}>注釈</button>
			<div className="browser-address">
				<input ref={addressInput} aria-label="アドレス" placeholder="URLを入力または検索" spellCheck={false} autoComplete="off" role="combobox" aria-autocomplete="list"
					aria-expanded={suggestionsOpen} aria-controls={suggestionsOpen ? historyListId : undefined}
					aria-activedescendant={suggestionsOpen ? `${historyListId}-${selectedSuggestion}` : undefined} value={address}
					onFocus={(event) => { setAddressFocused(true); event.currentTarget.select(); }}
					onBlur={() => setAddressFocused(false)}
					onChange={(event) => { setDraftAddress(event.target.value); setActiveSuggestion(0); }}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (suggestionsOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
							event.preventDefault();
							const direction = event.key === "ArrowDown" ? 1 : -1;
							setActiveSuggestion((selectedSuggestion + direction + suggestions.length) % suggestions.length);
							return;
						}
						if (event.key !== "Escape") return;
						event.stopPropagation();
						setDraftAddress(undefined);
						requestAnimationFrame(() => addressInput.current?.select());
					}} />
				<button type="submit" aria-label="開く" title="開く" disabled={!ready || !address.trim()}><Icon name="arrowUpRight" size="control" /></button>
				{suggestionsOpen && <ul id={historyListId} className="browser-address-suggestions" role="listbox" aria-label="アドレス候補">
					{suggestions.map((entry, index) => <li key={entry.url} id={`${historyListId}-${index}`} role="option"
						aria-selected={selectedSuggestion === index} onMouseDown={(event) => event.preventDefault()} onClick={() => navigate(entry.url)}>
						<Icon name={entry.icon} size="inline" />
						<span><strong>{entry.label}</strong><small>{entry.detail}</small></span>
					</li>)}
				</ul>}
			</div>
			<button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>履歴</button>
		</form>
		{error && <p className="browser-error" role="alert">{error}</p>}
		<div className="browser-body">
			<div className="browser-viewport">
				<div ref={container} className="browser-content" />
		{selection && image && <form ref={commentForm} className="browser-comment" aria-label="注釈を編集" style={commentPosition} onKeyDown={(event) => {
			if (event.key !== "Escape" || event.nativeEvent.isComposing || event.defaultPrevented) return;
			event.stopPropagation();
			closeComment();
		}} onSubmit={(event) => {
			event.preventDefault();
			const changes = Object.entries(adjustedRef.current).map(([key, value]) =>
				value === null ? `インラインの ${key} を削除` : `${key}: ${value};`);
			if (!note.trim() && !changes.length) return;
			const comment = [note.trim(), changes.length ? `プレビューした CSS:\n${changes.join("\n")}` : ""].filter(Boolean).join("\n\n");
			const delivery: BrowserAnnotationDelivery = { annotation: { selection, image, note: comment }, accepted: false };
			window.dispatchEvent(new CustomEvent<BrowserAnnotationDelivery>("hasilan:browser-annotation", { detail: delivery }));
			if (!delivery.accepted) { setError("入力欄に追加できません。会話を開き、添付数と容量を確認してください。"); return; }
			browser.current?.send("hasilan:browser-clear"); resetAdjustments(); setSelection(undefined); setImage(""); setNote("");
		}}>
			<label>注釈<textarea autoFocus value={note} onChange={(event) => setNote(event.target.value)} placeholder="この箇所への指示" /></label>
			{selection.adjustmentId !== undefined && <details className="browser-comment-tools">
				<summary>見た目を調整</summary>
			{adjustmentsEnabled && <div className="browser-adjustment-request">
				<input aria-label="調整したいこと" placeholder="例: ボタンを目立たせたい（任意）" maxLength={1000} value={intent} onChange={(event) => setIntent(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
						event.preventDefault();
						void suggestAdjustments();
					}} />
				<button type="button" disabled={suggesting || !model} title={!model ? "会話のモデルを選択してください" : undefined} onClick={() => void suggestAdjustments()}>
					{suggesting ? "調整項目を作成中…" : controls ? "項目を作り直す" : "AI で調整項目を作る"}
				</button>
			</div>}
			{controls && <BrowserAdjustmentControls controls={controls} styles={selection.styles} adjusted={adjusted} onChange={(styles) => {
				const next = { ...adjustedRef.current };
				for (const key of Object.keys(styles)) delete next[key];
				return updatePreview({ ...next, ...styles });
			}} />}
			<BrowserCssEditor computed={selection.styles} inline={selection.inlineStyles} adjusted={adjusted} onApply={(property, value) => {
				const next = { ...adjustedRef.current };
				delete next[property];
				if (value !== undefined) Object.defineProperty(next, property, { value, enumerable: true, configurable: true });
				return updatePreview(next);
			}} />
			{Object.keys(adjusted).length > 0 && <div><button type="button" onClick={() => updatePreview({})}>元の表示に戻す</button></div>}
			</details>}
			<div><button type="button" onClick={closeComment}>キャンセル</button><button type="submit" disabled={!note.trim() && !Object.keys(adjusted).length}>入力欄に追加</button></div>
		</form>}
			</div>
		{historyOpen && <section className="browser-history" aria-label="閲覧履歴"><header><strong>閲覧履歴</strong><button type="button" onClick={() => setHistory([])}>すべて削除</button><button type="button" aria-label="履歴を閉じる" onClick={() => setHistoryOpen(false)}><Icon name="close" size="inline" /></button></header><input aria-label="履歴を検索" placeholder="タイトル・URLで検索" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} /><ul>{history.filter((entry) => `${entry.title} ${entry.url}`.toLowerCase().includes(historyQuery.toLowerCase())).map((entry) => <li key={entry.url}><button type="button" onClick={() => navigate(entry.url)}><strong>{entry.title}</strong><small>{entry.url}</small><time>{new Date(entry.visitedAt).toLocaleString()}</time></button><button type="button" aria-label={`${entry.title}を履歴から削除`} onClick={() => setHistory((previous) => previous.filter((item) => item.url !== entry.url))}><Icon name="close" size="inline" /></button></li>)}</ul>{!history.length && <p>閲覧履歴はありません。</p>}</section>}
		</div>
	</section>;
}
