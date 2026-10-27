# アニメーション適用状況の調査

調査日: 2026-10-24

対象: `packages/web-harness/src/client` の画面コンポーネント、CSS、状態更新の経路。PC表示と390×844のスマホ表示で主要な開閉も確認した。以下の一覧・行番号は実装前の調査記録。実装後の結果は末尾に記載する。

アニメーションがない、表示時だけ動く、一部の操作経路だけ動かない状態変化を、42の操作単位に整理した。各項目は実装上の適用状況であり、すべてに動きを足すべきという意味ではない。「任意」は即時に切り替わる方がよい可能性もある。

認証の開始、モデルへの依頼、送信、削除、設計の保存などは実行していない。それらに依存する状態変化はコードによる確認。静的な本文、OS標準ダイアログ、ブラウザー標準の動画操作UIは対象外。

## 先に確認したい不一致

1. 会話の右クリックメニュー、名前変更・削除確認、セッション引き継ぎには、画面本体・背景とも開閉アニメーションがない。
2. モデルメニューは外側クリック・メニュー内Escapeでは終了処理を通るが、モデル名をもう一度押すと親が即座に削除する。画面切り替えや設定への移動にも直接削除する経路がある。
3. タブ用の一部CSSは旧クラス `.files-tab` / `.terminal-tab-item` 向け。現在の作業タブは `.detail-tab` であり、その指定は適用されない。ファイルタブを閉じるとパネル全体の画面切り替えは走るが、各タブの位置・幅の変化は補間されない。
4. 通知・スラッシュコマンド候補などは、表示時のアニメーションに対して削除時の処理がない。

## 会話・ナビゲーション

| ID | 場面 | 未適用の範囲・根拠 | 優先度 |
| --- | --- | --- | --- |
| 01 | 会話の右クリックメニュー | `.session-context-menu` の表示・消去に指定なし。親による条件付き描画で即座に消える。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SessionActions.tsx:71) | 高 |
| 02 | 名前変更・削除確認 | `.session-action-dialog` と `::backdrop` に開閉指定なし。キャンセルもそのまま削除する。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SessionActions.tsx:63) | 高 |
| 03 | セッション引き継ぎダイアログ | `.session-import-dialog` と背景に開閉指定なし。スマホの全画面表示も共通。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SessionImportDialog.tsx:73) | 高 |
| 04 | 引き継ぎの「読み込みについて」 | `.session-import-warnings` は共通の `::details-content` 対象に含まれず、本文が即座に開閉する。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SessionImportDialog.tsx:86) | 中 |
| 05 | 引き継ぎ候補・履歴プレビュー | 検索結果の増減、読込中→結果、候補選択時のプレビュー、警告・エラーの出入りが即時。スマホで一覧の高さが35%に変わる箇所にも補間なし。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SessionImportDialog.tsx:87) | 中 |
| 06 | サイドバーの会話一覧 | 会話の追加・削除、検索での増減、作業中優先の並べ替えに出入り・位置の補間なし。選択色とホバー移動には指定あり。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/App.tsx:329) | 中 |
| 07 | ワークスペース右端の＋ | ホバー・フォーカスで `opacity: 0→1` になるが、ボタンの共通指定にはopacityがないため即時表示。[CSS](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/styles.css:132) | 任意 |
| 08 | 会話・新規会話・Canvasの切り替え | 会話のキー変更、Canvasの `hidden`、空画面の中央配置とロゴ・パスの出入りに切り替え指定なし。入力欄の高さ変更アニメーションとは別の経路。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/App.tsx:342) | 中 |
| 09 | 予約中の追加指示 | 行の追加・削除、本文→編集欄、保存後の復帰、一覧全体の高さ変化に指定なし。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ChatPane.tsx:136) | 高 |
| 10 | スラッシュコマンド候補を閉じる | 表示時の `surface-enter` はあるが、Escape・選択・入力変更で条件が外れると即座に削除される。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ChatPane.tsx:170) | 高 |
| 11 | コマンド候補の絞り込み | 候補数の増減、空結果への切り替え、パネルの高さ変化に指定なし。選択色とEnter記号の表示は適用済み。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/CommandPicker.tsx:31) | 任意 |
| 12 | モデルメニューの一部の閉じ方 | モデル名の再クリック、会話切り替え、設定へ移動などが `setModelOpen(false)` で直接削除する。通常の `requestClose` を通らない。[起点](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/App.tsx:305)、[終了処理](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ModelMenu.tsx:63) | 高 |
| 13 | モデル・Thinkingの候補更新 | 検索・ページ送り・モデル変更に伴う候補の増減や選択記号は即時。リスト初回表示のアニメーションは、同じリスト内の更新には再適用されない。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ModelPicker.tsx:56) | 任意 |
| 14 | 子の会話案内・履歴欠落・モデル設定案内 | `.child-banner`、履歴が見つからないエラー、`.composer-caption` の表示・消去と高さ変化に指定なし。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ChatPane.tsx:132) | 中 |
| 15 | 通知・エラー・「最新へ」の消去 | `.composer-notice`、`.connection-warning`、`.global-error`、`.composer-error`、`.run-error`、`.back-to-bottom` は表示時のみ。条件解除での退場と後続要素の移動は即時。端末の `.terminal-error` も表示時のみ。[CSS](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/styles.css:565) | 中 |

