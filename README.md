# gtrends

Google Trends の薄いラッパー (Deno)。依存ゼロ、ブラウザ自動化不要。

急上昇トレンドは旧エンドポイントが廃止済みのため、pytrends や google-trends-api では取得できません。
本ライブラリは新経路 (batchexecute / RSS / HTML 埋め込み) に対応しています。

```sh
deno add jsr:@uyu/gtrends
```

権限は `--allow-net=trends.google.com` だけで動きます。

## 使い方

```ts
import { GTrends } from "@uyu/gtrends";

const gt = new GTrends({ hl: "ja", tz: -540, geo: "JP" });

// 急上昇 (Cookie 不要)
await gt.trendingNow("JP", { hours: 24, newsCount: 3 });
await gt.trendingRss("JP");           // 10 件固定・最軽量
await gt.trendingNowFromHtml("JP");   // GET 1 回・hours=24 固定

// Explore 系 (NID Cookie は自動取得)
await gt.interestOverTime(["youtube"], { time: "today 12-m" });
await gt.interestByRegion(["youtube"], { resolution: "CITY" });
await gt.relatedQueries(["youtube"]);

// メタデータ
await gt.autocomplete("nintendo");    // キーワード → mid
await gt.geoTree();                   // 地域マスタ (約 130KB)
await gt.categoryTree();              // カテゴリマスタ (約 60KB)
```

生の JSON が要る場合は `fetchExplore` / `fetchWidgetData` / `parseBatchExecute` などの
低レベル API と、codec 層の純粋関数を個別に import できます。

## 使う上での注意

- **`points` や `areas` が空配列で返ることがあります** (検索ボリュームが 0 の語)
- **時系列の末尾 1 点は `partial: true` の未確定値**です。確定値だけ欲しいなら捨ててください
- **`hasData` が true でも `value` が 0 になることがあります** (実値が 0 超 1 未満のとき)
- **`interestByRegion` の `CITY` 粒度では `code` が `null`** になり、代わりに `coords` が入ります
- **関連トピックは Google 側が常に空を返す**ため提供していません
- キーワードの比較は**最大 5 件**です

## レート制限

サーバ側は容量 90〜100 件のトークンバケットとして振る舞います。
**既定は 60 件/分・同時実行 1** で、内部で直列化しています。効くのは間隔より並列度です。

`new GTrends({ minIntervalMs: 2000 })` でさらに保守的にできます。

これを大きく超える量が必要なら、BigQuery 公開データセット `bigquery-public-data.google_trends`、
Google Trends 公式 API、商用 SERP プロバイダを検討してください。
IP や Cookie のローテーションで制限を超えるのは規約違反です。

## 開発

```sh
deno task test        # ユニットテスト (ネットワーク不要)
deno task test:live   # ライブ統合テスト
deno task check       # fmt + lint + 型検査
deno task fixtures    # フィクスチャの再録画
```

ライブ統合テストは GitHub Actions で 1 日おきに走り、ワイヤ仕様が変わると issue が立ちます。

エンドポイントの詳細な実測仕様は [live_integration/README.md](./live_integration/README.md) にあります。

## 注意

Google の非公開の内部 API を利用しています。予告なく変更・廃止されうるため、
個人利用・低頻度アクセスを前提としてください。

## ライセンス

MIT
