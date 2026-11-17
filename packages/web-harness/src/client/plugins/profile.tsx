import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { PluginProfile } from "../../shared/plugin-profile.ts";
import { api } from "../api.ts";

const ProfileContext = createContext<PluginProfile | undefined>(undefined);

export function PluginProfileProvider({ children }: { children: ReactNode }) {
	const [profile, setProfile] = useState<PluginProfile>();
	useEffect(() => {
		const controller = new AbortController();
		void api<PluginProfile>("/api/plugin-profile", { signal: controller.signal })
			.then((value) => { if (!controller.signal.aborted) setProfile(value); })
			.catch(() => {
				if (!controller.signal.aborted) setProfile({ activeIds: [], panels: [], themes: [], plugins: [] });
			});
		return () => controller.abort();
	}, []);
	return <ProfileContext.Provider value={profile}>{children}</ProfileContext.Provider>;
}

export function usePluginProfile() {
	return useContext(ProfileContext);
}
