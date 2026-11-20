# Hasilan Code 外部プラグインのサンプル

エージェントディレクトリの `plugins.json` に登録してホストを再起動すると読み込まれます。サイドバーの「プラグイン」画面からも追加・無効化・削除できます。

- `sample-tool/plugin.cjs`: Pi セッションへカスタムツール (`workspace_info`) を追加するサンプル
- `sample-panel/plugin.cjs` + `panel.js`: サイドバーに独自画面を追加し、下書きへテキストを送るサンプル
- `sample-theme/plugin.cjs`: 独自の配色テーマ (`Dusk (Sample)`) を追加するサンプル

`plugins.json` の設定例:

```json
{
  "sample-tool": "/path/to/examples/plugins/sample-tool/plugin.cjs",
  "sample-panel": "/path/to/examples/plugins/sample-panel/plugin.cjs",
  "sample-dusk": "/path/to/examples/plugins/sample-theme/plugin.cjs"
}
```
