# AIコーディングハーネスの比較と改善候補

調査日: 2026-10-26 JST

対象はCodex、Claude Code、OpenCode、Cursor Agent、Aiderと、Hasilan Codeのローカル作業ツリー。ハーネスとは、モデルに渡す文脈、編集・実行ツール、作業状態、確認画面、再開処理をまとめる実行基盤を指す。セキュリティは今回の調査対象に含めない。

改善の中心は、**依頼した変更を確認し、検証結果を判断し、途中からやり直すまでの操作をつなぐこと**にある。Hasilan Codeには既に目標管理、チーム実行、入力キュー、使用量表示がある。これらの状態を、成果を判断する画面や再開操作へつなぐ余地がある。

## 調査方法と限界

- 競合については公式ドキュメント本文を確認した。記載された仕様・操作を比較しており、同一モデル・同一課題での速度、成功率、費用は測定していない。
- Hasilanについては、App、ChatPane、DetailPane、SessionActions、ToolInspector、SettingsDialog、GoalPanel、SessionRegistry、公開HTTP API、入力・目標・使用量の型、Hashlineの編集とsnapshot管理を確認した。すべてのPi拡張や外部ツールを網羅した調査ではない。「未接続」は標準Web画面とAPIで確認した範囲を指す。
- 改善候補の優先度と最小構成は、この調査からの設計判断。競合の仕様そのものと区別する。
- デスクトップ、CLI、クラウドでは使える機能が異なる。比較表には対象画面と条件を併記する。OpenCodeは通常の`opencode.ai/docs`を根拠とし、開発版v2の仕様を混ぜない。
- 既存の未コミット変更を含む作業ツリーが対象。コード変更、ビルド、テスト、コミットは実施していない。

## 優先候補の一覧

規模は相対的な実装見積もりで、工数の実測ではない。「小」は既存経路の集約が中心、「中」は新しい画面・保存情報・APIの追加、「大」は実行状態やファイル解決先の変更を含む。

| 優先度 | 候補 | 確認した現状との差 | 最初の実装規模 |
| --- | --- | --- | --- |
| P1-1 | 作業全体の差分確認・行への修正依頼 | ツール呼び出し別diffはあるが、ターン全体の比較・復元画面はない | 中。ファイル復元と会話分岐は追加で大 |
| P1-2 | 完了条件と検証結果の記録 | コマンドの終了コードは見えるが、確認対象の版や未実行項目と結びつかない | 中 |
| P1-3 | 新しい画像・ファイル・選択範囲の添付 | 新規送信APIはテキストのみ。取り込んだ添付は既に表示できる | 中 |
| P1-4 | セッションとworktreeの対応管理 | 同じworkspaceでは作業ディレクトリを共有する | 大 |
| P2-1 | 中断後の確認・再開案内 | 保存・再開・一時停止はあるが、未確定の処理を確認する専用画面がない | 中 |
| P2-2 | 編集できる実行計画 | Goal・Canvas・チーム依頼はあるが、採用した計画と実行手順を結ぶ専用経路はない | 中 |
| P2-3 | 文脈の内訳とコードの見取り図 | 合計tokenはあるが、送信文脈の内訳を確認・選択する画面はない | 中。repo mapは追加で大 |
| P2-4 | 起動前にも使える環境診断 | 既存の端末検査と設定画面の診断が分かれている | 小〜中 |
| P2-5 | 読み込んだ指示・コマンドの補完 | resource loaderはあるが、入力欄は4コマンドだけ受け付ける | 中 |
| P3-1 | ターン別の使用量 | モデル・担当別の集計はあるが、同じ担当の依頼別には追えない | 中 |
| P3-2 | 要対応一覧と履歴の整理 | 状態表示はあるが、未読・完了・入力待ちの横断一覧や本文検索がない | 小〜中 |

## 競合から学べる具体的な操作

