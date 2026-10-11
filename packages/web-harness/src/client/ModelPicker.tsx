import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ModelCatalog } from "./types.ts";

export interface ModelPickerProps {
	catalog?: ModelCatalog;
	value?: { provider: string; id: string };
	onChange: (selection: { provider: string; id: string }) => void;
	disabled?: boolean;
	autoFocus?: boolean;
}

const PAGE_SIZE = 20;

export function ModelPicker({ catalog, value, onChange, disabled = false, autoFocus = false }: ModelPickerProps) {
	const labelId = useId();
	const providerId = useId();
	const searchId = useId();
	const resultsId = useId();
	const search = useRef<HTMLInputElement>(null);
	const [provider, setProvider] = useState("");
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const singleProvider = catalog?.providers.length === 1 ? catalog.providers[0].id : "";
	useEffect(() => { setProvider(singleProvider); }, [singleProvider]);
	useEffect(() => { if (autoFocus && !disabled) search.current?.focus(); }, [autoFocus, disabled]);
	const matches = useMemo(() => {
		const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
		const configured = new Set(catalog?.providers.filter((entry) => entry.configured === true).map((entry) => entry.id));
		return catalog?.models.filter((model) => {
			if (provider && model.provider !== provider) return false;
			const text = `${model.name ?? ""} ${model.id} ${model.provider}`.toLocaleLowerCase();
			return terms.every((term) => text.includes(term));
		}).sort((a, b) => {
			return Number(configured.has(b.provider)) - Number(configured.has(a.provider)) || a.provider.localeCompare(b.provider) || (a.name ?? a.id).localeCompare(b.name ?? b.id);
		}) ?? [];
	}, [catalog, provider, query]);
	useEffect(() => { setCursor(0); }, [matches]);
	const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
	const activeIndex = Math.min(cursor, Math.max(0, matches.length - 1));
	const currentPage = Math.floor(activeIndex / PAGE_SIZE);
	const visible = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
	useEffect(() => { document.getElementById(`${resultsId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" }); }, [activeIndex, resultsId, matches]);
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
				<input ref={search} id={searchId} type="search" role="combobox" aria-autocomplete="list" aria-expanded={!!catalog} aria-controls={resultsId} aria-activedescendant={matches.length ? `${resultsId}-${activeIndex}` : undefined} autoComplete="off" placeholder="モデル名・プロバイダーを検索" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
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
		{!catalog ? <p role="status">モデル一覧を読み込み中…</p> : <>
			<p className="fine-print" role="status">{matches.length === 0 ? "一致するモデルはありません。検索語やプロバイダーを変更してください。" : `${matches.length} 件中 ${currentPage * PAGE_SIZE + 1}–${currentPage * PAGE_SIZE + visible.length} 件`}</p>
			<ul id={resultsId} className="model-picker-results" role="listbox" aria-label="モデル">
				{visible.map((model, index) => <li role="presentation" key={`${model.provider}/${model.id}`}>
					<button id={`${resultsId}-${currentPage * PAGE_SIZE + index}`} type="button" role="option" className="model-picker-option" aria-selected={value?.provider === model.provider && value.id === model.id} data-highlighted={activeIndex === currentPage * PAGE_SIZE + index} onMouseMove={() => setCursor(currentPage * PAGE_SIZE + index)} onClick={() => onChange({ provider: model.provider, id: model.id })}>
						<strong>{model.name ?? model.id}{value?.provider === model.provider && value.id === model.id && <span className="model-selected-mark" aria-label="選択中">✓</span>}</strong><span>{model.provider} / {model.id}{catalog.providers.find((entry) => entry.id === model.provider)?.configured === false ? " · 接続する" : ""}</span>
					</button>
				</li>)}
			</ul>
			{lastPage > 0 && <div className="model-picker-pagination" aria-label="モデル一覧のページ">
				<button type="button" disabled={disabled || currentPage === 0} onClick={() => setCursor((currentPage - 1) * PAGE_SIZE)}>前の20件</button>
				<span>{currentPage + 1} / {lastPage + 1}</span>
				<button type="button" disabled={disabled || currentPage === lastPage} onClick={() => setCursor((currentPage + 1) * PAGE_SIZE)}>次の20件</button>
			</div>}
		</>}
		<p className="fine-print">↑ ↓ で移動、Enter で選択。未接続のプロバイダーは、対応するアカウントログインまたは API キーで接続してください。</p>
	</fieldset>;
}
