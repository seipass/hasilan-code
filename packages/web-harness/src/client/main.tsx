import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage } from "./api.ts";
import { ApplicationFont } from "./FontAppearance.tsx";
import { ApplicationTheme } from "./ThemeAppearance.tsx";
import { anyDraftDirty } from "./files/file-drafts.ts";
import { PluginApplication } from "./plugins/application.tsx";
import { PluginProfileProvider } from "./plugins/profile.tsx";
import { preferences } from "./preferences.ts";
import { trackVisualViewport } from "./visual-viewport.ts";
import "./styles.css";
import "./CornerRadius.css";
import "./CleanAppearance.css";
import "./GlassSurfaces.css";
import "./Mobile.css";
import "./NoMotion.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
const application = createRoot(root);
async function start(): Promise<void> {
	application.render(<p role="status">設定を読み込んでいます…</p>);
	try {
		let legacy: Storage | undefined;
		try { legacy = window.localStorage; } catch { /* Browser storage is optional. */ }
		await preferences.initialize(legacy);
		application.render(<StrictMode><PluginProfileProvider><ApplicationFont /><ApplicationTheme /><PluginApplication /></PluginProfileProvider></StrictMode>);
	} catch (reason) {
		application.render(<div className="global-error" role="alert"><span>設定を読み込めません: {errorMessage(reason)}</span><button type="button" onClick={() => { void start(); }}>再試行</button></div>);
	}
}
window.hasilanFlushPreferences = () => preferences.flush();
window.addEventListener("pagehide", () => { void preferences.flush().catch(() => undefined); });
window.addEventListener("beforeunload", (event) => {
	if (anyDraftDirty()) event.preventDefault();
});
window.addEventListener("focus", () => { void preferences.sync().catch(() => undefined); });
document.addEventListener("visibilitychange", () => { if (document.hidden) void preferences.flush().catch(() => undefined); });
window.setInterval(() => { if (!document.hidden) void preferences.sync().catch(() => undefined); }, 3000);
void start();
trackVisualViewport();

declare global {
	interface Window { hasilanFlushPreferences?: () => Promise<void> }
}
