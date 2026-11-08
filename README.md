<div align="center">
  <img src="packages/web-harness/public/icon.svg" alt="Hasilan Code" width="88" height="88" />

  # Hasilan Code

  Hasilan Code は Pi を基盤にした、ローカルの単一ユーザー向け AI コーディング環境です。
  AI との会話、複数の AI による作業分担、設計画面、ファイル閲覧、端末操作をひとつの画面で行えます。

  [使い始める](#クイックスタート) · [主な機能](#主な機能) · [詳しい使い方](packages/web-harness/README.md)
</div>

> [!IMPORTANT]
> Hasilan Code はローカルの単一ユーザー向けです。AI によるコマンド実行、端末操作、ブラウザー操作には、アプリケーションを起動したユーザーの権限が使われます。作業を隔離する仕組みはありません。信頼できる環境で使用してください。

## 主な機能

| 機能 | 概要 |
| --- | --- |
| AI チャット | 任意のモデルと推論強度（Thinking）を選択し、対話しながらツール実行結果を確認できます。 |
| チーム実行 | 複数の AI に作業を分担させ、各担当エージェントの進捗や関係性を確認できます。 |
| 百鬼夜行 | ワークスペースに常駐する自律型 AI チームです。親 AI が目標を管理し、専門担当エージェントが相互の相談・引き継ぎや補助エージェントへの委譲を行いながら作業を進めます。 |
| Goal | 設定した目標に向けて AI が自律的に作業を継続します。達成・入力待ち・停止などの状態を把握できます。 |
| Canvas | アイデアや構成要素をノードと接続線で図示・整理し、AI への指示コンテキストとして活用できます。 |
| 開発用パネル | ファイルの閲覧・編集、Markdown プレビュー、動画再生、エディタ・端末の画面分割に対応しています。 |
| ブラウザー・Web 検索 | AI によるヘッドレスブラウザー操作や、外部検索サービスを通じた情報収集が可能です。 |

会話履歴、作業フォルダー、チーム状態はすべてローカル環境に保存されます。設定や履歴データは、本家 Pi とは完全に分離された領域に保持されます。

Web 版と同じ画面およびデータを共有して利用できる [Electron デスクトップ版](docs/desktop.md) も提供しています。

## クイックスタート

### 前提環境

- 利用する AI モデルの認証情報または API キー（初回起動時に設定画面から入力）
- Web 版：Node.js 22.19.0 以上（Windows デスクトップ版には不要）
- ソースからビルドする場合：Git。Linux で `node-pty` をビルドする場合は C++ コンパイラ（g++）、make、Python が必要です。

### インストール方法の選択

目的に応じた方法を選択してください。Web 版はインストール後に `hasilan-code` コマンドで起動し、Windows デスクトップ版はスタートメニューから起動できます。

1. **[npm による導入・更新](#npm-から導入更新)**：Node.js 環境が整っている場合の標準的な方法。
2. **[GitHub Releases からの導入](#github-releases-から導入)**：インストーラーや配布スクリプトを利用する方法。
3. **[AI エージェントに依頼](#ai-にインストールを依頼)**：ターミナル操作が可能な AI に導入手順を任せる方法。

※ 配布パッケージを利用する場合、Git は不要です（Linux 環境で端末機能を利用する際のみビルドツールが必要です）。

### 初回起動と対話の流れ

1. 設定画面（「プロバイダー」タブ）を開き、利用する AI モデルの認証情報を設定します。
2. チャット入力欄でモデルと推論強度（Thinking）を選択します。
3. 作業フォルダー（ワークスペース）を確認し、AI にプロンプトを送信します。

入力欄では **Enter** で送信、**Shift + Enter** で改行できます。AI の実行中は **Enter** で割り込み指示、**Ctrl + Enter**（macOS は **Cmd + Enter**）で完了後の予約指示を送信できます。

Web 版で特定の作業フォルダーを指定して起動する場合は、`--cwd` オプションを使用します。

```sh
hasilan-code --cwd /path/to/project
```

ソースコードから起動する場合は `npm run web -- --cwd /path/to/project` を実行します。

リッスンするポート番号は `--port` で変更できます（例: `--port 0` を指定すると OS が空きポートを自動割り当てします）。

Windows 環境で `node-pty` のビルドに失敗した場合の対処法や、GUI フォルダー選択ダイアログが利用できない環境での操作手順については、[詳しい起動手順](packages/web-harness/README.md#起動) を参照してください。

## 導入・更新

ビルド済み配布物には、本プロジェクト専用にカスタマイズされた Pi SDK および実行時依存関係がすべて同梱されています。上流の公式 npm パッケージへ差し替えて動作させる構成ではありません。

### npm から導入・更新

Node.js 22.19.0 以上が必要です。Linux 環境をご利用の場合は、事前に [Linux での事前準備](#linux-での事前準備) をご確認ください。

新規導入および更新手順は共通です。更新時は起動中の Hasilan Code を終了してから実行してください（Linux では `setup` コマンドに `--build-pty` を付与します）。

```sh
npm install --global --ignore-scripts hasilan-code
hasilan-code setup
hasilan-code --version
hasilan-code
```

`setup` は導入後の初期セットアップ用コマンドです。ブラウザー操作機能に必要な Chromium の確認・取得や、macOS における端末用ヘルパーの実行権限設定を行います。すでに互換性のある Chromium がシステム上に存在する場合はそれを再利用します。ブラウザー操作機能が不要な場合は、`hasilan-code setup --skip-browser` で取得をスキップできます。

更新を実行すると、npm の `latest` バージョンが適用されます。認証情報・会話履歴・チーム状態は配布物とは独立した `~/.hasilan-code/agent` 配下に永続化されているため、更新によってデータが消失することはありません。バージョンを固定して導入したい場合は、`hasilan-code@0.2.0` のようにバージョンを明示してください。

起動コマンド `hasilan-code` を実行すると、既定で `127.0.0.1:3080` にローカルサーバーが起動し、コンソールにワンタイム認証トークン付きの起動用 URL が出力されます。ブラウザーは自動起動しないため、出力された URL を手動で開いてください。認証付き URL は第三者に漏洩しないよう安全に取り扱ってください。

#### Linux での事前準備

Linux 向けの端末制御ネイティブモジュール（`node-pty`）はパッケージに同梱されていないため、初回起動前にローカルビルドが必要です。C++ コンパイラ、make、Python を用意した上で、`hasilan-code setup --build-pty` を実行してください。

Debian / Ubuntu での準備例:

```sh
sudo apt-get update
sudo apt-get install -y build-essential python3
npm install --global --ignore-scripts hasilan-code
hasilan-code setup --build-pty
```

その他のディストリビューションでは、以下のパッケージをインストールしてください。

| ディストリビューション | パッケージインストール例 |
| --- | --- |
| Fedora / RHEL | `sudo dnf install -y gcc-c++ make python3` |
| Arch Linux | `sudo pacman -S --needed base-devel python` |

ブラウザー操作機能に必要な OS 共有ライブラリは、Chromium 本体とは別にシステムへ導入する必要があります。Playwright に対応した Linux 環境では、以下のコマンドで一括インストールできます（管理者権限が必要となる場合があります）。

```sh
node "$(npm root -g)/hasilan-code/node_modules/playwright/cli.js" install-deps chromium
```

対応ディストリビューションや詳細な依存関係は [Playwright の公式要件](https://playwright.dev/docs/browsers#install-system-dependencies) を参照してください（※ Alpine Linux 等の musl 環境はブラウザー機能のサポート対象外です）。ブラウザー機能を使わない場合は、セットアップ時に `--skip-browser` を指定することで、これらのライブラリのインストールを省略できます。

準備完了後、バージョン確認および起動を行います。

```sh
hasilan-code --version
hasilan-code
```

### GitHub Releases から導入

- **Windows デスクトップ版**: [GitHub Releases](https://github.com/seipass/hasilan-code/releases) から `Hasilan-Code-<version>-win-x64.exe` をダウンロードして実行してください。Node.js を個別に導入する必要はありません。
- **Web 版（インストーラースクリプト利用）**: Releases ページから `install-hasilan.mjs` をダウンロードし、Node.js で実行します。

```sh
node install-hasilan.mjs --setup
```

インストーラーは配布物の SHA-256 チェックサムを検証した上で専用ディレクトリへ展開し、実行コマンドの配置先を案内します。`--version` を省略すると最新版が選択され、`--prefix <directory>` でインストール先ディレクトリをカスタマイズできます。再実行することで既存環境の更新も可能です。

### AI にインストールを依頼

ターミナル操作が可能な AI エージェント（Claude Code、Codex 等）に以下のプロンプトを渡すことで、環境確認からセットアップまでを自動化できます。

```text
https://github.com/seipass/hasilan-code/blob/main/INSTALL.md に従って Hasilan Code をインストールしてください。
```

### ソースコードから起動する（開発者向け）

リポジトリをクローンし、ルートディレクトリで以下の手順を実行します。

```sh
git clone https://github.com/seipass/hasilan-code.git
cd hasilan-code
npm install --ignore-scripts
npm rebuild node-pty --ignore-scripts=false --foreground-scripts
npm run build:hasilan
node packages/web-harness/bin/hasilan-code.mjs setup
npm run web
```

起動後、コンソールに表示される認証付き URL をブラウザーで開きます。既定のアドレスは `127.0.0.1:3080` です。

### 同一 LAN 内の他端末からアクセスする

スマートフォンやタブレット、別の PC からアクセスする場合は、ホストマシンと同一の信頼できるローカルネットワークに接続し、`--lan` オプションを付けて起動します。

```sh
hasilan-code --lan
```

ソースコードから起動する場合は `npm run web -- --lan` を指定します。

起動時、ホスト端末自身の認証用 URL に加え、検出されたプライベート IPv4 アドレスごとの `LAN authenticated launch URL` が一覧表示されます。ターミナルが TTY 出力に対応している場合は、スマートフォンですぐに読み取れる QR コードも同時に出力されます（ファイル出力やパイプライン経由の場合は URL のみ表示）。

対応するプライベート IPv4 アドレス帯は `10.x.x.x`、`172.16.x.x`〜`172.31.x.x`、`192.168.x.x` です。複数の接続先が表示された場合は、接続元端末と同じネットワークセグメントのアドレスを選択してください。

> [!CAUTION]
> - 接続できない場合は、ホストマシンのファイアウォール設定でリッスンポート（既定: 3080）への受信許可状況や、ルーター側の端末間通信禁止（AP アイソレーション）設定をご確認ください。
> - LAN モードの通信は暗号化（HTTPS）されておらず、認証 URL を知る端末からはホストのファイル操作や端末実行が可能です。信頼できない共有 Wi-Fi や公衆ネットワーク、インターネットへの直接公開環境では絶対に使用しないでください。
> - 外部端末からワークスペースを追加する際は、ホストマシン上の絶対パスを手動入力します。

## 使い方

チャットの入力欄では、自然言語による通常の指示に加えて、以下のスラッシュコマンドを利用できます。

| コマンド | 用途 |
| --- | --- |
| `/hyakki <目的>` | 百鬼夜行を開始し、複数の専門 AI エージェントによる自律的なチーム協調タスクを実行します。 |
| `/goal <目標>` | Goal モードを開始し、指定したゴールに到達するまで AI が反復作業を継続します。 |
| `/goal pause` | 進行中の Goal タスクを一時停止します。 |
| `/goal resume` | 一時停止中の Goal タスクを再開します。 |
| `/canvas` | ノードベースの設計・構想用キャンバス画面を開きます。 |
| `/chat` | キャンバス画面から標準のチャット画面へ戻ります。 |

入力欄に `/` を入力すると、利用可能なコマンド一覧がポップアップ表示されます。

### 百鬼夜行（自律協調チーム）

例えば `/hyakki ログイン機能を実装し、独立してレビューする` のように指示を送信すると、親 AI（マネージャー）が全体の目標分解、各担当エージェントの担当範囲、受け入れ条件を自動で定義・整理します。

実装や検証などの各実務は、専門エージェント自身が自律的に進めます。担当者同士での直接相談や作業の引き継ぎが可能で、限定的なサブタスクは補助エージェントへ適宜委譲されます。親 AI は自らコード実装を行わず、全体の進捗調整と成果物の最終判断に専念します。

チームの状態は会話セッション単位ではなくワークスペース単位に紐づいて永続化されます。新しい会話から別の依頼を送った場合やサーバーを再起動した後でも、エージェント ID・作業履歴・担当範囲はそのまま引き継がれます。「チーム」タブを開くと、関係図やリストで全体の進捗、選択した担当者の作業成果を確認でき、各担当エージェントの会話ログを直接開くことも可能です。担当範囲の見直しが必要な場合は、親 AI に再調整を指示できます。また、担当者が待機状態の間はモデル推論を行わないため、不要な API コストは発生しません。

### Canvas（設計キャンバス）

`/canvas` で設計画面を開き、ノードの追加や接続線での関連付けを行いながらアイデアや仕様を視覚的に整理できます。作成した構成図はファイルへエクスポートしたり、AI にタスクを相談・指示する際の下書きコンテキストとして活用できます。

### Goal（自律反復実行）

`/goal <目標>` で達成したいゴールを設定すると、AI が目標達成まで自己評価とタスク実行を繰り返します。現在の進行状態は `/goal` で確認できます。自動的な利用料金上限は設定されないため、必要に応じて `/goal pause` を実行して一時停止してください。

### アカウント使用量モニタリング

「設定 → 使用量」画面では、接続している各対応プロバイダーのアカウント利用上限、残量、リセット日時を確認できます（CommandCode、Devin、ChatGPT 認証を利用した OpenAI/Codex に対応）。ここに表示される情報はプロバイダー API から取得したアカウント全体のクォータであり、個別の会話内トークン消費量とは異なります。「更新」ボタンを押すことで最新情報に再取得できます。

詳細な操作仕様、チーム運用の制約事項、Web 検索設定、データの保存形式については、[Web ハーネスの README](packages/web-harness/README.md) を参照してください。

AI によるデスクトップ GUI 操作を利用する場合は、[Computer Use の準備と操作](docs/computer-use.md) を確認してください（Python 環境および画面アクセス権限が必要です）。

## 設定とデータの保存先

認証情報や会話履歴などのユーザーデータは、既定で `~/.hasilan-code/agent` に保存されます。保存先を変更したい場合は、環境変数 `HASILAN_CODE_AGENT_DIR` に任意の絶対パスを設定してください。

| 保存内容 | 主な格納場所 |
| --- | --- |
| モデル認証情報 | `auth.json` |
| モデル設定・共通設定 | `models.json`、`settings.json` など |
| Web 設定・検索プロバイダー認証 | `web-harness/` |
| 会話セッション履歴 | `web-harness/sessions/` |
| ワークスペースごとのキャンバス設計データ | `web-harness/canvases/` |

UI の表示設定や環境設定は Web 版とデスクトップ版の間で共有されます。設定画面で登録した API キーやプロバイダー認証は、アプリケーション再起動後も保持されます。

### Devin アカウント連携

「設定 → プロバイダー」で **Devin** を選択し、「Devinでログイン」を実行します。ブラウザー認証、Devin CLI の既存認証情報の読み込み、または手動によるセッショントークン入力に対応しています。認証完了後は、対象アカウントで利用可能なモデルや Thinking 強度を選択できるようになります。

※ 本機能は Devin の非公開プロトコルを利用した非公式連携です。Devin 側の仕様変更に伴い接続できなくなる可能性があります。対応範囲やデータ保存の詳細は [Devin アカウント連携の説明](packages/web-harness/README.md#devinアカウント) を参照してください。

## 開発

このリポジトリには複数のパッケージが含まれています。

| ディレクトリ | 内容 |
| --- | --- |
| [`packages/web-harness`](packages/web-harness) | Hasilan Code の Web 画面とサーバー |
| [`packages/ai`](packages/ai) | モデルやプロバイダーとの通信 |
| [`packages/agent`](packages/agent) | AI の実行処理 |
| [`packages/coding-agent`](packages/coding-agent) | コーディング用エージェントの機能 |
| [`packages/tui`](packages/tui) | Pi 由来の端末表示機能 |

次のコマンドはリポジトリのルートで実行してください。

```sh
# Hasilan Code と必要な SDK のビルド
npm run build:hasilan

# 型やコード品質などの確認（整形によるファイル更新を含む）
npm run check

# 通常のテスト
./test.sh

# Hasilan Code と独自 SDK 契約のテスト
npm run test:hasilan
```

`npm run test:hasilan`は単体検証と実 Chromium の操作検証を分けて実行します。実プロバイダーの認証や有料 API は使いません。Chromium は起動手順の`setup`で準備してください。

Web 側のコードだけを変更した場合は、`npm run build --workspace=hasilan-code` でビルドできます。ビルド後はサーバーを再起動し、ブラウザーを再読み込みしてください。

開発時の規則は [`AGENTS.md`](AGENTS.md)、貢献に関する案内は [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照してください。実際の AI プロバイダーを呼び出すテストには、認証や利用料金が必要な場合があります。

ローカルで画面の認証を省略して開発する場合は、[ローカル開発モード](docs/local-development.md)を参照してください。

## メンテナー向け文書

- [リリースとnpm公開の手順](docs/release.md)
- [上流 Pi の更新手順](docs/upstream-sync.md)

## 本家 Pi との関係

Hasilan Code は [Pi](https://github.com/earendil-works/pi) を基盤とした派生プロジェクトであり、Pi の公式配布物ではありません。現在取り込んでいる上流のリリースおよびコミットは以下のとおりです。

| 項目 | 内容 |
| --- | --- |
| 本リポジトリ | [`seipass/hasilan-code`](https://github.com/seipass/hasilan-code) |
| 上流リポジトリ | [`earendil-works/pi`](https://github.com/earendil-works/pi) |
| 取り込み済みリリース | [Pi v1.5.0](https://github.com/earendil-works/pi/releases/tag/v1.5.0) |
| 取り込み元コミット | `f9a26365568127461c47a07a37dcb42c140a3ac5` |

Pi に由来する共有パッケージは、競合を防ぐため独自の `@hasilan-code/*` スコープで管理しています（例: `@hasilan-code/pi-ai`、`@hasilan-code/pi-agent-core`、`@hasilan-code/pi-coding-agent`）。SDK をインポートするコードや拡張機能の実装でも、こちらのパッケージ名を使用してください（旧スコープへの後方互換エイリアスは提供していません）。サードパーティ製ライブラリの名称および著作権表示はそのまま保持しています。

これらの内部パッケージは npm レジストリに個別公開せず、統合パッケージである `hasilan-code` の内部に直接同梱しています。ソースコード上のワークスペースは誤公開防止のため `private: true` を維持し、検証済み tarball からのみ配布パッケージを生成します。また、TypeScript の各 OS 向けバイナリは固定バージョンをインストール時の npm 経由で取得します。

上流の変更取り込みは手動で行っています。GitHub Actions は本リポジトリ専用のワークフローのみを稼働させ、上流向けの自動公開・同期・Issue/PR 自動処理などのワークフローは無効化しています。なお、`oh-my-pi` 関連のソースコード、プロンプト、テストデータ、ネイティブバイナリは一切使用していません。

上流コミットの同期手順については、[上流 Pi の更新手順](docs/upstream-sync.md) を参照してください。

## セキュリティ

起動時に表示される URL および QR コードにはワンタイム認証トークンが含まれます。信頼できない第三者に共有しないでください。LAN からのアクセスを許可するのは明示的に `--lan` オプションを指定した場合に限られます。インターネットへ直接公開したり、信頼できない作業フォルダー（未検証の外部リポジトリなど）を対象にして起動しないでください。実行権限とサンドボックス環境の有無については、[冒頭の注意点](#hasilan-code) を必ず確認してください。

AI モデルや外部 Web 検索サービスの利用には、各プロバイダー所定の API 利用料が発生する場合があります。

脆弱性やセキュリティ上の問題を報告する場合は、[`SECURITY.md`](SECURITY.md) を参照してください。

## ライセンス

Hasilan Code は [GNU General Public License v3.0 only](LICENSE) で公開しています。本家 Pi に由来するコードには、引き続き [MIT License と著作権表示](LICENSE-PI-MIT) が適用されます。フォントなどの同梱素材には、それぞれのライセンスが適用されます。

配布パッケージにはブラウザー側に組み込む外部ライブラリの通知を`dist/client/THIRD_PARTY_LICENSES.txt`として同梱します。
