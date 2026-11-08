# Hasilan Code のリリース手順

以下のコマンドは、すべてリポジトリのルートディレクトリで実行してください。

本体のバージョン（`packages/web-harness/package.json` の `version`）と基盤となる Pi のバージョン（同ファイルの `hasilanCode.piVersion`）は個別に管理されます。上流のリリース用コマンド（`release:patch` や `version:patch` 等）は使用しません。

### CI / CD ワークフロー構成

- **[Hasilan Code CI](../.github/workflows/hasilan-ci.yml)**: Windows、macOS、Linux の各 OS 上でビルド、整合性チェック、テストを実行します。Ubuntu ジョブで生成された単一の配布 tarball を 3 つの OS のリポジトリ外部環境へ実際にインストールし、CLI 起動、カスタマイズ済み SDK の整合性、認証付き HTTP 通信、PTY 端末の入出力を検証します。
- **[Hasilan Code Release](../.github/workflows/hasilan-release.yml)**: `hasilan-vX.Y.Z` 形式の Git タグがプッシュされた場合に起動します。CI で検証された Web 配布パッケージおよび Windows デスクトップ版インストーラー、`SHA256SUMS`、ソースコード情報を GitHub Releases へ自動公開します（本家の `vX.Y.Z` タグとは分離して管理され、既存バージョンを上書きすることはありません）。
- **依存関係の厳格性**: ビルド時は `nix/model-catalog.json` で固定された Pi のモデルカタログを SHA-256 で検証し、`nix/hasilan-model-catalog.json` で定義された独自モデルを追加して利用します。実行時依存パッケージの解決結果がルートの `package-lock.json` と乖離している場合、パッケージ作成はエラーとなります。

## ローカルでの検証

配布パッケージをローカルで生成し、ワーキングツリー外の隔離環境へのインストール・動作を検証します。

```sh
npm run pack:hasilan
npm run smoke:hasilan
```

Linux 環境でのスモークテストは `npm run smoke:hasilan -- --build-pty` を実行してください。生成された成果物は `.artifacts/hasilan-code/` に出力されます。ソースコードのワークスペースを直接 `npm publish` することは禁止されており、検証済みの tarball のみが公開対象となります。

## リリース作業フロー

1. **バージョンのインクリメント**
   - パッチ修正の場合は `npm run version:hasilan:patch`、マイナー機能追加の場合は `npm run version:hasilan:minor` を実行します（Pi のバージョンは変更されません）。
2. **ビルドとスモークテスト**
   - 変更内容とロックファイルを確認後、`npm run pack:hasilan` および `npm run smoke:hasilan` を実行して検証します。
3. **コミットとプッシュ**
   - 検証済みの変更をコミットし、`main` ブランチへプッシュします。
4. **リリースタグの発行**
   - `git tag hasilan-vX.Y.Z` を作成し、`git push origin hasilan-vX.Y.Z` でプッシュします。
5. **公開の確認**
   - GitHub Actions の実行完了と配布物の公開状態を確認します。公開済みタグや配布アーカイブの上書き修正は行わず、修正が必要な場合は常に次期バージョンを発行してください。

> [!TIP]
> - 3 OS での検証が成功した後にデスクトップ版の検証スクリプトのみに修正が必要となった場合、`main` に修正を反映した上で `Hasilan Code Release` ワークフローを手動実行できます。`release_tag` に既存タグ、`verified_run_id` に検証成功時のジョブ実行 ID を指定することで、同一の検証済み Web 配布物を用いてデスクトップ版を再生成できます。
> - GitHub Releases の公開が完了し、npm への公開のみが失敗・未完了の場合は、上記の手動実行パラメータに `npm_only` を指定して再実行できます。GitHub 上に公開済みのアーカイブと検証済みアーカイブの SHA-256 が完全一致する場合に限り、npm への公開が実行されます。

## npm の初回公開と Trusted Publishing

初回公開時のみ、パッケージ所有者が `npm login --registry=https://registry.npmjs.org --auth-type=web` で認証を行い、検証済みの `hasilan-code-X.Y.Z.tgz` を以下のコマンドで公開します（認証トークン等をリポジトリやログに残さないでください）。

```sh
npm publish <tarball> --tag latest --access public --ignore-scripts
```

以降の自動公開では npm 11.15 以上を使用し、GitHub Actions を Trusted Publisher として設定します。

```sh
npm trust github hasilan-code --file hasilan-release.yml --repository seipass/hasilan-code --environment npm-publish --allow-publish --yes
```

登録完了後、GitHub のリポジトリ変数 `HASILAN_NPM_PUBLISH=true` を設定すると、ワークフロー内の npm 公開ジョブが有効化されます（静的な長期 npm トークンの保管は不要です）。未設定時は GitHub Releases のみが公開され、npm 公開ジョブはスキップされます。詳細な仕様は [npm 公式ドキュメント（Trusted Publishers）](https://docs.npmjs.com/trusted-publishers/) を参照してください。

公開結果のみを手動確認する場合は、検証済み配布物が格納されたディレクトリを指定して以下のスクリプトを実行します（公開処理自体は行われません）。

```sh
node scripts/hasilan-publish.mjs .artifacts/hasilan-code
```
