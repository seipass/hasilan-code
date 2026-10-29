# Jev Computer Use OSS の実装調査

調査日: 2026-10-28 JST。一次資料のコードを読んだ比較であり、実機での速度・成功率比較はしていない。製品コードは変更していない。

## ネイティブデスクトップ

### awlevin/typesafe-computer-use

確認した版: [`44ca11f0935b021b73020825da054b5c92cc1288`](https://github.com/awlevin/typesafe-computer-use/commit/44ca11f0935b021b73020825da054b5c92cc1288)。macOS を中心にした実装で、Windows アダプターはコード上で experimental とされている。

- **OCR とアクセシビリティを併用する。** 画面内の文字を OCR で読み、OS が公開する操作部品と統合して番号を付ける。重なった同一対象は統合し、元の OS 部品への参照も番号に結び付ける。OS の部品一覧に対象がなくても、OCR の文字領域をクリック対象にできる。[perception.py](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/perception.py#L84)、[統合処理](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/perception.py#L636)
- **操作の種類と対象を別の質問にする。** 1 回の Jev リクエストで、`kind` はクリック・入力・スクロール等から選び、`item` はクリック対象から選ぶ。入力は既にフォーカスされた欄が内容を必要としている場合に限るため、「入力欄をクリック」と「同じ欄へ入力」を同じ意味の候補として競合させない。[decide.py](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/decide.py#L29)、[質問構成](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/decide.py#L205)
- **名前のほかに位置と周辺情報を渡す。** 各候補には `top-left` 等の位置、部品の役割を付ける。同名候補には同じ行にある文字も付け、たとえば複数の「Buy」を区別する。[item_criteria](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/decide.py#L91)、[base_state](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/decide.py#L127)
- **閾値は現在の Hasilan と異なる。** 実行継続には選択回答の `confidence` を使い、既定値は 0.4。クリック時は操作と対象の confidence の低い方を使う。Hasilan のように選択確率 0.75/0.8 と confidence を両方満たす条件ではない。この数値が Hasilan に適するとは未検証。[config.py](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/config.py#L11)、[confidence](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/decide.py#L189)、[停止判定](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/runner.py#L340)
- **実行後の結果を見る。** OS の部品に直接操作できる場合は先にそれを試し、拒否された場合は画素座標でのクリックに戻る。入力は値を読み返し、通常の入力では Jev にも結果を確認させる。画面が変わらない操作や同じ画面での反復を検出して停止・再指示につなげる。[actions.py](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/actions.py#L48)、[入力](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/actions.py#L105)、[runner.py](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/runner.py#L181)

作者の設計説明には、同じ意味の候補が複数あると確信度が分散して停止につながった、と明記されている。これは作者の開発上の観測であり、全アプリの成功率を示す結果ではない。[how-a-step-works.md](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/docs/how-a-step-works.md#L55)

**Windows の注意点:** 操作部品候補の `_ui_attrs` は `Name` を読む。全ての無名入力欄をそのまま残す実装ではない。共有の探索処理には親や行・セル内の文字からラベルを補う処理がある。フォーカス済み入力欄は別に取得し、placeholder と値も渡す。OCR との併用を含めて比較する必要がある。また Windows の OCR 言語はこの版では `en` 固定で、中央モニターの日本語 YMM4 でそのまま使えるという根拠にはならない。[Windows 候補](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/windows.py#L555)、[フォーカス済み欄](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/windows.py#L464)、[ラベル補完](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/ax_walk.py#L197)、[OCR 設定](https://github.com/awlevin/typesafe-computer-use/blob/44ca11f0935b021b73020825da054b5c92cc1288/typesafe_computer_use/windows.py#L38)

### savka777/jev-use

確認した版: [`b22e568adf110eeb64f89bf4d731a69d23c461dc`](https://github.com/savka777/jev-use/commit/b22e568adf110eeb64f89bf4d731a69d23c461dc)。macOS のアクセシビリティを使う別実装。

- **無名入力欄を捨てない。** 編集可能な役割の部品は名前が空でも対象として残す。表示名は値、役割、DOM 識別子、親コンテナ等で補い、同じ名前が異なる場所にあれば番号で区別する。タイトル・説明・ヘルプ・placeholder・ラベル用の別部品も読む。[属性取得](https://github.com/savka777/jev-use/blob/b22e568adf110eeb64f89bf4d731a69d23c461dc/Sources/JevDesktop/Desktop.swift#L112)、[無名欄と候補名](https://github.com/savka777/jev-use/blob/b22e568adf110eeb64f89bf4d731a69d23c461dc/Sources/JevDesktop/Desktop.swift#L615)
- **現在の操作と対応する対象を別々に選ぶ。** `operation` と操作別の target head を 1 回の Jev リクエストで質問する。指示では、入力する文があるなら事前クリックより `TYPE_TEXT` を優先する。ラベルだけでなく値・入力欄の種類・領域を渡す。[Decision.swift](https://github.com/savka777/jev-use/blob/b22e568adf110eeb64f89bf4d731a69d23c461dc/Sources/JevCore/Decision.swift#L225)、[入力候補](https://github.com/savka777/jev-use/blob/b22e568adf110eeb64f89bf4d731a69d23c461dc/Sources/JevDesktop/Desktop.swift#L714)
- **対象部品への操作と再確認を持つ。** 対象アプリ・ウィンドウ・部品名の変化を確認し、入力時は OS のフォーカス設定を試してから必要なら部品位置へのクリックに戻る。入力した値の読戻しも行う。[実行](https://github.com/savka777/jev-use/blob/b22e568adf110eeb64f89bf4d731a69d23c461dc/Sources/JevDesktop/Desktop.swift#L1067)、[入力処理](https://github.com/savka777/jev-use/blob/b22e568adf110eeb64f89bf4d731a69d23c461dc/Sources/JevDesktop/Desktop.swift#L1231)

## ブラウザー

### browser-use/jev-ultrafast

確認した版: [`1231850a0bf1a0c0341fe408ef1668dbbfdfac46`](https://github.com/browser-use/jev-ultrafast/commit/1231850a0bf1a0c0341fe408ef1668dbbfdfac46)。ブラウザー専用であり、Windows アプリの UI Automation と同じ取得能力を持つわけではない。

- **DOM の実部品を番号付き候補にする。** ノードへの参照、役割、名前、現在値、選択状態を取得する。名前が空でも役割をラベルに使うため、編集可能な欄を名前の有無だけでは捨てない。[snapshot.js](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/snapshot.js#L52)
- **操作と対象を分離し、対象を操作別に絞る。** 一つのノードに一つの表示番号を割り当て、クリック・入力・選択で候補の集合を分ける。一回のリクエストで操作と各対象を選ばせ、選択された操作に対応する対象だけを実行する。[action_space と choose](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/model.py#L48)
- **通常の判断は構造化データで行う。** 既定のループではスクリーンショットを Jev に渡さず、ページの文字・候補・値・最近の操作を渡す。文章生成用モデルは入力操作で呼ぶ。[choose](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/model.py#L108)、[入力用モデル呼出し](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/agent.py#L118)
- **部品の変化や操作の反復を扱う。** ページが変われば観測し直し、画面が変わらない操作が三回続けば停止する。スクロールや待機も、観測した状態に応じて候補にする。[agent.py](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/agent.py)、[snapshot.js](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/snapshot.js)

### moritzkremb/jev-voice-browser

確認した版: [`198a0764395a666f8398026c0d8abdaf6d1866c5`](https://github.com/moritzkremb/jev-voice-browser/commit/198a0764395a666f8398026c0d8abdaf6d1866c5)。音声指示を Playwright のブラウザー操作へ対応付ける実装。

- **無名入力欄を残す。** ラベルを得る際に表示文字や placeholder 等を使い、名前がなくても入力欄の役割なら候補から除かない。番号で実ノードと対応付ける。[snapshot.js](https://github.com/moritzkremb/jev-voice-browser/blob/198a0764395a666f8398026c0d8abdaf6d1866c5/src/snapshot.js#L192)
- **曖昧な候補をユーザーに選ばせる。** 対象の確信度が不足した場合、有力候補を二〜三件に絞って番号付きで提示する。該当する候補がなければ待機し、入力先の推定にはページの検索欄を使う経路も持つ。[policy.js](https://github.com/moritzkremb/jev-voice-browser/blob/198a0764395a666f8398026c0d8abdaf6d1866c5/src/policy.js#L218)
- **判定基準は実装ごとに異なる。** この版の対象選択は confidence 0.45、選択確率 0.35 を基準とし、モデルは `jev-1.13.0` に固定している。これをそのままデスクトップへ流用してよいという根拠にはならない。[constants.js](https://github.com/moritzkremb/jev-voice-browser/blob/198a0764395a666f8398026c0d8abdaf6d1866c5/src/constants.js#L58)

## 公式ドキュメントとの関係

TypeSafe は、複数の質問を一回で送り、選択された経路の回答だけをコードで使う方式を案内している。上記の操作と対象の並列選択に対応する。[Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)

confidence は選択確率の分布から計算する値で、選択確率そのものとは異なる。閾値は操作の影響と実際のデータに応じて調整するよう案内されており、全ての用途に同じ閾値を推奨しているわけではない。[Confidence](https://docs.typesafe.ai/confidence)

画像入力と Box による位置特定は、この調査日時点でも本番品質には達していない実験的機能とされている。構造化した部品情報や OCR を使う OSS の設計は参考になるが、この記載だけで今回の失敗を画像入力の問題と断定することはできない。[Images](https://docs.typesafe.ai/images)

## Hasilan の今回の失敗への示唆

Hasilan の `accessibility.ts` は `Name` が空の部品を候補から除き、`jev.ts` はその候補から対象を選ばせる。今回の記録では「欄が見える」の確率が 0.982 である一方、60 候補の対象選択は `none` が 0.977 だった。候補一覧そのものが保存されていないため、原因が「欄が候補から落ちた」か「欄はあったが対応付けできなかった」かはまだ確定できない。

上記 OSS から得られる設計上の候補は、無名入力欄の保持と役割・placeholder・周辺ラベルによる説明、OCR による補完、同じ操作を表す候補の統合、操作の種類と対象の分離、実行結果の読戻しである。これらは Hasilan への提案であり、YMM4 での動作を実測した結論ではない。閾値だけを下げても `none` が高確信度で選ばれた問題は解決しない。
