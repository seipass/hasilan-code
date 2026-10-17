# Hasilan Code

Piを基盤にした、ローカル単一ユーザー用のWebコーディング環境です。本家Piとは独立したプロジェクトであり、公式Piの配布物ではありません。

- Web上の会話、モデル・Thinkingの選択、ツールと実行履歴の表示
- 親AI・子AIのチーム実行、Goal、百鬼夜行、チーム関係図
- 設計用Canvas、ファイル・動画ビューア、分割タブ、PTY端末
- 専用ディレクトリへの設定・認証・会話の保存

起動方法・使い方・セキュリティ上の制約は [WebハーネスのREADME](packages/web-harness/README.md) を参照してください。ホストの権限でコマンドとファイル操作を実行します。サンドボックスではありません。

## 本家Piとの関係

| 項目 | 設定 |
|---|---|
| 独自リポジトリ（`origin`） | https://github.com/seipass/hasilan-code |
| 本家リポジトリ（`upstream`） | https://github.com/earendil-works/pi |
| 取り込み済みリリース | [Pi v1.3.0](https://github.com/earendil-works/pi/releases/tag/v1.3.0) |
| 上流コミット | `71023aec1546d6d677a65669c5665c0927ce0dd0` |
| Webハーネス | `packages/web-harness`（npm名 `hasilan-code`） |
| 同梱するPiのソース | `packages/ai`、`packages/agent`、`packages/coding-agent`など |

Pi SDKはこのモノレポ内のworkspaceを参照します。npmのPiパッケージだけを差し替える更新方法は使いません。内部の`@earendil-works/*`名は上流との差分を小さくするため保持しており、本リポジトリからその名前でnpm公開することは想定していません。`hasilan-code`自体も現在は`private: true`です。GitHubでのソース公開とは別の設定です。

本家向けのGitHub Actionsは初回公開時にリポジトリ設定で無効化しています。自動同期・モデルカタログ公開・本家のIssue/PR受付制御は実行しません。上流の著作権表示とMITライセンスは保持します。oh-my-piのソース、prompt、fixture、native binaryは使用していません。

## 開発

Node.js 22.19以上が必要です。依存のlifecycle scriptは実行せずインストールします。PTY用native moduleの準備とビルド手順は [起動手順](packages/web-harness/README.md#起動) を参照してください。

```sh
npm install --ignore-scripts
npm run build
npm run check
```

テストは`./test.sh`または各パッケージの対象ファイルを指定して実行します。実プロバイダーを使うテストには認証と料金が伴うため、Webハーネスの会話・チーム検証はfaux providerを使います。

## 本家Piを更新する手順

初回clone時は`origin`だけが設定されるため、上流を追加します。

```sh
git remote add upstream https://github.com/earendil-works/pi.git
```

以降は次の手順で更新します。作業前に自分の変更をコミットし、他の作業者の変更がないことを確認してください。自動更新は行いません。

1. 対象リリースの変更履歴を読み、タグとコミットを確認する。
2. `git fetch upstream --tags`で取得し、作業ブランチで対象タグをmergeする。上流のGit履歴を保持し、WebハーネスとPi SDKへの独自変更を競合解決時に残す。
3. `packages/web-harness/package.json`のPi依存3件を対象リリースへ揃える。外部依存の変更はリリースノートとlifecycle scriptを確認する。
4. `npm install --package-lock-only --ignore-scripts`、`npm install --ignore-scripts`、`node scripts/generate-coding-agent-install-lock.mjs`で依存と生成lockを更新する。
5. `npm run check`、変更したSDK契約のテスト、Webハーネスの会話・チーム・再開・保存を検証する。既存認証や有料APIを使わず、隔離した設定ディレクトリとfaux providerで確認する。
6. このREADMEとWebハーネスのREADMEの上流バージョン・コミットを更新する。ロックファイルを含む差分を確認してコミットする。
7. ビルド後に自分のWebサーバーを再起動する。既存の`dist`や起動中のプロセスはソース更新だけでは切り替わらない。

独自の変更は`origin`へpushします。本家への変更提案は別途、本家の[貢献ルール](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md)に従って行います。

## ライセンス

[MIT](LICENSE)。本家Piの著作権表示を含みます。フォントなどの同梱アセットのライセンスは各ファイルの記載を参照してください。
