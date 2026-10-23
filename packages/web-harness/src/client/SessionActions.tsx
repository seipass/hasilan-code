import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "./api.ts";
import type { SessionSummary } from "./types.ts";
import "./SessionActions.css";

export interface SessionActionTarget {
	session: SessionSummary;
	x: number;
	y: number;
	opener: HTMLButtonElement;
}

export function SessionActions({ target, onClose, onRename, onDelete }: {
	target: SessionActionTarget;
	onClose: () => void;
	onRename: (id: string, title: string) => Promise<void>;
	onDelete: (id: string) => Promise<void>;
}) {
	const menu = useRef<HTMLDivElement>(null);
	const dialog = useRef<HTMLDialogElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const headingId = useId();
	const [action, setAction] = useState<"rename" | "delete">();
	const [title, setTitle] = useState(target.session.title ?? "新しい会話");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	useLayoutEffect(() => {
		if (action) return;
		const element = menu.current;
		if (!element) return;
		const bounds = element.getBoundingClientRect();
		element.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - bounds.width - 8))}px`;
		element.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - bounds.height - 8))}px`;
		element.querySelector<HTMLButtonElement>("button")?.focus();
	}, [action, target]);
	useEffect(() => {
		if (action) {
			dialog.current?.showModal();
			if (action === "rename") { input.current?.focus(); input.current?.select(); }
			return;
		}
		const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose(); };
		const dismiss = () => onClose();
		document.addEventListener("pointerdown", outside);
		window.addEventListener("resize", dismiss);
		window.addEventListener("scroll", dismiss, true);
		return () => {
			document.removeEventListener("pointerdown", outside);
			window.removeEventListener("resize", dismiss);
			window.removeEventListener("scroll", dismiss, true);
		};
	}, [action, onClose]);
	useEffect(() => () => { if (target.opener.isConnected) target.opener.focus({ preventScroll: true }); }, [target.opener]);
	async function submit() {
		if (busy || !action || action === "rename" && !title.trim()) return;
		setBusy(true); setError(undefined);
		try {
			if (action === "rename") await onRename(target.session.sessionId, title.trim());
			else await onDelete(target.session.sessionId);
			onClose();
		} catch (reason) { setError(errorMessage(reason)); setBusy(false); }
	}
	if (action) return <dialog ref={dialog} className="session-action-dialog" aria-labelledby={headingId} aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
		<form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
			<h2 id={headingId}>{action === "rename" ? "名前を変更" : "会話を削除"}</h2>
			{action === "rename" ? <label>会話名<input ref={input} value={title} maxLength={200} required disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label> : <p>「{target.session.title ?? "新しい会話"}」と、その子の会話を削除しますか？</p>}
			{error && <p role="alert" className="error">{error}</p>}
			<div className="session-action-buttons"><button type="button" disabled={busy} onClick={onClose}>キャンセル</button><button type="submit" className={action === "delete" ? "danger" : undefined} disabled={busy || action === "rename" && !title.trim()}>{busy ? "処理中…" : action === "rename" ? "保存" : "削除"}</button></div>
		</form>
	</dialog>;
	return <div ref={menu} className="session-context-menu" role="menu" aria-label="会話の操作" style={{ left: target.x, top: target.y }} onKeyDown={(event) => {
		if (event.key === "Escape" || event.key === "Tab") { event.stopPropagation(); if (event.key === "Escape") event.preventDefault(); onClose(); return; }
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault(); event.stopPropagation();
		const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
	}}>
		<button type="button" role="menuitem" onClick={() => setAction("rename")}>名前を変更</button>
		<button type="button" role="menuitem" className="danger" onClick={() => setAction("delete")}>削除</button>
	</div>;
}
