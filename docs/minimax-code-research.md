# MiniMax Code の良いところ

2026-11-12 JST に [公開ソースのコミット](https://github.com/MiniMax-AI/minimax-code/commit/3c21163c85a9684030cb147bfef48c6284fa3c46) を調査した。対象は公開ソースの TUI 0.7.2、CLI、ACP、同梱コード、公式デモ。Desktop の独自画面、クラウド実行専用部分、公開 npm 版には別の境界がある。こちらではインストールやモデル呼び出しを行っていない。UX の評価は、確認できた挙動とその設計からの評価。 [公開範囲とバージョン](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/open-source-status.md) [公式の検証記録](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/verification.md)

## AI が長い作業を続ける仕組み

| 良いところ | 具体的な挙動と利点 |
| --- | --- |
| 会話の停止と画面移動を別の操作として扱う | Esc は現プロセスが所有するバックグラウンドの Bash・子エージェントまで止め、完了通知で勝手に会話を再開しない。セッション切替や `/clear` は実行中ターンを停止し、Goal とキューを一時停止する一方で、バックグラウンド作業は続く。未消化の割り込み入力が履歴保存に失敗したときもキューへ戻す。画面移動で調査やテストを止めず、停止を選んだときに活動をまとめて止められる。 [停止の境界](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md#stopping-a-conversation-and-its-background-work) |
| 長いシェル作業を同じ実行のままバックグラウンドに移す | 対応するツール構成では、前景 Bash が一定時間を超えると同じコマンドのタスク ID を返す。結果には終了コード、シグナル、タイムアウト、キャンセル、部分出力が残り、長い出力は先頭・末尾と全ログの参照を返す。出力の追加取得はバイト位置で行える。AI が巨大ログに埋もれず、途中から追える。 [Bash の実行契約](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md#local-bash-execution) |
| 質問待ちを実行状態として保存する | `ask_user` はターンを保留中の質問として確定する。返答がストリーム終了より先に到着する場合も扱い、最終メッセージがない失敗として誤表示しない。人間の返答待ちが会話を開き直したときにも意味を持つ。 [Ask・Plan の質問待ち](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md#askplan-answer-requests) |
| Goal の完了に独立した検証を入れる | 実際に使ったモデル経路に応じて、Token Plan と MiniMax API キーでは既定で読み取り専用のサブエージェントが検証する。カスタムモデル等の BYOK では既定で作業AIの完了提案を採用し、追加呼び出しの負担を抑える。設定で検証方式を指定できる。実装を担当したAIの報告を、独立した観点から確認できる。 [検証ポリシー](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/agent-modules/goal/src/verification/verification-policy.ts) [検証役への接続](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/local-runtime-v2/src/application/agent/goal-subagent-verifier.ts) |
| 巻き戻し・編集・分岐を履歴の境界として扱う | 変更前のプレビューを組み立て、履歴の状態や別ランタイムの実行所有権を検査する。巻き戻し・再送には操作記録と段階ごとの復旧処理があり、中断後の再開も考慮する。履歴と実際の作業がずれやすい操作に、確認と復旧の境界がある。 [変更ワークフロー](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/local-runtime-v2/src/application/session/conversation-mutation-workflow.ts) [操作の復旧](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/local-runtime-v2/src/application/session/conversation-rewind-edit-service.ts) |
| 応答待ちと途中の無応答に別々の期限を設ける | 最初の応答イベントが来ない場合と、その後ストリームが止まる場合に個別の期限を置く。目に見える出力が始まる前はリトライ可能で、出力後はエラーとして止める。長時間の無反応と、再試行で同じ応答が重複する問題の両方を扱う。 [モデル要求のタイムアウト](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md#model-request-timeouts) |

## コンテキスト・実行効率

| 良いところ | 具体的な挙動と利点 |
| --- | --- |
| 軽い会話を専用モードで始められる | `--mode lightweight` は短い会話用プロンプトを使い、ツール定義、ワークスペース指示、Skills、MCP、メモリをプロバイダーへ送らない。新規ルートセッションに固定される。コード変更を伴わない質問で送信するコンテキストを減らせる。 [軽量セッション](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/README.md#lightweight-conversations) |
| 圧縮の条件を複数に分ける | モデルの出力予算を確保した上で履歴を圧縮する。トークン数だけでなく、ツール結果の大きさやリクエストのバイト数でも発動し、閾値を早める設定がある。大きいツール結果にはアーカイブ経路がある。ひとつの閾値に任せるより、長いコード作業で失敗の原因を切り分けやすい。 [自動圧縮](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md#automatic-context-compaction-trigger) [ツール結果アーカイブ実装](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/tool-result-archiver.ts) |
| 古い画像を外して再試行し、素材は後で開ける | 添付、Read の画像、ブラウザーのスクリーンショットを共通のメディア予算で扱う。画像数・リクエストサイズで拒否された場合は、最新画像を残して古いものを落とし一度再試行する。外したツール画像は参照パスを残す。連続したブラウザー操作でモデルの入力上限を踏んだとき、最新画面を使って続けられる。 [リクエストの画像予算](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md#request-media-budget) |
| ツールの中間出力をモデルへ全部返さず処理できる | PTC ベータでは、AI が `run_code` から複数ツールを呼び、フィルターした結果を返す。ツールモードをセッション作成か圧縮時に固定して、プロンプト先頭を安定させる。権限、個別の拒否、全体キャンセルを従来の実行経路に接続し、記録には子ツールをまとめる。大量の検索・読み込みで文脈を圧迫しにくい。 [PTC](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md#programmatic-tool-calling) |
| キャッシュの経路もセッションの設計に入れる | 対応する OpenAI 互換のカスタムプロバイダーでセッションごとのキーを送れる。サーバー側の対応次第で同じセッションをキャッシュの効く経路に寄せられる。 [キャッシュとセッションの関連付け](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/examples.md#prompt-cache-session-affinity) |

## 拡張・モデル・外部連携

| 良いところ | 具体的な挙動と利点 |
| --- | --- |
| 標準アカウントと自前モデルの入口を揃える | MiniMax ログインと BYOK を選べる。BYOK は OpenAI Completions、OpenAI Responses、Anthropic Messages 形式を選択できる。接続テスト付きで保存・選択でき、コンテキスト・出力上限、環境変数による API キー、対応するカスタムヘッダーを設定できる。ローカルモデルや中継サービスを試す手順が具体的。 [モデルの設定例](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/examples.md#2-choose-your-own-model) [公式 README](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/README.md) |
| モデル変更の適用範囲が明確 | 対話起動時のモデル指定は対象セッションに保存される。新規セッションの全体既定は別で、ヘッドレスの上書きは今回だけの選択として扱う。ヘッドレスは選択したモデルを基準に認証要否を判定する。アカウント既定を変えずにテストや案件ごとのモデル選択ができる。 [対話起動モデル](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md#interactive-startup-model) [認証とランタイム境界](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/architecture.md#managed-capabilities-and-tool-integration) |
| プラグインの能力を配布単位で束ねる | 宣言ファイルで App・Connector、MCP、Skill、同期 Hook、ホスト側の連携を参照できる。パッケージ形式、スキーマ、検証用データが公開され、公式カタログとローカルパッケージを管理できる。個別のスクリプトを寄せ集める手間が減る。 [パッケージ形式](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/plugins/package-format-v1.md) [管理の例](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/examples.md#4-manage-plugins) |
| MCP の「設定済み」と「利用可能」を区別する | ワークスペースの `.mcp.json` と環境変数を使え、設定読込・接続・ツール検出・エラーの違いを表示する。設定の再読込を認証成功と混同しない。キー不足や接続不良の切り分けがしやすい。 [プロジェクト MCP の具体例](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/examples.md#5-connect-an-authenticated-project-mcp-server) |
| Hook の表示とモデルに渡す文脈を分ける | Hook は `systemMessage` で人間への通知を保存・表示できる。モデル文脈に追加する内容は別のフィールドで指定する。再開後にも通知を確認でき、通知だけでモデル呼び出しを増やさない。 [Hook の表示仕様](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/hooks.md#display-and-model-context) |
| ローカル作業から検索・メディアへ広げられる | 公開ソースには検索、画像入力、MCP、管理型コネクター、別プロセスのメディアツール連携が含まれる。子プロセスには短期トークンを貸し出し、更新用の認証情報はホストに留める。実サービスの記録では検索・カタログ・ツール検出まで確認されており、有料メディア生成やコネクターへの書き込みは未確認。 [対応範囲](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md) [公式の実サービス検証記録](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/verification.md#live-production-account-acceptance) |

## 自動化・配布・品質管理

| 良いところ | 具体的な挙動と利点 |
| --- | --- |
| 端末、CI、エディターで実行基盤を共有する | 対話 TUI、ヘッドレス `mcode exec`、ACP はプロセス内の同じアプリケーション層を通り、セッション・キュー・実行・プロバイダーを共用する。端末で試した作業を CI や対応エディターに持ち込みやすい。 [公開アーキテクチャ](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/architecture.md) [ACP ランチャー](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/code-acp/README.md) |
| TypeScript と Python の SDK が実行結果を扱える | 両 SDK は CLI を使ってセッションの作成・再開、ストリーミング、キャンセルを提供する。TypeScript 側はバージョン付きの NDJSON イベント、タイムアウト、最大ステップ数、終了理由別の型を公開する。テキスト解析だけで成否を判断する必要が減り、CI で実行が終わらない場合も扱いやすい。 [TypeScript SDK](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/code-sdk/README.md) [Python SDK](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/code-sdk-python/README.md) |
| オフラインでも実行の重要部分を検証する | ローカルの OpenAI 互換サーバーを相手に、実行・セッション再開・ファイルツール・認証経路を通すテストがある。ネットワーク失敗を再現し、オンラインでの受け入れ記録とは分けている。各挙動を有料キーなしで繰り返し検証できる。 [検証記録](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/verification.md#clean-directory-acceptance) |
| 性能を PR で継続比較する | 通常は 100 ラウンド、性能変更時は起動と 300 ラウンドの履歴増大も測る。同じランナー上で基準・候補を交互に実行し、経過時間・CPU・RSS・完全な履歴とツール結果を検査する。ノイズの大きい測定も別判定で残す。単発ベンチの速さより、長時間の実用上の退行を見つけやすい。 [性能 CI](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/performance-ci.md) |
| 初回体験と配布後の検証を一緒に設計している | 公式の OS 別インストーラー、npm、検証用アーカイブ、ソースからの導入を案内する。インストール先とユーザーデータを別に説明し、リリース候補にはソースリビジョンの記録とハッシュを付ける。最初の教材はモデル利用なしで完成形を試せ、初回プロンプトと追加修正の流れまで再現できる。 [インストールガイド](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/installation.md) [リリース手順](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/releasing.md) [公式デモ](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/demo.md) |
| 診断とユーザーデータの扱いが明示されている | 利用イベント、性能指標、エラー診断は別々のオプトインで、既定はオフ。診断で送信される項目と経路を公開している。障害調査のために何が送られるか、利用者が判断しやすい。 [テレメトリの仕様](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/telemetry.md) |

## 操作と表示

| 良いところ | 具体的な挙動と利点 |
| --- | --- |
| 結論と実行の証拠がつながっている | 公式の CLI デモでは、ファイル確認 → 編集 → テストを短い行でつなぎ、編集箇所を行番号付き差分、テスト結果を実際のコマンドと出力で見せる。その後に原因と修正を文章で説明する。会話を上から読むだけで、結論をどの操作で確かめたか追える。 [CLI デモ](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/demo.md) |
| 作業ログの上を読んでいる間、表示位置を守る | 全画面 TUI で上へスクロールすると自動追従が外れ、送信、新規セッション、明示的な最下部移動で追従に戻る。通常のターミナル表示は確定した行を端末のスクロールバックに送り、生成中の行は更新できる領域に置く。設定パネルから戻ったときにも会話の行を復元する。 [追従設計](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/superpowers/specs/2026-09-23-tui-follow-tail-design.md) [表示の動作](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md) |
| 本線の実行を続けながら横から質問できる | `/btw` は保存済みの完結した履歴を使って別の会話を開き、本線が進んでもその開始時の文脈は固定される。完了したツール呼び出しは結果ごと引き継ぎ、再実行しない。Ctrl+/ で往復できるので、調査中に用語や理由を聞いても本線の依頼が変わらない。 [サイドチャット](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md) |
| 実行中に指示を変えるか、次の指示を積むかを選べる | Enter で実行中のターンへ指示し、Alt+Enter で次に実行する指示を積む。Shift+Tab で Plan、Alt+M で権限モードを切り替える。ユーザーが入力した目的、操作のタイミング、許可範囲をキーボードから扱える。 [キーボード操作](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/README.md) [権限モード](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/installation.md#permission-modes) |
| 添付や拡張を入力した時点で確認できる | `@` からファイルと有効なプラグインを選び、選択したプラグインの識別情報を下書き・編集・キューに引き継ぐ。入力候補は作業が落ち着いた後の空の入力欄に出て、Tab で採用できる。 [入力補助とメンション](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/tui-capabilities.md) |
| 巻き戻す対象を選んで変更を確認できる | 履歴から起点を選び、会話だけ、または会話とファイルを巻き戻す。変更予定をプレビューできるので、質問だけやり直す操作と作業ツリーに触る操作を判断しやすい。 [対象の選択](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/tui/src/tui/features/session-mutation/scope-picker.ts) [プレビューの実装](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/tui/src/tui/features/session-mutation/rewind-preview-panel.ts) |
| 見た目の設定に試着と取り消しがある | テーマは候補へ移動するだけでその場でプレビューでき、キャンセルで復元できる。ステータス行も実際のデータを見ながら項目を検索・並べ替えでき、横幅が狭いときに残す情報に優先順位がある。 [テーマ](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/tui/docs/theme-config.md) [ステータス行](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/tui/docs/status-line-config.md) |

## Desktop で確認できた製品設計

- **会話は中央、進捗と担当は右、履歴は左。** 公式画面では回答の直前に思考とコマンドの件数を薄い一行で置き、進捗はチェック付きの行、エージェントは名前と完了状態で見せている。ボーダーと背景色の差が控えめで、視線が本文に戻りやすい。 [Desktop の公式画面](https://filecdn.minimax.chat/public/c3ebbd2e-f55b-48d7-adff-030abb63e06d.png)
- **Coding と Work で作業の入口を切り替える。** コーディングではフォルダー、編集、端末、ブラウザープレビュー、差分をつなげる。Work では文書やメディア、連携、定期実行を同じタスクの中で扱う。Canvas は画像・動画・HTML を並べて比較できる成果物置き場として紹介されている。 [Desktop の機能](https://code.minimax.io/about) [コーディングの流れ](https://code.minimax.io/tools/ai-coding-agent)
- **離席時の確認とクラウドへの引き継ぎに、それぞれ入口がある。** モバイル連携で稼働中の Desktop に接続し、進捗や承認を扱える。クラウド実行ではタスクの文脈と必要なファイルを引き継ぎ、変更を確認して同期する流れが紹介されている。 [Desktop とモバイルの公式説明](https://code.minimax.io/about)
- **AI が作った画面を、繰り返し使える Mini App にできる。** マニフェスト、画面、永続化できるバックエンドを持ち、ホストが起動と保存を扱う。ユーザーは画面で選んだ内容を入力欄に送って確認でき、AI も MCP 経由でアプリを操作できる。公式例には 3D モデルの注釈、使用量、Git 履歴、作業の進捗を追う画面がある。作った成果物を次の仕事の操作画面にできる点が特徴的。 [Mini Apps の公式解説](https://www.minimax.io/blog/minimax-code-mini-app-1792650729)

## Hasilan Code に取り入れるなら

| 優先 | 変更案 | 既存機能との接点 |
| --- | --- | --- |
| 1 | AI の回答から、そのターンで触ったファイル・確認したテスト・プレビューへ移動できるようにする。テストを実行した記録がある場合にコマンドと結果を表示する。 | [ファイル変更](../packages/web-harness/src/client/FileChanges.tsx) と [AI の活動](../packages/web-harness/src/client/turn-activity.ts) を同じターンで関連付ける。 |
| 2 | チーム右欄に進捗と担当の一覧を出し、担当を開くと作業の根拠と成果を確認できるようにする。 | [作業一覧](../packages/web-harness/src/client/WorkOverview.tsx) やエージェント別ワークツリーの状態を使う。 |
| 3 | 実行中の会話を保ったまま、今の文脈で短い質問をする入口を作る。進行中の指示と次の指示は、送信前に結果が予測できる表示にする。 | [会話](../packages/web-harness/src/client/Conversation.tsx) と既存の実行中・完了後の送信経路を使う。 |
| 4 | ブラウザーの注釈を、成果物やダッシュボードからも送れるようにする。作成・再表示・入力欄への受け渡しから始める。 | [内蔵ブラウザー](../packages/web-harness/src/client/BrowserPane.tsx) と [Canvas](../packages/web-harness/src/client/CanvasPane.tsx) が土台になる。 |
| 5 | 長い履歴の性能を同じデータで繰り返し計測する。読み込み時間、メモリ、生成中のスクロール位置、履歴や添付の欠落を合わせて確認する。 | [会話の仮想表示](../packages/web-harness/src/client/Conversation.tsx) の調整を検証できるようにする。 |

公開ソースは固定コミットを確認し、Desktop は公式の画面と説明を参照した。起動時間・メモリ・操作応答や、他製品との同条件でのモデル品質は未測定。
