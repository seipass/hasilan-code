# 上流 Pi の更新手順

以下のコマンドは、すべてリポジトリのルートディレクトリで実行してください。

作業前に手元の変更をコミットし、ワーキングツリーがクリーンな状態であることを確認してください。また、取り込み対象となる上流リリースの変更点・リリースノートを事前に確認してください。

1. **上流リポジトリの登録（初回のみ）**

   ```sh
   git remote add upstream https://github.com/earendil-works/pi.git
   ```

2. **タグの取得とマージ**

   ```sh
   git fetch upstream --tags
   ```

   作業ブランチに対象タグをマージします。マージ競合（コンフリクト）が発生した場合は、本プロジェクト固有の変更や拡張コードを維持して解消してください。

3. **バージョンと依存定義の整合**
   - `packages/web-harness/package.json` 内の Pi 関連依存関係（3件）および `hasilanCode.piVersion` / `hasilanCode.piCommit` を対象リリースに合わせて更新します。
   - `nix/model-catalog.json` のモデルカタログが上流 Pi の API と互換性を持っているか確認します。
   - 外部依存パッケージの変更がある場合は、リリースノートとライフサイクルスクリプトのセキュリティを確認してください。

4. **依存関係とロックファイルの更新**

   ```sh
   npm install --package-lock-only --ignore-scripts
   npm install --ignore-scripts
   node scripts/generate-coding-agent-install-lock.mjs
   ```

5. **検証の実行**
   - `npm run check` および影響箇所のテストを実行します。
   - 隔離した設定ディレクトリとモックプロバイダー環境を使用し、会話、チーム（百鬼夜行）、セッション再開、データ保存などの基本操作が正常に動作するか確認してください。

6. **ドキュメントの更新**
   - [README.md](../README.md) および [`packages/web-harness/README.md`](../packages/web-harness/README.md) に記載されている上流バージョンとコミットハッシュを更新し、変更差分を確認します。

7. **ビルドと動作確認**
   - `npm run build:hasilan` で全体を再ビルドし、Web サーバーを再起動して挙動を確認します。

※ 上流リポジトリ（Pi 本家）への機能提案や不具合報告を行う場合は、[Pi の貢献ガイドライン](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) を参照してください。
