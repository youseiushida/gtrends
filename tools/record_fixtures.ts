/**
 * ライブから実レスポンスを録画して `tests/fixtures/` に保存する。
 *
 * **なぜ必要か**: 調査に使った HAR には `/trends/api/*` のレスポンスボディが
 * 1 件も保存されていない (DevTools のページ単位ボディ退避が原因で 71 件すべて空)。
 * したがって Explore 系のフィクスチャはライブから録るしかない。
 * batchexecute 系は HAR に 21 本あるので `tests/fixtures/batchexecute.ts` に既に入っている。
 *
 * ## 使い方
 *
 * ```sh
 * deno task fixtures
 * # プロキシ経由で自宅 IP を焼かないようにする場合:
 * HTTPS_PROXY=http://user:pass@host:port deno task fixtures
 * ```
 *
 * ## 安全策
 *
 * - **NID Cookie は保存しない。** 本文に混入していないかを保存前に検査する。
 * - 巨大なレスポンス (pickers/geo は約 130KB) は先頭だけを保存する。
 * - リクエスト間隔は 1.5 秒。全部で 8 リクエスト程度。
 *
 * @module
 */

import { Session } from "../src/session.ts";
import { fetchExplore, findWidget } from "../src/api/explore.ts";
import { encodeReq } from "../src/api/explore.ts";
import { ORIGIN } from "../src/session.ts";

const OUT_DIR = new URL("../tests/fixtures/", import.meta.url);
const MAX_BYTES = 200_000;

/** 秘密情報が混入していないか検査する。 */
function assertNoSecrets(name: string, body: string): void {
  const patterns: Array<[string, RegExp]> = [
    ["NID Cookie", /NID=[A-Za-z0-9_\-=+/]{40,}/],
    ["reCAPTCHA トークン", /0[03]AFcWeA[A-Za-z0-9_\-]{40,}/],
  ];
  for (const [label, re] of patterns) {
    if (re.test(body)) {
      throw new Error(`${name} に ${label} らしき文字列が含まれています。保存を中止しました。`);
    }
  }
}

async function save(name: string, body: string): Promise<void> {
  assertNoSecrets(name, body);
  const truncated = body.length > MAX_BYTES;
  const content = truncated ? body.slice(0, MAX_BYTES) : body;
  await Deno.writeTextFile(new URL(name, OUT_DIR), content);
  console.log(
    `  saved ${name} (${content.length} 文字${truncated ? " / 先頭のみ" : ""})`,
  );
}

const session = new Session({ hl: "en-US", minIntervalMs: 1500 });

console.log("NID を取得しています...");
const nid = await session.ensureNid();
console.log(`  NID: ${nid === null ? "取得できず" : "取得済み"}`);

console.log("\nExplore 系を録画しています (HAR に無いのでライブからしか取れない)...");

// --- explore (単一キーワード) ---
const explore = await fetchExplore(
  session,
  { comparisonItem: [{ keyword: "youtube", geo: "JP", time: "today 12-m" }] },
  { hl: "en-US", tz: 0 },
);
await save("explore_single.json", JSON.stringify(explore, null, 2));

// --- widgetdata 3 種 ---
for (
  const [id, path] of [
    ["TIMESERIES", "multiline"],
    ["GEO_MAP", "comparedgeo"],
    ["RELATED_QUERIES", "relatedsearches"],
  ] as const
) {
  const w = findWidget(explore.widgets, id);
  if (w === null || w.request === undefined || typeof w.token !== "string") {
    console.warn(`  [skip] ${id} が見つかりません`);
    continue;
  }
  const url = `${ORIGIN}/trends/api/widgetdata/${path}?hl=en-US&tz=0` +
    `&req=${encodeReq(w.request)}&token=${encodeURIComponent(w.token)}`;
  const body = await session.getJson(url, { withCookie: false });
  await save(`${path}.txt`, body);
}

// --- autocomplete ---
{
  const body = await session.getJson(
    `${ORIGIN}/trends/api/autocomplete/${encodeURIComponent("nintendo")}?hl=en-US&tz=0`,
    { withCookie: false },
  );
  await save("autocomplete.txt", body);
}

// --- RSS ---
{
  const body = await session.getText(`${ORIGIN}/trending/rss?geo=JP`, { withCookie: false });
  await save("trending_rss.xml", body);
}

// --- i0OFE (小さめの窓で) ---
{
  const { buildBatchExecuteBody, buildBatchExecuteUrl, batchExecuteHeaders } = await import(
    "../src/codec/batchexecute.ts"
  );
  const calls = [{ rpcid: "i0OFE", args: [null, null, "JP", 1, "en-US", 4] }];
  const body = await session.postForm(
    buildBatchExecuteUrl(calls, { hl: "en-US" }),
    buildBatchExecuteBody(calls),
    batchExecuteHeaders(),
  );
  await save("i0OFE_jp_4h.txt", body);
}

console.log("\n完了しました。tests/fixtures/ を確認してください。");
