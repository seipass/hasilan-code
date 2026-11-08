Linux で端末機能の準備が不足している場合の起動案内を改善した修正版です。

## 修正内容

- **Linux の起動エラー**：端末用モジュール `node-pty` が見つからない場合、内部のエラー表示だけで終了せず、必要な準備方法を案内するようにしました。
- **セットアップ時の確認**：Linux で端末用モジュールが未ビルドの場合に、その状態をわかりやすく示します。
- **ほかの OS の案内**：Windows・macOS で同じモジュールを読み込めない場合は、インストール状態を確認するための案内を表示します。

## Linux での準備

Linux では C++ コンパイラー・make・Python を用意して、`hasilan-code setup --build-pty` を実行してください。Linux 用の端末モジュールは事前ビルド済みの形で同梱していません。

## インストール・更新

Node.js 22.19.0 以上を用意し、以下のコマンドでこのバージョンを指定して導入できます。

```sh
npm install --global --ignore-scripts hasilan-code@0.1.4
hasilan-code setup
hasilan-code
```

GitHub Releases には配布用アーカイブとインストーラーを添付しています。詳しくは[このバージョンの導入手順](https://github.com/seipass/hasilan-code/blob/hasilan-v0.1.4/README.md)を参照してください。認証情報と会話履歴はインストール先とは別に保存されます。配布物の検証には添付の `SHA256SUMS` を使用してください。

[前のリリースからの変更一覧](https://github.com/seipass/hasilan-code/compare/hasilan-v0.1.3...hasilan-v0.1.4)
