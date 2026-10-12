# SUI-USDC LPダッシュボード

Cetus の SUI-USDC 集中流動性ポジション向けの確認ツールです。ウォレットアドレスは扱いません。ポジションの数量は手入力します。

- 外部データ源は **Cetus 公開API のみ**(APIキー不要、GitHub Secret 不要)
- SUI 価格は、プールの `current_sqrt_price` から計算(USDC = 1 USD)
- ±5/10/15/20/25/30/50% のレンジ別想定手数料、IL、損益分岐、離脱確率、ティア比較、価格シナリオ、履歴チャート

## ローカルで動かす

ES Modules を使うため、`file://` ではなく HTTP サーバー経由で開きます。

```bash
python3 -m http.server 8765
# http://localhost:8765/
```

## テスト

```bash
node --test tests/calc.test.mjs
node scripts/snapshot.mjs   # data/history.json に1件追記(ネットワーク必要)
```

## GitHub Pages で公開する

1. **public** リポジトリを作って push する(public なら Actions の分数は無制限)。
2. リポジトリの Settings → Pages → Source を「GitHub Actions」にする。
3. Actions タブで `pages` workflow を `Run workflow` する(以後は6時間ごとに自動実行)。

`pages.yml` は、(a) 6時間ごとに Cetus の価格・TVL・出来高を `data/history.json` に追記コミットし、(b) 同じ workflow 内でサイトをデプロイします。GITHUB_TOKEN による push は他の workflow を起動しないため、スナップショットとデプロイを1本にまとめています。

### ボラティリティ(σ)

履歴の 0.05% プール価格から、3〜12時間間隔の連続2点の対数リターンを使って日次σを推定します。有効サンプルが28本(約7日)に達するまでは、既定値 6%/日 を使い「暫定値」と表示します。画面から手入力で上書きもできます。

### API障害が長く続いたとき

Cetus API が60日間失敗し続けると、スナップショットのコミットが止まり、GitHub が scheduled workflow を自動で無効化することがあります。その場合は Actions タブで workflow を再度 Enable してください。

## 注意

- 手数料の見積もりは、現在 tick の有効流動性を分母にした近似です。価格がレンジ内を動くと分母が変わるため、狭いレンジほど振れます。
- プロトコル手数料率 20% は定数です(`calc.mjs` の `PROTOCOL_FEE_RATE`、Cetus GlobalConfig の `protocol_fee_rate`)。
- 試算は投資助言ではありません。
