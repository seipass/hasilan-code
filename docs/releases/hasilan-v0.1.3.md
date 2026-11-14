AI アカウントの接続先を増やし、利用上限や残量をアプリ内で確認しやすくした更新です。

## 新しい連携

- **Devin アカウントに対応**：ログイン情報の取得、利用できるモデルの一覧、応答の受信を組み込みました。
- **アカウント使用量の表示**：設定画面から、CommandCode・Devin・OpenAI/Codex（ChatGPT 認証）の利用上限、残量、更新時刻などを確認できます。
- **情報の更新**：使用量画面から取得し直せるようにし、対応するサービスごとの違いを扱える構成にしました。

## 注意事項

Devin の接続機能は非公式連携です。接続先サービスの仕様変更によって動作しなくなる場合があります。表示される使用量は各アカウントから取得した情報で、個別の会話のトークン集計とは異なります。

## インストール・更新

Node.js 22.19.0 以上を用意し、以下のコマンドでこのバージョンを指定して導入できます。

```sh
npm install --global --ignore-scripts hasilan-code@0.1.3
hasilan-code setup
hasilan-code
```

GitHub Releases には配布用アーカイブとインストーラーを添付しています。詳しくは[このバージョンの導入手順](https://github.com/seipass/hasilan-code/blob/hasilan-v0.1.3/README.md)を参照してください。認証情報と会話履歴はインストール先とは別に保存されます。配布物の検証には添付の `SHA256SUMS` を使用してください。

[前のリリースからの変更一覧](https://github.com/seipass/hasilan-code/compare/hasilan-v0.1.2...hasilan-v0.1.3)
