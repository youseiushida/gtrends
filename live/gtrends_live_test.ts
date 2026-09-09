/**
 * ライブ統合テスト — 実際の Google Trends を叩いて回帰を検知する。
 *
 * ```sh
 * deno task test:live
 * # 自宅 IP を焼きたくない場合はプロキシ経由で:
 * HTTPS_PROXY=http://user:pass@host:port deno task test:live
 * ```
 *
 * ## 設計方針
 *
 * ネットワークは不安定なので 429 では**ハードに落とさず skip** する。
 * ただしそれをやると **「N passed」が「N 件検証済み」を意味しなくなる**。
 * 調査中に実際に「302 ブロック中に中核主張が一度も実行されないまま全テストが緑」
 * という事故が起きた。
 *
 * 対策として**検証台帳**を持ち、最後のテストで
 * **中核主張が 1 つでも未検証なら失敗させる**。
 * これがないとライブテストの存在意義がなくなる。
 *
 * @module
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import { GTrends } from "../src/client.ts";
import { TrendsHttpError } from "../src/transport.ts";

// ---------------------------------------------------------------------------
// 検証台帳
// ---------------------------------------------------------------------------

/** これらが検証されないまま緑になったら失敗させる。 */
const CORE_CLAIMS = [
  "trendingNow が Cookie 無しで動く",
  "RSS が 10 件返る",
  "autocomplete が 5 件返る",
  "explore が token を発行する",
  "multiline が時系列を返す",
] as const;

type Claim = (typeof CORE_CLAIMS)[number] | string;

const ledger = new Map<Claim, { verified: boolean; note: string }>();

function claimOk(claim: Claim, note = ""): void {
  ledger.set(claim, { verified: true, note });
}

function claimSkipped(claim: Claim, note = ""): void {
  if (ledger.get(claim)?.verified === true) return;
  ledger.set(claim, { verified: false, note });
}

/** レート制限やブロックなら skip、それ以外は本物の失敗として投げ直す。 */
function isTransient(e: unknown): boolean {
  if (e instanceof TrendsHttpError) {
    return e.outcome === "rate-limited" || e.outcome === "blocked" ||
      e.outcome === "server-error";
  }
  // ネットワーク断など。
  return e instanceof TypeError;
}

async function attempt(claim: Claim, fn: () => Promise<string>): Promise<void> {
  try {
    claimOk(claim, await fn());
  } catch (e) {
    if (isTransient(e)) {
      const reason = e instanceof TrendsHttpError ? e.outcome : "network";
      console.warn(`[skip] ${claim}: ${reason}`);
      claimSkipped(claim, reason);
      return;
    }
    throw e;
  }
}

/** ライブテスト用のクライアント。既定より保守的なペースにする。 */
function makeClient(): GTrends {
  return new GTrends({ hl: "en-US", tz: 0, geo: "JP", minIntervalMs: 1500 });
}

// ---------------------------------------------------------------------------
// Trending 系 (Cookie 不要・レート枠が緩いので先に回す)
// ---------------------------------------------------------------------------

Deno.test("live: trendingNow が Cookie 無しで急上昇一覧を返す", async () => {
  const gt = makeClient();
  await attempt(CORE_CLAIMS[0], async () => {
    const trends = await gt.trendingNow("JP", { hours: 4, newsCount: 1 });
    assertGreater(trends.length, 0, "急上昇が 0 件になることは通常ない");
    const first = trends[0];
    assert(first !== undefined);
    assertGreater(first.title.length, 0);
    assert(first.startedAt instanceof Date);
    assertEquals(first.active, first.endedAt === null);
    assertEquals(first.relatedQueries[0], first.title, "関連クエリの先頭はタイトル自身");
    assertEquals(
      first.normalizedKey,
      first.title.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC"),
    );
    return `${trends.length} 件`;
  });
});

Deno.test("live: 廃止された旧エンドポイントが今も 404 であることを確認する", async () => {
  // ここが 200 に戻ったら、Google が旧 API を復活させたということなので気付けるようにする。
  for (const path of ["/trends/api/dailytrends?geo=JP", "/trends/api/realtimetrends?geo=JP"]) {
    try {
      const res = await fetch(`https://trends.google.com${path}`, { redirect: "manual" });
      await res.body?.cancel();
      assertEquals(res.status, 404, `${path} が 404 でなくなった`);
    } catch (e) {
      if (!isTransient(e)) throw e;
      console.warn(`[skip] 旧エンドポイント確認: ネットワークエラー`);
    }
  }
});

Deno.test("live: RSS が 10 件返り、ニュースは 0〜3 件の可変である", async () => {
  const gt = makeClient();
  await attempt(CORE_CLAIMS[1], async () => {
    const items = await gt.trendingRss("JP");
    assertEquals(items.length, 10, "RSS は 10 件固定");
    let newsTotal = 0;
    for (const item of items) {
      assertGreater(item.title.length, 0);
      assert(item.news.length <= 3, `ニュースは最大 3 件 (実際 ${item.news.length})`);
      newsTotal += item.news.length;
      // 空文字を「画像あり」と誤判定していないこと。
      assert(item.picture === null || item.picture.startsWith("http"));
      for (const n of item.news) {
        assert(n.url.startsWith("http"));
        assert(n.picture === null || n.picture.startsWith("http"));
      }
    }
    return `10 件 / ニュース計 ${newsTotal} 件`;
  });
});

