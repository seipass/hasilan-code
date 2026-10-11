# Hasilan Code

Piのローカル単一ユーザー用Web入口。上流CLI/TUIとは独立したworkspaceです。基準コミット: `c5f5b3282d5e4203c085e59837ba17aeaf2829b5`。oh-my-piのソース、prompt、fixture、native binaryは使用しません。

## 起動

Node.js 22.19以上が必要です。リポジトリrootで実行します。

```sh
npm install --ignore-scripts
npm rebuild node-pty --ignore-scripts=false --foreground-scripts
npm run build
npx playwright install chromium
npm run web
```

引数なしで起動できます。起動ディレクトリを最初のワークスペースとして登録し、入力欄上に作業先のパスを表示します。別のディレクトリで始める場合だけ `--cwd <workspace-directory>` を指定します。サイドバーの「会話」右の「＋」から、ホストOSのネイティブフォルダー選択ダイアログで追加できます。Windowsではエクスプローラー形式のフォルダー選択を開きます。キャンセルではワークスペースも下書きも変更しません。

既定は `127.0.0.1:3080`。`--port 0` はOS割当です。port衝突や明示指定した無効なcwdで終了し、別のport/cwdへ切り替えません。ブラウザーは自動起動しません。表示された認証付き起動URLを手動で開いてください。URLはHttpOnly/SameSite=Strict cookieへ交換され、URLからtokenを除去します。起動URLは秘密として扱ってください。`--no-open`の指定は不要です。

Windowsのnode-pty native installが失敗する場合、Python 3.11/3.12、Visual Studio 2022 C++ Build Tools、Windows SDK、Spectre対応libraryを用意してrebuildします。pipeへのfallbackはありません。
ネイティブフォルダー選択はホストのデスクトップ上に表示します。WindowsはPowerShell/WinForms、macOSは標準のフォルダー選択、Linuxはzenityまたはkdialogを使用します。SSHやデスクトップ環境のないホストではダイアログを利用できません。同時に開くダイアログは一つです。

## 会話を始める

