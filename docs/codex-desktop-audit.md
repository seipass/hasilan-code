# Codex Desktop 解析と Hasilan Code 改善候補

調査日 2026-11-13。比較対象は Windows の Codex MSIX 26.1106.6628.0、同梱デスクトップアプリのパッケージ版 26.1106.51428、Hasilan Code の調査開始時点 `63ceb684e`。Codex はインストール済みの `app.asar` を読み取り専用で調査し、公開仕様と照合した。同梱コードから確認した実装、公開されている製品機能、Hasilan Code 向けの設計案を区別する。配布物のコードやユーザーの会話・認証データはこのリポジトリに収録していない。

## 優先順位

| 優先 | 候補 | 完了を判断できる挙動 |
| --- | --- | --- |
| 高 | ターンの概要と巨大な結果を別々に読み込む | 数千ターンと巨大ログを含む会話を開くと、直近の回答が先に出る。個別ログや過去のターンは開いた分だけ転送され、上を読んでいる途中の位置が保たれる。 |
| 高 | Git差分のレビューと行コメントを一続きにする | 作業ツリー、ステージ、ブランチ、直近ターンを明示して切り替え、選択した差分行にコメントを付け、送信前に確認できる。 |
| 高 | 起動と復旧を段階ごとに追えるようにする | ウィンドウ表示、バックエンド接続、履歴表示までを独立に計測する。レンダラーとバックエンドの異常を別々に再現でき、下書き・状態・エラーが適切に復元される。 |
| 高 | フォアグラウンドの会話にも作業場所の選択を設ける | 送信前にローカルまたは分離環境と起点ブランチを確認できる。採用・移送時の競合は、元の変更を保持したまま確認できる。 |
| 中 | ユーザーとAIがブラウザーの対象を共有する | ユーザーがタブと注釈を確認できる。再読み込みやタブを閉じた後に古い要素参照で操作すると、取り直しを促す。 |
| 中 | 実行中・返答待ち・承認待ち・再接続を一貫して表示する | 一覧・本文・概要の状態が一致し、アプリを開き直したときに現在できる操作が分かる。 |

## Windows 配布物から確認した実装

以下のファイル名とバイト位置は上記バージョンの `app/resources/app.asar` 内のエントリーを指す。難読化されたバンドル内の呼び出しや条件式を根拠にし、文言・定数だけ見つかった機能の有効化状況は判定していない。

