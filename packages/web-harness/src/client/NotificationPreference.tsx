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

	return (
		<section id="appearance-notify" className="appearance-card">
			<div className="appearance-card-header">
				<div>
					<h3>完了通知</h3>
					<p className="appearance-card-desc">バックグラウンド時に作業が完了または失敗したとき、デスクトップ通知を出します。</p>
				</div>
			</div>
			<label className="settings-toggle appearance-toggle-row">
				<span className="appearance-toggle-copy">
					<strong>デスクトップ通知を有効にする</strong>
					<span>
						{permission === "unsupported"
							? "このブラウザーは通知に対応していません。"
							: permission === "denied"
								? "ブラウザーの設定で通知がブロックされています。"
								: "タブのタイトルとアイコンはオフでも実行中・完了を示します。"}
					</span>
				</span>
				<input
					type="checkbox"
					checked={enabled}
					disabled={permission === "unsupported"}
					onChange={(event) => {
						void toggle(event.currentTarget.checked);
					}}
				/>
			</label>
		</section>
	);
}
