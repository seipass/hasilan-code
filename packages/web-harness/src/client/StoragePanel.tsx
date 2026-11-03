import { useEffect, useState } from "react";
import { api, errorMessage } from "./api.ts";

interface StorageUsage {
	sessions: number;
	sessionFiles: number;
	preferences: number;
	imports: number;
	orphans: number;
	orphanBytes: number;
}

function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Shows where the agent profile spends disk; transcripts of deleted conversations are listed. */
export function StoragePanel() {
	const [usage, setUsage] = useState<StorageUsage>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(true);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		const controller = new AbortController();
		setBusy(true);
		void api<StorageUsage>("/api/storage", { signal: controller.signal })
			.then((value) => { if (!controller.signal.aborted) { setUsage(value); setError(undefined); } })
			.catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
			.finally(() => { if (!controller.signal.aborted) setBusy(false); });
		return () => controller.abort();
	}, [attempt]);

	return <div className="settings-section">
		<div className="storage-heading"><h3>保存データ</h3><button type="button" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>{busy ? "集計中…" : "更新"}</button></div>
		<p>会話・設定・引き継いだ素材は <code>~/.hasilan-code/agent</code> に保存します。</p>
		{error && <p className="error" role="alert">{error}</p>}
		{usage && <dl className="storage-table">
			<div><dt>会話の記録</dt><dd>{size(usage.sessions)}<small>{usage.sessionFiles.toLocaleString("ja-JP")}ファイル</small></dd></div>
			<div><dt>画面の設定・下書き</dt><dd>{size(usage.preferences)}</dd></div>
			<div><dt>引き継いだ素材</dt><dd>{size(usage.imports)}</dd></div>
		</dl>}
		{usage && usage.orphans > 0 && <p className="fine-print">アプリから削除した会話の記録が {usage.orphans.toLocaleString("ja-JP")} ファイル、{size(usage.orphanBytes)} 残っています。会話を削除しても記録ファイルは残る仕様です。</p>}
		{usage && usage.orphans === 0 && <p className="fine-print">アプリから削除した会話の記録はありません。</p>}
		<p className="fine-print">この画面は集計のみです。ファイルは削除しません。</p>
	</div>;
}
