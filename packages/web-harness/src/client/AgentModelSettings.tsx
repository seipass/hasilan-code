import { useState } from "react";
import { AGENT_CATEGORIES, type AgentCategory, type AgentModels } from "../shared/agent-categories.ts";
import { Select } from "./Select.tsx";
import type { ModelCatalog, ThinkingLevel } from "./types.ts";

export function AgentModelSettings({ models, catalog, busy, onChange, onSave, changed }: {
	models: AgentModels;
	catalog?: ModelCatalog;
	busy: boolean;
	onChange: (models: AgentModels) => void;
	onSave: () => void;
	changed: boolean;
}) {
	const [category, setCategory] = useState<AgentCategory>("coding");
	const selection = models[category];
	const providers = catalog?.providers.filter((provider) => provider.configured && catalog.models.some((model) => model.provider === provider.id)) ?? [];
	const available = catalog?.models.filter((model) => model.provider === selection?.provider) ?? [];
	const levels = available.find((model) => model.id === selection?.id)?.thinkingLevels ?? ["off"];
	return <form onSubmit={(event) => { event.preventDefault(); onSave(); }}>
		<fieldset disabled={busy} className="settings-section">
			<legend>担当タスク別のモデル</legend>
			<p>Hyakki-Yako とチーム機能で、AI が担当を割り当てるときに使います。</p>
			<div className="settings-field-grid">
				<label>タスクの種類<Select value={category} onChange={(value) => setCategory(value as AgentCategory)}>
					{Object.entries(AGENT_CATEGORIES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
				</Select></label>
				<label>プロバイダー<Select value={selection?.provider ?? ""} onChange={(provider) => {
					const next = { ...models };
					const first = catalog?.models.find((model) => model.provider === provider);
					if (first) next[category] = { provider, id: first.id, thinkingLevel: first.thinkingLevels?.[0] ?? "off" };
					else delete next[category];
					onChange(next);
				}}><option value="">指定なし</option>
					{selection && !providers.some(({ id }) => id === selection.provider) && <option value={selection.provider}>{selection.provider}（利用不可）</option>}
					{providers.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
				</Select></label>
			</div>
			{selection && <div className="settings-field-grid">
				<label>モデル<Select value={selection.id} onChange={(id) => {
					const supported = available.find((model) => model.id === id)?.thinkingLevels ?? ["off"];
					const thinkingLevel = supported.includes(selection.thinkingLevel) ? selection.thinkingLevel : supported[0] ?? "off";
					onChange({ ...models, [category]: { ...selection, id, thinkingLevel } });
				}}>
					{!available.some(({ id }) => id === selection.id) && <option value={selection.id}>{selection.id}（利用不可）</option>}
					{available.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
				</Select></label>
				<label>Thinking<Select value={selection.thinkingLevel} onChange={(value) => onChange({ ...models, [category]: { ...selection, thinkingLevel: value as ThinkingLevel } })}>
					{levels.map((level) => <option key={level} value={level}>{level}</option>)}
				</Select></label>
			</div>}
			<div className="settings-form-footer">
				<p className="settings-inline-status" role="status">{changed ? "変更は未保存です。" : "変更なし"}</p>
				<div className="settings-actions"><button type="submit" disabled={!changed}>保存</button></div>
			</div>
		</fieldset>
	</form>;
}
