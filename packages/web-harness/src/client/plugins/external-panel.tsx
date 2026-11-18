import { useEffect, useRef, useState } from "react";
import type { ExternalPanelEntry } from "../../shared/plugin-profile.ts";
import { errorMessage } from "../api.ts";
import type { WorkspacePanel, WorkspacePanelProps } from "./workspace-panels.ts";

type MountContext = { signal: AbortSignal } & ({
	scope: "application";
} | {
	scope: "workspace";
	workspaceId: string;
	insertDraft: (text: string) => void;
	setDirty: (dirty: boolean) => void;
});
type Mount = (root: HTMLElement, context: MountContext) => void | (() => void);

export function externalPanel({ id, title, scope }: ExternalPanelEntry): WorkspacePanel {
	let loading: Promise<Mount> | undefined;
	function load() {
		loading ??= new Promise<Mount>((resolve, reject) => {
			const script = document.createElement("script");
			script.src = `/api/plugin-profile/${encodeURIComponent(id)}/panel.js`;
			let mount: Mount | undefined;
			script.addEventListener("hasilan:panel", (event) => {
				const detail: unknown = (event as CustomEvent).detail;
				if (typeof detail === "function") mount = detail as Mount;
			}, { once: true });
			script.onload = () => {
				script.remove();
				if (mount) resolve(mount);
				else reject(new Error("プラグインが画面を登録しませんでした。"));
			};
			script.onerror = () => {
				script.remove();
				reject(new Error("プラグイン画面を読み込めませんでした。"));
			};
			document.head.append(script);
		}).catch((error: unknown) => {
			loading = undefined;
			throw error;
		});
		return loading;
	}
	function View({ workspaceId, opened, onDraft, onDirtyChange }: WorkspacePanelProps) {
		const root = useRef<HTMLDivElement>(null);
		const callbacks = useRef({ onDraft, onDirtyChange });
		callbacks.current = { onDraft, onDirtyChange };
		const [error, setError] = useState<string>();
		const [retry, setRetry] = useState(0);
		const ready = opened && (scope === "application" || !!workspaceId);
		useEffect(() => {
			const node = root.current;
			if (!opened || !node) return;
			setError(undefined);
			const controller = new AbortController();
			const signal = controller.signal;
			const context: MountContext | undefined = scope === "application"
				? { scope, signal }
				: workspaceId ? {
					scope: "workspace", workspaceId, signal,
					insertDraft: (text) => { if (!signal.aborted) callbacks.current.onDraft(text); },
					setDirty: (dirty) => { if (!signal.aborted) callbacks.current.onDirtyChange(dirty); },
				} : undefined;
			if (!context) return;
			let dispose: ReturnType<Mount>;
			void load().then((mount) => {
				if (!signal.aborted) dispose = mount(node, context);
			}).catch((reason: unknown) => {
				if (!controller.signal.aborted) {
					node.replaceChildren();
					callbacks.current.onDirtyChange(false);
					setError(errorMessage(reason));
				}
			});
			return () => {
				controller.abort();
				try { dispose?.(); }
				catch (reason) { console.error(errorMessage(reason)); }
				finally {
					node.replaceChildren();
					callbacks.current.onDirtyChange(false);
				}
			};
		}, [opened, workspaceId, retry]);
		if (!ready) return null;
		return <section className={scope === "application" ? "external-plugin-panel external-application" : "external-plugin-panel"} aria-label={title}>
			{error && <div role="alert"><p className="error">{error}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>再試行</button></div>}
			<div ref={root} />
		</section>;
	}
	return { id, title, icon: "panel", View };
}
