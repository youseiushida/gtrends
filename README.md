# gtrends

Google Trends の薄いラッパー (Deno / TypeScript)。

ブラウザ自動化も外部依存も不要で、`fetch` + 文字列処理 + `JSON.parse` だけで動きます。
[実測調査](./live_integration/README.md)に基づいて実装しました。

```ts
import { GTrends } from "@youseiushida/gtrends";

const gt = new GTrends({ hl: "ja", tz: -540, geo: "JP" });

const trends = await gt.trendingNow();                    // 急上昇 (Cookie 不要)
const series = await gt.interestOverTime(["youtube"]);    // 時系列
const region = await gt.interestByRegion(["youtube"]);    // 地域別
const related = await gt.relatedQueries(["youtube"]);     // 関連キーワード
```

## なぜ作ったか

既存ライブラリには実際の空白があります (2026-09 に実測):

| | pytrends 4.9.2 | google-trends-api 4.9.2 | 本ライブラリ |
| --- | --- | --- | --- |
| 最終リリース | 2023-04 (2025-04 にアーカイブ) | 2022-06 | — |
| Explore 系 (時系列/地域/関連) | 動く | 動く | 対応 |
| **急上昇系** | **404** | **404** | **対応** |

急上昇系が死んでいるのはライブラリの不具合ではなく、**Google が旧エンドポイントを廃止した**ためです
(`/trends/api/dailytrends` と `/trends/api/realtimetrends` は 404、
`/trends/trendingsearches/daily` は `/trending` へ 302)。
新しい経路 (`batchexecute` の `i0OFE`、`/trending` の HTML 埋め込み、RSS) に
**どちらのライブラリも対応していません**。

## インストール

```sh
deno add jsr:@youseiushida/gtrends
```

必要な権限は `--allow-net=trends.google.com` だけです。

## API

### 急上昇 (Cookie 不要・最も安定)

```ts
import { GTrends } from "@youseiushida/gtrends";
const gt = new GTrends({ geo: "JP" });

// RPC 経由。時間窓とニュース展開数を指定できる (最も情報量が多い)
const a = await gt.trendingNow("JP", { hours: 24, newsCount: 3 });

// /trending の HTML 埋め込みから。GET 1 回で済むが hours=24 固定で 1.2MB
const b = await gt.trendingNowFromHtml("JP");

// RSS。10 件固定だが最軽量
const c = await gt.trendingRss("JP");
```

`hours` を大きくすると件数が増えます (実測 geo=JP: 4h→65 件、24h→428 件、168h→2,491 件)。
**`hours` と `newsCount` を同時に大きくすると数 MB になる**ので注意してください。

### Explore 系 (`NID` Cookie が必要)

```ts
import { GTrends } from "@youseiushida/gtrends";
const gt = new GTrends({ geo: "JP" });

const series = await gt.interestOverTime(["youtube"], { time: "today 12-m" });
const region = await gt.interestByRegion(["youtube"], { resolution: "CITY" });
const related = await gt.relatedQueries(["youtube"]);
```

Cookie の取得は自動です。`explore` が配る token は 24 時間有効なので
**内部でキャッシュし、同じ条件なら再取得しません** (レート制限対策として最も効きます)。

### メタデータ

```ts
import { GTrends } from "@youseiushida/gtrends";
const gt = new GTrends();

const topics = await gt.autocomplete("nintendo");  // キーワード → mid (常に 5 件)
const geos = await gt.geoTree();                   // 地域マスタ (約 130KB)
const cats = await gt.categoryTree();              // カテゴリマスタ (約 60KB)
```

マスタデータは日単位で変わらないので、呼び出し側でキャッシュしてください。

### 低レベル API

生の JSON が必要なら `fetchExplore` / `fetchWidgetData` / `parseBatchExecute` などを
個別に import できます。codec 層の純粋関数 (`stripXssiPrefix`、`decodeWidgetToken`、
`resolutionForSpan` など) も公開しています。

