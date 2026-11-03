import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { errorMessage } from "./api.ts";
import { anyDraftDirty } from "./files/file-drafts.ts";
import { preferences } from "./preferences.ts";
import "./styles.css";
import "./GlassSurfaces.css";
import "./CornerRadius.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
const application = createRoot(root);
async function start(): Promise<void> {
	application.render(<p role="status">設定を読み込んでいます…</p>);
	try {
		let legacy: Storage | undefined;
		try { legacy = window.localStorage; } catch { /* Browser storage is optional. */ }
		await preferences.initialize(legacy);
		application.render(<StrictMode><App /></StrictMode>);
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

declare global {
	interface Window { hasilanFlushPreferences?: () => Promise<void> }
}
