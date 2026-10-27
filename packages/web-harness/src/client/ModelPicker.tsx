import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MotionItems, Presence } from "./Motion.tsx";
import type { ModelCatalog } from "./types.ts";

export interface ModelPickerProps {
	catalog?: ModelCatalog;
	value?: { provider: string; id: string };
	onChange: (selection: { provider: string; id: string }) => void;
	disabled?: boolean;
	autoFocus?: boolean;
	compact?: boolean;
}

const PAGE_SIZE = 20;

export function ModelPicker({ catalog, value, onChange, disabled = false, autoFocus = false, compact = false }: ModelPickerProps) {
	const labelId = useId();
	const providerId = useId();
	const searchId = useId();
	const resultsId = useId();
	const search = useRef<HTMLInputElement>(null);
	const [provider, setProvider] = useState("");
	const [query, setQuery] = useState("");
	const [connectedOnly, setConnectedOnly] = useState(false);
	const [cursor, setCursor] = useState(0);
	const singleProvider = catalog?.providers.length === 1 ? catalog.providers[0].id : "";
	useEffect(() => { setProvider(singleProvider); }, [singleProvider]);
	useEffect(() => { if (autoFocus && !disabled) search.current?.focus(); }, [autoFocus, disabled, catalog]);
	const matches = useMemo(() => {
		const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
		const configured = new Set(catalog?.providers.filter((entry) => entry.configured === true).map((entry) => entry.id));
		return catalog?.models.filter((model) => {
			if (provider && model.provider !== provider) return false;
			if (connectedOnly && !configured.has(model.provider)) return false;
			const text = `${model.name ?? ""} ${model.id} ${model.provider}`.toLocaleLowerCase();
			return terms.every((term) => text.includes(term));
		}).sort((a, b) => {
			return (compact ? 0 : Number(value?.provider === b.provider && value.id === b.id) - Number(value?.provider === a.provider && value.id === a.id) || Number(configured.has(b.provider)) - Number(configured.has(a.provider))) || a.provider.localeCompare(b.provider) || (a.name ?? a.id).localeCompare(b.name ?? b.id);
		}) ?? [];
	}, [catalog, provider, query, connectedOnly, compact, value?.provider, value?.id]);
	useEffect(() => {
		const selected = compact && !query ? matches.findIndex((model) => model.provider === value?.provider && model.id === value.id) : -1;
		setCursor(Math.max(0, selected));
	}, [matches, compact, query, value?.provider, value?.id]);
	const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
	const activeIndex = Math.min(cursor, Math.max(0, matches.length - 1));
	const currentPage = Math.floor(activeIndex / PAGE_SIZE);
	const visible = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
	useEffect(() => { document.getElementById(`${resultsId}-${activeIndex}`)?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [activeIndex, resultsId, matches]);
	const showCompactSearch = compact && (catalog?.models.length ?? 0) > 4;
	useEffect(() => {
		if (!compact || !autoFocus || disabled || showCompactSearch || !catalog) return;
		const selected = matches.findIndex((model) => model.provider === value?.provider && model.id === value.id);
		setCursor(Math.max(selected, 0));
		document.getElementById(`${resultsId}-${Math.max(selected, 0)}`)?.focus();
	}, [compact, autoFocus, disabled, showCompactSearch, catalog, resultsId, value?.provider, value?.id]);
	if (compact) return <fieldset className="model-picker model-picker-compact" disabled={disabled} aria-labelledby={labelId} onKeyDown={(event) => {
		if (event.target instanceof HTMLInputElement || !matches.length || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
		event.preventDefault();
		const next = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
		setCursor(next);
		document.getElementById(`${resultsId}-${next}`)?.focus();
	}}>
		<legend id={labelId} className="sr-only">モデルを選択</legend>
		{showCompactSearch && <label htmlFor={searchId} className="model-compact-search"><span className="sr-only">モデルを検索</span><input ref={search} id={searchId} type="search" role="combobox" aria-autocomplete="list" aria-expanded={matches.length > 0} aria-controls={resultsId} aria-activedescendant={matches.length ? `${resultsId}-${activeIndex}` : undefined} autoComplete="off" placeholder="モデルを検索" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
			if (event.nativeEvent.isComposing) return;
			if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); }
			else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setCursor(Math.max(0, Math.min(matches.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)))); }
			else if (event.key === "Enter" && matches[activeIndex]) { event.preventDefault(); onChange({ provider: matches[activeIndex].provider, id: matches[activeIndex].id }); }
		}} /></label>}
		{!catalog ? <p role="status">モデル一覧を読み込み中…</p> : <>{matches.length === 0 && <p role="status">{catalog.models.length === 0 ? "利用できるモデルがありません。" : "一致するモデルはありません。"}</p>}<ul id={resultsId} className="model-picker-results" role="listbox" aria-label="モデル">
			<MotionItems items={matches} itemKey={(model) => `${model.provider}/${model.id}`}>{(model) => {
				const index = matches.indexOf(model);
				const selected = value?.provider === model.provider && value.id === model.id;
				const group = catalog.providers.find((entry) => entry.id === model.provider);
				return <li role="presentation" key={`${model.provider}/${model.id}`}>
					{index >= 0 && (index === 0 || matches[index - 1].provider !== model.provider) && <div className="model-group-heading">{group?.name ?? model.provider}</div>}
					<button id={index >= 0 ? `${resultsId}-${index}` : undefined} type="button" role="option" className="model-picker-option" aria-selected={selected} data-highlighted={activeIndex === index} onMouseMove={() => { if (index >= 0) setCursor(index); }} onClick={() => onChange({ provider: model.provider, id: model.id })}>{model.name ?? model.id}{selected && <span className="model-selected-mark motion-label" aria-label="選択中">✓</span>}</button>
				</li>;
			}}</MotionItems>
		</ul></>}
	</fieldset>;
	return <fieldset className="model-picker" disabled={disabled} aria-labelledby={labelId}>
		<legend id={labelId} className={autoFocus ? "sr-only" : undefined}>モデルを選択</legend>
		<div className="model-picker-filters">
			{catalog && catalog.providers.length > 1 && <label htmlFor={providerId}>プロバイダー
				<select id={providerId} value={provider} onChange={(event) => setProvider(event.target.value)}>
					<option value="">すべてのプロバイダー</option>
					{catalog.providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.configured === true ? " · 設定済み" : entry.configured === false ? " · 未接続" : ""}</option>)}
				</select>
			</label>}
			<label htmlFor={searchId}>モデルを検索
				<input ref={search} id={searchId} type="search" role="combobox" aria-autocomplete="list" aria-expanded={!!catalog && matches.length > 0} aria-controls={resultsId} aria-activedescendant={matches.length ? `${resultsId}-${activeIndex}` : undefined} autoComplete="off" placeholder="名前・モデルIDで絞り込む" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
					if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); return; }
					if (event.nativeEvent.isComposing) return;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						setCursor(Math.max(0, Math.min(matches.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1))));
					} else if (event.key === "Enter") {
						event.preventDefault();
						if (!disabled && matches[activeIndex]) onChange({ provider: matches[activeIndex].provider, id: matches[activeIndex].id });
					}
				}} />
			</label>
		</div>
		{catalog && <div className="model-picker-toolbar"><label><input type="checkbox" checked={connectedOnly} onChange={(event) => setConnectedOnly(event.target.checked)} />接続済みのみ</label><span role="status">{matches.length === 0 ? "該当するモデルはありません" : `${matches.length} 件${lastPage > 0 ? ` · ${currentPage + 1} / ${lastPage + 1} ページ` : ""}`}</span></div>}
		{!catalog ? <p role="status">モデル一覧を読み込み中…</p> : <>
			<ul id={resultsId} className="model-picker-results" role="listbox" aria-label="モデル">
				<MotionItems items={visible} itemKey={(model) => `${model.provider}/${model.id}`}>{(model) => { const index = matches.indexOf(model); return <li role="presentation" key={`${model.provider}/${model.id}`}>
					<button id={index >= 0 ? `${resultsId}-${index}` : undefined} type="button" role="option" className="model-picker-option" aria-selected={value?.provider === model.provider && value.id === model.id} data-highlighted={activeIndex === index} onMouseMove={() => { if (index >= 0) setCursor(index); }} onClick={() => onChange({ provider: model.provider, id: model.id })}>
						<strong>{model.name ?? model.id}{value?.provider === model.provider && value.id === model.id && <span className="model-selected-mark">選択中</span>}</strong><span>{model.provider} / {model.id}</span>{catalog.providers.find((entry) => entry.id === model.provider)?.configured === false && <span className="model-needs-connection">接続が必要</span>}
					</button>
				</li>; }}</MotionItems>
			</ul>
			<Presence show={matches.length === 0}><div className="model-picker-empty"><p>{connectedOnly ? "接続済みのモデルに一致しません。" : "検索語やプロバイダーを変えてください。"}</p><button type="button" onClick={() => { setQuery(""); setProvider(singleProvider); setConnectedOnly(false); search.current?.focus(); }}>絞り込みを解除</button></div></Presence>
			{lastPage > 0 && <div className="model-picker-pagination" aria-label="モデル一覧のページ">
				<button type="button" disabled={disabled || currentPage === 0} onClick={() => setCursor((currentPage - 1) * PAGE_SIZE)}>前の20件</button>
				<span>{currentPage + 1} / {lastPage + 1}</span>
				<button type="button" disabled={disabled || currentPage === lastPage} onClick={() => setCursor((currentPage + 1) * PAGE_SIZE)}>次の20件</button>
			</div>}
		</>}
		<p className="fine-print">↑ ↓ で移動 · Enter で選択 · Esc で検索語を消去。接続が必要なモデルは選択後に認証できます。</p>
	</fieldset>;
}
