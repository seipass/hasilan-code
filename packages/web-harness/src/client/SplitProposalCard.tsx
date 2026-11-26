import { useState } from "react";
import type { SplitNoticeSurface, SplitProposalSurface, SurfaceAction } from "../shared/surfaces.ts";
import { errorMessage } from "./api.ts";
import { Icon } from "./Icon.tsx";
import "./SplitProposalCard.css";

export function SplitProposalCard({
	surface,
	onAction,
	onSelectSession,
}: {
	surface: SplitProposalSurface;
	onAction: (surfaceId: string, action: SurfaceAction) => Promise<void>;
	onSelectSession?: (sessionId: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	async function decide(type: "accept_split" | "keep_here") {
		if (busy) return;
		setBusy(true);
		setError(undefined);
		try {
			await onAction(surface.surfaceId, { type });
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(false);
		}
	}

	if (surface.status === "split") {
		return (
			<div className="sp-settled">
				<Icon name="split" size="inline" />
				<span>新しいセッションへ移動しました</span>
				{surface.branchName && <code className="sp-branch">{surface.branchName}</code>}
				{surface.childSessionId && onSelectSession && (
					<button type="button" className="text-link" onClick={() => onSelectSession(surface.childSessionId!)}>
						セッションを開く
					</button>
				)}
			</div>
		);
	}

	if (surface.status === "kept") {
		return <div className="sp-settled">このセッションに続けて送信しました</div>;
	}

	return (
		<div className="sp-proposal" role="region" aria-label="セッション分割の提案">
			<div className="sp-user-bubble">{surface.promptText}</div>
			<p className="sp-explanation">{surface.explanation}</p>
			<div className="sp-actions">
				<button
					type="button"
					className="sp-btn is-primary"
					disabled={busy}
					onClick={() => {
						void decide("accept_split");
					}}
				>
					<Icon name="split" size="inline" />
					<span>{busy ? "作成中…" : "新しいセッション"}</span>
				</button>
				<button
					type="button"
					className="sp-btn"
					disabled={busy}
					onClick={() => {
						void decide("keep_here");
					}}
				>
					このまま続ける
				</button>
			</div>
			{error && <p className="sp-error" role="alert">{error}</p>}
		</div>
	);
}

export function SplitNoticeCard({
	surface,
	onSelectSession,
}: {
	surface: SplitNoticeSurface;
	onSelectSession?: (sessionId: string) => void;
}) {
	return (
		<div className={`sp-notice is-${surface.status}`} role="status">
			<span className={`sp-notice-icon is-${surface.status}`} aria-hidden="true">
				<Icon name={surface.status === "completed" ? "check" : "close"} size="inline" />
			</span>
			<span className="sp-notice-text">
				<strong>{surface.childTitle}</strong>{" "}
				{surface.status === "completed" ? "が完了しました" : "が失敗しました"}
				{surface.changedFiles > 0 && ` · ${surface.changedFiles} ファイル変更`}
			</span>
			{onSelectSession && (
				<button type="button" className="text-link" onClick={() => onSelectSession(surface.childSessionId)}>
					確認する
				</button>
			)}
		</div>
	);
}
