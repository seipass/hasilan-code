import { useSyncExternalStore } from "react";
import { preferences } from "./preferences.ts";

export function PreferenceStatus() {
	const error = useSyncExternalStore(preferences.subscribeStatus, preferences.getError, preferences.getError);
	return error ? <div className="global-error" role="alert"><span>{error}</span><button type="button" onClick={() => { void preferences.flush().catch(() => undefined); }}>再試行</button></div> : null;
}
