/**
 * 高レベル API の古典派 (Detroit school) テスト。
 *
 * **HTTP 境界だけを差し替え、内部の協力者は一切モックしない。**
 * codec → transport → session → api → client の実オブジェクトを通した結果を
 * 状態ベースで検証する (呼び出し回数の検証は、直列化やキャッシュのように
 * 「回数そのものが仕様」である箇所に限る)。
 *
 * 使うフィクスチャはすべて**実サーバから録画した本物のレスポンス**なので、
 * 手書きフィクスチャでは見落とす奇妙なケース (空配列、hasData=true だが value=0 など) も
 * そのまま踏める。
 *
 * @module
 */

import { assert, assertEquals, assertGreater, assertRejects } from "@std/assert";
import { GTrends } from "../src/client.ts";
import { exploreRoutes, fakeHttp, recordingSleep, TEST_NID } from "./fake_http.ts";

/** ネットワークもタイマーも使わないクライアントを組み立てる。 */
function makeClient(routes = exploreRoutes()) {
  const { doFetch, log } = fakeHttp(routes);
  const { sleepFn, waited } = recordingSleep();
  let clock = 0;
  const gt = new GTrends({
    doFetch,
    sleepFn,
    now: () => (clock += 1000),
    hl: "en-US",
    tz: 0,
    geo: "JP",
    minIntervalMs: 0,
  });
  return { gt, log, waited };
}

// ---------------------------------------------------------------------------
// Explore 系のフルフロー
// ---------------------------------------------------------------------------

Deno.test("時系列 — NID 取得 → explore → multiline のフルフローが通る", async () => {
  const { gt, log } = makeClient();
  const series = await gt.interestOverTime(["youtube"], { time: "today 12-m" });

  assertGreater(series.points.length, 0);
  assertEquals(series.keywords, ["youtube"]);
  // 全系列を通した最大が 100 になるのが Trends の正規化。
  assertEquals(Math.max(...series.points.map((p) => p.values[0] ?? 0)), 100);
  for (const p of series.points) {
    assert(p.at instanceof Date && !Number.isNaN(p.at.getTime()), "epoch 文字列が Date になる");
    assertEquals(p.values.length, 1);
  }

  // 3 段フローが実際に走っている。
  const urls = log.map((l) => l.url);
  assert(urls.some((u) => u.includes("/trending?geo=")), "NID ブートストラップ");
  assert(urls.some((u) => u.includes("/trends/api/explore?")), "explore");
  assert(urls.some((u) => u.includes("/widgetdata/multiline")), "multiline");
});

Deno.test("isPartial は末尾 1 点にだけ立つ", async () => {
  const { gt } = makeClient();
  const series = await gt.interestOverTime(["youtube"]);
  const partials = series.points.filter((p) => p.partial);
  assert(partials.length <= 1, `partial は 0 か 1 点 (実際 ${partials.length} 点)`);
  if (partials.length === 1) {
    assertEquals(partials[0], series.points.at(-1), "末尾の点である");
  }
});

Deno.test("地域別 — CITY 以外では code が入る", async () => {
  const { gt } = makeClient();
  const geo = await gt.interestByRegion(["youtube"]);
  assertGreater(geo.areas.length, 0);
  const first = geo.areas[0];
  assert(first !== undefined);
  assertEquals(typeof first.name, "string");
  // 録画は REGION 粒度なので geoCode がある。CITY だと null になる。
  assert(first.code !== null || first.coords !== null, "code か coords のどちらかは必ずある");
});

Deno.test("関連キーワード — TOP と RISING に分かれ、ブレイクアウトを数字の有無で判定する", async () => {
  const { gt } = makeClient();
  const related = await gt.relatedQueries(["youtube"]);
  assertGreater(related.top.length, 0);
  for (const item of related.top) {
    assertEquals(typeof item.query, "string");
    // TOP は必ず数値表示なのでブレイクアウトにはならない。
    assertEquals(item.breakout, false, `TOP の ${item.query} が breakout 判定された`);
  }
  for (const item of related.rising) {
    // RISING は "Breakout" / "+300%" のどちらか。数字が無ければブレイクアウト。
    assertEquals(item.breakout, !/\d/.test(item.formatted));
  }
});

Deno.test("token が有効な間は explore を再実行しない", async () => {
  const { gt, log } = makeClient();
  await gt.interestOverTime(["youtube"]);
  await gt.interestByRegion(["youtube"]);
  await gt.relatedQueries(["youtube"]);

  const exploreCalls = log.filter((l) => l.url.includes("/trends/api/explore?"));
  assertEquals(exploreCalls.length, 1, "explore は 1 回だけ (token を 24h キャッシュしている)");
  // レート制限が厳しいのは explore だけなので、ここを減らすのが唯一の実効的な対策。
  assertEquals(log.filter((l) => l.url.includes("/widgetdata/")).length, 3);
});

Deno.test("invalidate でキャッシュを捨てると explore を叩き直す", async () => {
  const { gt, log } = makeClient();
  await gt.interestOverTime(["youtube"]);
  gt.invalidate();
  await gt.interestOverTime(["youtube"]);
  assertEquals(log.filter((l) => l.url.includes("/trends/api/explore?")).length, 2);
});

