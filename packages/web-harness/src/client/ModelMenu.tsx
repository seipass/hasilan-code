import type { ThinkingLevel } from "@hasilan-code/pi-agent-core";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "./api.ts";
import { MobileSheet, useMobileLayout } from "./MobileSheet.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import type { Model, ModelCatalog } from "./types.ts";
import "./ModelMenu.css";

export function ModelMenu({ catalog, value, thinkingLevel, onChange, onThinkingChange, onSettings, onClosingChange, onClose, disabled }: {
	catalog?: ModelCatalog;
	value?: Model;
	thinkingLevel?: ThinkingLevel;
	onChange: (selection: Model) => Promise<void>;
	onThinkingChange: (level: ThinkingLevel) => Promise<void>;
	onSettings: () => void;
	onClosingChange: (closing: boolean) => void;
	onClose: () => void;
	disabled: boolean;
}) {
	const mobile = useMobileLayout();
	const available = useMemo(() => {
		if (!catalog) return undefined;
		const configured = new Set(catalog.providers.filter((entry) => entry.configured === true).map((entry) => entry.id));
		return { providers: catalog.providers.filter((entry) => configured.has(entry.id)), models: catalog.models.filter((model) => configured.has(model.provider)) };
	}, [catalog]);
	const selectedModel = available?.models.find((model) => model.provider === value?.provider && model.id === value.id);
	const levels: ThinkingLevel[] = selectedModel?.thinkingLevels ?? ["off"];
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [closing, setClosing] = useState(false);
	const menu = useRef<HTMLDivElement>(null);
	const titleId = useId();
	useLayoutEffect(() => {
		if (mobile) return;
		const anchor = document.querySelector<HTMLButtonElement>(".model-trigger");
		const element = menu.current;
		if (!anchor || !element) return;
		function position() {
			const bounds = anchor!.getBoundingClientRect();
			const width = Math.min(480, window.innerWidth - 24);
			Object.assign(element!.style, {
				position: "fixed",
				width: `${width}px`,
				left: `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`,
				bottom: `${window.innerHeight - bounds.top + 8}px`,
				maxHeight: `${Math.max(0, Math.min(590, bounds.top - 20))}px`,
			});
		}
		position();
		const observer = new ResizeObserver(position);
		observer.observe(anchor);
		const column = anchor.closest(".chat-column");
		if (column) observer.observe(column);
		const composer = anchor.closest(".composer");
		if (composer) observer.observe(composer);
		window.addEventListener("resize", position);
		window.addEventListener("scroll", position, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", position);
			window.removeEventListener("scroll", position, true);
		};
	}, [mobile]);
	const requestClose = () => {
		if (closing || busy) return;
		if (mobile || window.matchMedia("(prefers-reduced-motion: reduce)").matches) onClose();
		else { setClosing(true); onClosingChange(true); }
	};
	useEffect(() => {
		if (mobile) return;
		const outside = (event: PointerEvent) => {
			if (!closing && !busy && event.target instanceof Element && !menu.current?.contains(event.target) && !event.target.closest(".model-trigger")) requestClose();
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [mobile, busy, closing, onClose]);

	async function choose(selection: Model) {
		if (busy || disabled) return;
		if (value?.provider === selection.provider && value.id === selection.id) return;
		setBusy(true); setError(undefined);
		try { await onChange(selection); }
		catch (reason) { setError(errorMessage(reason)); }
		finally { setBusy(false); }
	}

	async function update(operation: () => Promise<void>) {
		if (busy || disabled) return;
		setBusy(true); setError(undefined);
		try { await operation(); }
		catch (reason) { setError(errorMessage(reason)); }
		finally { setBusy(false); }
	}

	const content = <>
		<div className="model-menu-columns">
			<section className="model-menu-models" aria-label="モデル選択">
				<h3>モデル</h3>
				<ModelPicker catalog={available} value={value} onChange={(selection) => { void choose(selection); }} disabled={busy || disabled} autoFocus={!mobile} compact />
				{available && available.models.length === 0 && <button type="button" className="model-settings-link" onClick={onSettings}>設定でモデルを接続</button>}
			</section>
			<section className="model-menu-thinking" aria-label="Thinking選択">
				<h3>Thinking</h3>
				{selectedModel && <ul className="thinking-picker-results" role="listbox" aria-label="Thinking" onKeyDown={(event) => {
					if (!(event.target instanceof HTMLButtonElement) || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
					const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
					if (!options.length) return;
					event.preventDefault();
					const index = options.indexOf(event.target);
					options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
				}}>
					{levels.map((level) => <li key={level} role="presentation"><button type="button" className="model-picker-option" role="option" aria-selected={thinkingLevel === level} disabled={busy || disabled} onClick={() => { void update(() => onThinkingChange(level)); }}>{({ off: "オフ", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" } satisfies Record<ThinkingLevel, string>)[level]}{thinkingLevel === level && <span className="model-selected-mark" aria-label="選択中">✓</span>}</button></li>)}
				</ul>}
				{!selectedModel && <p className="fine-print">モデルを選択してください。</p>}
			</section>
		</div>
		{disabled && <p className="fine-print">実行が終わるとモデルを変更できます。</p>}
		{error && <p className="composer-error" role="alert">{error}</p>}
	</>;
	if (mobile) return <MobileSheet open side="bottom" title="モデル・Thinking" busy={busy} onClosing={() => onClosingChange(true)} onClose={requestClose}><div className="mobile-model-menu" aria-busy={busy}>{content}</div></MobileSheet>;
	return <div ref={menu} className="composer-popover model-popover" data-closing={closing} inert={closing} role="dialog" aria-labelledby={titleId} aria-busy={busy} onAnimationEnd={(event) => { if (closing && event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => {
		if (event.key !== "Escape") return;
		event.preventDefault(); event.stopPropagation();
		if (!busy) { requestClose(); document.querySelector<HTMLButtonElement>(".model-trigger")?.focus(); }
	}}>
		<header><strong id={titleId}>モデル・Thinking</strong><button className="icon-button" type="button" disabled={busy || closing} aria-label="モデル選択を閉じる" onClick={() => { requestClose(); document.querySelector<HTMLButtonElement>(".model-trigger")?.focus(); }}>×</button></header>
		{content}
	</div>;
}
