import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "./api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import type { Model, ModelCatalog } from "./types.ts";

export function ModelMenu({ catalog, value, thinkingLevel, defaultModel, onChange, onThinkingChange, onDefaultChange, onSettings, onClosingChange, onClose, disabled }: {
	catalog?: ModelCatalog;
	value?: Model;
	thinkingLevel?: ThinkingLevel;
	defaultModel?: Model;
	onChange: (selection: Model) => Promise<void>;
	onThinkingChange: (level: ThinkingLevel) => Promise<void>;
	onDefaultChange: (selection: Model | null) => Promise<void>;
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
	const levels = catalog?.models.find((model) => model.provider === value?.provider && model.id === value.id)?.thinkingLevels ?? ["off"];
	const isDefault = defaultModel?.provider === value?.provider && defaultModel?.id === value?.id;
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
		if (value?.provider === selection.provider && value.id === selection.id) { requestClose(); return; }
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
		<header><strong id={titleId}>モデル</strong><button className="icon-button" type="button" disabled={busy || closing} aria-label="モデル選択を閉じる" onClick={() => { requestClose(); document.querySelector<HTMLButtonElement>(".model-trigger")?.focus(); }}>×</button></header>
		<ModelPicker catalog={available} value={value} onChange={(selection) => { void choose(selection); }} disabled={busy || disabled} autoFocus compact />
		{available && available.models.length === 0 && <button type="button" className="model-settings-link" onClick={onSettings}>設定でモデルを接続</button>}
		{value && available?.models.some((model) => model.provider === value.provider && model.id === value.id) && <div className="model-menu-preferences">
			<label>Thinking<select value={thinkingLevel ?? ""} disabled={busy || disabled} onChange={(event) => { const level = event.target.value as ThinkingLevel; void update(() => onThinkingChange(level)); }}>
				<option value="" disabled>SDK の既定</option>
				{levels.map((level) => <option key={level} value={level}>{({ off: "オフ", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" } as Record<ThinkingLevel, string>)[level]}</option>)}
			</select></label>
			<div className="model-menu-default"><span>新しい会話の既定: {defaultModel ? `${defaultModel.provider} / ${defaultModel.id}` : "自動選択"}</span><button type="button" disabled={busy || disabled || isDefault} onClick={() => { void update(() => onDefaultChange(value)); }}>このモデルを既定に設定</button>{defaultModel && <button type="button" disabled={busy || disabled} onClick={() => { void update(() => onDefaultChange(null)); }}>既定を解除</button>}</div>
		</div>}
		{disabled && <p className="fine-print">実行が終わるとモデルを変更できます。</p>}
		{error && <p className="composer-error" role="alert">{error}</p>}
	</div>;
}
