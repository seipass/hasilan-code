# Hasilan Codeのリリース

以下のコマンドはリポジトリのルートで実行してください。

本体のバージョンは`packages/web-harness/package.json`のバージョン、基盤 Pi のバージョンは同ファイルの`hasilanCode.piVersion`で別々に管理します。本家の`release:patch`や`version:patch`はこのアプリのリリースに使いません。

- [Hasilan Code CI](../.github/workflows/hasilan-ci.yml): Windows・macOS・Linux でビルド、全体チェック、対象テストを実行します。Ubuntu で作った同一の配布物を 3 OS のリポジトリ外へインストールし、CLI・変更済み SDK・認証付き HTTP・実際の PTY 入出力を検証します。
- [Hasilan Code Release](../.github/workflows/hasilan-release.yml): `hasilan-vX.Y.Z`タグだけで動作し、CI で検証した配布物・インストーラー・`SHA256SUMS`・ソース情報を GitHub Releases へ公開します。本家の`vX.Y.Z`タグとは分離します。同じバージョンの配布物を上書きしません。
- ビルドには`nix/model-catalog.json`で固定した Pi のモデルカタログを、SHA-256 で検証してから使用します。実行時依存の解決結果がルート lockfile にないバージョンへ変わった場合はパッケージ作成を拒否します。

ローカルで配布物を作り、作業ツリー外への導入を検証します。

```sh
npm run pack:hasilan
npm run smoke:hasilan
```

Linux の配布物検証は`npm run smoke:hasilan -- --build-pty`で行います。成果物は`.artifacts/hasilan-code/`です。ソース workspace を直接`npm publish`すると拒否します。公開するのは検証済みの tarball だけです。

次の手順でリリースします。

1. 修正なら`npm run version:hasilan:patch`、機能追加なら`npm run version:hasilan:minor`でアプリだけを更新します。Pi のバージョンは変えません。
2. 更新内容と lockfile を確認し、`npm run pack:hasilan`、`npm run smoke:hasilan`を実行します。
3. 検証した変更をコミットして`main`へ push します。
4. `git tag hasilan-vX.Y.Z`、`git push origin hasilan-vX.Y.Z`で公開します。npm の通常導入先は明示的に`latest`へ設定します。
5. GitHub Actions の成功と公開先を確認します。公開済みタグ・配布物は置き換えず、修正は次のバージョンで出します。npm 公開だけが失敗した場合は失敗ジョブだけを再実行します。

## npmの初回公開とtrusted publishing

初回のみ所有者が`npm login --registry=https://registry.npmjs.org --auth-type=web`で認証し、検証済みの`hasilan-code-X.Y.Z.tgz`を`npm publish <tarball> --tag latest --access public --ignore-scripts`で公開します。認証コードやトークンはリポジトリやチャットへ保存しません。

以降の公開では npm 11.15 以上を使い、GitHub Actions を Trusted Publisher として登録します。ブラウザーでの本人認証が求められたら、その画面で承認してください。

```sh
npm trust github hasilan-code --file hasilan-release.yml --repository seipass/hasilan-code --environment npm-publish --allow-publish --yes
```

登録後に GitHub のリポジトリ変数`HASILAN_NPM_PUBLISH=true`を設定すると npm 公開ジョブが有効になります。長期保存する npm token は不要です。未設定時も GitHub Releases は公開しますが、npm 公開ジョブは明示的にスキップします。詳細は[npm の公式手順](https://docs.npmjs.com/trusted-publishers/)を参照してください。

新しい Trusted Publisher 設定は 2 日以内の最初の公開で検証する必要があります。次の未公開バージョンを公開できる時点で登録し、そのタグの npm 公開ジョブが成功することまで確認してください。

自動公開の再実行をスキップするのは、npm上の同じバージョンが検証済みアーカイブと一致する場合だけです。公開要求が受け付けられても、メタデータと実際にダウンロードした配布物のSHA-512が一致するまでは成功にしません。公開反映待ちは上流と同じ最大10分です。

公開結果だけを手動で確認する場合は、検証済み配布物のディレクトリを指定します。このコマンドは公開操作を行いません。

```sh
node scripts/hasilan-publish.mjs .artifacts/hasilan-code
```
