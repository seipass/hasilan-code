import { useEffect, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import { Icon } from "./Icon.tsx";
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
	const [address, setAddress] = useState(initialUrl ?? "");
	const [ready, setReady] = useState(false);
	const [mode, setMode] = useState<BrowserSelection["kind"]>();
	const [selection, setSelection] = useState<BrowserSelection>();
	const [image, setImage] = useState("");
	const [note, setNote] = useState("");
	const [error, setError] = useState("");
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
		const navigate = (event: Electron.DidNavigateEvent | Electron.DidNavigateInPageEvent) => { if (!("isMainFrame" in event) || event.isMainFrame) setAddress(event.url); };
		const message = (event: Electron.IpcMessageEvent) => {
			if (event.channel === "hasilan:browser-cancel") { setMode(undefined); return; }
			if (event.channel !== "hasilan:browser-selection") return;
			const selected = event.args[0] as BrowserSelection;
			setMode(undefined); setError("");
			void view.capturePage().then((capture) => {
				if (view.getURL() !== selected.url) throw new Error("Page changed");
				setSelection(selected); setImage(capture.toDataURL());
			}).catch(() => setError("スクリーンショットを取得できませんでした。もう一度選択してください。"));
		};
		view.addEventListener("dom-ready", ready);
		view.addEventListener("did-navigate", navigate);
		view.addEventListener("did-navigate-in-page", navigate);
		view.addEventListener("ipc-message", message);
		host.append(view);
		return () => { browser.current = null; view.remove(); };
	}, []);
	function navigate() {
		try {
			const value = address.trim();
			const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
			browser.current?.send("hasilan:browser-clear"); setSelection(undefined); setImage(""); setMode(undefined); setError("");
			void browser.current?.loadURL(url.href).catch(() => setError("ページを開けませんでした。"));
		} catch { setError("有効なURLを入力してください。"); }
	}
	function select(next: BrowserSelection["kind"]) {
		if (!ready) return;
		setSelection(undefined); setImage(""); setMode(next); setError("");
		browser.current?.send("hasilan:browser-select", next);
	}
	return <section className="browser-pane" aria-label="ブラウザ">
		<form className="browser-toolbar" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
			<button type="button" aria-label="戻る" disabled={!ready} onClick={() => { if (browser.current?.canGoBack()) browser.current.goBack(); }}><Icon name="chevronLeft" size="control" /></button>
			<button type="button" aria-label="進む" disabled={!ready} onClick={() => { if (browser.current?.canGoForward()) browser.current.goForward(); }}><Icon name="chevronRight" size="control" /></button>
			<button type="button" aria-label="再読み込み" disabled={!ready} onClick={() => browser.current?.reload()}><Icon name="refresh" size="control" /></button>
			<input aria-label="アドレス" placeholder="URLを入力" value={address} onChange={(event) => setAddress(event.target.value)} />
			<button type="submit">開く</button>
		</form>
		<div className="browser-annotation-tools" role="group" aria-label="注釈の対象">
			<button type="button" disabled={!ready} aria-pressed={mode === "element"} onClick={() => select("element")}>要素</button>
			<button type="button" disabled={!ready} aria-pressed={mode === "text"} onClick={() => select("text")}>テキスト</button>
			<button type="button" disabled={!ready} aria-pressed={mode === "region"} onClick={() => select("region")}>範囲</button>
			{mode && <span role="status">{mode === "element" ? "要素をクリック" : mode === "text" ? "テキストを選択" : "範囲をドラッグ"} · Escでキャンセル</span>}
		</div>
		{error && <p className="browser-error" role="alert">{error}</p>}
		<div ref={container} className="browser-content" />
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
