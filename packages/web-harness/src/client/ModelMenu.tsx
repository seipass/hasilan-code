import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "./api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import type { Model, ModelCatalog } from "./types.ts";

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

	return <div ref={menu} className="composer-popover model-popover" data-closing={closing} inert={closing} role="dialog" aria-labelledby={titleId} aria-busy={busy} onAnimationEnd={(event) => { if (closing && event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => {
		if (event.key !== "Escape") return;
		event.preventDefault(); event.stopPropagation();
		if (!busy) { requestClose(); document.querySelector<HTMLButtonElement>(".model-trigger")?.focus(); }
	}}>
		<header><strong id={titleId}>モデル・Thinking</strong><button className="icon-button" type="button" disabled={busy || closing} aria-label="モデル選択を閉じる" onClick={() => { requestClose(); document.querySelector<HTMLButtonElement>(".model-trigger")?.focus(); }}>×</button></header>
		<div className="model-menu-columns">
			<section className="model-menu-models" aria-label="モデル選択">
				<h3>モデル</h3>
				<ModelPicker catalog={available} value={value} onChange={(selection) => { void choose(selection); }} disabled={busy || disabled} autoFocus compact />
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
				{!selectedModel && <p className="fine-print">左でモデルを選択してください。</p>}
			</section>
		</div>
		{disabled && <p className="fine-print">実行が終わるとモデルを変更できます。</p>}
		{error && <p className="composer-error" role="alert">{error}</p>}
	</div>;
}
