# Hasilan Code

Piを基盤にした、ローカル単一ユーザー用のWebコーディング環境です。本家Piとは独立したプロジェクトであり、公式Piの配布物ではありません。

- Web上の会話、モデル・Thinkingの選択、ツールと実行履歴の表示
- 親AI・子AIのチーム実行、Goal、百鬼夜行、チーム関係図
- 設計用Canvas、ファイル・動画ビューア、分割タブ、PTY端末
- 専用ディレクトリへの設定・認証・会話の保存

起動方法・使い方・セキュリティ上の制約は [WebハーネスのREADME](packages/web-harness/README.md) を参照してください。ホストの権限でコマンドとファイル操作を実行します。サンドボックスではありません。
## 導入・更新

Node.js 22.19以上が必要です。ビルド済み配布物には、このプロジェクトで変更したPi SDKと実行時依存を同梱します。本家のnpmパッケージへ置き換えて実行する構成ではありません。

npm公開済みバージョンの導入・更新:

```sh
npm install --global --ignore-scripts hasilan-code
hasilan-code setup
hasilan-code --version
hasilan-code
```

Linuxの端末にはnative addonのビルドが必要です。C++コンパイラー・make・Pythonを用意し、`hasilan-code setup --build-pty`を明示的に実行してください。この操作だけが`node-pty`の確認済みinstall scriptを実行します。通常のインストールではlifecycle scriptを実行しません。ChromiumのOS依存ライブラリは[Playwrightの要件](https://playwright.dev/docs/browsers#install-system-dependencies)も参照してください。

macOSでも初回に`hasilan-code setup`を実行してください。Chromiumの導入に加え、同梱するPTY補助プログラムの実行権限を設定します。ブラウザーを使わない場合は`hasilan-code setup --skip-browser`で端末だけを準備できます。

npmアカウントなしで導入する場合は [GitHub Releases](https://github.com/seipass/hasilan-code/releases) の`install-hasilan.mjs`を保存して実行します。

```sh
node install-hasilan.mjs --version 1.1.0 --setup
```

インストーラーは配布物のSHA-256を確認して専用ディレクトリへ導入し、コマンドの配置先を表示します。`--prefix <directory>`で配置先を指定できます。`--version`を省略すると最新の公開リリースを使います。同じコマンドを再実行すると更新できます。認証・会話は配布物とは別の`~/.hasilan-code/agent`に保持します。Windows/macOS向けのPTY prebuildは同梱し、Linuxでのビルドには`--build-pty`を指定します。


## 本家Piとの関係

| 項目 | 設定 |
|---|---|
| 独自リポジトリ（`origin`） | https://github.com/seipass/hasilan-code |
| 本家リポジトリ（`upstream`） | https://github.com/earendil-works/pi |
| 取り込み済みリリース | [Pi v1.3.0](https://github.com/earendil-works/pi/releases/tag/v1.3.0) |
| 上流コミット | `71023aec1546d6d677a65669c5665c0927ce0dd0` |
| Webハーネス | `packages/web-harness`（npm名 `hasilan-code`） |
| 同梱するPiのソース | `packages/ai`、`packages/agent`、`packages/coding-agent`など |

Pi SDKはこのモノレポ内のworkspaceを参照します。npmのPiパッケージだけを差し替える更新方法は使いません。内部の`@earendil-works/*`名は上流との差分を小さくするため保持し、`hasilan-code`の配布物に変更済みの実装を同梱します。本リポジトリから本家の名前でnpm公開しません。
ソースworkspaceは誤公開を防ぐため`private: true`のままにし、ビルド済みの検証用tarballからだけ公開用パッケージを作ります。TypeScriptのOS別実行ファイルは、固定したバージョンを導入先のnpmで取得します。

独自のGitHub Actionsだけを有効にし、本家向けの自動公開・同期・Issue/PR受付制御は無効のままにします。上流の著作権表示とMITライセンスを保持します。oh-my-piのソース、prompt、fixture、native binaryは使用していません。

## 開発

Node.js 22.19以上が必要です。依存のlifecycle scriptは実行せずインストールします。PTY用native moduleの準備とビルド手順は [起動手順](packages/web-harness/README.md#起動) を参照してください。

```sh
npm install --ignore-scripts
npm run build:hasilan
npm run check
```

`npm run test:hasilan`はWebハーネスのテストと、独自変更を加えたSDKのコンテキスト再開・入力キューのテストを実行します。実プロバイダーの認証や有料APIは使いません。

## 独自CI・リリース

本体のバージョンは`packages/web-harness/package.json`、基盤Piのバージョンはその`hasilanCode.piVersion`で別々に管理します。本家の`release:patch`や`version:patch`はこのアプリのリリースに使いません。

- [Hasilan Code CI](.github/workflows/hasilan-ci.yml): Windows・macOS・Linuxでビルド、全体チェック、対象テストを実行します。Ubuntuで作った同一の配布物を3 OSのリポジトリ外へインストールし、CLI・変更済みSDK・認証付きHTTP・実際のPTY入出力を検証します。
- [Hasilan Code Release](.github/workflows/hasilan-release.yml): `hasilan-vX.Y.Z`タグだけで動作し、CIで検証した配布物・インストーラー・`SHA256SUMS`・ソース情報をGitHub Releasesへ公開します。本家の`vX.Y.Z`タグとは分離します。同じバージョンの配布物を上書きしません。
- ビルドは`nix/model-catalog.json`で固定したPiのモデルカタログをSHA-256検証して使用します。実行時依存の解決結果がルートlockfileにないバージョンへ変わった場合はパッケージ作成を拒否します。

ローカルで配布物を作り、作業ツリー外への導入を検証します。

```sh
npm run pack:hasilan
npm run smoke:hasilan
```

Linuxの配布物検証は`npm run smoke:hasilan -- --build-pty`で行います。成果物は`.artifacts/hasilan-code/`です。ソースworkspaceを直接`npm publish`すると拒否します。公開するのは検証済みのtarballだけです。

次のリリース:

1. 修正なら`npm run version:hasilan:patch`、機能追加なら`npm run version:hasilan:minor`でアプリだけを更新する。Piのバージョンは変えない。
2. 更新内容とlockfileを確認し、`npm run pack:hasilan`、`npm run smoke:hasilan`を実行する。
3. 検証した変更をコミットして`main`へpushする。
4. `git tag hasilan-vX.Y.Z`、`git push origin hasilan-vX.Y.Z`で公開する。初回は`hasilan-v1.1.0`。
5. GitHub Actionsの成功と公開先を確認する。公開済みタグ・配布物は置き換えず、修正は次のバージョンで出す。npm公開だけが失敗した場合は失敗ジョブだけを再実行する。

### npmの初回公開とtrusted publishing

初回のみ所有者が`npm login --registry=https://registry.npmjs.org --auth-type=web`で認証し、検証済みの`hasilan-code-X.Y.Z.tgz`を`npm publish <tarball> --access public --ignore-scripts`で公開します。認証コードやトークンはリポジトリやチャットへ保存しません。

以降はnpmのパッケージ設定のTrusted PublisherにGitHub Actionsを登録します。

| 設定 | 値 |
|---|---|
| Organization or user | `seipass` |
| Repository | `hasilan-code` |
| Workflow filename | `hasilan-release.yml`（パスではなくファイル名） |
| Environment name | `npm-publish` |
| Allowed actions | `npm publish`を許可 |

登録後にGitHubのリポジトリ変数`HASILAN_NPM_PUBLISH=true`を設定するとnpm公開ジョブが有効になります。長期保存するnpm tokenは不要です。未設定時もGitHub Releasesは公開しますが、npm公開ジョブは明示的にスキップします。詳細は[npmの公式手順](https://docs.npmjs.com/trusted-publishers/)を参照してください。
新しいTrusted Publisher設定は2日以内の最初の公開で検証する必要があります。登録は次の未公開バージョンを出せる時点で行い、そのタグのnpm公開ジョブまで成功を確認してください。

## 本家Piを更新する手順

初回clone時は`origin`だけが設定されるため、上流を追加します。

```sh
git remote add upstream https://github.com/earendil-works/pi.git
```

以降は次の手順で更新します。作業前に自分の変更をコミットし、他の作業者の変更がないことを確認してください。自動更新は行いません。

1. 対象リリースの変更履歴を読み、タグとコミットを確認する。
2. `git fetch upstream --tags`で取得し、作業ブランチで対象タグをmergeする。上流のGit履歴を保持し、WebハーネスとPi SDKへの独自変更を競合解決時に残す。
3. `packages/web-harness/package.json`のPi依存3件と`hasilanCode.piVersion`・`hasilanCode.piCommit`を対象リリースへ揃え、`nix/model-catalog.json`のカタログがそのPiのAPIに対応することも確認する。外部依存の変更はリリースノートとlifecycle scriptを確認する。
4. `npm install --package-lock-only --ignore-scripts`、`npm install --ignore-scripts`、`node scripts/generate-coding-agent-install-lock.mjs`で依存と生成lockを更新する。
5. `npm run check`、変更したSDK契約のテスト、Webハーネスの会話・チーム・再開・保存を検証する。既存認証や有料APIを使わず、隔離した設定ディレクトリとfaux providerで確認する。
6. このREADMEとWebハーネスのREADMEの上流バージョン・コミットを更新する。ロックファイルを含む差分を確認してコミットする。
7. ビルド後に自分のWebサーバーを再起動する。既存の`dist`や起動中のプロセスはソース更新だけでは切り替わらない。

独自の変更は`origin`へpushします。本家への変更提案は別途、本家の[貢献ルール](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md)に従って行います。

## ライセンス

[MIT](LICENSE)。本家Piの著作権表示を含みます。フォントなどの同梱アセットのライセンスは各ファイルの記載を参照してください。
