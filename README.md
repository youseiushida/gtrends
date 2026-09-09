# gtrends

Google Trends の薄いラッパー (Deno)。依存ゼロ。

```sh
deno add jsr:@uyu/gtrends
```

```ts
import { GTrends } from "@uyu/gtrends";

const gt = new GTrends({ hl: "ja", tz: -540, geo: "JP" });

// 急上昇 (Cookie 不要)
await gt.trendingNow("JP", { hours: 24, newsCount: 3 });
await gt.trendingRss("JP"); // 10 件・軽量

// Explore 系 (Cookie は自動取得)
await gt.interestOverTime(["youtube"]);
await gt.interestByRegion(["youtube"]);
await gt.relatedQueries(["youtube"]);

// メタデータ
await gt.autocomplete("nintendo"); // キーワード → mid
await gt.geoTree();
await gt.categoryTree();
```

権限は `--allow-net=trends.google.com` のみ。生の JSON が要る場合は `fetchExplore` /
`fetchWidgetData` / `parseBatchExecute` 等の低レベル API も公開しています。

## 注意点

- `points` / `areas` は**空配列で返ることがある** (検索ボリューム 0 の語)
- 時系列の**末尾 1 点は未確定** (`partial: true`)
- `hasData` が true でも `value` は 0 になりうる (実値が 0 超 1 未満)
- `interestByRegion` の `CITY` 粒度は `code` が null で、代わりに `coords` が入る
- 関連トピックは Google 側が常に空を返すため未提供
- キーワード比較は最大 5 件
- 既定 60 件/分・同時実行 1 に自動で制御 (`minIntervalMs` で調整可)

非公開の内部 API を利用しているため予告なく壊れます。 エンドポイントの実測仕様は
[live_integration/README.md](./live_integration/README.md)。

## 開発

```sh
deno task test        # ユニット (ネットワーク不要)
deno task test:live   # ライブ統合
```

MIT