## 詳細パネル・ファイル・端末

| ID | 場面 | 未適用の範囲・根拠 | 優先度 |
| --- | --- | --- | --- |
| 16 | 作業タブの追加・削除・並べ替え | `.detail-tab` にあるのは背景・境界色のtransition。追加時の出現、幅の変化、並べ替え後の位置は即時。ファイルタブ削除だけは `transitionItems` でパネル全体を切り替え、端末タブ削除はそれも通らない。また分割ボタン群のホバーは旧ヘッダー用の指定で、現在の `.detail-toolbar` にマウスを置いてもグループのopacityが変わらない。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:120)、[旧ホバー指定](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SplitLayout.css:18) | 高 |
| 17 | 詳細内の表示切り替え | ファイル／端末、作業タブ／ツールの内容は `hidden` で即時切り替え。チーム全体の表示時には `.team-pane` のアニメーションがあるが、戻り側も含めた共通の切り替えにはなっていない。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:199) | 中 |
| 18 | 左右・上下分割と統合 | Gridの構成、表示するペイン、境界線の有無が即時に変わる。分割後のレイアウトへの移動に指定なし。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SplitLayout.tsx:22)、[CSS](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SplitLayout.css:1) | 中 |
| 19 | 分割ドロップの案内 | 初回のフェードはある。左右・上下の候補変更はinsetの即時変更、ドラッグ終了時は即座に削除。[CSS](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SplitLayout.css:22) | 任意 |
| 20 | タブ＋の「↓端末」「→ファイル」ヒント | 3px移動で表示し、終了時に削除。ヒント本体の出入り、選択方向の背景・境界色に指定なし。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:191)、[CSS](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.css:22) | 中 |
| 21 | デスクトップのファイル一覧全体 | 選択中のファイルタブがなくなるとツリー・境界線を外し、列構成を即時に変更する。フォルダー内部の開閉とは別で、こちらは補間なし。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/files/FilePane.tsx:81) | 中 |
| 22 | ファイルの読込開始・失敗・画像表示 | 読込済み本文の登場には180msのフェードがある。一方、旧本文→読込中、エラー・空表示、画像や動画の実データが後から届く時点には専用の切り替えがない。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/files/FilePreview.tsx:55) | 中 |
| 23 | 詳細パネル固有のエラー | `.detail-error` は共通の通知アニメーション対象外。表示、再試行、閉じる操作で即時に出入りする。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:198) | 中 |
| 24 | 端末の接続・操作権バー | 接続中／閲覧のみ／再接続のバーとボタンが条件で出入りし、端末領域の高さも即時に変わる。状態文字の色だけはtransitionあり。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/terminal/TerminalPane.tsx:239) | 中 |
| 25 | ファイル境界・分割境界のホバー | `.files-splitter::before`、`.split-divider` の背景変化にtransitionなし。外側の `.panel-resize::after` は共通指定の対象なので差がある。[ファイル](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/files/FilePane.css:108)、[分割](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SplitLayout.css:14) | 任意 |
| 26 | 音楽プレーヤーの状態変化 | 再生／一時停止・ミュートのSVG差し替え、ジャケット失敗時の代替アイコン、再生エラーの表示は即時。ボタンの背景・色は共通transitionあり。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/files/AudioPreview.tsx:40) | 任意 |

## チーム・Canvas

