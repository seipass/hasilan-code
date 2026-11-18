import { Component, type ComponentType, lazy, type ReactNode, Suspense, useMemo } from "react";
import { externalPanel } from "./external-panel.tsx";
import { usePluginProfile } from "./profile.tsx";

const applicationModules = import.meta.glob<ComponentType>("../App.tsx", { import: "App" });
const BundledApplication = lazy(() => applicationModules["../App.tsx"]().then((App) => ({ default: App })));
const loading = <p role="status">プラグインを読み込んでいます…</p>;

class ApplicationBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		if (this.state.failed) return <div className="global-error" role="alert">
			<span>標準画面を読み込めませんでした。</span>
			<button type="button" onClick={() => window.location.reload()}>再読み込み</button>
		</div>;
		return this.props.children;
	}
}

export function PluginApplication() {
	const profile = usePluginProfile();
	const selected = profile?.application?.kind === "external" ? profile.application.panel : undefined;
	const View = useMemo(() => selected ? externalPanel(selected).View : undefined, [selected]);
	if (!profile) return loading;
	if (View) return <View opened onDraft={() => {}} onDirtyChange={() => {}} />;
	if (profile.application?.kind === "built-in") return <ApplicationBoundary>
		<Suspense fallback={loading}><BundledApplication /></Suspense>
	</ApplicationBoundary>;
	return <main className="external-plugin-panel"><p>表示する画面がありません。プラグイン設定を確認してください。</p></main>;
}