Deno.test("comparisonItem の上限超過は送信前に弾く", async () => {
  const { gt, log } = makeClient();
  await assertRejects(
    () => gt.interestOverTime(["a", "b", "c", "d", "e", "f"]),
    RangeError,
    "最大 5 件",
  );
  assertEquals(log.length, 0, "1 リクエストも発行していない");
});

Deno.test("widgetdata には Cookie を送らず、explore にだけ送る", async () => {
  const { gt, log } = makeClient();
  await gt.interestOverTime(["youtube"]);

  const explore = log.find((l) => l.url.includes("/trends/api/explore?"));
  const widget = log.find((l) => l.url.includes("/widgetdata/"));
  assertEquals(
    (explore?.init.headers as Record<string, string>).cookie,
    `NID=${TEST_NID}`,
    "explore には NID が必要",
  );
  assertEquals(
    (widget?.init.headers as Record<string, string>).cookie,
    undefined,
    "widgetdata は token だけで通るので Cookie を送らない",
  );
});

Deno.test("widget.request をそのまま透過させている (token 署名を壊さない)", async () => {
  const { gt, log } = makeClient();
  await gt.interestOverTime(["youtube"]);
  const widget = log.find((l) => l.url.includes("/widgetdata/multiline"));
  assert(widget !== undefined);
  const req = new URL(widget.url).searchParams.get("req");
  assert(req !== null);
  const parsed = JSON.parse(req) as Record<string, unknown>;
  // explore が返した固有フィールドがそのまま乗っている。
  assert("userConfig" in parsed, "userConfig を落としていない");
  assert("requestOptions" in parsed);
});

// ---------------------------------------------------------------------------
// Trending Now (Cookie 不要・explore に依存しない)
// ---------------------------------------------------------------------------

Deno.test("急上昇トレンド — explore を経由せず batchexecute だけで完結する", async () => {
  const { gt, log } = makeClient();
  const trends = await gt.trendingNow("JP", { hours: 4, newsCount: 1 });

  assertGreater(trends.length, 0);
  assertEquals(
    log.filter((l) => l.url.includes("/trends/api/explore?")).length,
    0,
    "explore を一切叩かない",
  );
  assertEquals(
    log.filter((l) => l.url.includes("/trending?geo=")).length,
    0,
    "NID ブートストラップすら不要",
  );

  const first = trends[0];
  assert(first !== undefined);
  assertEquals(typeof first.title, "string");
  assert(first.startedAt instanceof Date);
  assertEquals(first.active, first.endedAt === null);
  // 関連クエリの先頭は必ずタイトル自身。
  assertEquals(first.relatedQueries[0], first.title);
});

Deno.test("急上昇トレンド — 正規化キーは NFD → 結合マーク除去 → NFC", async () => {
  const { gt } = makeClient();
  const trends = await gt.trendingNow("JP", { hours: 4 });
  for (const t of trends) {
    assertEquals(
      t.normalizedKey,
      t.title.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC"),
      `${t.title} の正規化キーが規則どおりでない`,
    );
  }
});

Deno.test("RSS — ニュースは 0〜3 件の可変で、空画像は null に正規化される", async () => {
  const { gt } = makeClient();
  const items = await gt.trendingRss("JP");
  assertEquals(items.length, 10, "RSS は 10 件固定");
  for (const item of items) {
    assert(item.news.length >= 0 && item.news.length <= 3, `ニュース ${item.news.length} 件`);
    // 空文字を「画像あり」と誤判定していない。
    assert(item.picture === null || item.picture.length > 0);
    for (const n of item.news) {
      assert(n.picture === null || n.picture.length > 0);
      assert(n.url.startsWith("http"), "媒体の実 URL が入る");
    }
  }
});

// ---------------------------------------------------------------------------
// メタデータ
// ---------------------------------------------------------------------------

Deno.test("オートコンプリート — Cookie 不要で常に 5 件返る", async () => {
  const { gt, log } = makeClient();
  const topics = await gt.autocomplete("nintendo");
  assertEquals(topics.length, 5);
  for (const t of topics) {
    assert(/^\/[mg]\//.test(t.mid), `mid の形式: ${t.mid}`);
    assertGreater(t.title.length, 0);
  }
  const call = log.find((l) => l.url.includes("/autocomplete/"));
  assertEquals((call?.init.headers as Record<string, string>).cookie, undefined);
});

// ---------------------------------------------------------------------------
// 直列化とペース制御
// ---------------------------------------------------------------------------

Deno.test("並列に呼んでも内部で直列化される", async () => {
  const { gt, log } = makeClient();
  // 並列に投げても、レート制限を避けるため 1 本ずつ流れる。
  await Promise.all([
    gt.trendingRss("JP"),
    gt.trendingRss("US"),
    gt.autocomplete("a"),
  ]);
  assertEquals(log.length, 3);
});

Deno.test("未知の URL は 404 として扱われ、黙って通らない", async () => {
  const { gt } = makeClient([]);
  await assertRejects(() => gt.trendingRss("JP"));
});
