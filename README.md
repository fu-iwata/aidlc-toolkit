# AI-DLC Toolkit

AI-DLC（AI-Driven Development Life Cycle）で進めているプロジェクトの intent の一覧と、AI-DLC の audit から計算した推定コストを、VS Code の中で見るための拡張機能です。

> **非公式の拡張機能です。** AI-DLC（[awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows)）の開発元や AWS とは関係がなく、それらが作ったり保証したりするものではありません。

## できること

- **Intent 一覧**（アクティビティバー）: ワークスペースの AI-DLC の intent を一覧にし、phase と stage ごとの進み具合と、intent ごとの推定コストを表示します。作業中の intent が分かり、状態ファイル（`aidlc-state.md`）を開いたり、intent 名をコピーしたりできます。
- **使用量（今月）**（アクティビティバー）: 今月に完了した stage の使用量を、モデル別のトークン数と金額（USD と日本円）で表示します。
- **ステータスバー**: 今月の推定コスト（例 `AI-DLC 推定 ¥1,234`）を表示します。クリックすると内訳の画面を開きます。

記録が変わると自動で読み直します。拡張機能は記録を読むだけで、書き換えません。

AI-DLC の記録が無いワークスペースでは起動せず、アクティビティバーのアイコンとステータスバーも出ません。開いた後に初めて記録を作ったときは、ウィンドウを再読み込み（「Developer: Reload Window」）すると表示されます。

## 使う前に

- ワークスペースのフォルダのルートに、AI-DLC の記録（`aidlc/spaces/*/intents/`）があること。
- Intent 一覧と使用量（今月）は、どちらも作業中の space（`aidlc/active-space`、無ければ `default`）だけを数えます。intent の一覧は、その space の `intents.json` から読みます。
- マルチルートのワークスペースでは、AI-DLC の記録があるフォルダをすべて読みます。Intent 一覧はフォルダごとに見出しを分け、使用量（今月）は全部のフォルダの合計です。

## 対応している AI-DLC の版

AI-DLC 2.11.1 の記録（`aidlc-state.md`、`intents.json`、audit）の書式で確かめています。この拡張機能は記録の書式を直接読むので、AI-DLC の版が変わると読めなくなることがあります。読めないときは、Intent 一覧と使用量のビューに「書式を読めません」と表示し、黙って 0 円にはしません。

## 金額について

- 金額は、audit の `STAGE_COMPLETED` に記録されたトークン数と、拡張機能に同梱の単価表（Claude の公式の標準単価）から計算した**推定**です。請求額とは一致しません。画面にも「推定」と表示します。
- 同梱の単価表は、表示の中に「〜時点」と書いた日に公式の料金表で確かめた単価です。その後に料金が変わっても、拡張機能を更新するまでは古い単価で計算します。
- 動いている途中の stage と、AI-DLC の stage の外の会話は含みません。Web 検索などトークン以外の料金と税も含みません。
- 同梱の単価表に無いモデルは、ワークスペースの `.claude/tools/data/model-rates.json` の単価で補います。どちらにも無いモデルは金額に含めません。
- 自分の単価を使いたいときは、ユーザー設定の `aidlcToolkit.modelRates` に書きます。書いたモデルだけが、同梱の単価表より優先されます。

```jsonc
"aidlcToolkit.modelRates": {
  "opus-5-5": { "input": 4, "cacheWrite5m": 5, "cacheWrite1h": 8, "cacheRead": 0.2, "output": 20 }
}
```

## 設定

| 設定 | 既定値 | 説明 |
|---|---|---|
| `aidlcToolkit.usdJpyRate` | `150` | USD から JPY への換算レート。既定値は仮の値なので、実際に使うレートに合わせてください。 |
| `aidlcToolkit.timeZone` | `Asia/Tokyo` | 「今月」の境界を決めるタイムゾーン（IANA 名）。 |
| `aidlcToolkit.regionalPremium` | `false` | Amazon Bedrock の日本国内クロスリージョン推論（`jp.` の推論プロファイル）の上乗せ（+10%）を金額に含める。 |
| `aidlcToolkit.modelRates` | `{}` | 自分で使う単価（USD / 100 万トークン）。モデルごとに、同梱の単価表より優先されます。ユーザー設定にだけ書けます。 |
| `aidlcToolkit.modelRatesPath` | 空 | 同梱の単価表に無いモデルを補う単価表のパス。空ならワークスペースの `.claude/tools/data/model-rates.json`。ユーザー設定（リモートではそのマシンの設定）にだけ書けます。 |

## データの扱い

ワークスペースの中のファイルを読むだけで、外部への送信は行いません。

信頼していないワークスペース（制限モード）でも、AI-DLC の記録を読んで表示します。コードは実行しません。

## ライセンス

MIT ライセンス。全文は拡張機能に同梱の LICENSE ファイルにあります。
