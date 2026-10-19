# 上流 Pi の更新手順

以下のコマンドはリポジトリのルートで実行してください。

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
6. [ルートREADME](../README.md)と [`packages/web-harness/README.md`](../packages/web-harness/README.md) に記載した上流のバージョンとコミットを更新し、差分を確認します。
7. ビルド後、実行中の Web サーバーを再起動します。

本家への変更提案は[Pi 側の貢献ルール](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) に従ってください。
