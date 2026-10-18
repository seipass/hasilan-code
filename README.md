<div align="center">
  <img src="packages/web-harness/public/icon.svg" alt="Hasilan Code" width="88" height="88" />

  # Hasilan Code

  Hasilan Code は、Pi を基盤にしたローカルの単一ユーザー向け Web コーディング環境です。
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
| 百鬼夜行 | 親 AI が作業を整理して子 AI に実装や検証を依頼し、その結果をまとめます。 |
| Goal | 設定した目標に向けて AI が作業を継続します。達成、入力待ち、停止などの状態を確認できます。 |
| Canvas | 項目とそのつながりを図に整理し、AI への指示に利用できます。 |
| 開発用パネル | ファイルや動画の閲覧、Markdown のプレビュー、タブの分割、端末操作ができます。 |
| ブラウザーと Web 検索 | ブラウザーの操作と、設定した検索サービスによる情報の取得に対応しています。 |

会話、作業フォルダー、チームの状態はローカルに保存します。Hasilan Code の設定と履歴は、本家 Pi と別の場所に保存します。

## クイックスタート

### 必要なもの

- Node.js 22.19.0 以上
- AI モデルの認証または API キー（利用開始時に設定）
- Git（ソースからビルドする場合）、Linux で端末機能を使う場合は C++ コンパイラー・make・Python

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

> [!CAUTION]
> 起動時に表示される URL には認証情報が含まれます。第三者に共有しないでください。AI モデルや検索サービスの利用には、各サービスの料金が発生する場合があります。

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