- 「新しい会話」で下書きを入力し、送信時に会話を作成します。未送信の入力欄は会話領域の中央に置き、入力欄の上には左にアイコンと Hasilan Code、右に作業先のワークスペースのパスを表示します。モデル未設定なら下書きを保持して入力欄のモデル選択を開きます。通常のEnterは改行、Ctrl/Cmd + Enterは送信です。
- モデルは入力欄のボタンから選びます。未接続なら「ChatGPTでログイン」から先にアカウント認証できます。ログイン後は一覧を更新し、モデルを選びます。モデルを先に選んだ場合は、同じパネルでアカウント認証またはAPIキー接続を行い、成功後にそのモデルを選択します。検索・プロバイダー絞り込み、↑↓・Enterに対応します。選択後は下書きを保持して入力欄へ戻ります。Escape・閉じるボタン・パネル外のクリックで閉じます。設定の「モデル」タブでもアカウント認証と既定モデルを設定できます。一覧の認証状態は接続設定の有無であり、API疎通を保証しません。
- 入力欄の下に選択中モデルのコンテキスト使用量と上限を表示します。使用量はPi SDKによる推定値で、未実行の会話・ホスト再起動直後などSDKがまだ計測できない場合は「—」です。上限のみ表示できる場合もあります。
- 新規会話のモデルは、明示選択 → Webの既定 → Hasilan Codeのプロジェクト・グローバル設定の既定 → 認証設定のある利用可能モデル、の順で決まります。Piの既定は引き継ぎません。既存会話のモデルは既定変更で書き換えません。
- サイドバーの「会話」はワークスペース別のアコーディオンで、その下に各セッションを表示します。ワークスペース名で作業対象を選び、会話を選ぶとその履歴を開きます。会話の最新の指示を見出しにして表示します。下書きと表示中の会話・ワークスペースはブラウザーのlocalStorageに保存します。ブラウザーの保存機能が使えない場合も入力・送信は可能ですが、再読み込み後の下書き復元はできません。
- ファイル・チーム・ツール・端末は「詳細」のタブで切り替えます。「詳細」ボタンでパネルを開閉し、左端をドラッグすると幅を調整できます。ファイル画面は左に開いたファイルのタブと読み取り専用プレビュー、右にファイルツリーを表示します。境界をドラッグしてツリー幅を調整でき、各領域は独立してスクロールします。狭い画面ではプレビューを300px、ツリーを180px以上に保ち、横スクロールで閲覧します。タブは詳細の表示切り替えでも保持し、作業フォルダーの変更でリセットします。タブ選択やパネル再表示で外部変更を取得します。
- スクロール領域には細い、画面の配色に合わせたスクロールバーを使います。操作中は見やすくし、端末の文字表示領域のスクロール幅は変更しません。
- ファイル・端末のタブは中クリックでも閉じられ、ドラッグで順序を変更できます。順序変更で表示中のファイルやPTYは切り替えません。タブ順序はブラウザー内の表示状態です。
- コードファイルは拡張子に応じてシンタックスハイライトします。MarkdownはGFM対応のプレビューを既定にし、「ソース」で行番号付き表示へ切り替えます。プレビューは全ページを取得してから描画し、取得途中のファイル変更や省略された長い行では不完全な文書を描画せずエラーにします。行リンクはソース表示で該当行を開きます。raw HTMLは実行しません。
- 「端末」タブは会話とは独立したPTYです。「＋」で作成し、端末内のタブで切り替えます。別の詳細タブへの切り替えや詳細パネルの非表示中もPTYは継続し、非表示の端末も出力・終了状態を受け取ります。「×」または中クリックはPTYを終了してタブを閉じます。シェルのキー入力は会話画面のショートカットへ伝播せず、バックグラウンドの出力は入力欄のフォーカスを移しません。
- パネルとファイルツリーのサイズ境界はキーボードでも操作できます。矢印キーで16px、Shift + 矢印キーで48pxずつ調整し、Home/Endで最小・最大にします。ツール呼び出しは会話内にも折りたたんで表示し、パスを選ぶとファイルを開きます。
- 実行中の追加指示は「完了後に続ける」または「実行中に指示」で送信できます。空の入力欄では送信ボタンが停止ボタンになります。
- 会話の新着、モデル選択、設定、詳細・端末パネルには短い状態遷移アニメーションがあります。OSの「視覚効果を減らす」設定（`prefers-reduced-motion`）ではアニメーションとスムーズスクロールを無効化します。ストリーミング中の本文やパネルのドラッグ操作には移動アニメーションを適用しません。
- チーム詳細は担当・状態・現在の作業を先に表示し、過去の実行と識別子は必要時だけ開けます。会話内のAI応答には重複する名前ラベルを付けません。
- 閉じた「思考」には推論の先頭を一行で表示し、開くと全文を読めます。通常テキストは [Gen Interface JP](https://gen.typesetting.jp/)（npm版0.8.0）、コード・ファイルソース・端末は [UDEV Gothic](https://github.com/yuru7/udev-gothic)（v2.2.0）を使用します。両書体はホストから配信し、外部CDNは必要ありません。UDEV Gothicのライセンスは `public/fonts/UDEVGothic-LICENSE.txt` です。

画面・タブ・起動ログの名称は `Hasilan Code`。npmパッケージ名は `hasilan-code`。ロゴとfaviconは `public/icon.svg` を共有し、配色は `src/client/styles.css` の指定パレットを使います。

## 設定と永続化

Piとは設定・認証・会話履歴を分離します。既定の保存先は `~/.hasilan-code/agent`。`HASILAN_CODE_AGENT_DIR` に絶対パス（先頭の `~` も可）を指定すると変更できます。Pi用の `PI_CODING_AGENT_DIR` は参照しません。

| 保存内容 | 専用ディレクトリ内のパス |
|---|---|
| アカウント認証・保存済みLLM認証 | `auth.json` |
| モデル定義・モデルカタログキャッシュ | `models.json` / `models-store.json` |
| SDK設定・OAuth用のインストールID | `settings.json` |
| Webの既定モデル・検索・チーム設定 | `web-harness/settings.json` |
| Brave/Tavilyキー | `web-harness/credentials.json` |
| ワークスペース・セッション・チーム・実行状態 | `web-harness/state.json` |
| 会話履歴（Pi SDKのJSONL形式） | `web-harness/sessions/` |

プロジェクト設定は `<workspace>/.hasilan-code/settings.json`。拡張・スキル・プロンプト・テーマ・`SYSTEM.md`・`APPEND_SYSTEM.md` の自動探索も `.hasilan-code` を使います。Piの `~/.pi/agent` やプロジェクトの `.pi` は自動で読み込み・変更しません。以前Pi側に保存した認証・Web設定・履歴は移行せず、そのまま残します。共通の `AGENTS.md` と `.agents` のスキル、およびプロバイダーの環境変数は引き続き利用できます。

アカウント認証は既存Pi SDKのOAuthを使い、専用の `auth.json` に保存します。認証情報の更新もSDKが管理します。ログインは明示クリックで開始し、表示したリンクをユーザーが開きます。デバイスコード、選択肢、コード・コールバックURL入力に対応し、キャンセル・画面を閉じる操作・ホスト終了で待機を中止します。同時ログインは一つです。認証成功後はモデル一覧を更新します。モデル選択パネル・設定画面で入力したLLM APIキーは現在プロセス専用で、再起動すると失われます。キー・トークンの値はGETやWebSocketへ返しません。

会話のauthorityはSDKのJSONLです。再起動時に実行中runは`interrupted`となり、自動再実行しません。未消費入力も自動再送しません。空sessionの未作成JSONLは正常ですが、materialized会話のJSONLが消失した場合はmissingとして扱います。

## 実行モデル

session選択は表示だけを切り替えます。非選択sessionと子agentの実行は継続します。teamのconcurrencyはrootを含むteamごとのlimitです。`team.wait`中はpermitを返し、結果を返す前に再取得します。子は独立会話ですが同じworkspaceのlive fileを共有します。

ユーザーterminalはworkspace所属の実PTYで、agent bashと別物です。session切替、panel非表示、接続切れ、agent Stopではkillしません。明示Closeとhost終了でkillします。再接続snapshotはheadless xtermの画面（scrollback 2000行）で、全文logではありません。操作権は一接続だけで、引き継ぎは明示操作です。

## ファイルとHashline

viewerはread-onlyで、agentの既読行に影響しません。外部editor/PTYの変更はRefreshで取得します。アプリ内commitはfiles_changed通知で再取得します。

Hashlineは独立実装です。全文由来の`[PATH#TAG]`と`LINE:TEXT`を使います。編集は最後にagentが読んだsnapshotと既読行に限定し、raw revisionが変化した場合は再readが必要です。stale remappingはありません。`N*`はMarkdown headingとTS/JS構文blockのみで、他言語は明示rangeを使用します。BOM/元の改行形式を維持し、mixed EOLは編集を拒否します。`write`は新規file専用です。

workspace外path、ADS、drive-relative、外部symlink/junctionはファイルサービスで拒否します。ただしこれはsandboxではありません。agent bash、ユーザーPTY、ブラウザーは起動ユーザーの権限で実行されます。multi-file commitも外部editorに対する原子的transactionではなく、I/O失敗時はfile別の適用結果を返します。

## 検証

```sh
npm run test --workspace=hasilan-code
npm run check
```

実LLMおよびBrave/Tavily smokeには有効な各credentialが必要です。未設定時は設定errorを表示し、明示選択したproviderの実行失敗時に別providerや偽browserへfallbackしません。