| ID | 場面 | 未適用の範囲・根拠 | 優先度 |
| --- | --- | --- | --- |
| 27 | チーム図の表示コマンド | ＋／−、等倍、全体表示、選択へ、キーボード選択時の中央移動がtransformの即時変更。ピンチやドラッグの直接操作とは分けて検討できる。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/TeamPane.tsx:90) | 中 |
| 28 | チーム図の構成更新 | エージェントの登場・削除、ノード位置、接続線の追加・削除・形状変更に指定なし。ノードの選択色・境界色・影と線の色は適用済み。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/TeamPane.tsx:208) | 中 |
| 29 | チームの非同期状態更新 | 待機先・失敗・結果・要確認表示の追加、概要の内容更新、空状態→関係図で本文・高さが即時に変わる。担当を選ぶ操作の `transitionItems` とは別。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/TeamPane.tsx:258) | 中 |
| 30 | Canvasの概要・選択項目・ファイルメニューを閉じる | `.canvas-properties[open] > div` の登場アニメーションのみ。共通details本文アニメーションの対象外なので、閉じる際は即時。[CSS](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/CanvasPane.css:18) | 中 |
| 31 | Canvasのノード・接続の追加／削除 | ノード・接続・空画面の出入りに指定なし。選択時の色・影のtransitionは存在する。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/CanvasPane.tsx:213) | 中 |
| 32 | Canvasの編集・接続モード | カード本文↔編集欄、「ここへ」ボタン、接続プレビュー、ツールバーの選択項目などは条件による即時切り替え。カード内の余白変更にも補間なし。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/CanvasPane.tsx:399) | 任意 |
| 33 | Canvasの表示コマンド・離散的な移動 | ＋／−、全体表示、画面外に追加したノードへの移動、矢印キーによる移動は即時。ドラッグ・ホイールへの追従とは別の経路。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/CanvasPane.tsx:268) | 任意 |
| 34 | Canvasの保存状態・エラー | 「保存済み／未保存／保存中」の文字・色、接続先案内、`.canvas-message` の登場・消去に指定なし。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/CanvasPane.tsx:340) | 中 |

## 設定・AIの操作表示・共通部品

| ID | 場面 | 未適用の範囲・根拠 | 優先度 |
| --- | --- | --- | --- |
| 35 | 設定の非同期更新 | 読込中、`.settings-notice`、設定固有のエラー、認証状態の更新に出入り・高さの指定なし。設定タブ／プロバイダーのユーザー選択時には画面切り替えがある。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SettingsDialog.tsx:134) | 中 |
| 36 | OAuthの手順更新 | ログイン開始、イベント行の追加、コード・入力フォームの表示と消去、成功・失敗への切り替えが即時。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/OAuthLogin.tsx:197) | 中 |
| 37 | アカウント使用量の再取得 | カード登場のアニメーションはある。更新時には一度カードを外して読込中に置き換えるため、退場と高さ変化は即時。エラー・非対応の案内も同様。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/AccountUsagePanel.tsx:32) | 中 |
| 38 | Computer useビュー本体・状態・履歴欄 | ビューの初回登場、操作中→終了／エラーの表示、2枚目で出る履歴欄に専用の指定なし。呼び出し履歴のdetails開閉には共通指定がある。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ComputerActivity.tsx:22) | 任意 |
| 39 | Computer useの画面・ポインター | `img.src`、カーソル位置、ドラッグ経路、実行中のopacity、画面↔読込失敗案内は即時変更。カーソルは操作キーで作り直すため位置transitionもない。追加する場合は、実操作の時刻・位置を誤認させない設計が必要。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ComputerActivity.tsx:27) | 任意 |
| 40 | 新しいツールカード・実行状態 | `.tool-card` は色・境界・影とdetails開閉のみ。カード追加そのものやRunning→Success/Errorのラベル差し替えには専用指定なし。通常の会話行の登場は仮想化側で明示的に無効化されている。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ToolInspector.tsx:100)、[抑止箇所](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/Conversation.css:3) | 任意 |
| 41 | Goalの生成・状態・操作ボタン | 本体の追加・消去、実行中→達成などの状態文字・色、操作ボタンや理由・エラーの増減に指定なし。Goal本文のdetails開閉と矢印は適用済み。[実装](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/GoalPanel.tsx:35) | 任意 |
| 42 | 共通の細かい状態変化 | ボタンのdisabledによるopacity、送信↔停止・処理中の記号差し替え、通常リンクやComputer use拡大リンクのホバー、Canvasのタイトル入力のホバー、ソースの行ハイライト、使用量などの数値・バー・状態文字の更新には一律の補間がない。通常ボタンの背景・文字・境界色は適用済み。[共通CSS](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/styles.css:536) | 任意 |

## 実画面で確認できた値

| 対象 | 確認結果 |
| --- | --- |
| 会話の右クリックメニュー | `animation-name: none`、`transition-duration: 0s` |
| 名前変更ダイアログ | 本体 `animation-name: none`、本体・背景とも `transition-duration: 0s` |
| セッション引き継ぎ | 本体・背景とも `animation-name: none`、`transition-duration: 0s` |
| 現在の作業タブ | `.detail-tab`。transitionは背景・境界色のみ、`view-transition-name: none`。旧 `.files-tab` / `.terminal-tab-item` は表示中DOMに存在しない |
| モデルメニュー | 開く際は `surface-enter`。トリガー再クリックではメニューが削除される。終了状態を待つ経路を通らないことはコードでも確認 |
| スマホのモデルシート | 開いた本体にtransform/display/overlay各240ms、背景各170ms。未適用には含めない |

## 適用済み・不足扱いにしない箇所

