import type { ThinkingLevel } from "@hasilan-code/pi-agent-core";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { MobileSheet, useMobileLayout } from "./MobileSheet.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import type { Model, ModelCatalog } from "./types.ts";
import "./ModelMenu.css";

const EFFORT_LABELS: Record<ThinkingLevel, string> = {
	off: "オフ", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大",
};

export function ModelMenu({ catalog, value, thinkingLevel, onChange, onThinkingChange, onSettings, onClose, disabled }: {
	catalog?: ModelCatalog;
	value?: Model;
	thinkingLevel?: ThinkingLevel;
	onChange: (selection: Model) => Promise<void>;
	onThinkingChange: (level: ThinkingLevel) => Promise<void>;
	onSettings: () => void;
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
	const [showModels, setShowModels] = useState(!value);
	const [preview, setPreview] = useState<ThinkingLevel>();
	const [dragProgress, setDragProgress] = useState<number>();
	const pointer = useRef<{ id: number; startX: number; left: number; travel: number } | undefined>(undefined);
	const thumb = useRef<HTMLDivElement>(null);
	const heading = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const currentLevel = preview ?? thinkingLevel ?? (selectedModel && levels.length === 1 ? levels[0] : undefined);
	const effortIndex = Math.max(0, levels.findIndex((level) => level === currentLevel));
	useLayoutEffect(() => {
		if (mobile) return;
		const anchor = document.querySelector<HTMLButtonElement>(".model-trigger");
		const element = menu.current;
		if (!anchor || !element) return;
		function position() {
			const bounds = anchor!.getBoundingClientRect();
			const width = Math.min(264, window.innerWidth - 24);
			Object.assign(element!.style, {
				position: "fixed",
				width: `${width}px`,
				left: `${Math.max(12, Math.min(bounds.left + (bounds.width - width) / 2, window.innerWidth - width - 12))}px`,
				bottom: `${window.innerHeight - bounds.top + 8}px`,
				maxHeight: `${Math.max(0, Math.min(380, bounds.top - 20))}px`,
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
		if (!busy) onClose();
	};
	useEffect(() => {
		if (mobile) return;
		const outside = (event: PointerEvent) => {
			if (!busy && event.target instanceof Element && !menu.current?.contains(event.target) && !event.target.closest(".model-trigger")) requestClose();
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [mobile, busy, onClose]);
	useEffect(() => {
		if (!showModels && !mobile) heading.current?.focus({ preventScroll: true });
	}, [mobile, showModels]);

	function selectView(models: boolean) {
		setShowModels(models);
		setError(undefined);
	}

	async function choose(selection: Model) {
		if (busy || disabled) return;
		if (value?.provider === selection.provider && value.id === selection.id) { selectView(false); return; }
		setBusy(true); setError(undefined);
		try { await onChange(selection); setPreview(undefined); selectView(false); }
		catch (reason) { setError(errorMessage(reason)); }
		finally { setBusy(false); }
	}

	async function commitEffort(level: ThinkingLevel) {
		if (busy || disabled || level === thinkingLevel) { setPreview(undefined); return; }
		setPreview(level);
		setBusy(true); setError(undefined);
		try { await onThinkingChange(level); }
		catch (reason) { setError(errorMessage(reason)); }
		finally { setBusy(false); setPreview(undefined); }
	}

	const content = <>
		{showModels ? <div className="model-menu-list-view">
			<header className="model-menu-list-header">
				{value ? <button type="button" aria-label="モデル選択、推論レベルに戻る" disabled={busy} onClick={() => selectView(false)}><Icon name="chevronLeft" size="control" />モデル選択</button> : <span>モデル選択</span>}
			</header>
			<section className="model-menu-models" aria-label="モデル選択">
				<ModelPicker catalog={available} value={value} onChange={(selection) => { void choose(selection); }} disabled={busy || disabled} autoFocus={!mobile} compact />
				{available && available.models.length === 0 && <button type="button" className="model-settings-link" onClick={onSettings}>設定でモデルを接続</button>}
			</section>
		</div> : <div className="model-menu-effort-view">
			<button ref={heading} type="button" className="model-menu-current" aria-label="モデル一覧を開く" disabled={busy || disabled} onClick={() => selectView(true)}>
				<span className="model-menu-effort-label">{currentLevel ? EFFORT_LABELS[currentLevel] : "自動"}</span>
				<span className="model-menu-current-name">{selectedModel?.name ?? value?.name ?? value?.id ?? "モデルを選択"}</span>
				<Icon name="chevronRight" size="inline" />
			</button>
			{selectedModel && levels.length > 1 && <div className="model-effort-control" data-dragging={dragProgress !== undefined} style={{ "--effort-progress": dragProgress ?? effortIndex / (levels.length - 1) } as CSSProperties}>
				<div className="model-effort-track" aria-hidden="true"><div className="model-effort-fill" /><div className="model-effort-ticks">{levels.map((level, index) => <span key={level} data-filled={index <= effortIndex} />)}</div></div>
				<div ref={thumb} className="model-effort-thumb" aria-hidden="true" />
				<input type="range" className="model-effort-slider" aria-label="推論レベル" aria-valuetext={currentLevel ? EFFORT_LABELS[currentLevel] : "自動"} min={0} max={levels.length - 1} step={1} value={effortIndex} disabled={disabled} aria-disabled={busy || undefined}
					onPointerDown={(event) => {
						if (event.button !== 0 || busy || pointer.current) { event.preventDefault(); return; }
						const bounds = event.currentTarget.getBoundingClientRect();
						const thumbWidth = thumb.current?.offsetWidth ?? 0;
						pointer.current = { id: event.pointerId, startX: event.clientX, left: bounds.left + thumbWidth / 2, travel: Math.max(1, bounds.width - thumbWidth) };
						event.currentTarget.setPointerCapture(event.pointerId);
					}}
					onPointerMove={(event) => {
						const active = pointer.current;
						if (active?.id !== event.pointerId || (dragProgress === undefined && Math.abs(event.clientX - active.startX) < 3)) return;
						setDragProgress(Math.max(0, Math.min(1, (event.clientX - active.left) / active.travel)));
					}}
					onPointerUp={(event) => {
						if (pointer.current?.id !== event.pointerId) return;
						pointer.current = undefined;
						setDragProgress(undefined);
						void commitEffort(levels[event.currentTarget.valueAsNumber]);
					}}
					onLostPointerCapture={(event) => {
						if (pointer.current?.id !== event.pointerId) return;
						pointer.current = undefined;
						setDragProgress(undefined);
						setPreview(undefined);
					}}
					onChange={(event) => {
						if (busy) return;
						const level = levels[event.currentTarget.valueAsNumber];
						if (pointer.current) setPreview(level);
						else void commitEffort(level);
					}} />
			</div>}
		</div>}
		{disabled && <p className="fine-print">実行が終わるとモデルを変更できます。</p>}
		{error && <p className="composer-error" role="alert">{error}</p>}
	</>;
	if (mobile) return <MobileSheet open side="bottom" title="モデル・Thinking" busy={busy} onClose={requestClose}><div className="mobile-model-menu" aria-busy={busy}>{content}</div></MobileSheet>;
	return <div ref={menu} className="composer-popover model-popover" role="dialog" aria-label="モデル・Thinking" aria-busy={busy} onKeyDown={(event) => {
		if (event.key !== "Escape") return;
		event.preventDefault(); event.stopPropagation();
		if (!busy) {
			if (showModels && value) selectView(false);
			else { requestClose(); document.querySelector<HTMLButtonElement>(".model-trigger")?.focus(); }
		}
	}}>
		{content}
	</div>;
}
