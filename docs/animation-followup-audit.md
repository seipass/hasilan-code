# 設定・タブ・入力・セッションのアニメーション再調査

調査日: 2026-10-25

修正前の作業ツリーとローカル実画面を対象に、不具合9件、未適用・不足10件を整理した。9件は実画面の操作と描画中の座標・スタイルで確認し、残り10件はコードの状態更新経路で確認した。網羅的な端末検証やフレームレート計測ではない。以下の調査記録は修正前の現象を残している。

## 修正状況

19件すべての修正を実装した。

| 対象 | 修正 |
| --- | --- |
| B01・B02・N09・N10 | 設定の開閉を現在値から反転できるCSS transitionへ変更。外枠と見出しの位置を固定し、本文をスクロール領域にした。カテゴリ本文と選択下線を直接アニメーションし、View Transition APIへの依存を解消した。 |
| B03・B04・B09 | 引き継ぎダイアログの縦配置を終了中も維持。案内・読込表示・プレビューを同じグリッド領域に重ね、古い表示の削除で本文が動かないようにした。スマホの表示条件も、退場中の要素ではなく選択状態から決める。 |
| B05・N05 | 入力欄の幅を監視して高さを再計算。送信方法と使用量の出入りでは横幅を、ツールバーの折り返しでは高さを補間する。 |
| B06・B07・N06・N07 | 新しい内容の準備完了まで古い画面を保持し、退場後に切り替えるMotionSwapを追加。チャットの二重フェードを解消し、ワークスペース変更時の詳細パネルにも適用した。入力欄や端末のインスタンスを二重に作らない。 |
| B08・N01・N02・N03 | タブ選択でファイルの取得キーを更新しない。タブ幅と＋ボタンの位置を補間し、選択中タブの削除・種類変更でも本文の退場を待つ。ドラッグは直接追従させる。 |
| N04・N08 | 動的に追加する通知は高さ0から展開。OAuthの入力フォーム変更にも退場・登場と高さの補間を追加した。 |

回帰テストは入力欄、Presence、レイアウト、MotionSwap、シートの5ファイルに限定した。実画面では設定の途中終了・カテゴリ切り替え、入力幅の変更、セッション切り替え、引き継ぎの終了とプレビュー、タブ削除と再選択を再確認した。設定外枠は高さ672px・上端24pxを維持し、引き継ぎ本文上端は230.64pxで変化しなかった。選択済みファイルの再選択では読込表示が再出現せず、不透明度1を維持した。

認証、会話送信、引き継ぎ確定、端末の作成・終了は実行していない。スマホ実機や全体テストは行わず、関連するコードと回帰テストの範囲で確認した。

設定の保存、認証開始、会話送信、セッション引き継ぎの確定、端末作成・終了は実行していない。一時入力した確認用の文章は復元し、選択セッションも調査前のものへ戻した。

## 不具合

