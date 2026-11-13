import { useId, useState } from "react";
import type { BrowserStyles } from "../shared/browser-adjustments.ts";

export function BrowserCssEditor({ computed, inline, adjusted, onApply }: {
	computed?: BrowserStyles;
	inline?: BrowserStyles;
	adjusted: BrowserStyles;
	onApply: (property: string, value: string | null | undefined) => boolean;
}) {
	const list = useId();
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const property = name.trim().startsWith("--") ? name.trim() : name.trim().toLowerCase();
	const properties = [...new Set([...Object.keys(computed ?? {}), ...Object.keys(inline ?? {}), ...Object.keys(adjusted)])].sort();
	const declarations = [...new Set([...Object.keys(inline ?? {}), ...Object.keys(adjusted)])];
	const currentValue = Object.hasOwn(adjusted, property) ? adjusted[property]
		: inline && Object.hasOwn(inline, property) ? inline[property]
		: computed && Object.hasOwn(computed, property) ? computed[property] : undefined;
	const apply = () => {
		if (property && value.trim() && onApply(property, value.trim())) setValue("");
	};
	return <details className="browser-css-editor">
		<summary>CSSを直接編集</summary>
		<div className="browser-css-fields">
			<input aria-label="CSSプロパティ" placeholder="box-shadow" list={list} value={name}
				onChange={(event) => setName(event.target.value)} />
			<datalist id={list}>{properties.map((key) => <option key={key} value={key} />)}</datalist>
			<input aria-label="CSSの値" placeholder={currentValue || "値"} value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
					event.preventDefault();
					apply();
				}} />
			<button type="button" disabled={!property || !value.trim()} onClick={apply}>適用</button>
		</div>
		{declarations.length > 0 && <ul>{declarations.map((key) => {
			const changed = Object.hasOwn(adjusted, key);
			const current = changed ? adjusted[key] : inline?.[key];
			return <li key={key}>
				<button type="button" className="browser-css-declaration" onClick={() => { setName(key); setValue(current ?? ""); }}>
					<code>{key}</code><span>{current ?? "削除"}</span>
				</button>
				{current !== null && <button type="button" aria-label={`${key} を削除`}
					onClick={() => onApply(key, Object.hasOwn(inline ?? {}, key) ? null : undefined)}>削除</button>}
				{changed && <button type="button" aria-label={`${key} を元に戻す`} onClick={() => onApply(key, undefined)}>戻す</button>}
			</li>;
		})}</ul>}
	</details>;
}
