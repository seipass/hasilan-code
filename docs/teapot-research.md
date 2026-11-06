# Teapot から取り入れられる設計

2026-11-07 JST に [Teapot のコード](https://github.com/akku1139/teapot/commit/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a)と Hasilan Code の `cab89c175` を比較した。実行時の性能や成功率は計測していない。

## 優先度が高いもの

1. **Goal の完了条件を、別のモデル呼び出しで検証する。** Hasilan Code の `/goal` は担当モデルの完了申告で達成に変わる。Teapot はユーザーが検証条件を指定した場合、別のコンテキストを持つ検証役に成果を確認させ、承認で完了、修正要求で再作業に進む。検証不能も完了扱いにしない。Hasilan Code では「テストが通る」「指定の成果物がある」などの条件を任意で入力し、判定・根拠・再作業を Goal カードに表示するとよい。Teapot の検証役はシェルも呼べるため、実装する際は検証コマンドの実行権限を別途定める。 [Hasilan の Goal ツール](../packages/web-harness/src/server/team-manager.ts) [Teapot の監査処理](https://github.com/akku1139/teapot/blob/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a/src/agent/agent.ts#L2777) [検証不能の回帰テスト](https://github.com/akku1139/teapot/blob/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a/test/audit-fail-open.test.ts#L10)
2. **Goal とチームの途中経過を構造化して表示する。** Teapot は人も確認できるチェックリストを項目単位で更新し、コンテキストの要約後にも Goal と一覧を再提示する。別の `report_progress` では、作業中の内容・達成状況・直近の試行・問題・次の一手を受け取る。Hasilan Code では既存のチーム詳細に最新の進捗を表示し、Goal カードに残作業を置けば、チャットを読み返す手間が減る。 [Hasilan のチーム詳細](../packages/web-harness/src/client/TeamPane.tsx) [Teapot の進捗報告](https://github.com/akku1139/teapot/blob/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a/src/agent/meta-tools.ts#L33) [チェックリストの部分更新](https://github.com/akku1139/teapot/blob/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a/src/agent/meta-tools.ts#L193) [要約後の再提示テスト](https://github.com/akku1139/teapot/blob/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a/test/compact-re-attaches-goal-todo.test.ts#L18)

## 用途が合えば取り入れたいもの

- **ワークスペース単位の定期実行。** Teapot は cron が一致した分を記録して同じ分の重複を抑え、設定済みエージェントへ指示をキュー投入する。Hasilan Code なら、毎朝の失敗テスト集計などを対象に、実行ごとの会話と結果一覧を作る案がある。タイムゾーン・停止中の取りこぼし・前回が実行中の場合の扱いは Hasilan Code 側で決める。 [Teapot の定期実行](https://github.com/akku1139/teapot/blob/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a/src/master.ts#L1761)
- **手動スクロールとレイアウトによる移動を分けて扱う。** Hasilan Code は既に表示行の位置を保持している。まだガタつく場合は、Teapot のように入力・プログラム移動・高さ変更を分離して観測し、ホイールやタッチ操作中は古い位置への補正を抑える方法を検証する。現行の仮想リストを前提にした追加改善候補。 [Hasilan のスクロール処理](../packages/web-harness/src/client/Conversation.tsx) [Teapot の原因分類](https://github.com/akku1139/teapot/blob/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a/frontend/lib/scroll-policy.ts#L44) [補正の抑制](https://github.com/akku1139/teapot/blob/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a/frontend/lib/scroll-policy.ts#L124)

並列実行、履歴の永続化、端末、ファイル編集は双方にある。差分の大きい **Goal の検証と途中経過** を先に検討する。Teapot は AGPL-3.0 表記のため、上記は既存の Hasilan Code 上に独自実装する案として整理した。 [Teapot README](https://github.com/akku1139/teapot/blob/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a/README.md) [Teapot LICENSE](https://github.com/akku1139/teapot/blob/6a5ae0ddd5f9ff6e37ad8a51c2c276073ad0d93a/LICENSE)