| 製品・対象 | 公式資料で確認した動作 | Hasilanに取り込む価値のある点 | 比較時の条件 |
| --- | --- | --- | --- |
| Codex・デスクトップ/CLI | ローカルレビューでは未ステージ、ステージ済み、コミット、ブランチ、直前ターンを選べる。画面から行単位の指摘とstage/revertにつなげられる。`/review`は差分を読み、指摘を返す。[Code review](https://learn.chatgpt.com/docs/code-review) | 変更内容と「どの作業の差分か」を同じ画面で確認し、その場所から修正依頼できること。 | レビューパネルはGitリポジトリが必要で、人間や他のツールの変更も含む。表示された変更をすべて当該エージェントの成果とみなしてはいけない。 |
| Codex・ワークツリー | チャットごとにGit worktreeを作り、LocalとのHandoffを提供する。セットアップを関連づけ、管理対象worktreeを削除する前には復元用snapshotを保存する。[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Local environments](https://learn.chatgpt.com/docs/environments/local-environment) | セッションと作業ディレクトリを対応させ、並行作業を始める前から成果の確認・再利用まで扱うこと。 | チャットを分けるだけではファイルは分離されない。依存関係やGit管理外ファイルの準備も必要。 |
| Claude Code・CLI | プロンプト開始前に編集対象のsnapshotを取り、コードだけ、会話だけ、両方の復元を選べる。保存済みセッションの再開後も利用できる。[Checkpointing](https://code.claude.com/docs/en/checkpointing) | 「会話をやり直す」と「ファイルを戻す」の選択を明示すること。 | Bashだけが変更したファイルは追跡対象外。保持期間やsnapshot数にも制限がある。全副作用の巻き戻しではない。 |
| Claude Code・再開/診断 | 再開時は未完了のツール呼び出しを識別し、実行済みか確認するようモデルへ伝える。`claude doctor`はセッションを始めず、インストールと設定の問題・対処候補を表示する。[Manage sessions](https://code.claude.com/docs/en/sessions)、[Advanced setup](https://code.claude.com/docs/en/setup) | 再開しただけで終わらず、何が未確定かを明示すること。起動失敗をチャット依頼の前に診断すること。 | 再開でバックグラウンド処理まで自動的に復活するわけではない。 |
| OpenCode・TUI | `@`で選択したファイルの内容を会話へ追加する。`/undo`と`/redo`はメッセージとファイル変更を戻す。通知は設定すると、完了や質問・エラーへの注意を促す。[TUI](https://opencode.ai/docs/tui/) | 文脈の追加、試行のやり直し、対応待ちの発見を短い操作で行えること。 | undo/redoのファイル復元にはGitが必要。通知は既定で無効で、デスクトップ通知は端末が非アクティブなときに送られる。 |
| OpenCode・診断連携 | LSP（言語サーバーとの共通通信方式）から診断を取得できる。ただし既定で無効。公式資料も、状態のずれ、メモリ、速度の理由からCLIのlint/typecheckの方が適する場合を説明している。[LSP Servers](https://opencode.ai/docs/lsp/) | 診断を編集後のフィードバックに使うことと、言語サーバーを常時必須にしない判断。 | 「LSPがあれば常に良い」という結論は出せない。 |
| OpenCode・再利用する指示 | Markdownや設定で独自コマンドを作り、`/`から実行できる。説明、引数、agent、modelを指定できる。[Commands](https://opencode.ai/docs/commands/) | 読み込んだ指示や拡張を、利用者が見つけて直接呼び出せること。 | 指示の再利用と、任意のツールやskillの存在は別の機能。 |
| Cursor Agent・計画/実行 | コードを調査し、質問し、利用者が編集できる計画を作る。計画を確認してBuildへ進み、必要ならworkspaceへ保存する。[Plan Mode](https://cursor.com/docs/agent/plan-mode) | 計画を会話中の文章だけで終わらせず、実行対象となる成果物にすること。 | 小さな変更は直接Agentで進めてよい、と公式資料も区別している。 |
| Cursor Agent・レビュー/復元 | チェックポイントを選んで状態を確認し、ファイルを復元できる。会話は残る。Agent Reviewはローカル変更への専用レビューを提供する。[Overview](https://cursor.com/docs/agent/overview)、[Agent Review](https://cursor.com/docs/agent/agent-review) | 差分確認からレビュー、試行のやり直しに移れること。 | checkpointはGitと別のローカル保存。会話の復元とは別。自動レビューの詳細は資料内で「task後」「commit後」の説明があり、ここでは自動起動条件を比較材料にしない。 |
| Cursor・ワークツリー | Agents Windowではエージェントごとのcheckoutを作る。`.cursor/worktrees.json`でOS別の準備手順を定義できる。[Worktrees](https://cursor.com/docs/configuration/worktrees) | 並行作業の分離と、その環境を実行可能にする準備を一緒に扱うこと。 | UI組み込み操作はAgents Window向け。IDEではWorktree Skillsを利用する。 |
| Aider・文脈 | ファイルと主要なクラス・関数・型・呼び出し形式をrepo mapにまとめ、依存グラフの順位とトークン上限に合わせて関連部分を選ぶ。[Repository map](https://aider.chat/docs/repomap.html) | 全文を大量に渡す前に、関連する定義とファイルの見取り図を小さく提示すること。 | この仕組みだけで調査時間やトークンが何割減るかは、今回測定していない。 |
| Aider・検証/取り消し | 変更後の自動lint、設定したテストコマンドの自動実行と失敗時の修正を提供する。`/diff`は直前メッセージ以降、`/undo`はAiderによる直前コミットを対象にする。[Linting and testing](https://aider.chat/docs/usage/lint-test.html)、[In-chat commands](https://aider.chat/docs/usage/commands.html) | 実行した確認と失敗を、修正の反復に戻すこと。変更単位を示すこと。 | 自動テストは`--test-cmd`と`--auto-test`で設定する。自動コミット方式そのものをHasilanへ移す必要はない。 |

## Hasilanの既存機能として扱うもの

今回の改善候補は、次の機能の再実装を意味しない。

- 継続する目標と状態管理。
- swarm/チーム実行と依存関係のグラフ表示。
- 実行中のsteer、follow-up入力、待機入力の編集・削除・即時送信。
- 外部セッションの取り込みと、取り込んだ画像・メディアの保持。
- hashlineを利用する既存の読み取り・差分編集経路。編集呼び出し単位のdiffと、古い行位置の編集を現在の内容へ再照合するためのメモリ上のsnapshotがある。このsnapshotは利用者向けのファイル巻き戻し機能ではない。
- トークン、コンテキスト、アカウント使用量の既存表示。
- 保存済みセッションの再開。起動時には進行中のgoal/swarmをpauseし、結果の記録がないツール呼び出しは画面への投影時に`cancelled`として表示する処理がある。
- DefaultResourceLoaderによるskill、拡張、再利用するpromptの読み込み。
- Chromium・Computer useの準備状態と対処手順を示す設定画面、node-ptyの起動前検査と導入コマンド。

新規入力については、`ChatPane.tsx`の送信がテキストと送信種別を受け取り、`contracts.ts`の`promptSchema`もテキストと`prompt`/`steer`/`followUp`を定義していることを確認した。改善対象は新しい画像やファイルを入力欄から追加する操作である。[ChatPane.tsx](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ChatPane.tsx:25)、[contracts.ts](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/shared/contracts.ts:34)

## ローカル実装の確認箇所

| 操作・状態 | 実装上の根拠 |
| --- | --- |
| 差分の表示範囲 | [DetailPaneの表示種別](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:14)、[ToolInspectorの呼び出し別diff](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ToolInspector.tsx:173)、[Hashlineのsnapshot管理](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/tools/hashline/snapshots.ts:44) |
| 完了・検証 | [Goalの保存項目](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/shared/goals.ts:4)、[Runの保存項目](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/types.ts:21)、[既存の終了コード・所要時間表示](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/ToolInspector.tsx:126) |
| 作業ディレクトリ | [セッション作成時のcwd](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/session-registry.ts:692)、[workspace単位で作る編集ツール](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/tools/hashline/index.ts:254) |
| 中断からの復帰 | [起動時のGoal・swarm一時停止](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/session-registry.ts:431)、[結果のない呼び出しの投影](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/session-registry.ts:521)、[既存の再接続処理](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/subscriptions.ts:107) |
| 再利用する指示 | [入力欄のコマンド解析](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/slash-command.ts:23)、[展開を無効にしたprompt送信](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/session-registry.ts:1070) |
| 使用量 | [既存の集計処理](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/session-usage.ts:15)、[provider/model単位の集約](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/shared/usage.ts:14) |
| 環境診断 | [起動前のnode-pty検査](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/bin/hasilan-code.mjs:69)、[設定画面の環境診断](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SettingsDialog.tsx:228) |
| 履歴と注意表示 | [タイトル・pathだけの検索](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/App.tsx:100)、[状態マーク](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/App.tsx:332)、[名前変更・削除メニュー](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/SessionActions.tsx:79) |

## 改善候補と最小構成

以下は、公式資料の機能数ではなく、依頼から結果確認までの負担を減らす順序の仮案。P1は普段の変更作業に直接効くもの、P2は長い作業や複数作業の質を上げるもの、P3は対象利用を確認して段階的に進めるものを表す。既存実装との重複がある候補は、差分に範囲を限定する。

### P1-1: 変更の確認と修正依頼をまとめる

**問題・例:** 依頼後に5ファイルが変わったとき、ツールの実行履歴とファイルプレビューを往復しても、今回の変更だけを追いにくい。別のセッションによる変更が混ざると、作業の範囲も誤認しやすい。

**現状の差分:** hashlineの呼び出し単位のdiffと、古い編集位置を再照合する処理はある。一方、DetailPaneの表示はtabs/team/toolsで、タブのresourceはfile/terminal。セッションやターン全体の変更一覧・差分確認・復元を利用者が操作する画面はない。[DetailPane.tsx](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/DetailPane.tsx:14)、[hashline](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/tools/hashline/index.ts:164)

**最小構成:** 変更ファイル一覧、差分、比較元、行を指定した修正依頼を一画面へまとめる。最初は「現在の未コミット差分」を明示して表示し、次にターン開始時の状態との比較を足す。差分の適用には既存のhashline編集経路を活用し、全体差分のための基準状態は別に保持する。

**必要な理由:** 編集そのものより、利用者が内容を確かめる出口が必要。stage/commit/PR作成を同時に実装する必要はない。取り消しを追加するときは、復元後に後続の人間の編集を失わない確認を行い、会話の分岐とファイル復元を別操作として示す。参考は[Codexのローカルレビュー](https://learn.chatgpt.com/docs/code-review)と[Claude Codeの復元対象の区別](https://code.claude.com/docs/en/checkpointing)。

**確認方法:** 別セッションの変更がある状態で、比較元と対象ファイルが正しく表示されること。行への修正依頼が対象パス・行・差分とともに入力へ戻ること。

### P1-2: 完了条件と検証結果を保存する

**問題・例:** 「修正済み」と表示されても、lintが成功したのか、テストが未実行なのか、修正前の実行結果なのかを会話から読み取る必要がある。

**最小構成:** 既存の目標に確認項目を関連づけ、実行コマンド、作業ディレクトリ、開始・終了、終了コード、出力へのリンク、確認対象の差分を記録する。状態は成功・失敗・未実行・結果が古いを区別する。検証後にコードが変わったら、その結果を現在の変更に対する成功として表示しない。

**現状の差分:** ToolInspectorには既にコマンド、終了コード、所要時間、出力がある。追加するのは、その記録をGoal・Run・確認対象の版へ結びつける部分。swarmの指示にも受け入れ条件と独立検証は記載されており、「検証の指示が一切ない」という指摘ではない。

**必要な理由:** bashが実行できることと、成果の検証が追えることは別。自動実行はリポジトリが定義した確認手順に従う。全編集のたびに全テストを回す仕組みは初期構成に不要。Aiderの[lint/testの失敗フィードバック](https://aider.chat/docs/usage/lint-test.html)と、Codex公式記事の[節目ごとの受け入れ条件・確認例](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)を参考にする。後者は実行例であり、製品が常に強制する保証ではない。

**確認方法:** 失敗→修正→成功の経緯と、未実行の項目が区別されること。既存のGoalは`objective`、状態、理由、日時を持つため、その状態を活用して拡張する。[goals.ts](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/shared/goals.ts:4)

### P1-3: ファイル・選択範囲・画像を新しい依頼へ付ける

**問題・例:** 「この画面と同じ配置にして」と頼む際、新しいスクリーンショットや対象のファイルを添える操作が必要。外部セッションの取り込みだけでは、その場の依頼を十分に表せない。

**最小構成:** composerのファイル選択と貼り付け、`@file`候補、選択範囲を文脈へ追加する操作を設ける。送信前にファイル名・範囲・画像を確認でき、取り外せるようにする。送信データもテキストと添付を分け、失敗した添付を送信済みとして扱わない。

**必要な理由:** 入力の説明負担を減らし、モデルが対象を推測する回数を減らす。初期段階では、既存のファイル一覧と画像表示を利用し、リポジトリ全体の索引は必要ない。参考は[OpenCodeの`@`ファイル参照](https://opencode.ai/docs/tui/)と[Aiderの`/add`・`/read-only`・`/paste`](https://aider.chat/docs/usage/commands.html)。

**確認方法:** 新規画像の追加、ファイルの追加・解除、範囲つき依頼が保存・再開後にも同じ対象として表示されること。インポート済みメディアの表示は維持する。

### P1-4: セッションごとのworktreeと準備状態

**問題・例:** 同じrepositoryで2つのセッションを走らせると、会話が別でも同じファイルを編集する。チームの依存関係が表示されても、作業ディレクトリの衝突は解消しない。

**現状の差分:** SessionRegistryはセッションのcwdにworkspace rootを使い、同じworkspaceの子セッションも共有する。bashから手動でworktreeを作りworkspaceとして追加することは可能だが、セッション作成から準備・再利用・成果確認へつなぐ管理経路はない。[session-registry.ts](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/session-registry.ts:692)

**最小構成:** 「現在のディレクトリで作業」「新しいworktreeで作業」を選び、セッションにpath・基準commit・branchを保存する。準備中、実行可能、準備失敗を表示する。まず作成・再利用・差分確認まで実装し、その後に結果の取り込みと整理を追加する。

**実装上の注意:** `cwd`だけを変えても不十分。Hashlineはworkspace IDから編集先を解決し、ファイルビューアとユーザー端末もworkspace単位で動く。管理対象のworktreeを実行先として登録し、コマンド・編集・表示が同じファイル群を参照する設計が必要。共有して作業するチームは維持し、独立した変更を試す場合に選べる方式にする。

**必要な理由:** 並行実行が増えるほど成果を分ける必要がある。worktreeを作るだけでは依存関係が欠けるため、プロジェクトごとの明示的な準備手順も必要。完全なクラウド環境や自動mergeは不要。参考は[CodexのworktreeとHandoff](https://learn.chatgpt.com/docs/environments/git-worktrees)、[CursorのOS別セットアップ](https://cursor.com/docs/configuration/worktrees)。

**確認方法:** 2つのセッションが異なるpathを使うこと、再開が同じworktreeへ戻ること、準備失敗時に未準備と表示されること。既存のユーザー作業があるworktreeを自動的に上書き・削除しない。

### P2-1: 中断後に「何が実行済みか」を示す

**問題・例:** コマンド送信後、結果を記録する前にプロセスが落ちる。再開して同じコマンドをそのまま繰り返すと、変更や外部処理を二重に実行する可能性がある。

**現状の差分:** Hasilanにも会話の保存・再開がある。起動時には進行中のgoal/swarmをpauseし、結果の記録がないツール呼び出しは画面への投影時に`cancelled`として表示する。未確定の効果を確認して続行する利用者向けの導線を改善する候補。[session-registry.ts](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/session-registry.ts:521)

**最小構成:** 既存の再開状態から、目標、最後の確認済み結果、中断した呼び出し、次に確認すべき項目を短くまとめる。`cancelled`を「ファイルやプロセスへの効果がなかった」と解釈しない。会話の再開、目標の継続、実行中プロセスの再接続を区別する。

**必要な理由:** 履歴を読み戻すだけでは完了状態は確定しない。全ツールの自動再試行は不要で、まず未確定を隠さないことが必要。[Claude Codeの再開仕様](https://code.claude.com/docs/en/sessions)も、中断した呼び出しは実際の効果を確かめてから再実行するよう扱っている。

**確認方法:** コマンド開始直後の終了を再現し、再開時に成功や未実行と誤表示しないこと。goal/swarmで通常のmodel retryを無効にしている設計を、不足や不具合とは扱わない。

### P2-2: 編集できる計画から実行へ進む

**問題・例:** 「設定画面を変更する」という計画を会話で作っても、どの案を採用したか、どの手順を実行中かが後から追いにくい。

**最小構成:** 調査結果、対象ファイル、手順、完了条件を持つ計画を保存し、利用者が編集して「この計画を実行」を選べるようにする。実行は既存の目標・チームへ接続し、計画と実装の状態を二重管理しない。

**現状の差分:** Canvasには編集した設計をファイルへ保存して会話・swarmへの下書きに追加する経路がある。これを活かし、実装手順・確認項目・進行中のRunを結びつける。新しい計画画面を既存Canvasと無関係に追加する必要はない。

**必要な理由:** 計画の存在より、確定した内容を次の作業へ渡せることに価値がある。簡単な修正で毎回計画承認を要求する必要はない。[Cursor Plan Mode](https://cursor.com/docs/agent/plan-mode)の編集→Build→workspace保存を参考にする。

**確認方法:** 編集した計画が実行開始時に渡され、途中再開でも同じ計画・未完了手順に戻れること。

### P2-3: 文脈の内訳を見せ、関連する定義を選ぶ

**問題・例:** 大きなコードベースで、ファイルの全文読み取りを重ねてから既存の型や共通処理に到達する。利用者も、どの添付・指示・実行出力が文脈を使っているか把握しにくい。

**最小構成:** まず、入力に含むファイル、読み取り済み範囲、指示、ツール定義・結果、圧縮の状態を確認できる一覧を出す。その後、ファイル名とsymbolの見取り図を小さいtoken budgetで生成する方式を試す。必要な全文は既存のreadで取得する。

**必要な理由:** 既存の使用量表示に「何を減らせるか」を追加する。Aiderの[repo map](https://aider.chat/docs/repomap.html)を参考にするが、ベクトル検索や全言語対応は初期段階では不要。LSPは定義・参照・編集後診断が必要な言語から任意導入し、CLIで十分な案件では増やさない。[Claude Codeのcode intelligence](https://code.claude.com/docs/en/plugins/code-intelligence)、[OpenCodeのLSP注意事項](https://opencode.ai/docs/lsp/)

**確認方法:** 対象機能の調査に使った読み取り回数・入力token・見落としを、同じモデルと課題で比較する。削減率を先に約束しない。

### P2-4: 起動・検索・実行環境の診断

**問題・例:** 起動はできても、検索コマンドが使えない、workspaceのpathが違う、端末で想定するshellが動かない、という問題が最初の依頼中に発覚する。

**最小構成:** read-onlyのdoctor画面またはCLIで、設定の読込、workspace、Git、検索ツール、shell、必要runtime、provider/modelの設定有無を確認する。成功・失敗・未確認、原因、次に実行すべき手順を表示する。モデルへの有料リクエストを通常の診断に含める必要はない。

**現状の差分:** 既にnode-ptyを起動前に検査し、Linux向けのビルド手順も表示している。設定の「環境」にはChromiumとComputer useの状態・対処手順がある。改善対象は、Web画面を起動できない段階でも呼べる共通診断と、個別診断の集約。既存機能を無効化して起動失敗を隠す提案ではない。

**必要な理由:** 個々のエラーを追加するより、作業開始前に不足をまとめて分かるようにする。[Claude Codeの`doctor`](https://code.claude.com/docs/en/setup)は、セッションを開始せずにインストールと設定を診断する例になる。

**確認方法:** 検索ツール欠落・不正な設定・存在しないworkspaceで、具体的な問題と対処が表示されること。既存の起動検査がある場合は、結果の集約と利用者への導線に絞る。

### P2-5: 読み込んだprompt・拡張コマンドを呼び出せるようにする

**問題・例:** チームで`/review`の指示を用意しても、composerでunknown commandと扱われると、毎回指示を貼り直す必要がある。拡張が読み込まれたことと、その操作が画面から発見・実行できることは別。

**現状の差分:** composerの解析が受け付ける組み込みは`/hyakki`、`/canvas`、`/chat`、`/goal`で、他のコマンドは拒否する。SessionRegistryのprompt呼び出しは`expandPromptTemplates: false`を指定する。一方、resource loaderは既存のprompt、skill、拡張を読み込む。[slash-command.ts](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/client/slash-command.ts:23)、[session-registry.ts](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/session-registry.ts:1070)

**最小構成:** 利用可能なcommand名・説明・取得元をcomposerへ渡し、補完して実行できるようにする。組み込み操作、prompt展開、拡張コマンドを適切な既存経路へ渡す。名前の衝突と存在しないcommandのエラーを明示する。

最初はprompt・skillの展開から接続する。SDK側で会話切り替えなどを行う拡張コマンドは、Web側のセッション状態との整合も必要なため、単純に未知の`/`入力をすべて転送する方式にはしない。

**必要な理由:** 既に読み込む機能を普段の操作につなぐ、小さく着手できる改善になる。参考は[OpenCodeの独自コマンド](https://opencode.ai/docs/commands/)。Hasilanにskillやextensionがないという指摘ではない。

**確認方法:** インストール済みのpromptと拡張コマンドが候補に出て、引数つきで実行できること。組み込みコマンドの既存操作が維持されること。

### P3-1: 使用量をターン・依頼別に追う

**問題・例:** 同じ専門担当へ3回依頼したとき、その担当の合計は分かっても、どの依頼で費用が増えたかは集計画面から追えない。

**現状の差分:** SessionUsageはprovider/model別に入力・出力・cache read/write・料金を集計し、圧縮や補助処理も含める。チーム画面では担当別の表示も既にある。追加するのは同じ担当内のターン・依頼別の粒度。[session-usage.ts](C:/Users/Hasilan/Projects/hasilan-code/packages/web-harness/src/server/session-usage.ts:15)

**最小構成:** 新しく記録する利用量をrun IDと結びつけ、直近ターン・依頼別に確認できるようにする。対応づけられない過去分は未割当として保持する。ツール出力ごとの料金はモデルAPIが直接返す値ではないため、推定を実測として表示しない。Goalの予算機能を復活させる提案は含めない。

**必要な理由:** 次回の依頼内容や担当モデルを調整する際の判断材料になる。Claude Codeも費用の推定とcache等の内訳を表示する。[Manage costs effectively](https://code.claude.com/docs/en/costs) 現在のUsagePanel・AccountUsagePanelを活用して掘り下げる。

**確認方法:** 同一tokenや子セッションを二重集計しないこと。定額プランの残量と推定API費用を混同しないこと。

### P3-2: 完了・失敗・入力待ちをまとめる

**問題・例:** 複数のセッションが動くと、すでにある入力キューとは別に、「どれが終わり、どれが返事を待っているか」を見つける負担が増える。

**現状の差分:** Appは選択していないworkspaceの更新も購読し、実行・失敗・中断の状態を表示する。履歴の検索対象はタイトルとworkspaceのpathで、本文、未読、入力待ちを横断する一覧ではない。セッションメニューは名前変更・削除に限られる。

**最小構成:** まず一覧を完了・失敗・入力待ち・実行中で絞り込み、未読と関連する差分・検証結果に飛べるようにする。その後、必要に応じて本文検索・ピン留め・アーカイブを足す。OS通知は希望する利用者だけに、完了や入力待ちを重複なく知らせる。既存のイベント購読を活用する。

**必要な理由:** 既存の入力キューと組み合わせて、注意を向ける会話を見つけやすくする。Codexの[Notifications](https://learn.chatgpt.com/docs/notifications)では、Activity viewが利用できる画面で未読・実行中・回答待ちを確認できる。Hasilanの一覧・イベント・通知機能に同等の情報がある場合は、その発見性だけを改善対象とする。

**確認方法:** 一度確認した完了を何度も未読通知しないこと。失敗や質問を含むセッションへ直接移動できること。

## 最初の実装単位

1. **変更と検証の出口:** 比較元つきの差分ビューと、実行した確認の記録。作業の成果を短時間で判断できるようにする。
2. **依頼の入口:** 新しいファイル・画像・選択範囲の添付。既存のセッション取り込みと分けて整備する。
3. **並行作業の分離:** sessionとworktreeの対応、準備状態、成果の確認。既存のチーム実行を基盤にする。
4. **長時間運用:** 中断状態の表示、計画からの再開、文脈と使用量の説明を追加する。

repo mapやLSPを先に広く導入しても、差分確認や未検証の見分けが難しい状態は残る。まず利用者が成果を判断できる画面を作り、その後に調査効率の改善を同じ課題で測る。

## 比較から直接採用しないもの

- 製品全体の順位、モデル能力の優劣、未測定の速度・費用削減率。
- Aiderの自動コミットをそのまま導入すること。Hasilanでは、変更単位を追えるsnapshotや差分でも目的を満たせる。[Git integration](https://aider.chat/docs/git.html)
- すべての変更に計画承認・全テスト・LSP起動を必須にすること。案件ごとの必要性と既存のリポジトリ手順を優先する。
- 既存の目標、チームグラフ、入力キュー、メディア取り込み、hashline編集、使用量表示を「競合にはあるがHasilanにはない」と扱うこと。
