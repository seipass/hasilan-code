import { useEffect, useId, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import { Icon } from "./Icon.tsx";
import { usePreferenceState } from "./preferences.ts";
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
}
export interface BrowserAnnotation { selection: BrowserSelection; image: string; note: string }
export interface BrowserAnnotationDelivery { annotation: BrowserAnnotation; accepted: boolean }

export function BrowserPane({ initialUrl }: { initialUrl?: string }) {
	const container = useRef<HTMLDivElement>(null);
	const browser = useRef<WebviewTag>(null);
	const addressInput = useRef<HTMLInputElement>(null);
	const historyListId = useId();
	const [pageAddress, setPageAddress] = useState(initialUrl ?? "");
	const [draftAddress, setDraftAddress] = useState<string>();
	const address = draftAddress ?? pageAddress;
	const [ready, setReady] = useState(false);
	const [annotating, setAnnotating] = useState(false);
	const [selection, setSelection] = useState<BrowserSelection>();
	const [image, setImage] = useState("");
	const [note, setNote] = useState("");
	const [error, setError] = useState("");
	const [history, setHistory] = usePreferenceState<{ url: string; title: string; visitedAt: number }[]>("pi-web-browser-history", []);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyQuery, setHistoryQuery] = useState("");
	const [navigation, setNavigation] = useState({ back: false, forward: false, loading: false });
	useEffect(() => {
		const host = container.current;
		if (!host) return;
		const view = document.createElement("webview") as WebviewTag;
		view.setAttribute("src", "about:blank");
		view.setAttribute("partition", "persist:hasilan-browser");
		view.className = "browser-webview";
		browser.current = view;
		let initial = initialUrl;
		const ready = () => { setReady(true); if (initial) { const url = initial; initial = undefined; void view.loadURL(url).catch(() => setError("ページを開けませんでした。")); } };
		const updateNavigation = () => setNavigation({ back: view.canGoBack(), forward: view.canGoForward(), loading: view.isLoading() });
		const navigate = (event: Electron.DidNavigateEvent | Electron.DidNavigateInPageEvent) => {
			if ("isMainFrame" in event && !event.isMainFrame) return;
			setPageAddress(event.url === "about:blank" ? "" : event.url);
			updateNavigation();
			setAnnotating(false); setSelection(undefined); setImage(""); setError("");
		};
		const loaded = () => {
			updateNavigation();
			const url = view.getURL();
			if (!/^https?:\/\//i.test(url)) return;
			setHistory((previous) => [{ url: url.slice(0, 8192), title: (view.getTitle() || url).slice(0, 512), visitedAt: Date.now() }, ...previous.filter((entry) => entry.url !== url)].slice(0, 200));
		};
		const message = (event: Electron.IpcMessageEvent) => {
			if (event.channel === "hasilan:browser-focus-address") { addressInput.current?.focus(); addressInput.current?.select(); return; }
			if (event.channel === "hasilan:browser-cancel") { setAnnotating(false); return; }
			if (event.channel !== "hasilan:browser-selection") return;
			const selected = event.args[0] as BrowserSelection;
			setAnnotating(false); setError("");
			void view.capturePage().then((capture) => {
				if (view.getURL() !== selected.url) throw new Error("Page changed");
				setSelection(selected); setImage(capture.toDataURL());
			}).catch(() => setError("スクリーンショットを取得できませんでした。もう一度選択してください。"));
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
	}, []);
	function navigate(destination = address) {
		const view = browser.current;
		const value = destination.trim();
		if (!ready || !view || !value) return;
		try {
			const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/?#]|$)/i.test(value);
			const explicit = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
			const host = local || /^[^\s/]+[.:][^\s/]+/.test(value);
			const url = explicit || host
				? new URL(explicit ? value : `${local ? "http" : "https"}://${value}`)
				: new URL(`https://duckduckgo.com/?q=${encodeURIComponent(value)}`);
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
			view.send("hasilan:browser-clear");
			setSelection(undefined); setImage(""); setAnnotating(false); setError("");
			setPageAddress(url.href);
			setDraftAddress(undefined);
			addressInput.current?.blur();
			view.focus();
			void view.loadURL(url.href).catch((reason: unknown) => {
				if (!(reason instanceof Error && reason.message.includes("ERR_ABORTED"))) setError("ページを開けませんでした。");
			});
		} catch { setError("有効なURLを入力してください。"); }
	}
	function toggleAnnotation() {
		if (!ready) return;
		setSelection(undefined); setImage(""); setError("");
		setAnnotating(!annotating);
		if (annotating) browser.current?.send("hasilan:browser-clear");
		else {
			browser.current?.send("hasilan:browser-select", "inspect");
			browser.current?.focus();
		}
	}
	return <section className="browser-pane" aria-label="ブラウザ" onKeyDown={(event) => {
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
			event.preventDefault();
			addressInput.current?.focus();
			addressInput.current?.select();
		}
	}}>
		<form className="browser-toolbar" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
			<button type="button" aria-label="戻る" title="戻る" disabled={!ready || !navigation.back} onClick={() => browser.current?.goBack()}><Icon name="chevronLeft" size="control" /></button>
			<button type="button" aria-label="進む" title="進む" disabled={!ready || !navigation.forward} onClick={() => browser.current?.goForward()}><Icon name="chevronRight" size="control" /></button>
			<button type="button" aria-label={navigation.loading ? "読み込みを中止" : "再読み込み"} title={navigation.loading ? "読み込みを中止" : "再読み込み"} disabled={!ready} onClick={() => navigation.loading ? browser.current?.stop() : browser.current?.reload()}><Icon name={navigation.loading ? "close" : "refresh"} size="control" /></button>
			<button type="button" aria-pressed={annotating} title="クリックで要素、ドラッグで範囲、Shiftを押しながらドラッグでテキスト" disabled={!ready || !pageAddress} onClick={toggleAnnotation}>注釈</button>
			<div className="browser-address">
				<input ref={addressInput} aria-label="アドレス" placeholder="URLを入力または検索" spellCheck={false} autoComplete="off" list={historyListId} value={address}
					onFocus={(event) => event.currentTarget.select()}
					onChange={(event) => setDraftAddress(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						event.stopPropagation();
						setDraftAddress(undefined);
						requestAnimationFrame(() => addressInput.current?.select());
					}} />
				<datalist id={historyListId}>{history.slice(0, 30).map((entry) => <option key={entry.url} value={entry.url} label={entry.title} />)}</datalist>
				<button type="submit" aria-label="開く" title="開く" disabled={!ready || !address.trim()}><Icon name="arrowUpRight" size="control" /></button>
			</div>
			<button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>履歴</button>
		</form>
		{error && <p className="browser-error" role="alert">{error}</p>}
		<div className="browser-body">
			<div ref={container} className="browser-content" />
		{historyOpen && <section className="browser-history" aria-label="閲覧履歴"><header><strong>閲覧履歴</strong><button type="button" onClick={() => setHistory([])}>すべて削除</button><button type="button" aria-label="履歴を閉じる" onClick={() => setHistoryOpen(false)}><Icon name="close" size="inline" /></button></header><input aria-label="履歴を検索" placeholder="タイトル・URLで検索" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} /><ul>{history.filter((entry) => `${entry.title} ${entry.url}`.toLowerCase().includes(historyQuery.toLowerCase())).map((entry) => <li key={entry.url}><button type="button" onClick={() => navigate(entry.url)}><strong>{entry.title}</strong><small>{entry.url}</small><time>{new Date(entry.visitedAt).toLocaleString()}</time></button><button type="button" aria-label={`${entry.title}を履歴から削除`} onClick={() => setHistory((previous) => previous.filter((item) => item.url !== entry.url))}><Icon name="close" size="inline" /></button></li>)}</ul>{!history.length && <p>閲覧履歴はありません。</p>}</section>}
		</div>
		{selection && image && <form className="browser-comment" onSubmit={(event) => {
			event.preventDefault();
			if (!note.trim()) return;
			const delivery: BrowserAnnotationDelivery = { annotation: { selection, image, note: note.trim() }, accepted: false };
			window.dispatchEvent(new CustomEvent<BrowserAnnotationDelivery>("hasilan:browser-annotation", { detail: delivery }));
			if (!delivery.accepted) { setError("入力欄に追加できません。会話を開き、添付数と容量を確認してください。"); return; }
			browser.current?.send("hasilan:browser-clear"); setSelection(undefined); setImage(""); setNote("");
		}}><label>注釈<textarea autoFocus value={note} onChange={(event) => setNote(event.target.value)} placeholder="この箇所への指示" /></label><div><button type="button" onClick={() => { browser.current?.send("hasilan:browser-clear"); setSelection(undefined); setImage(""); }}>キャンセル</button><button type="submit" disabled={!note.trim()}>入力欄に追加</button></div></form>}
	</section>;
}