## このライブラリが吸収している落とし穴

調査で判明した非自明な仕様を、利用側が意識しなくて済むように内部で処理しています。

- **XSSI プレフィックスの長さがエンドポイントごとに違う** — `explore` は 5 バイト、
  `widgetdata` 系は 6 バイト (カンマ有り)。`slice(5)` 決め打ちは壊れます
- **`batchexecute` の長さ行は UTF-16 コードユニット数** — バイト長で読むと日本語で即壊れます
- **`res.ok` は使えない** — Google はエラーを `text/html` の 200 で返します。
  成功条件は `status === 200 && content-type が application/json`
- **`redirect: "manual"` 必須** — follow すると `/sorry` の CAPTCHA を 200 で掴みます
- **`batchexecute` は HTTP 200 でも RPC 単位で失敗する** (`wrb.fr[2] === null`)
- **`widget.request` は 1 バイトも変えられない** — token がその署名なので 401 になります
- **429 は 2 種類ある** — 未 Cookie ゲート (新 NID を配る・即再試行で回復) と
  レート制限 (何も配らない・IP スコープなので時間経過待ち)

## レート制限

サーバ側のリミッタは**容量 90〜100 件のトークンバケット**として振る舞います
(実測 10 走行で破綻位置が 89〜102 件目に集中。レートを 120→480/分 に上げても動かない)。

- **既定は 60 件/分・同時実行 1。** 内部で直列化しています
- 補充速度は 60/分 と 120/分 の間。60/分 なら 435 件を 7 分以上流しても枯れませんでした
- **効くのはリクエスト間隔より並列度です**
- 429 の先に **IP 単位の 302 `/sorry` ブロック**があり、こちらは Cookie を替えても回復しません

`new GTrends({ minIntervalMs: 2000 })` でさらに保守的にできます。

**これを大きく超える量が必要なら経路を変えてください。** IP や Cookie をローテーションして
制限を超える設計は Google の利用規約が禁じる回避行為です。大量取得の正規ルートは
BigQuery 公開データセット `bigquery-public-data.google_trends`、Google Trends 公式 API、
ライセンス済みの商用 SERP プロバイダです。

## 開発

```sh
deno task test        # ユニットテスト (ネットワーク不要)
deno task test:live   # ライブ統合テスト (実 API を叩く)
deno task check       # fmt + lint + 型検査
deno task dry         # JSR 公開の事前検査
deno task fixtures    # フィクスチャの再録画
```

### テスト方針

**古典派 (Detroit school)** で書いています。継ぎ目は HTTP 境界ただ 1 つで、
内部の協力者はモックしません。

- ユニットテストは録画済みの**実レスポンス**を返す `FakeHttp` を注入し、
  codec → transport → session → api → client の**実オブジェクトを通した**結果を検証します
- `--allow-net` を与えずに走らせるので、モックの漏れは `PermissionDenied` で機械的に検出されます
- 待機時間は `sleepFn` を差し替えて実時間ゼロで検証します

ライブ統合テストは GitHub Actions で **1 日おき**に走ります。
Google のワイヤ仕様が変わると issue が自動で立ちます。

**検証台帳**を持っており、レート制限で中核主張が検証されないまま緑になることを防いでいます。
429 で skip する設計は必要ですが、それをやると「N passed」が「N 件検証済み」を
意味しなくなるためです (調査中に実際に起きた事故です)。

## 注意

これは Google の**非公開の内部 API** を利用しています。予告なく、一切の互換性配慮なく
変更・廃止されうるものです。旧 `/trends/api/*` は退役中のスタック上にあり、
中期的に消える可能性があります。

また新 `batchexecute` 系は reCAPTCHA Enterprise に移行済みで、
将来 BotGuard トークンの検証が始まれば `fetch` ベースのラッパーは原理的に成立しなくなります
(現時点では不要であることを実測で確認しています)。

個人利用・低頻度アクセスを前提としてください。

## ライセンス

MIT