| 対象 | 観察 | Hasilan Code で検討できること |
| --- | --- | --- |
| 起動・ウィンドウ | `.vite/build/early-bootstrap.js` がパッケージのエントリー。ホストチャンク `early-bootstrap-620-1eb87a1b3aa240b6.js` の 4844123・4844294・4929828 付近にはフレーム読み込み、表示準備、起動フェーズ別の経過時間記録がある。4883964 付近には主要画面用 `WebContentsView` の生成がある。 | Hasilan にも起動画面と別プロセスのホストがある。起動表示、ホスト ready、最初の描画、会話初期ページを個別に計測し、遅い段階を特定する。 [main](../apps/desktop/src/main.ts) · [host](../apps/desktop/src/host.ts) |
| 障害の診断 | 同チャンクの 388338 付近でプロセスメモリと app-server の診断を別々にまとめる経路がある。配布物から診断の全収集条件は確定できない。 | 通常時の計測はプロセス種別・起動フェーズ・失敗種別で集計する。診断を出す前に対象を確認でき、再現用のログは会話本文を含めずに採取できる構成にする。 [Desktop の障害表示](../apps/desktop/src/main.ts) |
| 履歴の段階読み込み | レンダラーチャンク `webview/assets/async/739301.37a39f26d6.js` の 810226–811200 付近で、ターンを項目未ロードで取得し、項目を別にページ取得する。サイズ制約エラーのときに項目数を半分にし、カーソルが進まない場合や別ターンの結果を検出する。889791 付近に互換経路もある。 | 既存のページングとDOM仮想化に、ツール結果や添付メタデータの遅延取得を足す。上限超過時はページを縮め、巨大な単一結果は範囲取得する。UIの段階読み込みとモデル向けコンテキスト圧縮は別々に計測する。 [履歴の投影](../packages/web-harness/src/shared/session-history.ts) · [会話の表示](../packages/web-harness/src/client/Conversation.tsx) |
| 長い一覧・差分 | 同レンダラーチャンクの 4987185 付近にファイルツリーの表示範囲と先読みの計算がある。7459522 付近ではレビューのファイルパスと画面内オフセットを保存している。 | 長いファイル一覧では表示範囲を絞る。差分を折りたたむ、更新する、戻る場合は、ファイルとその中の位置を復元する。 [ファイルペイン](../packages/web-harness/src/client/files/FilePane.tsx) · [差分カード](../packages/web-harness/src/client/FileChanges.tsx) |
| ブラウザーのライフサイクル | ホストチャンクの 1972324 付近に注釈プレビューをナビゲーションやレンダラー終了とともに破棄する処理がある。2849625 付近では、表示・Browser Use・キャプチャの状態でバックグラウンド制御を変える。専用 `browser-page-preload.js` も同梱されている。 | ユーザーのブラウザーと自動操作のタブを識別し、URL・ナビゲーション世代・表示状態を一緒に管理する。非表示タブの節電とAIの作業継続を個別に確認する。 [Desktop のブラウザー](../apps/desktop/src/main.ts) · [AIブラウザー](../packages/web-harness/src/server/tools/browser.ts) |
| 操作状態 | 同レンダラーチャンクの 1321967 付近で、計画、ターン、ツール項目、Goal のイベントを購読する。1431575 付近は分岐後の履歴読み込みを扱う。1456223 付近には固定した会話の読み込み経路がある。 | 画面上の実行表示と通知を同じ状態から作る。分岐やアーカイブの操作後は、保存済み状態と一覧が揃ってから成功を示す。 [実行一覧](../packages/web-harness/src/client/WorkOverview.tsx) · [セッション管理](../packages/web-harness/src/server/session-registry.ts) |
| 添付プレビュー | 同レンダラーチャンクの 4424787 付近でサムネイル処理を形式・バイト量とともに計測する。 | 添付追加から表示までを計測し、4K画像、PDF、オフィス文書など形式別に遅延とメモリを切り分ける。 [入力欄の添付](../packages/web-harness/src/client/ComposerAttachments.tsx) · [ファイル表示](../packages/web-harness/src/client/files/FilePreview.tsx) |
| ストリームの負荷 | 同レンダラーチャンクの 978076・1105325 付近にコマンド出力の差分を集約する処理、969358–970300 付近に非アクティブ会話の購読解除と、サーバーが未対応の場合の処理がある。 | Hasilan の投影更新と既存の履歴ページングを活かし、長い出力の行追加、重要な状態変更、会話一覧の更新で異なる頻度を設定する。購読を解く判断には実行中かどうかと受け手の有無を含める。 [サーバーイベント](../packages/web-harness/src/server/events.ts) · [購読](../packages/web-harness/src/client/subscriptions.ts) |
| 分離環境の寿命 | ホストチャンクの 3075726・3077497 付近には自動アーカイブのキューと、ピン留め情報の確認に失敗した場合に処理を見送る条件がある。3065224 付近には復元時に管理対象の worktree 状態を確認する経路がある。 | 破棄・採用に加え、整理候補・保護理由・サイズ・最後の使用・復元先を一覧に出せる。所有者や変更状態が不明なものは保護対象にする。 [作業分離](../packages/web-harness/src/server/agent-worktrees.ts) · [保存容量](../packages/web-harness/src/server/storage-usage.ts) |
| キーボードと設定読み込み | 同レンダラーチャンクの 8596146 付近ではコマンドパレットが IME の合成中にナビゲーションキーを消費しない。1462087 付近では同じ MCP 状態要求を実行中の Promise にまとめる。 | 日本語 IME とキー割り当てを複数の入力パネルにまたがって検証する。モデルや拡張一覧で同一問い合わせを共有し、開いた画面に必要な情報から読み込む。 [モデル選択](../packages/web-harness/src/client/ModelPicker.tsx) · [設定](../packages/web-harness/src/client/SettingsDialog.tsx) |

## 横断して追加で見る領域