// ---------------------------------------------------------------------------
// メタデータ
// ---------------------------------------------------------------------------

Deno.test("live: autocomplete が Cookie 無しで 5 件返す", async () => {
  const gt = makeClient();
  await attempt(CORE_CLAIMS[2], async () => {
    const topics = await gt.autocomplete("nintendo");
    assertEquals(topics.length, 5, "実測では常に 5 件");
    for (const t of topics) {
      assert(/^\/[mg]\//.test(t.mid), `mid の形式が変わった: ${t.mid}`);
    }
    // ★特定の mid を決め打ちしないこと。Knowledge Graph の候補は時期と IP で変動する。
    return topics.map((t) => t.title).join(", ");
  });
});

// ---------------------------------------------------------------------------
// Explore 系 (Cookie が要り、レート制限が厳しい)
// ---------------------------------------------------------------------------

Deno.test("live: explore が 4 ウィジェットと 24 時間有効な token を返す", async () => {
  const gt = makeClient();
  await attempt(CORE_CLAIMS[3], async () => {
    const res = await gt.explore(["youtube"], { time: "today 12-m", geo: "JP" });
    const ids = res.widgets.map((w) => w.id);
    for (const id of ["TIMESERIES", "GEO_MAP", "RELATED_TOPICS", "RELATED_QUERIES"]) {
      assert(ids.includes(id), `${id} が返らなくなった (実際: ${ids.join(", ")})`);
    }
    const ts = res.widgets.find((w) => w.id === "TIMESERIES");
    assertEquals(typeof ts?.token, "string");
    assertEquals(ts?.token?.length, 44, "token は 44 文字");
    return ids.join(", ");
  });
});

Deno.test("live: 時系列を取得でき、正規化とスキーマが仕様どおり", async () => {
  const gt = makeClient();
  await attempt(CORE_CLAIMS[4], async () => {
    const series = await gt.interestOverTime(["youtube"], { time: "today 12-m", geo: "JP" });
    assertGreater(series.points.length, 0);
    assertEquals(series.resolution, "WEEK", "today 12-m は WEEK になる");
    const max = Math.max(...series.points.map((p) => p.values[0] ?? 0));
    assertEquals(max, 100, "全系列を通した最大が 100 になる");
    // 末尾以外に partial が立っていないこと。
    const partials = series.points.filter((p) => p.partial);
    assert(partials.length <= 1);
    return `${series.points.length} 点 / ${series.resolution}`;
  });
});

Deno.test("live: token を使い回して地域別も取れる (explore は 1 回で済む)", async () => {
  const gt = makeClient();
  await attempt("token を使い回して comparedgeo が取れる", async () => {
    // 直前のテストとは別クライアントなので explore は 1 回走る。
    const geo = await gt.interestByRegion(["youtube"], { geo: "JP" });
    assertGreater(geo.areas.length, 0);
    const withCode = geo.areas.filter((a) => a.code !== null);
    assertGreater(withCode.length, 0, "REGION 粒度では geoCode が入る");
    return `${geo.areas.length} 地域 / ${geo.resolution}`;
  });
});

Deno.test("live: 不正な geo は 400 になる (リトライ不能なエラーとして分類される)", async () => {
  const gt = makeClient();
  try {
    await gt.explore(["youtube"], { geo: "ZZ-NOPE" });
    throw new Error("不正な geo が 400 にならなかった");
  } catch (e) {
    if (e instanceof TrendsHttpError) {
      if (e.outcome === "rate-limited" || e.outcome === "blocked") {
        console.warn(`[skip] 不正 geo の確認: ${e.outcome}`);
        return;
      }
      assertEquals(e.outcome, "bad-request");
      assertEquals(e.status, 400);
      return;
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// 検証台帳の集計 — これが最後に走る
// ---------------------------------------------------------------------------

Deno.test("live: 中核主張がすべて実測で検証されたことを確認する", () => {
  console.log("\n  === 検証台帳 ===");
  for (const [claim, { verified, note }] of ledger) {
    console.log(`  [${verified ? "OK  " : "SKIP"}] ${claim}${note !== "" ? ` — ${note}` : ""}`);
  }

  const unverified = CORE_CLAIMS.filter((c) => ledger.get(c)?.verified !== true);
  if (unverified.length > 0) {
    console.error(
      `\n  ★ 中核主張 ${unverified.length}/${CORE_CLAIMS.length} 件が未検証のまま終了しました:`,
    );
    for (const c of unverified) console.error(`     - ${c}`);
    console.error(
      "\n  レート制限または IP ブロックの可能性が高いです。" +
        "時間を空けるか別 IP で再実行してください。\n" +
        "  ネットワークが原因かどうかは、ネットワーク不要の `deno task test` が\n" +
        "  緑かどうかで切り分けられます。",
    );
  }
  // ★ここで失敗させないと「緑だが何も検証していない」状態を見逃す。
  assertEquals(
    unverified.length,
    0,
    `中核主張 ${unverified.length} 件が未検証: ${unverified.join(" / ")}`,
  );
});
