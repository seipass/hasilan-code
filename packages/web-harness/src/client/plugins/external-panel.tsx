import { useEffect, useRef, useState } from "react";
import type { ExternalPanelEntry } from "../../shared/plugin-profile.ts";
import { errorMessage } from "../api.ts";
import type { WorkspacePanel, WorkspacePanelProps } from "./workspace-panels.ts";

type Mount = (root: HTMLElement, context: {
	workspaceId: string;
	signal: AbortSignal;
	insertDraft: (text: string) => void;
	setDirty: (dirty: boolean) => void;
}) => void | (() => void);

export function externalPanel({ id, title }: ExternalPanelEntry): WorkspacePanel {
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
		useEffect(() => {
			const node = root.current;
			if (!opened || !workspaceId || !node) return;
			setError(undefined);
			const controller = new AbortController();
			let dispose: ReturnType<Mount>;
			void load().then((mount) => {
				if (controller.signal.aborted) return;
				dispose = mount(node, {
					workspaceId,
					signal: controller.signal,
					insertDraft: (text) => { if (!controller.signal.aborted) callbacks.current.onDraft(text); },
					setDirty: (dirty) => { if (!controller.signal.aborted) callbacks.current.onDirtyChange(dirty); },
				});
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
		}, [opened, workspaceId]);
		if (!opened || !workspaceId) return null;
		return <section className="external-plugin-panel" aria-label={title}>
			{error && <p className="error" role="alert">{error}</p>}
			<div ref={root} />
		</section>;
	}
	return { id, title, icon: "panel", View };
}
