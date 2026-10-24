<div align="center">
  <img src="packages/web-harness/public/icon.svg" alt="Hasilan Code" width="88" height="88" />

  # Hasilan Code

  Hasilan Code はPi を基盤にしたローカルの単一ユーザー向け Web コーディング環境です。
  AI との会話、複数の AI による作業分担、設計画面、ファイル閲覧、端末操作をひとつの画面で行えます。

  [使い始める](#クイックスタート) · [主な機能](#主な機能) · [詳しい使い方](packages/web-harness/README.md)
</div>

> [!IMPORTANT]
> Hasilan Code はローカルの単一ユーザー向けです。AI によるコマンド実行、端末操作、ブラウザー操作には、アプリケーションを起動したユーザーの権限が使われます。作業を隔離する仕組みはありません。信頼できる環境で使用してください。

## 主な機能

| 機能 | できること |
| --- | --- |
| AI チャット | 使用するモデルと推論の強度を選び、会話とツールの実行結果を確認できます。 |
| チーム実行 | 複数の AI に作業を分担させ、各担当の進捗や関係を確認できます。 |
| 百鬼夜行 | ワークスペースに継続するAIチームを置き、親AIが目標を管理します。専門担当は相談・引き継ぎや補助への委譲で作業を進めます。 |
| Goal | 設定した目標に向けて AI が作業を継続します。達成、入力待ち、停止などの状態を確認できます。 |
| Canvas | 項目とそのつながりを図に整理し、AI への指示に利用できます。 |
| 開発用パネル | ファイルや動画の閲覧、Markdown のプレビュー、タブの分割、端末操作ができます。 |
| ブラウザーと Web 検索 | ブラウザーの操作と、設定した検索サービスによる情報の取得に対応しています。 |

会話、作業フォルダー、チームの状態はローカルに保存します。Hasilan Code の設定と履歴は、本家 Pi と別の場所に保存します。

## クイックスタート

### 必要なもの

- Node.js 22.19.0 以上
- AI モデルの認証または API キー（利用開始時に設定）
- ソースからビルドする場合は Git、Linux で端末機能を使う場合は C++ コンパイラー・make・Python

### ビルド済み版を使う

通常の利用では npm または GitHub Releases から導入します。手順は[導入・更新](#導入更新)を参照してください。ビルド済み版に Git は不要です。Linux で端末機能を使う場合だけ、別途ネイティブビルド環境が必要です。

### ソースから起動する（開発者向け）

リポジトリを取得し、ターミナルで次のコマンドを順番に実行します。

```sh
git clone https://github.com/seipass/hasilan-code.git
cd hasilan-code
npm install --ignore-scripts
npm rebuild node-pty --ignore-scripts=false --foreground-scripts
npm run build:hasilan
node packages/web-harness/bin/hasilan-code.mjs setup
npm run web
```

起動したら、ターミナルに表示される認証付き URL をブラウザーで開いてください。ブラウザーは自動で開きません。既定の待ち受け先は `127.0.0.1:3080` です。

表示される認証URLは共有しないでください。

### 最初の会話

1. 設定画面の「プロバイダー」で、使う AI モデルの認証を設定します。
2. 入力欄から利用するモデルと推論の強度を選びます。
3. 作業フォルダーを確認し、AI に依頼を送信します。

送信は **Ctrl + Enter**（macOS では **⌘ + Enter**）、Enter は改行です。

別の作業フォルダーを使う場合は、起動時に `--cwd` で指定します。

```sh
npm run web -- --cwd /path/to/project
```

ポート番号は `--port` で変更できます。たとえば `--port 0` を指定すると、OS が空いているポートを割り当てます。

Windows で `node-pty` の準備に失敗した場合の対処方法や、フォルダー選択を利用できない環境での操作方法は[詳しい起動手順](packages/web-harness/README.md#起動) を参照してください。

## 導入・更新

ビルド済み配布物にはこのプロジェクトで変更した Pi SDK と実行時依存を同梱します。本家の npm パッケージへ置き換えて実行する構成ではありません。

### npm から導入・更新

Node.js 22.19.0以上が必要です。Linuxでは先に[Linuxのセットアップ](#linuxのセットアップ)を参照してください。

更新時も、実行中のHasilan Codeを終了してから同じコマンドを実行してください。Linuxでは`hasilan-code setup`を`hasilan-code setup --build-pty`に置き換えます。

```sh
npm install --global --ignore-scripts hasilan-code
hasilan-code setup
hasilan-code --version
hasilan-code
```

`setup`はインストール後の初回準備です。ブラウザー機能用のChromiumをダウンロードし、macOSでは端末用補助プログラムの実行権限も設定します。アプリの起動やログインは行いません。Chromiumが不要なら`hasilan-code setup --skip-browser`を使います。

更新するとnpmの`latest`に置き換わります。認証・会話・チームの状態は配布物とは別の`~/.hasilan-code/agent`に保持され、更新では変更されません。バージョンを固定する場合は`hasilan-code@0.1.5`のように指定します。アプリ内に自己更新コマンドはありません。

起動コマンド`hasilan-code`は既定で`127.0.0.1:3080`にサーバーを立ち上げ、認証付きURLを表示します。ブラウザーは自動で開きません。表示される認証URLは共有しないでください。

#### Linuxのセットアップ

Linux向けの端末用ネイティブモジュールは同梱していないため、起動前にビルドが必要です。C++コンパイラー・make・Pythonを用意し、`hasilan-code setup --build-pty`を実行してください。この操作で確認済みの`node-pty`のインストールスクリプトを実行します。ビルド前に起動すると、準備手順を表示して終了します。

Debian / Ubuntuでのセットアップ例です。

```sh
sudo apt-get update
sudo apt-get install -y build-essential python3
npm install --global --ignore-scripts hasilan-code
hasilan-code setup --build-pty
```

ほかのディストリビューションでは次のコマンドでビルドツールを用意します。利用中のディストリビューションに対応するコマンドだけを実行してください。

| ディストリビューション | コマンド |
| --- | --- |
| Fedora / RHEL | `sudo dnf install -y gcc-c++ make python3` |
| Arch Linux | `sudo pacman -S --needed base-devel python` |

ブラウザー機能に必要なOSライブラリは、Chromium本体とは別にインストールします。Playwrightが対応するLinux環境では、次のコマンドを使えます。管理者権限を求められる場合があります。

```sh
node "$(npm root -g)/hasilan-code/node_modules/playwright/cli.js" install-deps chromium
```

対応OSと依存ライブラリは[Playwrightの要件](https://playwright.dev/docs/browsers#install-system-dependencies)を参照してください。Alpine Linuxなどのmusl環境は、Playwrightのブラウザーの対応対象外です。

ブラウザー機能が不要なら、セットアップには`hasilan-code setup --build-pty --skip-browser`を使い、OSライブラリのインストールも省略できます。

準備が終わったら起動します。

```sh
hasilan-code --version
hasilan-code
```

### GitHub Releases から導入

npmレジストリからではなくGitHubの配布物を使う場合は、[GitHub Releases](https://github.com/seipass/hasilan-code/releases)から`install-hasilan.mjs`を保存して実行します。

```sh
node install-hasilan.mjs --setup
```

インストーラーは配布物の SHA-256 を確認して専用ディレクトリへ導入し、コマンドの配置先を表示します。`--version`を省略すると最新リリースを使い、`--prefix <directory>`で配置先を指定できます。同じコマンドを再実行すると更新できます。

認証・会話は配布物とは別の`~/.hasilan-code/agent`に保持します。Windows/macOS 向けの PTY prebuild は同梱しています。Linux では`hasilan-code setup --build-pty`でビルドしてください。

### 同じLANの別端末から使う

スマートフォンや別のPCから使う場合は、ホストと同じ信頼できるLANに接続して、`--lan`付きで起動します。通常起動は引き続きこのPCからだけ接続できます。

```sh
hasilan-code --lan
```

ソースからは`npm run web -- --lan`を使います。起動時に、このPC用の認証URLと、検出したプライベートIPv4アドレスごとの`LAN authenticated launch URL`を表示します。端末へ直接出力している場合は、各LAN用URLのQRコードも表示します。スマートフォンでQRを読み取るか、表示されたLAN用URLを同じネットワークの端末で開いてください。出力をファイルやパイプへ送る場合、QRは省略してURLだけを表示します。

対応するのは`10.x.x.x`、`172.16.x.x`〜`172.31.x.x`、`192.168.x.x`のIPv4アドレスです。複数のリンクが出た場合は、接続する端末と同じLANのアドレスを選んでください。VPN用・仮想アダプターのプライベートアドレスも表示される場合があります。

接続できない場合は、ホストのファイアウォールで使用ポート（既定3080）のプライベートネットワークからの受信を許可し、Wi-Fiの端末間通信が禁止されていないか確認してください。ファイアウォール全体を無効にする必要はありません。

URLとQRには認証情報が含まれます。起動し直すと無効になるため、新しく表示されたものを使ってください。LAN接続はHTTPで暗号化されず、接続者はホストのファイルと端末を操作できます。共有Wi-Fiやインターネットへのポート公開には使わないでください。別端末からの作業フォルダー追加は、サーバー上の絶対パスを入力します。

## 使い方

チャットの入力欄では通常の指示に加えて次のコマンドを使用できます。

| コマンド | 用途 |
| --- | --- |
| `/hyakki 目的` | 百鬼夜行を開始し、複数の AI に作業を分担させます。 |
| `/goal 目標` | Goal を開始し、指定した目標に向けて作業を継続します。 |
| `/goal pause` | 実行中の Goal を一時停止します。 |
| `/goal resume` | 一時停止した Goal を再開します。 |
| `/canvas` | ノードを使った設計画面を開きます。 |
| `/chat` | 設計画面からチャットに戻ります。 |

`/` を入力すると、利用できるコマンドの候補が表示されます。

### 百鬼夜行

たとえば `/hyakki ログイン機能を実装し、独立してレビューする` と送信すると、親AIが目標・担当範囲・受け入れ条件を整理します。実装や検証は専門担当が自分で進め、担当者同士でも直接相談・引き継ぎができます。必要な限定作業は、担当者から補助エージェントへ委譲できます。親AIは実装に回らず、全体の調整と最終判断を担当します。

チームは会話ではなくワークスペースに所属します。新しい会話から別の目的を送った場合やホストの再起動後も、同じ担当ID・履歴・担当範囲を引き継ぎます。各担当の会話はチームタブの詳細から開けます。進捗・引き継ぎ先・以前の作業はチーム関係図で確認でき、待機中なら担当範囲を変更できます。待機しているだけでモデルを呼び続けることはありません。

### Canvas

`/canvas` で設計画面を開き、項目を追加して線でつなぎます。作成した設計をファイルに書き出したり、AI に相談するための下書きにしたりできます。

### Goal

`/goal 目標` で目標を指定すると、AI が作業を継続します。現在の状態は `/goal` で確認できます。利用料金の上限は自動設定されません。必要に応じて `/goal pause` で一時停止してください。

### アカウントの使用量

「設定 → 使用量」で、接続中の対応プロバイダーの利用上限・残量・リセット日時を確認できます。CommandCode、Devin、ChatGPT認証のOpenAI/Codexに対応しています。ここに表示するのはプロバイダーから取得したアカウント全体の情報で、会話内のトークン集計とは別です。「更新」で再取得できます。

操作の詳細、チームの制約、検索設定、保存形式については [Web ハーネスの README](packages/web-harness/README.md) にまとめています。

## 設定と保存先

認証情報や会話履歴などの既定の保存先は `~/.hasilan-code/agent` です。変更する場合は、環境変数 `HASILAN_CODE_AGENT_DIR` に絶対パスを指定してください。

| 保存内容 | 主な保存先 |
| --- | --- |
| モデルの認証 | `auth.json` |
| モデルや共通設定 | `models.json`、`settings.json` など |
| Web の設定や検索サービスの認証情報 | `web-harness/` |
| 会話の履歴 | `web-harness/sessions/` |
| ワークスペースごとの設計 | `web-harness/canvases/` |

モデル選択など、一部の画面設定はブラウザー内にも保存されます。設定画面で入力した AI モデル用の API キーは、実行中のプロセスだけで有効です。再起動後は再設定してください。

### Devinアカウントを使う

「設定 → プロバイダー」で **Devin** を選び、「Devinでログイン」を押します。ブラウザーでのログイン、Devin CLIの資格情報の読み込み、セッショントークンの入力に対応します。接続後はそのアカウントで利用できるモデルとThinking強度を選べます。

Devinの非公開プロトコルを利用する非公式連携です。Devin側の変更で接続できなくなる場合があります。対応範囲と保存方法は[Devinアカウントの説明](packages/web-harness/README.md#devinアカウント)を参照してください。

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

## メンテナー向け文書

- [リリースとnpm公開の手順](docs/release.md)
- [上流 Pi の更新手順](docs/upstream-sync.md)

## 本家 Pi との関係

Hasilan Code は [Pi](https://github.com/earendil-works/pi) を基盤にした独立プロジェクトです。Pi の公式配布物ではありません。現在取り込んでいる Pi のリリースとコミットは次のとおりです。

| 項目 | 内容 |
| --- | --- |
| 独自リポジトリ | [`seipass/hasilan-code`](https://github.com/seipass/hasilan-code) |
| 上流リポジトリ | [`earendil-works/pi`](https://github.com/earendil-works/pi) |
| 取り込み済みのリリース | [Pi v1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0) |
| 上流のコミット | `4a080252f06caf63a525d7873c5d94d3c23887e0` |

Pi由来の共有パッケージは独自の`@hasilan-code/*`名前空間で管理します。たとえば`@hasilan-code/pi-ai`・`@hasilan-code/pi-agent-core`・`@hasilan-code/pi-coding-agent`です。SDKを利用するコードや拡張機能のimportも、この名前へ変更してください。旧名前空間への互換エイリアスは用意しません。第三者ライブラリの名前と著作権表示は維持します。

これらの共有パッケージは個別にnpm公開せず、製品パッケージ`hasilan-code`へ同梱します。ソースのworkspaceは誤公開を防ぐため`private: true`のままにし、検証済みtarballからだけ公開用パッケージを作ります。TypeScriptのOS別実行ファイルは固定したバージョンを導入先のnpmで取得します。

上流の更新は手動で行います。独自の GitHub Actions だけを有効にし、本家向けの自動公開・同期・Issue/PR 受付制御は無効にします。`oh-my-pi`のソース、プロンプト、テスト用データ、ネイティブバイナリは使用していません。

上流の取り込み手順は[上流 Pi の更新手順](docs/upstream-sync.md)を参照してください。

## セキュリティ

起動時に表示されるURLとQRには認証情報が含まれるため、第三者に共有しないでください。LANへの接続を許可するのは`--lan`を指定した場合だけです。インターネットに公開したり、信頼できない作業フォルダーで使用したりしないでください。実行権限と作業の隔離に関する制約は[冒頭の注意](#hasilan-code)を参照してください。

AI モデルや検索サービスの利用には、各サービスの料金が発生する場合があります。

セキュリティ上の問題を報告する場合は [`SECURITY.md`](SECURITY.md) を参照してください。

## ライセンス

本リポジトリは [MIT License](LICENSE) で公開しています。本家 Pi の著作権表示を保持しています。フォントなどの同梱素材には、それぞれのライセンスが適用されます。

配布パッケージにはブラウザー側に組み込む外部ライブラリの通知を`dist/client/THIRD_PARTY_LICENSES.txt`として同梱します。
