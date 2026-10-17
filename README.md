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
- Git
- AI モデルを利用するための認証または API キー
- `node-pty` をビルドできる環境（環境によって追加の開発ツールが必要です）

### インストールと起動

リポジトリを取得し、ターミナルで次のコマンドを順番に実行します。

```sh
git clone https://github.com/seipass/hasilan-code.git
cd hasilan-code
npm install --ignore-scripts
npm rebuild node-pty --ignore-scripts=false --foreground-scripts
npm run build
npx playwright install chromium
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
# 全体のビルド
npm run build

# 型やコード品質などの確認（整形によるファイル更新を含む）
npm run check

# 通常のテスト
./test.sh
```

Web 側のコードだけを変更した場合は、`npm run build --workspace=hasilan-code` でビルドできます。ビルド後はサーバーを再起動し、ブラウザーを再読み込みしてください。

開発時の規則は [`AGENTS.md`](AGENTS.md)、貢献に関する案内は [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照してください。実際の AI プロバイダーを呼び出すテストには、認証や利用料金が必要な場合があります。

## 本家 Pi との関係

Hasilan Code は [Pi](https://github.com/earendil-works/pi) を基盤にした独立プロジェクトです。Pi の公式配布物ではありません。現在取り込んでいる Pi のリリースとコミットは次のとおりです。

| 項目 | 内容 |
| --- | --- |
| 独自リポジトリ | [`seipass/hasilan-code`](https://github.com/seipass/hasilan-code) |
| 上流リポジトリ | [`earendil-works/pi`](https://github.com/earendil-works/pi) |
| 取り込み済みのリリース | [Pi v1.3.0](https://github.com/earendil-works/pi/releases/tag/v1.3.0) |
| 上流のコミット | `71023aec1546d6d677a65669c5665c0927ce0dd0` |

Pi の主要パッケージは、リポジトリ内の共有パッケージを参照します。内部の `@earendil-works/*` という名前は、上流との差分を小さくするために残しています。Hasilan Code と同梱パッケージを、このリポジトリから npm に公開する予定はありません。

上流の更新は手動で行います。本家用の自動同期や公開処理は、このリポジトリでは使用しません。`oh-my-pi` のソース、プロンプト、テスト用データ、ネイティブバイナリは使用していません。

<details>
<summary>上流 Pi の更新手順</summary>

作業前に自分の変更をコミットし、ほかの作業者による変更がないことを確認してください。対象リリースの変更点も先に確認します。

1. 初回のみ、上流リポジトリを登録します。

   ```sh
   git remote add upstream https://github.com/earendil-works/pi.git
   ```

2. `git fetch upstream --tags` で上流のタグを取得し、作業ブランチで対象のタグをマージします。競合を解決するときは、独自の変更を残してください。
3. `packages/web-harness/package.json` にある Pi 関連の依存 3 件を取り込み対象のバージョンに揃えます。
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