| ID | 優先度 | 操作と現象 | 確認・原因 |
| --- | --- | --- | --- |
| B01 | 高 | **設定を開く途中で閉じると、一瞬明るく大きくなる。** | 実画面。透明度0.083、縦移動9.17pxの途中から、閉じ始めに透明度1・移動0へ飛んだ。終了用キーフレームが現在値を引き継がず、不透明な完成形から始まる。[styles.css:530](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/styles.css:530)、[SettingsDialog.tsx:53](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SettingsDialog.tsx:53) |
| B02 | 高 | **設定の読み込み・カテゴリ切り替えで、外枠と見出しの位置が跳ねる。** | 実画面。初期読込で高さ約194→576px。プロバイダー→エージェントでは576→611pxへ補間なく変わる。本文だけをView Transitionの対象にした一方、中央配置の外枠は高さauto、transition-durationは0s。使用量の初回取得、プロバイダーの検索件数表示なども同じ経路。[styles.css:375](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/styles.css:375)、[GlassSurfaces.css:28](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/GlassSurfaces.css:28) |
| B03 | 高 | **セッション引き継ぎを閉じる途中で、画面が横並びに崩れる。** | 実画面。閉じる前はflex-direction:column、閉じ始めはdisplay:flexのままflex-direction:row。columnの指定が[open]にしかなく、終了アニメーション中に解除される。[SessionImportDialog.css:2](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SessionImportDialog.css:2) |
| B04 | 高 | **引き継ぎプレビューが表示された後、本文が2段階で上へ跳ねる。** | 実画面。本文上端318.89→283.14→230.64px、計約88pxの移動。古い「選択してください」と読込表示を通常フローに残してフェードするため、その削除時に本文の位置が変わる。[SessionImportDialog.tsx:99](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SessionImportDialog.tsx:99) |
| B05 | 高 | **入力後に詳細パネルを開くと、折り返した文章の下の行が隠れる。** | 実画面。入力欄の幅712→272px、必要な高さ119pxに対し表示高さは48px、overflow-y:hiddenのまま。高さ再計算が[text]にしか依存せず、幅変更を監視していない。サイドバー開閉やウィンドウ幅変更も同じ経路。[ChatPane.tsx:79](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ChatPane.tsx:79) |
| B06 | 高 | **既存セッションへの切り替えで、入力欄が中央に出てから下へ跳ぶ。** | 実画面。切り替え直後はis-empty・入力欄上端358.80px、その後has-messages・544pxへ約185px移動。データ未取得と本当に空の会話を同じempty条件で扱い、読込中だけホームの配置になる。セッションID変更時のフェードも、本文の準備完了を待っていない。[ChatPane.tsx:75](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ChatPane.tsx:75)、[subscriptions.ts:219](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/subscriptions.ts:219)、[App.tsx:84](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/App.tsx:84) |
| B07 | 中 | **セッション切り替えのフェードが二重にかかる。** | 実画面。親の透明度0.372、子0.267で、合成すると約0.10まで暗くなる。chat-columnのmediaReadyと、作り直したchat-paneのCSSアニメーションが同時に走る。[App.tsx:84](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/App.tsx:84)、[styles.css:599](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/styles.css:599) |
| B08 | 中 | **すでに選択済みのファイルタブを押しても、本文が消えて読み直される。** | 実画面。READMEタブを押し直すだけで、本文の透明度が0→1になり、読込表示も再出現。選択時に毎回requestIdを生成し、取得キーを更新する。通常のタブ再選択と明示的な更新が同じ扱いになっている。[DetailPane.tsx:81](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:81)、[FilePreview.tsx:25](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/files/FilePreview.tsx:25) |
| B09 | 中 | **スマホの初回引き継ぎプレビューが、一時的に隠れたままになる経路がある。** | コード確認。600px以下で、退出中の.session-import-emptyが残る間は:has()によってプレビュー全体がdisplay:none。応答が退出の140msより早い場合、本文が取得済みでも隠れ、リストだけ35%へ縮む。旧案内の削除による再表示はuseChildrenMotionの依存値を更新しない。スマホ実画面では未確認。[SessionImportDialog.css:44](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SessionImportDialog.css:44)、[SessionImportDialog.tsx:35](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SessionImportDialog.tsx:35) |

座標・サイズは調査用画面での値。再現の要点は、途中の値を補間せずに切り替わること。

## 未適用・不足

既存の色変更やフェードまで「なし」とは扱わず、動いていない対象を限定した。低優先度の項目は演出を追加するかどうかの判断が必要。

