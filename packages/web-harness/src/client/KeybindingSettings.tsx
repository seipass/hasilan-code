import { useEffect, useState } from "react";
import { DEFAULT_APP_KEYBINDINGS } from "./app-keybindings.ts";
import { errorMessage } from "./api.ts";
import { preferences, usePreferenceState } from "./preferences.ts";

type Bindings = Record<string, string[]>;

const ACTIONS = [
	{ id: "composer.send", label: "送信", description: "通常の送信。実行中は実行中の指示になります。" },
	{ id: "composer.followUp", label: "完了後に指示", description: "実行中の応答が終わってから届く指示を送ります。" },
	{ id: "composer.routeWorkspace", label: "送信先を選ぶ", description: "判断モデルにワークスペースと会話を選ばせます。" },
] as const;

function normalize(value: string): string | undefined {
	const parts = value
		.toLowerCase()
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	const key = parts.at(-1);
	if (!key) return undefined;
	const modifiers = ["ctrl", "meta", "shift", "alt"].filter((modifier) => parts.includes(modifier));
	return [...modifiers, key].join("+");
}

/** Key bindings live in shared preferences, so one editor covers web and desktop. */
export function KeybindingSettings() {
	const fallback = (): Bindings =>
		Object.fromEntries(Object.entries(DEFAULT_APP_KEYBINDINGS).map(([action, keys]) => [action, [...keys]]));
	const [bindings, setBindings] = usePreferenceState<Bindings>("pi-web-keybindings", fallback);
	const [editing, setEditing] = useState<string>();
	const [capture, setCapture] = useState("");
	const [error, setError] = useState<string>();

	useEffect(() => {
		if (!editing) return;
		const handler = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape") { setEditing(undefined); setCapture(""); setError(undefined); return; }
			const key = event.key.toLowerCase();
			if (["control", "meta", "shift", "alt"].includes(key)) return;
			const parts = [event.ctrlKey ? "ctrl" : "", event.metaKey ? "meta" : "", event.shiftKey ? "shift" : "", event.altKey ? "alt" : "", key].filter(Boolean);
			setCapture(parts.join("+"));
		};
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [editing]);

	function save(action: string): void {
		const binding = normalize(capture);
		if (!binding) { setError("修飾キーとキーを1つ以上入力してください。"); return; }
		const next: Bindings = { ...bindings, [action]: [binding] };
		try {
			setBindings(next);
			void preferences.flush().catch((reason: unknown) => setError(errorMessage(reason)));
			setEditing(undefined); setCapture(""); setError(undefined);
		} catch (reason) { setError(errorMessage(reason)); }
	}

	return <div className="settings-section">
		<h3>キー割り当て</h3>
		<p>入力欄で使うキーを変更できます。変更はWeb・デスクトップで共有されます。</p>
		<ul className="keybinding-list">
			{ACTIONS.map((action) => {
				const current = bindings[action.id] ?? DEFAULT_APP_KEYBINDINGS[action.id];
				return <li key={action.id} className="keybinding-row">
					<div><strong>{action.label}</strong><span>{action.description}</span></div>
					<div className="keybinding-controls">
						{editing === action.id
							? <><kbd aria-live="polite">{capture || "キーを押してください"}</kbd><button type="button" onClick={() => save(action.id)} disabled={!capture}>保存</button><button type="button" onClick={() => { setEditing(undefined); setCapture(""); }}>取消</button></>
							: <><kbd>{current.join(" / ")}</kbd><button type="button" onClick={() => { setEditing(action.id); setCapture(""); setError(undefined); }}>変更</button><button type="button" disabled={JSON.stringify(current) === JSON.stringify(DEFAULT_APP_KEYBINDINGS[action.id])} onClick={() => setBindings({ ...bindings, [action.id]: [...DEFAULT_APP_KEYBINDINGS[action.id]] })}>既定に戻す</button></>}
					</div>
				</li>;
			})}
		</ul>
		{error && <p className="error" role="alert">{error}</p>}
		<p className="fine-print">Enter だけを割り当てると、改行は Shift + Enter になります。</p>
	</div>;
}