- **日本語とアクセシビリティ。** IME確定中のEnter、候補ポップアップでの矢印キー、モーダルを閉じた後のフォーカス、長い応答の読み上げ、縮小表示と動きの軽減を同じシナリオで確認する。Hasilanにはキーバインド設定と動きの軽減があり、主要な入力経路を回帰確認の対象にできる。 [入力欄](../packages/web-harness/src/client/ChatPane.tsx) · [キーバインド](../packages/web-harness/src/client/app-keybindings.ts) · [動きの設定](../packages/web-harness/src/client/NoMotion.css)
- **起動後の体感と配布。** 起動の冷温差、会話切り替え、アイドル・タブ再表示時のメモリ、アップデート後のプロファイル復元を別々に計測する。配布物のサイズから実行時メモリは推定できない。Hasilan は既にメモリ計測を行っており、同じ会話・添付で比較する土台がある。 [Desktop 開発](desktop.md)
- **休止からの復帰。** ホストチャンクの 1792069 付近に接続状態を扱うクラスが OS の suspend/resume を購読する実装がある。Hasilan の再購読に加え、休止復帰時に接続と実行中の端末を再照合し、切断中の指示が送信済みか再送が必要か分かるようにする。 [再接続](../packages/web-harness/src/client/subscriptions.ts)
- **ローカル成果物の持ち方。** 同レンダラーチャンクの 2063715 付近ではローカル画像をパスで扱う分岐がある。Hasilan の添付は保存後はファイル参照を配信する。長い添付の下書きもファイル参照へ寄せ、読み込み中の取り消し、送信失敗の再試行、孤立した下書きの整理を確認する。 [添付の保管](../packages/web-harness/src/server/prompt-attachments.ts) · [下書き](../packages/web-harness/src/client/ComposerAttachments.tsx)
- **権限の表示。** 同レンダラーチャンクの 1305236 付近で、選んだ権限プロファイルと実行時のルートを起動条件に含める。Hasilan の実行環境やファイル境界に合わせ、適用対象のパスと今許可されている動作を一覧・送信前・承認画面で一貫して表示する。 [Hasilan のファイル境界](../packages/web-harness/src/server/workspace-files.ts)
- **Hasilan 固有の価値。** 複数プロバイダー、Jevによる入力先判断・Computer Use、Hyakki、チーム関係図、翻訳・要約、セッション引き継ぎは比較の起点になる。Codexの仕組みを活かす場合も、モデルとプロバイダーの選択、担当AIごとの作業分離、親AIによる採用判断を設計に含める。 [設定](../packages/web-harness/src/client/SettingsDialog.tsx) · [ワークスペース選択](../packages/web-harness/src/server/workspace-router.ts) · [担当の作業分離](../packages/web-harness/src/server/agent-worktrees.ts)

## 利用者のワークフローから見た改善候補

Codex 側の記載は OpenAI の公開資料で確認した製品仕様。インストール済み Windows ビルドの個別機能や提供状況は、別の観測結果と照合する。Hasilan Code 側はリポジトリの該当実装を確認した。

