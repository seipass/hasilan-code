import { useMemo } from "react";
import { App } from "../App.tsx";
import { externalPanel } from "./external-panel.tsx";
import { usePluginProfile } from "./profile.tsx";

export function PluginApplication() {
	const profile = usePluginProfile();
	const selected = profile?.application?.kind === "external" ? profile.application.panel : undefined;
	const View = useMemo(() => selected ? externalPanel(selected).View : undefined, [selected]);
	if (!profile) return <p role="status">プラグインを読み込んでいます…</p>;
	if (View) return <View opened onDraft={() => {}} onDirtyChange={() => {}} />;
	if (profile.application?.kind === "built-in") return <App />;
	return <main className="external-plugin-panel"><p>表示する画面がありません。プラグイン設定を確認してください。</p></main>;
}
