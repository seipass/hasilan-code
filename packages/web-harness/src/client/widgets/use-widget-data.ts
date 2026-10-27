import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api.ts";

export function useWidgetData<T>(path: string | undefined, enabled: boolean, interval: number) {
	const [result, setResult] = useState<{ path: string; data?: T; error?: string; busy: boolean }>();
	const refresh = useRef<() => void>(() => {});
	useEffect(() => {
		if (!path || !enabled) return;
		const controller = new AbortController();
		let timer: number | undefined;
		let pending = false;
		const update = async () => {
			if (pending || controller.signal.aborted) return;
			window.clearTimeout(timer);
			if (document.visibilityState === "hidden") {
				timer = window.setTimeout(() => {
					void update();
				}, interval);
				return;
			}
			pending = true;
			setResult((previous) => ({ ...(previous?.path === path ? previous : undefined), path, busy: true }));
			try {
				const data = await api<T>(path, { signal: controller.signal });
				if (!controller.signal.aborted) setResult({ path, data, busy: false });
			} catch (error) {
				if (!controller.signal.aborted)
					setResult((previous) => ({
						...(previous?.path === path ? previous : undefined),
						path,
						error: errorMessage(error),
						busy: false,
					}));
			} finally {
				pending = false;
				if (!controller.signal.aborted)
					timer = window.setTimeout(() => {
						void update();
					}, interval);
			}
		};
		const onVisible = () => {
			if (document.visibilityState === "visible") void update();
		};
		refresh.current = () => {
			void update();
		};
		void update();
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			refresh.current = () => {};
			controller.abort();
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [path, enabled, interval]);
	return { ...(result?.path === path ? result : undefined), refresh: () => refresh.current() };
}