| 領域 | Codex で確認できた操作 | Hasilan Code の現状と取り入れる候補 |
| --- | --- | --- |
| 会話の入口 | ローカルプロジェクトは複数フォルダーを関連付けられ、プロジェクト外のチャットも作成できる。会話開始時に実行先を決める。 [プロジェクト](https://learn.chatgpt.com/docs/projects#use-local-projects-for-folders-and-codebases) | Hasilan の送信先提案、既存会話への送信を生かし、送信前に対象フォルダー・ブランチ・ローカル／隔離を一行で確認できるようにする。似た名前のリポジトリでは完全パスも出す。 [workspace-send.ts](../packages/web-harness/src/client/workspace-send.ts) |
| 履歴・整理 | プロジェクト／会話のピン留め、会話検索、プロジェクト単位の一括アーカイブ、復元がある。 [プロジェクトと会話](https://learn.chatgpt.com/docs/projects#organize-projects-and-chats) | Hasilan はタイトル・パス・本文の検索、手動順序、アーカイブ復元がある。常用会話だけを固定するピン留め、完了分の一括整理、検索結果から該当発言へ直接移動を追加できる。 [App.tsx](../packages/web-harness/src/client/App.tsx) · [SessionArchivePanel.tsx](../packages/web-harness/src/client/SessionArchivePanel.tsx) |
| 実行中の追加入力 | Queue と Steer を明示し、既定の動作を設定できる。 [Remote の作業ガイド](https://developers.openai.com/blog/mastering-codex-remote-for-engineering) | Hasilan にも完了後／実行中の送信と、キュー内編集・取消・即時送信がある。送信前に現在の挙動をボタン横で示し、操作を発見できるようにする。優先度は既存キーバインドの好みを保った上で検討。 [ChatPane.tsx](../packages/web-harness/src/client/ChatPane.tsx) |
| 本線の横で質問 | `/side` や本文選択から、関係する履歴を使ったサイドチャットを開ける。元の会話は作業の記録として使い続ける。 [サイドチャット](https://developers.openai.com/blog/mastering-codex-remote-for-engineering) | Hasilan のチーム子会話は担当者の作業。本文・エラー・差分を選んで一時的に解説を聞ける入口は別用途として有用。Pi の既存の fork を参照し、親ターンや作業ツリーに影響しない質問モードを設計する。 [ChatPane.tsx](../packages/web-harness/src/client/ChatPane.tsx) · [agent-session-runtime.ts](../packages/coding-agent/src/core/agent-session-runtime.ts) |
| Plan と Goal | Plan は実装前に方針を相談するモード、Goal はターンをまたぐ完了条件。計画を読んでから実行へ進められる。 [Plan と Goal](https://developers.openai.com/blog/mastering-codex-remote-for-engineering) | Hasilan の Canvas と `/goal`、スウォームをつなぎ、普通の会話でも変更なしで調査・計画してから、合意した完了条件を Goal に昇格できる入口があると使いやすい。 [slash-command.ts](../packages/web-harness/src/client/slash-command.ts) · [GoalPanel.tsx](../packages/web-harness/src/client/GoalPanel.tsx) · [CanvasPane.tsx](../packages/web-harness/src/client/CanvasPane.tsx) |
| 通知と作業一覧 | Remote は完了と人の対応待ちを通知し、Scheduled は確認すべき結果を未読として集約する。 [Remote](https://learn.chatgpt.com/docs/remote-connections#what-you-can-do-remotely) · [Scheduled](https://learn.chatgpt.com/docs/automations?surface=app#manage-scheduled-tasks) | Hasilan の完了通知とタイトル／アイコン表示はあるが、未読はブラウザー内状態でフォーカス時に一括解除される。作業一覧に質問・承認・失敗・完了を集め、個々の対象を読んだ時に既読化できるようにする。 [attention.ts](../packages/web-harness/src/client/attention.ts) · [WorkOverview.tsx](../packages/web-harness/src/client/WorkOverview.tsx) |
| 差分の意味 | Git の作業ツリー、インデックス、コミット、基準ブランチ、直近ターンを切り替えられる。複数リポジトリのプロジェクトにも対応する。 [差分の対象](https://learn.chatgpt.com/docs/code-review?surface=app#what-changes-it-shows) | Hasilan の会話カードは成功した edit/write の記録、作業一覧はエージェント worktree の基準差分。両方を明示しつつ現在の Git 差分を追加すると、シェルや手動編集による差も確認できる。実際の Git 状態とターンの変更由来は別の情報として保持する。 [file-changes.ts](../packages/web-harness/src/client/file-changes.ts) · [WorkOverview.tsx](../packages/web-harness/src/client/WorkOverview.tsx) |
| 行単位のレビュー | 差分に行コメントを残し、送信前に修正指示を添えられる。ステージ・アンステージ・リバートは全体・ファイル・ハンク単位。レビュー専用モードと優先度付き指摘もある。 [レビュー操作](https://learn.chatgpt.com/docs/code-review?surface=app#inline-comments-for-feedback) | Hasilan はファイルごとのパッチ表示がある。まず行・差分版・変更前後を添えた注釈と明示的送信、次に Git 操作。以前の変更カードで「元に戻す」を省くというユーザー指定は、別画面での Git リバート採用とは切り分ける。 [FileChanges.tsx](../packages/web-harness/src/client/FileChanges.tsx) · [WorkOverview.tsx](../packages/web-harness/src/client/WorkOverview.tsx) |
| PR と検証結果の往復 | 関連チャットへ戻り、失敗した CI チェックを送信前の下書きとして添付できる。 [PR のチェック](https://learn.chatgpt.com/docs/code-review?surface=app#continue-in-a-chat) | Hasilan の GitHub ウィジェット、シェル結果、差分を、対象 PR・実行コマンド・終了コード・ログ範囲を持つ参照へつなぐ。トークン節約にも関係するため、巨大ログは短い要約と元ログ参照で扱う。 [HomeDashboard.tsx](../packages/web-harness/src/client/HomeDashboard.tsx) · [tools/shell.tsx](../packages/web-harness/src/client/tools/shell.tsx) |
| Worktree と作業移管 | 新規会話で基準ブランチと worktree を指定でき、通常は detached HEAD で作成。現在の未コミット変更を引き継げる。Handoff は会話と作業場所を移し、同じ worktree に戻れる。 [Worktree と Handoff](https://learn.chatgpt.com/docs/environments/git-worktrees) | Hasilan は子エージェントの独立 worktree、差分、割当元による採用・破棄・復元が既にある。ユーザー自身が開始するチャットにも実行場所を選ぶ UI を出し、採用と作業場所の移管を別操作にする。 [agent-worktrees.ts](../packages/web-harness/src/server/agent-worktrees.ts) · [team-manager.ts](../packages/web-harness/src/server/team-manager.ts) |
| プロジェクトの環境と操作 | リポジトリ共有の環境設定で、OS 別 setup script を新規 worktree に実行できる。よく使うテストや起動コマンドは名前付き Action で端末から実行できる。 [Local environments](https://learn.chatgpt.com/docs/environments/local-environment) | Hasilan の作業一覧と端末に、設定元・実行するコマンド・環境準備中／失敗／再試行を表示する。生成物・秘密ファイルを worktree へコピーする場合は、対象が見える設定が要る。 [agent-worktrees.ts](../packages/web-harness/src/server/agent-worktrees.ts) · [DetailPane.tsx](../packages/web-harness/src/client/DetailPane.tsx) |
| 統合端末 | 端末は現在の会話のプロジェクト／worktree を対象にし、AI が現在の端末出力を参照できる。 [統合端末](https://learn.chatgpt.com/docs/integrated-terminal) | Hasilan の一覧・復元は workspaceId 単位。端末に実際の CWD、チャット／worktree と稼働状態を表示し、ユーザーが選択した端末出力や開発サーバーの URL を会話へ渡せるようにする。 [DetailPane.tsx](../packages/web-harness/src/client/DetailPane.tsx) · [terminal-manager.ts](../packages/web-harness/src/server/terminal-manager.ts) |
| ブラウザー共同作業 | 内蔵ブラウザーを人と AI が共有し、全画面／分割、要素・範囲のコメント、Adjust によるフォント・余白・色等の一時プレビューを提供する。 [内蔵ブラウザー](https://learn.chatgpt.com/docs/browser?surface=app) | Hasilan は履歴・候補・要素／範囲／テキスト注釈と画像添付がある。閲覧は Electron webview、AI 操作はセッション別 Playwright。現在のタブを明示的に AI に渡す選択肢と、注釈の前後状態・ビューポート・調整値を一緒に保持する案が有力。 [BrowserPane.tsx](../packages/web-harness/src/client/BrowserPane.tsx) · [browser.ts](../packages/web-harness/src/server/tools/browser.ts) |
| ブラウザーの範囲と診断 | 独立したプロファイル、履歴の個別削除、サイト単位の権限、承認付き CDP 診断を提供。通常ブラウザーのタブには拡張機能を使える。 [Browser](https://learn.chatgpt.com/docs/browser?surface=app) | Hasilan も専用 Electron パーティションと検索・削除可能な履歴がある。URL・現在の操作主体・持続する権限を表示し、まずコンソール／ネットワーク／DOM の診断データをユーザーが選択して渡す。日常の閲覧履歴全体をAIへ送る必要はない。 [apps/desktop/src/main.ts](../apps/desktop/src/main.ts) · [BrowserPane.tsx](../packages/web-harness/src/client/BrowserPane.tsx) |
| Computer Use | 対象アプリを確認・承認し、停止・人による引き継ぎが可能。Windows は前景で操作する。 [Computer Use](https://learn.chatgpt.com/docs/computer-use) | Hasilan はモデル判断に加えて Jev／互換バックエンド、操作履歴とスクリーンショットを持つ。現在の対象アプリ・ウィンドウ・モニター・操作権を常時表示し、取得できない画面・対象消失・一時停止を区別すると、GUI 操作失敗時に診断しやすい。 [computer-use.md](./computer-use.md) · [ComputerActivity.tsx](../packages/web-harness/src/client/ComputerActivity.tsx) |
| Skills・MCP・Plugins | 目的別 Skills とサービス操作を同一パッケージで配布し、入力時の明示呼び出しやローカル／共有の配布元を扱う。 [プラグイン構成](https://developers.openai.com/plugins/concepts/plugins) · [配布](https://developers.openai.com/plugins/build/plugins) | Hasilan の Pi にはスキル検出・展開、MCP と tool search／Code Mode がある。Web／Desktop に、有効な能力一覧、提供元、接続エラー、実際に使うツールを出す。まず既存能力を検索・選択できるようにし、導入カタログは別段階。 [agent-session.ts](../packages/coding-agent/src/core/agent-session.ts) · [slash-command.ts](../packages/web-harness/src/client/slash-command.ts) |
| 予約タスク | チャット継続型と各回独立型、ローカル／worktree、モデル、繰り返し、結果の未読管理。 [Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app) | Hasilan の Goal 継続と予約実行は別の需要。端末やトレイを土台に、次回、実行先、最終結果、失敗理由、停止を表示する。休止・再起動をまたぐ重複実行と、対応が必要な結果だけを通知する条件を先に定義する。 [GoalPanel.tsx](../packages/web-harness/src/client/GoalPanel.tsx) · [apps/desktop/src/main.ts](../apps/desktop/src/main.ts) |
| リモート | QR で端末を個別にペアリングし、ホストを切り替えられる。モバイルで指示、質問、承認、差分、結果を扱う。SSH ホストも別経路で開ける。 [Remote connections](https://learn.chatgpt.com/docs/remote-connections) | Hasilan の LAN 用 QR とモバイル表示を生かし、ホストの接続状態、端末ごとの無効化、狭い画面の作業判断を優先する。LAN URL の共有範囲を越える機能は、別途ホスト認証・暗号化・権限設計を要する。 [README の LAN 設定](../README.md#同一-lan-内の他端末からアクセスする) |
| コマンド発見と設定 | 統合コマンドパレット、設定検索、キーバインド、用途に応じた導入を提供する。 [統合端末とパレット](https://learn.chatgpt.com/docs/integrated-terminal) · [変更履歴](https://learn.chatgpt.com/docs/changelog) | Hasilan の Ctrl+K 会話検索、スラッシュコマンド、独立したファイル検索、キー設定を保ちながら、横断パレットを追加する案。実行先切り替え、ツール起動、最近の会話、設定の各結果はアイコンと所在を表示する。 [App.tsx](../packages/web-harness/src/client/App.tsx) · [QuickOpen.tsx](../packages/web-harness/src/client/files/QuickOpen.tsx) · [KeybindingSettings.tsx](../packages/web-harness/src/client/KeybindingSettings.tsx) |

優先する一連の操作は、**送信前に作業場所を把握 → 実行中に介入 → 差分・検証の根拠を確認 → 行や画面へ注釈 → 同じ会話に修正を送る**。Hasilan Code の会話概要、作業一覧、Jev、Canvas、内蔵ブラウザーをつなげると、一画面に情報を増やすだけの場合より日常の操作数を減らせる。

### 現行の公開仕様で追加確認した候補

- **Appshots。** Windows では左右の Alt キーなどで最前面ウィンドウの画像と取得可能なテキストを下書きに入れ、現在／新規／自動から送付先を選べる。Hasilan の Computer Use 撮影と添付の基盤を利用し、人が見ている外部アプリのエラーを一手で下書きへ入れる入口にできる。送信前の確認と、ウィンドウの範囲が分かる表示が必要。 [Appshots](https://learn.chatgpt.com/docs/appshots) · [ComposerAttachments.tsx](../packages/web-harness/src/client/ComposerAttachments.tsx)
- **成果物のプレビュー。** ChatGPT デスクトップ公式仕様には文書・PDF・表計算・スライド、HTML のソース／プレビュー、LaTeX の直前成功版を保持する表示、成果物への注釈がある。Hasilan は Markdown、ソース、画像、動画、音声と翻訳・要約を持つ。まず PDF と隔離したローカル HTML から始め、成果物リンクから対象を開き、確認した行や領域を同じ会話に返せるようにする。 [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer) · [FilePreview.tsx](../packages/web-harness/src/client/files/FilePreview.tsx)
- **ページ固有の注釈。** Codex の公式 Browser Annotation API では、ページ側が選択単位、追加メタデータ、カスタム調整項目や注釈を開く入口を指定できる。Hasilan の Canvas やローカル開発用プレビューでは、コンポーネント ID、レイアウト案、デザイントークンを注釈に持たせる選択肢がある。サイト提供の情報はタスクの資料として保持する。 [Annotations Extensibility](https://learn.chatgpt.com/docs/annotations-extensibility) · [browser-preload.ts](../apps/desktop/src/browser-preload.ts)
- **外観と操作の細部。** Hasilan は既にテーマの共有や UI／コードのフォント設定を持つ。次に見るべきは、会話内検索、未読にする／次の要対応へ移動、閉じたタブの復元、最近のモデル、キー入力から割当を逆引きする設定。Codex のショートカット一覧はこれらを用途とフォーカス範囲ごとに示す。 [アプリのコマンド](https://learn.chatgpt.com/docs/reference/commands) · [設定](https://learn.chatgpt.com/docs/reference/settings) · [ThemeAppearance.tsx](../packages/web-harness/src/client/ThemeAppearance.tsx)

## 実行基盤・状態・復旧

調査対象の Windows MSIX は `OpenAI.Codex 26.1106.6628.0`、同梱の `app/resources/codex.exe` は `0.167.0-alpha.4.1`。PATH の CLI `0.163.0` と区別した。同梱バイナリから実験機能込みの TypeScript 型を生成し、939ファイルを生成し、対象プロトコルの型を確認した。隔離した設定・作業ディレクトリとローカルの模擬 Responses SSE サーバーを使い、`initialize`、スレッド作成、合成ターン完了、履歴取得、購読解除、診断を stdio で実行した。実モデルは呼んでいない。公開仕様と、当該バイナリで到達を確認した API を区別する。 [OpenAI の App Server 設計](https://openai.com/index/unlocking-the-codex-harness/) [公開 App Server 仕様](https://learn.chatgpt.com/docs/app-server)

| 観点 | Codex の根拠と Hasilan Code への適用 |
| --- | --- |
| UI とランタイムの境界 | Codex Desktop は検証済みのバイナリを同梱し、長寿命の子プロセスに双方向 JSON-RPC で接続する。Web 側はコンテナの同じランタイムを HTTP/SSE の背後に置く。Hasilan Code でも Electron の親が IPC で `DesktopHost` を制御し、子が Web と同じ `startHarness` を実行する。次の改善は HTTP/WS を捨てず、クライアント／ホストのバージョン・能力を起動時に照合し、未知のイベントへの耐性と配布物の組み合わせを契約テストにすること。 [Codex のクライアント構成](https://openai.com/index/unlocking-the-codex-harness/) [DesktopHost](../apps/desktop/src/host.ts) [共通サーバーの起動](../packages/web-harness/src/server/desktop-host.ts) |
| 状態確認とランタイム起動の分離 | Codex は `thread/read` を履歴閲覧、`thread/resume` を作業への再接続として分け、既存の実行中スレッドへ再参加できる。模擬ターンの後、購読解除から `thread/resume` で再開し、`excludeTurns: true` と概要1件を指定すると、全ターンの配列は空で初期ページだけに1件返った。同梱バイナリは空のスレッドで `thread/read` と既読状態を返し、初回のユーザー入力までは `thread/turns/list` が未永続化と明示した。同じ空スレッドの `thread/items/list` は `-32601`。合成ターン完了後は、同じスレッドの両方の一覧が各1件を返した。インストール済み renderer の `739301.37a39f26d6.js` ではバイト 810226 に同 API の呼び出しと過大応答時のページ縮小、バイト 889791 に `thread/turns/list` の `itemsView: full` を使う互換経路がある。Hasilan Code の50メッセージのページと履歴パッチを土台に、要約と詳細の転送を分け、重いログ・差分・画像を開いたときに個別取得できる。 [履歴 API](https://learn.chatgpt.com/docs/app-server#list-thread-turns) [Hasilan の履歴モデル](../packages/web-harness/src/shared/session-history.ts) |
| イベントと操作の整合 | Codex には `thread/turn/item` ごとの開始・差分・完了通知があり、実測でもメッセージの差分、トークン使用量、既読状態の通知を受けた。割り込みには `expectedTurnId`、キュー投入には `clientUserMessageId` を使う。既読更新も `expectedRevision` を受ける。Hasilan は epoch、seq、再購読、50ms の更新集約、入力のサーバー ID と既存キューを持つ。追加するなら、送信・停止・割り込みの受付にクライアントの操作 ID と対象 run ID を持たせ、通信再試行で二重送信せず、古い操作で新しい作業を止めないようにする。 [ターンとイベント](https://learn.chatgpt.com/docs/app-server#turns) [EventHub](../packages/web-harness/src/server/events.ts) [再接続](../packages/web-harness/src/client/subscriptions.ts) [入力管理](../packages/web-harness/src/server/team-manager.ts) |
| 承認・質問・MCP の双方向化 | Codex は権限要求、ユーザー質問、MCP の追加入力をサーバーから発行し、回答・期限切れ・ターン停止に伴う破棄を解決通知で閉じる。Hasilan の Web セッションは Pi 拡張を `bindExtensions({})` で接続している。既存 Pi 拡張の質問 UI を共通の保留要求として投影し、再接続後の表示と二重回答防止をまとめて扱うと、Web と Desktop の機能差を減らせる。 [Codex の承認と質問](https://learn.chatgpt.com/docs/app-server#approvals) [Hasilan の拡張バインド](../packages/web-harness/src/server/session-registry.ts#L1327) [Pi の UI バインド](../packages/coding-agent/src/core/agent-session.ts#L3485) |
| 失敗・中断・再開 | Codex の構造化された承認、ツール完了、割り込み、スレッド状態は、再接続時に何が残ったか判断する材料になる。Hasilan はホスト異常終了を検出し、起動時に Goal／Hyakki を一時停止して明示再開にする。直前に実行したツール、結果、適用済み変更、再実行対象をチェックポイントとして表示し、途中のコマンドや変更を再開時に無条件で繰り返さないようにする。 [Codex のイベント仕様](https://learn.chatgpt.com/docs/app-server#events) [Hasilan の起動時復旧](../packages/web-harness/src/server/session-registry.ts#L485) [DesktopHost の終了検知](../apps/desktop/src/host.ts) |
| 分岐・巻き戻し | Codex は `thread/fork` の `lastTurnId` で起点を指定できる。同梱の型では `thread/revert` は会話履歴だけを戻し、ローカルファイルの差分は対象外。旧 `thread/rollback` は実際に未知メソッドだった。Hasilan にあるエージェント別ワークツリーの採用・破棄・復元を活かし、会話の分岐と Git の採用操作は個別の記録・プレビューを持たせる。 [履歴の分岐・復元](https://learn.chatgpt.com/docs/app-server#threads) [Hasilan のワークツリー](../packages/web-harness/src/server/agent-worktrees.ts) |
| 長時間のプロセスと診断 | 同梱バイナリの `server/diagnostics` はプロセス情報と `app.requests.in_flight`、`app.requests.queued`、`core.threads.live` を返した。生成型の `process/spawn` は接続単位のハンドルでストリーミングし、出力上限到達を示す。Hasilan の端末マネージャー・ブラウザーワーカー・メモリ測定を起点に、起動、待ち行列、アクティブセッション、端末、画像の件数とメモリを処理単位で診断する。個人データやトークン本文を含めず、起動や再接続の遅さを再現しやすくする。 [Codex のコマンド実行](https://learn.chatgpt.com/docs/app-server#command-execution) [端末マネージャー](../packages/web-harness/src/server/terminal-manager.ts) [既存のメモリ測定](performance/desktop-memory-2026-11-08.md) |

## コンテキストと拡張性

| 観点 | Codex の根拠と Hasilan Code への適用 |
| --- | --- |
| プロンプトキャッシュの安定 | OpenAI の設計記事では、ツール定義の順序がぶれてキャッシュを失った実例がある。変更を末尾への追記で表せる場合、先頭を維持する。Hasilan は既にプロバイダー別のキャッシュ・セッションアフィニティ設定を持つ。安定した tool schema 順序を比較テストにし、MCP の発見・設定切替・エージェントからの通知が毎ターンの先頭を変えないか測る。 [Codex エージェントループの性能設計](https://openai.com/index/unrolling-the-codex-agent-loop/) [既存のプロバイダー互換設定](../packages/ai/src/providers/compat-schema.ts) |
| 圧縮と再取得 | Codex の設計記事にはコンテキスト圧縮とモデル側の不透明な圧縮アイテムがある。記事の通信方式は公開時点の説明で、現在のすべてのモデル経路に一般化しない。Hasilan には Pi の要約圧縮と再試行があるので、モデル横断で改善しやすいのは、ツールの原文を後から取得可能にし、圧縮後も制約・成果物・未完了作業を検証すること。 [Codex の圧縮設計](https://openai.com/index/unrolling-the-codex-agent-loop/) [Pi の compaction 実装](../packages/coding-agent/src/core/compaction/) |
| プラグインの能力・由来・診断 | Codex は Skill、MCP、Hook を一つの導入単位で扱い、Hook は現行の定義をユーザーが信頼してから実行する。Hasilan の Pi にはリソースローダー、由来情報、設定エラー、拡張の衝突検出がある。追加価値は、Web／Desktop で同じ一覧に「どこから来たか」「利用可能か」「何を実行するか」を出し、再読み込みや無効化の結果を確認できること。 [OpenAI のプラグイン仕様](https://developers.openai.com/plugins/build/plugins) [Pi リソースローダー](../packages/coding-agent/src/core/resource-loader.ts) |
| 実行環境の識別とリモート | 同梱の型には `environment/add`、`environment/info`、`environment/status` と、端末とは別の Remote ペアリング／失効インターフェースがある。Hasilan の同一ホスト Web/LAN 接続を使うなら、まず各スレッド・コマンドに「どの環境・フォルダーで動いているか」を表示する。その後に別実行ホスト、端末再接続、ペアリングの失効を個別に設計する。 [App Server の環境・リモート仕様](https://learn.chatgpt.com/docs/app-server) [Hasilan のネットワーク設定](../packages/web-harness/src/server/network.ts) |
| Code Mode・自動化 | Windows 配布物には `codex-code-mode-host.exe` があり、公開仕様は長寿命の App Server と単発の自動化入口を分ける。Hasilan は既に Code Mode を持つ。道具のまとめ実行を再導入する必要はなく、実行単位の親子関係、再開情報、結果の上限と原文参照、ヘッドレスから同じイベントを扱えることを改善候補にできる。 [Codex の連携方式](https://openai.com/index/unlocking-the-codex-harness/) [Hasilan の Code Mode](../packages/coding-agent/src/extensions/codemode/) |

上記のうち、操作 ID と対象 run ID、保留要求、要約から詳細への段階読み込みは、ランタイムの置き換えを伴わず個別に検証できる。再接続中の送信、長いツール出力、承認待ちの状態を固定データで比較し、初回表示時間、使用メモリ、二重実行、復旧時の欠落を同時に確認すると、見た目と内部の差を追いやすい。

## 比較結果の使い方

1. **日常の操作を先に改善する。** 作業一覧と会話の概要から、今の Git 差分、担当の変更、テスト結果、ソースに直接移動できるようにする。小さな修正をレビューし、行コメントから同じ会話へ指示を返すまでの操作を通して評価する。
2. **大きい会話と復旧を同じテストに入れる。** 会話切替、スクロール、切断からの復帰を、長いログ・画像・複数タブがある状態で再現する。初回表示時間、ピークメモリ、重複実行、下書き・未読・承認要求の保持を測る。モデルへの入力・出力・キャッシュ読取は別の指標にする。
3. **運用機能は実行場所と状態を先に揃える。** worktree、ローカル端末、将来のリモートホストで、送信先、権限、キャンセル、復旧、残るデータが追える状態を作る。予約実行とリモート操作はこの契約を使う。

確認範囲は Windows の配布バンドル、同梱ランタイムの隔離実行、公式資料、Hasilan Code の対応ソース。実機の画面操作、OS横断での動作、サーバー側の機能フラグ、クラウドや実モデルの挙動、性能差の実測はこの調査の証拠に含めていない。模擬ターンで確認した項目は、実行基盤の節に具体的に記載した。
