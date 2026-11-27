import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "./api.ts";
import { FontAppearance } from "./FontAppearance.tsx";
import { ThemeAppearance } from "./ThemeAppearance.tsx";
import { HOME_BACKGROUND_KEY, type HomeBackground, parseHomeBackground, prepareHomeBackground, saveHomeBackground } from "./home-background.ts";
import { preferences, usePreferenceState, usePreferenceString } from "./preferences.ts";
import { Presence } from "./Motion.tsx";
import "./HomeAppearance.css";

export function useHomeBackground() {
	const stored = usePreferenceString(HOME_BACKGROUND_KEY);
	const background = useMemo(() => parseHomeBackground(stored), [stored]);
	useEffect(() => {
		// The image is fetched on demand so it does not inflate the startup preference snapshot.
		if (stored !== null) return;
		void preferences.load(HOME_BACKGROUND_KEY).catch(() => undefined);
	}, [stored]);
	const changeBackground = useCallback((next: HomeBackground | undefined) => {
		saveHomeBackground(next);
		void preferences.flush().catch(() => undefined);
	}, []);
	return { background, changeBackground };
}

export function HomeBackdrop({ background }: { background?: HomeBackground }) {
	return <Presence show={!!background}>{background && <div className="home-backdrop" aria-hidden="true"><img key={background.image} src={background.image} alt="" /></div>}</Presence>;
}

export function HomeAppearance({ background, onChange }: { background?: HomeBackground; onChange: (next: HomeBackground | undefined) => void }) {
	const [dashboardEnabled, setDashboardEnabled] = usePreferenceState("pi-web-home-dashboard", true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const input = useRef<HTMLInputElement>(null);
	const mounted = useRef(false);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	async function choose(file: File) {
		setBusy(true); setError(undefined);
		try {
			const next = await prepareHomeBackground(file);
			if (mounted.current) onChange(next);
		} catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
		finally { if (mounted.current) setBusy(false); }
	}
	return (
		<>
			<ThemeAppearance />
			<FontAppearance />
			<section id="appearance-home" className="appearance-card home-appearance" aria-busy={busy}>
				<div className="appearance-card-header">
					<div>
						<h3>ホーム画面</h3>
						<p className="appearance-card-desc">ウィジェット表示とホーム上部の背景画像を設定します。</p>
					</div>
				</div>
				<label className="settings-toggle appearance-toggle-row">
					<span className="appearance-toggle-copy">
						<strong>ホーム画面にウィジェットを表示</strong>
						<span>GitHub 活動・日次トークン推移・最近の会話を表示します</span>
					</span>
					<input
						type="checkbox"
						checked={dashboardEnabled}
						onChange={(event) => setDashboardEnabled(event.currentTarget.checked)}
					/>
				</label>
				<div className="appearance-divider" />
				<div className="home-bg-layout">
					<div className="home-background-preview" aria-label="背景のプレビュー">
						<HomeBackdrop background={background} />
						{!background && <span>背景画像なし</span>}
						<div className="home-background-preview-composer" aria-hidden="true">
							<span>Hasilan Code</span>
							<i />
						</div>
					</div>
					<div className="home-bg-controls">
						<p className="home-background-name" role="status">
							{busy ? "画像を準備しています…" : background ? background.name : "画像を選択するとすぐに反映されます。"}
						</p>
						<input
							ref={input}
							type="file"
							accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/bmp"
							aria-label="ホームの背景画像"
							hidden
							disabled={busy}
							onChange={(event) => {
								const file = event.currentTarget.files?.[0];
								event.currentTarget.value = "";
								if (file) void choose(file);
							}}
						/>
						<div className="home-background-actions">
							<button type="button" className="appearance-primary-btn" disabled={busy} onClick={() => input.current?.click()}>
								{background ? "画像を変更" : "画像を選択"}
							</button>
							<button
								type="button"
								className="appearance-ghost-btn"
								disabled={busy || !background}
								onClick={() => {
									try {
										onChange(undefined);
										setError(undefined);
									} catch (reason) {
										setError(errorMessage(reason));
									}
								}}
							>
								背景を解除
							</button>
						</div>
						<p className="fine-print">20 MB 以下の JPEG / PNG / WebP / AVIF / GIF / BMP に対応。</p>
						<Presence show={!!error}>
							<p className="error" role="alert">
								{error}
							</p>
						</Presence>
					</div>
				</div>
			</section>
		</>
	);
}
