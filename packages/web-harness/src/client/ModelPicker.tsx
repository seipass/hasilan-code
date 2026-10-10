import { useEffect, useId, useMemo, useState } from "react";
import type { ModelCatalog } from "./types.ts";

export interface ModelPickerProps {
	catalog?: ModelCatalog;
	value?: { provider: string; id: string };
	onChange: (selection: { provider: string; id: string }) => void;
	disabled?: boolean;
}

const PAGE_SIZE = 20;

export function ModelPicker({ catalog, value, onChange, disabled = false }: ModelPickerProps) {
	const labelId = useId();
	const providerId = useId();
	const searchId = useId();
	const [provider, setProvider] = useState(value?.provider ?? "");
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(0);
	const singleProvider = catalog?.providers.length === 1 ? catalog.providers[0].id : "";
	useEffect(() => {
		setProvider(value?.provider ?? singleProvider);
		setQuery("");
		setPage(0);
	}, [value?.provider, singleProvider]);
	const matches = useMemo(() => {
		const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
		return catalog?.models.filter((model) => {
			if (provider && model.provider !== provider) return false;
			const text = `${model.name ?? ""} ${model.id} ${model.provider}`.toLocaleLowerCase();
			return terms.every((term) => text.includes(term));
		}) ?? [];
	}, [catalog, provider, query]);
	const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
	const currentPage = Math.min(page, lastPage);
	const visible = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
	const selected = value && catalog?.models.find((model) => model.provider === value.provider && model.id === value.id);

	return <fieldset className="model-picker" disabled={disabled} aria-labelledby={labelId}>
		<legend id={labelId}>モデルを選択</legend>
		<div className="model-picker-filters">
			{catalog && catalog.providers.length > 1 && <label htmlFor={providerId}>プロバイダー
				<select id={providerId} value={provider} onChange={(event) => { setProvider(event.target.value); setPage(0); }}>
					<option value="">すべてのプロバイダー</option>
					{catalog.providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.configured === true ? " · 接続設定済み" : entry.configured === false ? " · キー未設定" : ""}</option>)}
				</select>
			</label>}
			<label htmlFor={searchId}>モデルを検索
				<input id={searchId} type="search" autoComplete="off" placeholder="モデル名・IDで検索" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
			</label>
		</div>
		<p className="model-picker-selection">{value ? <>選択中: <strong>{selected?.name ?? value.id}</strong> <span>{value.provider} / {value.id}</span></> : "モデルはまだ選択されていません。"}</p>
		{!catalog ? <p role="status">モデル一覧を読み込み中…</p> : <>
			<p className="fine-print" role="status">{matches.length === 0 ? "一致するモデルはありません。検索語やプロバイダーを変更してください。" : `${matches.length} 件中 ${currentPage * PAGE_SIZE + 1}–${currentPage * PAGE_SIZE + visible.length} 件`}</p>
			<ul className="model-picker-results" aria-label="検索結果">
				{visible.map((model) => <li key={`${model.provider}/${model.id}`}>
					<button type="button" className="model-picker-option" aria-pressed={value?.provider === model.provider && value.id === model.id} onClick={() => onChange({ provider: model.provider, id: model.id })}>
						<strong>{model.name ?? model.id}</strong><span>{model.provider} / {model.id}</span>
					</button>
				</li>)}
			</ul>
			{lastPage > 0 && <div className="model-picker-pagination" aria-label="モデル一覧のページ">
				<button type="button" disabled={disabled || currentPage === 0} onClick={() => setPage(currentPage - 1)}>前の20件</button>
				<span>{currentPage + 1} / {lastPage + 1}</span>
				<button type="button" disabled={disabled || currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>次の20件</button>
			</div>}
		</>}
		<p className="fine-print">API キーが未設定でも選択できます。実行する前にプロバイダーの接続を設定してください。</p>
	</fieldset>;
}
