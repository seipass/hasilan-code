import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { PluginProfile } from "../../shared/plugin-profile.ts";
import { api, errorMessage } from "../api.ts";

const ProfileContext = createContext<PluginProfile | undefined>(undefined);

export function PluginProfileProvider({ children }: { children: ReactNode }) {
	const [profile, setProfile] = useState<PluginProfile>();
	const [error, setError] = useState<string>();
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		void api<PluginProfile>("/api/plugin-profile", { signal: controller.signal })
			.then((value) => { if (!controller.signal.aborted) setProfile(value); })
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(errorMessage(reason));
			});
		return () => controller.abort();
	}, [attempt]);
	if (error) return <div className="global-error" role="alert">
		<span>プラグイン設定を読み込めませんでした。{error}</span>
		<button type="button" onClick={() => { setError(undefined); setAttempt((value) => value + 1); }}>再試行</button>
	</div>;
	return <ProfileContext.Provider value={profile}>{children}</ProfileContext.Provider>;
}

export function usePluginProfile() {
	return useContext(ProfileContext);
}
