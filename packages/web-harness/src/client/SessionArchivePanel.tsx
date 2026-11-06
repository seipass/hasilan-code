import { useEffect, useState } from "react";
import type { ArchivedSession } from "../shared/session-archive.ts";
import { api, errorMessage } from "./api.ts";
import "./SessionArchivePanel.css";

const dates = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" });

export function SessionArchivePanel({ onRestored }: { onRestored?: () => Promise<void> }) {
	const [entries, setEntries] = useState<ArchivedSession[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	useEffect(() => {
		const controller = new AbortController();
		void api<ArchivedSession[]>("/api/session-archive", { signal: controller.signal }).then(
			(value) => { if (!controller.signal.aborted) setEntries(value); },
			(reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); },
		).finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, []);

	async function change(targets: ArchivedSession[], method: "POST" | "DELETE") {
		if (busy || targets.length === 0) return;
		if (method === "DELETE" && !window.confirm(`${targets.length}件の会話記録を完全に削除しますか？ この操作は取り消せません。`)) return;
		setBusy(true);
		setNotice(undefined);
		setError(undefined);
		let completed = 0;
		const failures: string[] = [];
		for (const entry of targets) {
			try {
				await api(`/api/session-archive/${encodeURIComponent(entry.file)}`, { method });
				setEntries((previous) => previous.filter((item) => item.file !== entry.file));
				completed++;
			} catch (reason) {
				failures.push(errorMessage(reason));
			}
		}
		if (completed && method === "POST") {
			try { await onRestored?.(); }
			catch { setError("会話は復元されました。一覧を更新できなかったため、画面を再読み込みしてください。"); }
		}
		if (completed) setNotice(`${completed}件を${method === "POST" ? "復元" : "完全に削除"}しました。`);
		if (failures.length) setError(`${failures.length}件を処理できませんでした。 ${failures[0]}`);
		setBusy(false);
	}

	return <>
		<div className="storage-heading"><h3>アーカイブ</h3><button type="button" className="danger" disabled={busy || loading || !entries.length} onClick={() => { void change(entries, "DELETE"); }}>すべて完全に削除</button></div>
		<p className="fine-print">削除済みの会話記録を復元するか、完全に削除できます。</p>
		{loading && <p role="status">アーカイブを読み込み中…</p>}
		{notice && <p role="status">{notice}</p>}
		{error && <p className="error" role="alert">{error}</p>}
		{!loading && !error && !entries.length && <p>アーカイブは空です。</p>}
		<ul className="session-archive-list" aria-busy={busy}>
			{entries.map((entry) => <li className="settings-section" key={entry.file}>
				<strong>{entry.title || entry.sessionId}</strong>
				<small title={entry.cwd}>{entry.cwd}</small>
				<small><time dateTime={new Date(entry.modifiedAt).toISOString()}>{dates.format(entry.modifiedAt)}</time> · {(entry.bytes / (1024 * 1024)).toLocaleString("ja-JP", { maximumFractionDigits: 1 })} MB</small>
				<div className="session-archive-actions">
					<button type="button" disabled={busy} onClick={() => { void change([entry], "POST"); }}>復元</button>
					<button type="button" className="danger" disabled={busy} onClick={() => { void change([entry], "DELETE"); }}>完全に削除</button>
				</div>
			</li>)}
		</ul>
	</>;
}
