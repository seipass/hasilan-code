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

引数なしで起動できます。起動ディレクトリを最初のワークスペースとして登録し、初回画面でも入力できます。別のディレクトリで始める場合だけ `--cwd <workspace-directory>` を指定します。サイドバーの「会話」右の「＋」から、ホストOSのネイティブフォルダー選択ダイアログで追加できます。キャンセルではワークスペースも下書きも変更しません。

既定は `127.0.0.1:3080`。`--port 0` はOS割当です。port衝突や明示指定した無効なcwdで終了し、別のport/cwdへ切り替えません。ブラウザーは自動起動しません。表示された認証付き起動URLを手動で開いてください。URLはHttpOnly/SameSite=Strict cookieへ交換され、URLからtokenを除去します。起動URLは秘密として扱ってください。`--no-open`の指定は不要です。

Windowsのnode-pty native installが失敗する場合、Python 3.11/3.12、Visual Studio 2022 C++ Build Tools、Windows SDK、Spectre対応libraryを用意してrebuildします。pipeへのfallbackはありません。
ネイティブフォルダー選択はホストのデスクトップ上に表示します。WindowsはPowerShell/WinForms、macOSは標準のフォルダー選択、Linuxはzenityまたはkdialogを使用します。SSHやデスクトップ環境のないホストではダイアログを利用できません。同時に開くダイアログは一つです。

## 会話を始める

- 「新しい会話」で下書きを入力し、送信時に会話を作成します。モデル未設定なら下書きを保持して設定画面を開きます。通常のEnterは改行、Ctrl/Cmd + Enterは送信です。
- モデルは入力欄のボタンから検索・プロバイダー絞り込みで選びます。設定の「モデル」タブでは接続先、APIキー、既定モデルをまとめて設定できます。一覧の認証状態は接続設定の有無であり、キーの有効性やAPI疎通を保証しません。
- 新規会話のモデルは、明示選択 → Webの既定 → 作業フォルダーを含むPiの既定 → 認証設定のある利用可能モデル、の順で決まります。既存会話のモデルは既定変更で書き換えません。
- サイドバーの「会話」はワークスペース別のアコーディオンで、その下に各セッションを表示します。ワークスペース名で作業対象を選び、会話を選ぶとその履歴を開きます。会話の最新の指示を見出しにして表示します。下書きと表示中の会話・ワークスペースはブラウザーのlocalStorageに保存します。ブラウザーの保存機能が使えない場合も入力・送信は可能ですが、再読み込み後の下書き復元はできません。
- ファイル・チーム・ツールの詳細は必要時に開きます。「詳細」ボタンで表示を切り替え、パネル左端をドラッグすると幅を調整できます。ファイル画面は左に開いたファイルのタブと読み取り専用プレビュー、右にファイルツリーを表示します。境界をドラッグしてツリー幅を調整でき、各領域は独立してスクロールします。狭い画面ではプレビューを300px、ツリーを180px以上に保ち、横スクロールで閲覧します。タブは詳細の表示切り替えでも保持し、作業フォルダーの変更でリセットします。タブ選択やパネル再表示で外部変更を取得します。
- ファイル・端末のタブは中クリックでも閉じられ、ドラッグで順序を変更できます。順序変更で表示中のファイルやPTYは切り替えません。タブ順序はブラウザー内の表示状態です。
- コードファイルは拡張子に応じてシンタックスハイライトします。MarkdownはGFM対応のプレビューを既定にし、「ソース」で行番号付き表示へ切り替えます。プレビューは全ページを取得してから描画し、取得途中のファイル変更や省略された長い行では不完全な文書を描画せずエラーにします。行リンクはソース表示で該当行を開きます。raw HTMLは実行しません。
- 「端末」は会話とは独立したPTYです。「＋」で作成し、タブで切り替えます。パネル上端をドラッグすると高さを調整できます。非表示タブも出力・終了状態を受け取り、パネルを隠してもPTYは継続します。「×」または中クリックはPTYを終了してタブを閉じます。シェルのキー入力は会話画面のショートカットへ伝播せず、バックグラウンドの出力は入力欄のフォーカスを移しません。
- パネルとファイルツリーのサイズ境界はキーボードでも操作できます。矢印キーで16px、Shift + 矢印キーで48pxずつ調整し、Home/Endで最小・最大にします。ツール呼び出しは会話内にも折りたたんで表示し、パスを選ぶとファイルを開きます。
- 実行中の追加指示は「完了後に続ける」または「実行中に指示」で送信できます。空の入力欄では送信ボタンが停止ボタンになります。

画面・タブ・起動ログの名称は `Hasilan Code`。npmパッケージ名は `hasilan-code`。ロゴとfaviconは `public/icon.svg` を共有し、配色は `src/client/styles.css` の指定パレットを使います。

## 設定と永続化

LLMはPiの既存`auth.json`/`models.json`と環境変数を利用します。設定画面で入力したLLM API keyは現在プロセス専用で、再起動すると失われます。Brave/Tavily keyはPi agent directory内`web-harness/credentials.json`へ、設定は`settings.json`へ別保存します。keyの値はGETやWebSocketへ返しません。

会話のauthorityはPiのJSONLです。`web-harness/state.json`はworkspace、session descriptor、team/run、未消費入力を保存します。再起動時に実行中runは`interrupted`となり、自動再実行しません。未消費入力も自動再送しません。空sessionの未作成JSONLは正常ですが、materialized会話のJSONLが消失した場合はmissingとして扱います。

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