Windows で `node-pty` の準備に失敗した場合や、フォルダー選択を利用できない環境については、[詳しい起動手順](packages/web-harness/README.md#起動) を参照してください。

### Devinアカウントを使う

「設定 → プロバイダー」で **Devin** を選び、「Devinでログイン」を押します。ブラウザーでのログイン、Devin CLIの資格情報の読み込み、セッショントークンの入力に対応します。接続後は、そのアカウントで利用できるモデルとThinking強度を選べます。

Devinの非公開プロトコルを利用する非公式連携です。Devin側の変更で接続できなくなる場合があります。対応範囲と保存方法は[Devinアカウントの説明](packages/web-harness/README.md#devinアカウント)を参照してください。

## 導入・更新

ビルド済み配布物には、このプロジェクトで変更した Pi SDK と実行時依存を同梱します。本家の npm パッケージへ置き換えて実行する構成ではありません。

### npm から導入・更新

Node.js 22.19.0 以上が必要です。

```sh
npm install --global --ignore-scripts hasilan-code
hasilan-code setup
hasilan-code --version
hasilan-code
```

`setup`はインストール後の初回準備です。既定ではブラウザー機能用の Chromium をダウンロードし、macOS では端末用補助プログラムの実行権限も設定します。アプリの起動やログインは行いません。Chromium が不要なら`hasilan-code setup --skip-browser`を使います。

Linux で端末機能を使う場合は、C++ コンパイラー・make・Python を用意し、`hasilan-code setup --build-pty`を実行してください。この操作でのみ、確認済みの`node-pty` install scriptを実行します。Chromium の OS 依存ライブラリは[Playwright の要件](https://playwright.dev/docs/browsers#install-system-dependencies)も参照してください。

起動コマンド`hasilan-code`は既定で`127.0.0.1:3080`にサーバーを立ち上げ、認証付きURLを表示します。ブラウザーは自動で開きません。URLには認証情報が含まれるため、第三者に共有しないでください。

### GitHub Releases から導入

npm を使わない場合は、[GitHub Releases](https://github.com/seipass/hasilan-code/releases)から`install-hasilan.mjs`を保存して実行します。

```sh
node install-hasilan.mjs --setup
```

インストーラーは配布物の SHA-256 を確認して専用ディレクトリへ導入し、コマンドの配置先を表示します。`--version`を省略すると最新リリースを使い、`--prefix <directory>`で配置先を指定できます。同じコマンドを再実行すると更新できます。認証・会話は配布物とは別の`~/.hasilan-code/agent`に保持します。Windows/macOS 向けの PTY prebuild は同梱し、Linux でのビルドには`hasilan-code setup --build-pty`を指定してください。

## 使い方

チャットの入力欄では、通常の指示に加えて次のコマンドを使用できます。

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

たとえば `/hyakki ログイン機能を実装し、独立してレビューする` と送信すると、親 AI が作業を整理して子 AI に実装と検証を依頼します。各担当の進捗はチーム関係図で確認できます。

### Canvas

`/canvas` で設計画面を開き、項目を追加して線でつなぎます。作成した設計をファイルに書き出したり、AI に相談するための下書きにしたりできます。

### Goal

`/goal 目標` で目標を指定すると、AI が作業を継続します。現在の状態は `/goal` で確認できます。利用料金の上限は自動設定されません。必要に応じて `/goal pause` で一時停止してください。

### アカウントの使用量

「設定 → 使用量」で、接続中の対応プロバイダーの利用上限・残量・リセット日時を確認できます。CommandCode、Devin、ChatGPT認証のOpenAI/Codexに対応しています。会話内のトークン集計とは別の、プロバイダーから取得したアカウント全体の情報です。「更新」で再取得できます。

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

## 開発

このリポジトリには、複数のパッケージが含まれています。

| ディレクトリ | 内容 |
| --- | --- |
| [`packages/web-harness`](packages/web-harness) | Hasilan Code の Web 画面とサーバー |
| [`packages/ai`](packages/ai) | モデルやプロバイダーとの通信 |
| [`packages/agent`](packages/agent) | AI の実行処理 |
| [`packages/coding-agent`](packages/coding-agent) | コーディング用エージェントの機能 |
| [`packages/tui`](packages/tui) | Pi 由来の端末表示機能 |

次のコマンドは、リポジトリのルートで実行してください。

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

## 独自CI・リリース

本体のバージョンは`packages/web-harness/package.json`、基盤 Pi のバージョンはその`hasilanCode.piVersion`で別々に管理します。本家の`release:patch`や`version:patch`はこのアプリのリリースに使いません。

- [Hasilan Code CI](.github/workflows/hasilan-ci.yml): Windows・macOS・Linux でビルド、全体チェック、対象テストを実行します。Ubuntu で作った同一の配布物を 3 OS のリポジトリ外へインストールし、CLI・変更済み SDK・認証付き HTTP・実際の PTY 入出力を検証します。
- [Hasilan Code Release](.github/workflows/hasilan-release.yml): `hasilan-vX.Y.Z`タグだけで動作し、CI で検証した配布物・インストーラー・`SHA256SUMS`・ソース情報を GitHub Releases へ公開します。本家の`vX.Y.Z`タグとは分離します。同じバージョンの配布物を上書きしません。
- ビルドは`nix/model-catalog.json`で固定した Pi のモデルカタログを SHA-256 検証して使用します。実行時依存の解決結果がルート lockfile にないバージョンへ変わった場合はパッケージ作成を拒否します。

ローカルで配布物を作り、作業ツリー外への導入を検証します。

```sh
npm run pack:hasilan
npm run smoke:hasilan
```

Linux の配布物検証は`npm run smoke:hasilan -- --build-pty`で行います。成果物は`.artifacts/hasilan-code/`です。ソース workspace を直接`npm publish`すると拒否します。公開するのは検証済みの tarball だけです。

次のリリース:

1. 修正なら`npm run version:hasilan:patch`、機能追加なら`npm run version:hasilan:minor`でアプリだけを更新する。Pi のバージョンは変えない。
2. 更新内容と lockfile を確認し、`npm run pack:hasilan`、`npm run smoke:hasilan`を実行する。
3. 検証した変更をコミットして`main`へ push する。
4. `git tag hasilan-vX.Y.Z`、`git push origin hasilan-vX.Y.Z`で公開する。npm の通常導入先は明示的に`latest`へ設定する。
5. GitHub Actions の成功と公開先を確認する。公開済みタグ・配布物は置き換えず、修正は次のバージョンで出す。npm 公開だけが失敗した場合は失敗ジョブだけを再実行する。

### npmの初回公開とtrusted publishing

初回のみ所有者が`npm login --registry=https://registry.npmjs.org --auth-type=web`で認証し、検証済みの`hasilan-code-X.Y.Z.tgz`を`npm publish <tarball> --tag latest --access public --ignore-scripts`で公開します。認証コードやトークンはリポジトリやチャットへ保存しません。

以降は npm 11.15 以上で GitHub Actions を Trusted Publisher として登録します。ブラウザーでの本人認証が求められたら、その画面で承認してください。

```sh
npm trust github hasilan-code --file hasilan-release.yml --repository seipass/hasilan-code --environment npm-publish --allow-publish --yes
```

登録後に GitHub のリポジトリ変数`HASILAN_NPM_PUBLISH=true`を設定すると npm 公開ジョブが有効になります。長期保存する npm token は不要です。未設定時も GitHub Releases は公開しますが、npm 公開ジョブは明示的にスキップします。詳細は[npm の公式手順](https://docs.npmjs.com/trusted-publishers/)を参照してください。

新しい Trusted Publisher 設定は 2 日以内の最初の公開で検証する必要があります。登録は次の未公開バージョンを出せる時点で行い、そのタグの npm 公開ジョブまで成功を確認してください。

自動公開は、npm上の同じバージョンが検証済みアーカイブと一致する場合だけ再実行をスキップします。公開要求が受け付けられても、メタデータと実際にダウンロードした配布物のSHA-512が一致するまでは成功にしません。公開反映待ちは上流と同じ最大10分です。

公開結果だけを手動で確認する場合は、検証済み配布物のディレクトリを指定します。このコマンドは公開操作を行いません。

```sh
node scripts/hasilan-publish.mjs .artifacts/hasilan-code
```

## 本家 Pi との関係

Hasilan Code は [Pi](https://github.com/earendil-works/pi) を基盤にした独立プロジェクトです。Pi の公式配布物ではありません。現在取り込んでいる Pi のリリースとコミットは次のとおりです。

| 項目 | 内容 |
| --- | --- |
| 独自リポジトリ | [`seipass/hasilan-code`](https://github.com/seipass/hasilan-code) |
| 上流リポジトリ | [`earendil-works/pi`](https://github.com/earendil-works/pi) |
| 取り込み済みのリリース | [Pi v1.3.0](https://github.com/earendil-works/pi/releases/tag/v1.3.0) |
| 上流のコミット | `71023aec1546d6d677a65669c5665c0927ce0dd0` |

Pi 由来の共有パッケージは、独自の`@hasilan-code/*`名前空間で管理します。たとえば`@hasilan-code/pi-ai`・`@hasilan-code/pi-agent-core`・`@hasilan-code/pi-coding-agent`です。SDK を利用するコードや拡張機能の import も、この名前へ変更してください。旧名前空間への互換エイリアスは用意しません。第三者ライブラリの名前と著作権表示は維持します。これらの共有パッケージは現時点では個別に npm 公開せず、製品パッケージ`hasilan-code`へ同梱します。ソース workspace は誤公開を防ぐため`private: true`のままにし、検証済み tarball からだけ公開用パッケージを作ります。TypeScript の OS 別実行ファイルは、固定したバージョンを導入先の npm で取得します。

上流の更新は手動で行います。独自の GitHub Actions だけを有効にし、本家向けの自動公開・同期・Issue/PR 受付制御は無効にします。`oh-my-pi`のソース、プロンプト、テスト用データ、ネイティブバイナリは使用していません。

<details>
<summary>上流 Pi の更新手順</summary>

作業前に自分の変更をコミットし、ほかの作業者による変更がないことを確認してください。対象リリースの変更点も先に確認します。

1. 初回のみ、上流リポジトリを登録します。

   ```sh
   git remote add upstream https://github.com/earendil-works/pi.git
   ```

2. `git fetch upstream --tags` で上流のタグを取得し、作業ブランチで対象のタグをマージします。競合を解決するときは、独自の変更を残してください。
3. `packages/web-harness/package.json`の Pi 関連の依存 3 件と`hasilanCode.piVersion`・`hasilanCode.piCommit`を対象リリースへ揃え、`nix/model-catalog.json`のカタログがその Pi の API に対応することも確認します。外部依存の変更はリリースノートと lifecycle script を確認してください。
4. 次のコマンドで依存関係とロックファイルを更新します。

   ```sh
   npm install --package-lock-only --ignore-scripts
   npm install --ignore-scripts
   node scripts/generate-coding-agent-install-lock.mjs
   ```

5. `npm run check` と変更箇所のテストを実行します。隔離した設定領域と疑似プロバイダーを使い、会話、チーム、再開、保存の動作も確認してください。
6. この README と [`packages/web-harness/README.md`](packages/web-harness/README.md) に記載した上流のバージョンとコミットを更新し、差分を確認します。
7. ビルド後、実行中の Web サーバーを再起動します。

本家への変更提案は、[Pi 側の貢献ルール](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) に従ってください。

</details>

## セキュリティ

Hasilan Code は既定で `127.0.0.1` に待ち受け、起動時に認証付き URL を表示します。AI によるファイル編集、コマンド実行、ブラウザー操作には、アプリケーションを起動したユーザーの権限が使われます。外部に公開したり、信頼できない作業フォルダーで使用したりしないでください。

セキュリティ上の問題を報告する場合は [`SECURITY.md`](SECURITY.md) を参照してください。

## ライセンス

本リポジトリは [MIT License](LICENSE) で公開しています。本家 Pi の著作権表示を保持しています。フォントなどの同梱素材には、それぞれのライセンスが適用されます。

配布パッケージには、ブラウザー側に組み込む外部ライブラリの通知を`dist/client/THIRD_PARTY_LICENSES.txt`として同梱します。Gen Interface JP の著作権表示と [SIL Open Font License](packages/web-harness/public/fonts/GenInterfaceJP-OFL.txt) もフォントと一緒に配布します。