- サイドバーと詳細パネルの開閉、スマホのサイドバー背景。
- 設定ダイアログの開閉、設定タブ／プロバイダー選択時の画面切り替え。
- モデルメニューの登場と、通常の終了処理を通る閉じ方。
- モデル・担当詳細のボトムシート、ファイル一覧の右シート。
- ワークスペースのアコーディオン、ファイルツリー内部の開閉と矢印。
- 使用量ポップアップの表示・終了、使用量／Goal／ツール／思考／コンテキストのdetails本文。details本文は `interpolate-size` 対応環境に限る。
- ファイル本文の読込完了時のフェード、音楽プレーヤーを含むファイルビューの初回登場。
- コマンド候補の登場・選択色・Enter記号、通常ボタンの色、実行中の点滅。
- チームノードの選択・状態色・影、Canvasノードの選択色・影、接続線の選択色。

## 意図的な抑止・判断を分ける箇所

- 入力欄のフォーカス時の発光は、以前の指示で不要とされた演出。追加候補に含めない。
- 同じ新規会話を開き直しただけで入力欄やロゴの位置がずれる場合はレイアウトの問題であり、移動アニメーションで隠す対象ではない。08は画面の種類が変わる際の切り替えを指す。
- ストリーミング本文、端末出力、スクロールの位置補正、ドラッグ中のリサイズ・移動、ピンチ操作は即時追従を維持する。これらへの一律のtransitionは遅れや位置ずれの原因になる。
- 仮想化した会話行と高さ調整用スペーサーは明示的にアニメーションを止めている。単純に戻すと履歴の再表示・計測で再生されるため、通常メッセージは未実装の不具合として数えない。
- `prefers-reduced-motion: reduce` では意図的に動きを止める。`transitionItems` はブラウザーにView Transition APIがない場合も即時更新へ退避する。
- 数値、再生位置、音量、実際の操作位置は読み取りや操作の正確さを優先する。「任意」の項目には動きを足さない選択もある。

## 実装する場合の順序

まず01・02・03の開閉と12の閉じる経路を揃える。次に09・10・16の出入り・レイアウト変化を扱う。これにより、同じ種類の操作なのに突然消える差を減らせる。

追加・削除は閉じる状態を保持して終了後にDOMから外す。位置の変化は更新前後の位置を測って補間し、ドラッグ中は停止する。全要素への `transition: all` は使わない。既存のスマホシート、フォーカス時の発光抑止、動きを減らす設定を維持する。

## 実装結果（2026-10-25）

共通の `Presence` で終了まで要素を保持し、`MotionItems` で一覧の追加・削除・並べ替えを扱う。退場中は操作を無効化し、再表示された場合は終了を取り消す。非表示の端末・Canvasはマウントを維持する。

| 対象ID | 適用内容 |
| --- | --- |
| 01–05 | 会話メニュー、確認・引き継ぎダイアログと背景の開閉。候補・プレビュー・警告・読込状態の切り替え。 |
| 06–13 | 会話・ワークスペース・予約指示・コマンド・モデル候補の出入りと位置変更。モデルメニューはトリガー再クリックを含む終了経路を統一。 |
| 14–17 | 会話案内・通知の出入り、現在の作業タブへの適用、詳細ビューの切り替え。 |
| 18–26 | 分割モード・ファイル一覧のレイアウト変更、ドロップ案内とジェスチャーヒント、読込・メディア表示、端末状態、境界のホバー、音楽プレーヤーの記号とエラー。端末の状態バーはフェードのみとし、連続リサイズを避ける。 |
| 27–34 | チーム図・Canvasの表示コマンド、ノード・接続の出入りと配置更新、結果・失敗・空状態、編集・接続UI、保存状態、メニューの終了。 |
| 35–42 | 設定・OAuth・使用量の状態更新、Computer useの画面読込・履歴・状態、実行中のツールカード、Goal、共通の色・無効化・記号変更。 |

動きは主に140–220msのフェード・位置補間。入力欄のフォーカス発光、本文の逐次生成、端末出力、ドラッグ・ピンチ・サイズ調整、実際の操作位置、数値・再生位置・音量には遅延を加えていない。`prefers-reduced-motion` では即時更新する。

検証:

- `npm run check`。型、依存関係、インストールロック、ブラウザー入口の検査。
- 関連9ファイル・40テスト。再登場した一覧キー、表示コマンド中の直接操作への切り替え、動きを減らす設定、入力欄の高さ、長い履歴、チームのジェスチャー、Canvas・詳細タブなど。
- PCと390×844のブラウザーで模擬データによる開閉、退場途中の再表示、一覧項目の復帰、ネイティブダイアログの終了・再開、非表示中の入力値保持、操作コマンドの中断を確認。
- 実部品のコマンド候補の絞り込み・Escape、詳細タブ追加・左右分割、スマホのモデル候補絞り込み・シート終了を確認。
- OAuthの実認証、AIへの送信、実データの削除・設計保存は検証のために実行していない。
