# Electronデスクトップ版

Web版のReact UI・HTTP/WebSocket API・AI実行処理を共有し、Electronはウィンドウと共有サーバーの起動・終了を管理します。ブラウザーで使うWeb版も継続して利用できます。

## 利用

Windowsの配布物は`Hasilan-Code-<version>-win-x64.exe`です。インストール後はスタートメニューから起動します。Node.jsの別途インストールは不要です。Electron内蔵のNodeランタイムで同梱サーバーを動かします。

- アプリ上部にウィンドウ操作を配置します。Windows・LinuxではVS Codeの実装を参考にした最小化・最大化／復元・閉じるを右側に配置し、macOSは標準のウィンドウボタンを使用します。上部の空き領域をドラッグしてウィンドウを移動できます。
- 作業フォルダーの選択はOSのダイアログで行います。
- ウィンドウの閉じるボタンは画面を隠します。処理は通知領域で継続し、アイコンから再表示できます。通知領域を使えない環境では終了操作になります。
- メニューまたは通知領域の「終了」でサーバーも停止します。AIの作業・未処理の入力・稼働中の端末があれば、停止前に確認します。
- 通知領域の「表示 → サーバーを再起動」は処理を停止する確認を表示します。起動失敗時は画面の「もう一度起動」で再試行できます。
- 「Hasilan Code → 更新を確認」で更新を確認します。ダウンロードと適用はユーザーが選びます。作業中の更新にも終了確認があり、通常終了だけで更新を勝手に適用しません。

認証・ワークスペース・セッションはWeb版と同じ`~/.hasilan-code/agent/`を使用します。`HASILAN_CODE_AGENT_DIR`で別の絶対パスも指定できます。同じデータを使うサーバーは一つだけ起動できます。Web版を終了してからデスクトップ版を起動してください。所有プロセスが異常終了した場合は次回起動時にロックを回復します。稼働中と確認できた場合は所有プロセスのPIDを表示します。旧版が残した所有情報のないロックだけは、最大1分の確認待ちになります。ロック未対応の古いWeb版も先に終了してください。

ウィンドウ位置とブラウザーの保存領域はElectronのユーザーデータディレクトリに保存します。`HASILAN_CODE_DESKTOP_DATA_DIR`を指定すると、この保存先も分離できます。アンインストールでは利用者データを削除しません。

背景画像、ウィジェット（配置・地域・タイマー・メモ）、新規会話のモデル・Thinking、キー割り当て、最後に開いた会話、入力中の文章・添付、パネルとファイルタブの配置、音量・ミュート・再生位置は、共通の`~/.hasilan-code/agent/web-harness/ui-preferences/`に保存します。同じサーバーに接続した画面間では変更を同期します。音楽は自動再生せず、サーバー終了後の端末を勝手に再作成しません。

既存のブラウザー内設定は、更新後に元のWeb版URLを一度開くと共通保存先へ移行します。移行では共通保存済みの値を上書きしません。Web・デスクトップで`HASILAN_CODE_AGENT_DIR`が異なる場合は共有しません。Electronのポートが次回起動で変わっても、共通設定は復元されます。

Pythonを使用するComputer Use、Chromiumを使用するブラウザーツールなどの外部ツールはWeb版と同じ要件です。デスクトップ版にPythonやPlaywrightのブラウザーは同梱していません。

## 開発

リポジトリのルートから実行します。

```sh
npm ci --ignore-scripts
# クリーンなcheckoutでPi SDKが未ビルドの場合
npm run build:hasilan
npm run build:desktop
npm run desktop
```

`build:desktop`は共有サーバー・Web UI・Electronシェルをビルドします。Pi SDKのモデルカタログは変更しません。Electronは固定バージョンとnpmに含まれるSHA-256チェックサムを使って取得し、`apps/desktop/.runtime/electron/`に展開します。npmのインストールスクリプトを一括で有効にする必要はありません。

検証は次のコマンドです。実際のプロバイダーAPIは呼びません。

```sh
npm run check
node --test apps/desktop/test/host.test.ts
npm run smoke:desktop
```

`smoke:desktop`は一時的な専用データ領域でElectronを起動します。認証付きUI、フォルダー選択のIPC、実際のPTYとWebSocket、閉じた後のサーバー継続、終了キャンセル、終了時のサーバー停止を確認します。通常の認証情報・セッションには書き込みません。

## パッケージ

```sh
npm run build:desktop
npm run pack:desktop -- --dir
npm run smoke:desktop -- --executable ".artifacts/desktop/win-unpacked/Hasilan Code.exe"
npm run pack:desktop -- --web-package .artifacts/desktop/web/hasilan-code-0.1.7.tgz
```

成果物は`.artifacts/desktop/`です。`--dir`は展開済みアプリだけを作成します。指定がなければWindowsではNSISインストーラーを作ります。Web配布物のバージョンをElectron側にも設定し、同じ配布物のUIとSDKをまとめて同梱します。`--web-package`を省略すると現在のビルド済みWeb版を、レビュー済みルートlockfileの依存関係で再パッケージします。

インストーラーは同じOS・CPUで作ります。macOSはdmg/zip、LinuxはAppImageの設定もありますが、現在の実機確認はWindows x64です。LinuxではC++コンパイラー・make・Pythonを用意し、`pack:desktop -- --build-pty`でレビュー済みnode-ptyのビルドを明示的に許可してください。パッケージ作成時にElectronの実ランタイムでnode-ptyとTypeScriptの読み込みを検証します。

公開前に各対象OSで配布物のスモークを通してください。Windowsのコード署名・macOSの署名と公証はelectron-builder標準の設定を使います。資格情報のないローカルビルドは未署名です。

## 更新配布

更新元は`https://github.com/seipass/hasilan-code/releases/latest/download/`です。インストーラーと対応する`.blockmap`、`latest.yml`などの更新メタデータを、同じ未公開バージョンのGitHub Releaseへまとめて公開します。macOSでは更新用zipも必要です。UI・サーバー・Electronは一つのバージョンとして更新します。

`hasilan-v*` タグのリリースでは、検証済みの Web 配布物を Windows デスクトップ版に同梱し、インストーラーと更新メタデータを同じ GitHub Release に公開します。デスクトップの更新メタデータがまだ公開されていない場合は、更新確認で取得できない旨を表示します。既に公開済みのバージョンの成果物は置き換えず、次のバージョンとして公開してください。
