import { usePreferenceState } from "./preferences.ts";

/** Opt-in desktop notification when a run settles while the tab is in the background. */
export function NotificationPreference() {
	const [enabled, setEnabled] = usePreferenceState("pi-web-notifications", false);
	const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;

	async function toggle(next: boolean): Promise<void> {
		if (next && permission === "default") {
			const granted = await Notification.requestPermission();
			if (granted !== "granted") return;
		}
		setEnabled(next);
	}

	return <div className="settings-section">
		<h3>完了通知</h3>
		<p>このタブを表示していない間に作業が完了または失敗したとき、デスクトップ通知を出します。</p>
		<label className="settings-toggle"><input type="checkbox" checked={enabled} disabled={permission === "unsupported"} onChange={(event) => { void toggle(event.currentTarget.checked); }} /><span>デスクトップ通知を有効にする</span></label>
		<p className="fine-print">{permission === "unsupported" ? "このブラウザーは通知に対応していません。" : permission === "denied" ? "ブラウザーの設定で通知がブロックされています。サイトの権限から許可してください。" : "通知の許可はこのボタンで初めて要求します。タブのタイトルとアイコンは、通知を有効にしなくても実行中・完了を示します。"}</p>
	</div>;
}