| ID | 優先度 | 場所・未適用部分 | 根拠 |
| --- | --- | --- | --- |
| N01 | 中 | **タブ追加・削除・名前の幅変更に、＋ボタンの位置とタブ自身の幅の補間がない。** 残るタブの移動・削除タブのフェードとは不一致。 | 実画面。削除タブが透明度0.81→0.01で残っている間も、＋は左へ約120px移動済み。＋はMotionItemsの外、タブ幅も共通フックの対象外。[DetailPane.tsx:170](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:170)、[Motion.tsx:28](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/Motion.tsx:28) |
| N02 | 中 | **選択中タブを閉じると、本文の退出アニメーションがない。** ヘッダーだけが退出する。 | コード確認。ヘッダーはMotionItemsで保持するが、本文はlayout.tabs.mapから直接削除する。内側のPresenceも一緒にアンマウントされるため退出を待てない。[DetailPane.tsx:122](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:122)、[DetailPane.tsx:202](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:202) |
| N03 | 中 | **新しいタブの選択画面→ファイル・端末で、元の画面の退出がない。** | コード確認。同じタブID・selected=trueのまま、選択画面を別コンポーネントへ即時置換する。新しい読込表示などに登場演出があっても、元の画面の退場は補われない。[DetailPane.tsx:144](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:144)、[DetailPane.tsx:207](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:207) |
| N04 | 中 | **入力欄上の通知・モデル設定案内・子セッション案内などは、初回表示時の高さが補間されない。** | コード確認。Presenceのcollapseは通常の退出時とその反転時に高さを扱うが、初回の登場は透明度だけ。場所を確保する瞬間に周囲が動く。閉じるときの縮小は実装済み。[Motion.tsx:119](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/Motion.tsx:119)、[ChatPane.tsx:169](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ChatPane.tsx:169) |
| N05 | 中 | **入力欄下の送信方法・使用量ボタンの出入りで、ツールバーの幅・折り返し・高さの補間がない。** | コード確認。busy、hasContextLimitによる直接の条件付き描画。送信・停止記号の登場フェードやボタンの色変更とは別の対象。実行開始・送信は今回試していない。[ChatPane.tsx:193](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ChatPane.tsx:193) |
| N06 | 中 | **セッション切り替え時、古い本文・入力欄の退出がない。** | コード確認。ChatPaneのkeyを変えて即座に作り直し、新しい側だけをフェードする。B06の読込中の配置問題とは別に、旧画面から受け渡す処理がない。[App.tsx:348](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/App.tsx:348) |
| N07 | 中 | **ワークスペース変更時、右側のタブ・ファイル表示の旧画面の退出がない。** | コード確認。DetailPaneをworkspaceIdのkeyで直接作り直す。チャット列のuseContentMotionは右パネルを対象に含めない。各部品の登場演出は存在する。[App.tsx:353](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/App.tsx:353) |
| N08 | 低 | **設定内のOAuth入力が次の入力へ変わる際、フォーム間の切り替えと高さの補間がない。** | コード確認。prompt.idの変更でフォームを交換しても、外側Presenceのshow=trueが変わらず、再実行されない。初回表示のフェードと手順一覧の追加アニメーションは実装済み。認証操作は今回実行していない。[OAuthLogin.tsx:202](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/OAuthLogin.tsx:202) |
| N09 | 低・任意 | **設定タブの選択下線は、位置移動や出入りの補間がない。** | コード確認。文字色・背景色にはtransitionがあるが、下線はbox-shadowを選択先へ即時付け替える。本文のView Transitionは適用済み。[styles.css:572](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/styles.css:572) |
| N10 | 低・環境依存 | **View Transition APIがない環境では、設定カテゴリの本文切り替えが即時になる。** | コード確認。transitionItemsの代替経路は状態更新のみ。一方でCSSの本文アニメーションは無条件にnoneへ上書きしている。調査ブラウザーではAPIがあるため再現対象外。動きを減らす設定による即時切り替えは不足扱いにしない。[item-transition.ts:4](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/item-transition.ts:4)、[GlassSurfaces.css:28](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/GlassSurfaces.css:28) |

## 修正する場合の順序

1. B05の入力欠け、B03の引き継ぎ終了時の崩れを先に直す。
2. B01・B02・B04の開閉中の形と高さの不連続を直す。
3. B06・B07・N06をまとめ、既存セッションを空の会話として表示しない構造にする。本文の準備完了と切り替えを同期し、フェードを1か所にする。
4. B08・N01〜N03をタブの表示更新として整理する。再選択、明示的な更新、内容の置換、タブの削除を区別する。
5. その他の高さの出入りを整え、低優先度の演出は必要性を判断する。

## 今回の不足に含めなかったもの

- 前回修正した、移動中の並べ替え・サイズ変更の中断、共通Presenceの透明度・縮小の反転、連続スクリーンショットのフェード。
- ファイル・端末タブを通常選択する際のPresence、設定本文のView Transition、引き継ぎ候補一覧のMotionItems。これら自体は実装されている。
- 入力欄の初回表示時の即時サイズ確定、直接のドラッグ・ピンチへの追従、ストリーミング文字、端末の出力、入力欄のフォーカス発光の抑止。
- OSのファイル選択やブラウザー標準の選択メニュー。アプリのアニメーション対象として扱っていない。

初回調査では、設定・タブ・入力・引き継ぎ・セッション切り替えのコードを読み、上記の操作に限って実画面を確認した。スマホ実機、認証完了後の非同期状態、送信・引き継ぎ確定後の画面、端末作成後の画面はコード確認に留めた。その後の修正と確認範囲は冒頭の「修正状況」を参照。
