# デスクトップ版

デスクトップ版 Hasilan Code は、Web 版と同じ画面、バックエンドサーバー、AI 実行コアを採用した Electron アプリケーションです。ウィンドウ管理および内部サーバープロセスのライフサイクルを Electron が統括します。

## インストールと起動

Windows 環境では、[GitHub Releases](https://github.com/seipass/hasilan-code/releases) から `Hasilan-Code-<version>-win-x64.exe` をダウンロードしてインストールします。インストール完了後はスタートメニューから起動できます（Node.js の個別導入は不要です）。

### ウィンドウと操作体系

- **タイトル・トレイ表示**: ウィンドウタイトルおよびシステムトレイのツールチップには、Web 画面と同様に処理中・完了のタスク件数と会話名が表示されます。macOS の Dock や Windows のタスクバーアイコンには未完了件数のバッジが表示されます。
- **ウィンドウ操作**: アプリ上部のボタンから最小化・最大化・復元・クローズが行えます（macOS は OS 標準のボタンを使用）。上部の空き領域をドラッグしてウィンドウを移動できます。
- **ワークスペース選択**: 作業フォルダーの選択には OS 標準のネイティブダイアログが使用されます。
- **バックグラウンド動作**: ウィンドウの閉じるボタン（×）を押すと画面のみが非表示になり、バックグラウンド処理はシステムトレイ常駐で継続します。トレイアイコンからいつでも再表示可能です（トレイ非対応環境では終了動作となります）。
- **完全終了**: アプリケーションメニューまたはトレイメニューの「終了」を選択すると、内部サーバーを含めて停止します。AI タスクの実行中、未送信の入力、または動作中のターミナルが存在する場合は、停止前に確認ダイアログが表示されます。
- **サーバー再起動**: トレイメニューの「表示 → サーバーを再起動」から内部サーバーを再起動できます。起動失敗時は画面上の「もう一度起動」ボタンで再試行可能です。
- **アップデート確認**: 「Hasilan Code → 更新を確認」から最新バージョンの検出、ダウンロード、適用が可能です。作業中に更新を適用する場合は終了確認が行われます。

## データの保存先と共有

認証情報、ワークスペース設定、会話セッション履歴は、Web 版と共通の `~/.hasilan-code/agent/` に保存されます（環境変数 `HASILAN_CODE_AGENT_DIR` で任意の絶対パスに変更可能）。

> [!IMPORTANT]
> 同一のデータ領域を使用するサーバープロセスは同時に 1 つのみ起動できます。Web 版が起動している場合は、終了してからデスクトップ版を起動してください。前回プロセスが異常終了した場合、次回起動時に自動でロックの回復を試みます。他のプロセスが実行中の場合は対象の PID が表示されます。

- **Electron 固有データ**: ウィンドウ位置やブラウザーキャッシュ領域は、Electron の標準ユーザーデータディレクトリに保存されます（`HASILAN_CODE_DESKTOP_DATA_DIR` を指定することで分離可能）。アンインストール時にユーザーデータが自動削除されることはありません。
- **UI 設定の自動同期**: 背景画像、ウィジェット（配置・地域・タイマー・メモ）、新規会話時のモデル・Thinking 強度、キーバインド、最後に開いたセッション、入力中のドラフト・添付、パネル・ファイルタブの分割配置、メディアの音量・再生位置などは、共通設定ディレクトリ（`~/.hasilan-code/agent/web-harness/ui-preferences/`）に保存されます。同一サーバーに接続する画面間で変更がリアルタイムに同期されます。
- **外部依存の要件**: [Computer Use](computer-use.md) に必要な Python 環境や、ブラウザーツールに必要な Chromium は Web 版と同じ要件となります（デスクトップ版のインストーラーには同梱されていません）。

## 開発手順

リポジトリのルートディレクトリから実行します。

```sh
npm ci --ignore-scripts
# 新規チェックアウト等で Pi SDK が未ビルドの場合
npm run build:hasilan
npm run build:desktop
npm run desktop
```

`build:desktop` は共有サーバー、Web UI、Electron シェルをビルドします（Pi SDK のモデルカタログは変更しません）。Electron バイナリは固定バージョンおよび npm の SHA-256 チェックサムを用いて取得され、`apps/desktop/.runtime/electron/` に展開されます。

### テスト・検証

以下のコマンドで検証を実行します（実プロバイダー API は呼び出しません）。

```sh
npm run check
node --test apps/desktop/test/host.test.ts
npm run smoke:desktop
```

`smoke:desktop` は一時的な分離データ領域で Electron を起動し、認証付き UI、フォルダー選択 IPC、実際の PTY および WebSocket 通信、ウィンドウ閉鎖後のサーバー継続性、終了キャンセル処理、終了時のサーバー停止を検証します。通常のセッションデータには影響しません。

## パッケージ作成

```sh
npm run build:desktop
npm run pack:desktop -- --dir
npm run smoke:desktop -- --executable ".artifacts/desktop/win-unpacked/Hasilan Code.exe"
npm run pack:desktop -- --web-package .artifacts/desktop/web/hasilan-code-0.2.0.tgz
```

生成された成果物は `.artifacts/desktop/` に出力されます。`--dir` を指定すると展開済みディレクトリアプリのみを生成します（指定しない場合は Windows 向け NSIS インストーラーを生成）。

Linux 環境でビルドする場合は、C++ コンパイラ、make、Python を用意した上で、`pack:desktop -- --build-pty` を実行して `node-pty` のビルドを明示的に許可してください。パッケージ生成時に Electron の実行時ランタイム環境で `node-pty` および TypeScript の読み込み検証が行われます。

配布前に各対象 OS でスモークテストを通過させてください。なお、署名用資格情報が設定されていないローカル環境でのビルドは未署名パッケージとなります。

## アップデートの配信仕様

アップデート取得元は `https://github.com/seipass/hasilan-code/releases/latest/download/` です。インストーラーと対応する `.blockmap`、`latest.yml` などの更新メタデータを、対象バージョンの GitHub Release へまとめて公開します。UI、サーバー、Electron は 1 つの統合バージョンとしてアトミックに更新されます。

`hasilan-v*` タグのリリースでは、検証済みの Web 配布物を Windows デスクトップ版に同梱し、インストーラーと更新メタデータを同一の GitHub Release に公開します。公開済みリリースの成果物は上書きせず、修正が必要な場合は常に次期バージョンとして公開してください。
