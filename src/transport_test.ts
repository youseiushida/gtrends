import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  classifyRateLimit,
  classifyResponse,
  extractNid,
  fetchWithRecovery,
  parseGoogleErrorPage,
  readJsonBody,
  retryPlan,
  TrendsHttpError,
} from "./transport.ts";
import type { DoFetch, Sleep } from "./types.ts";

/** 実測に基づく 429 ページの断片 (アポストロフィは実物どおりカーリーと直線が混在)。 */
const HTML_429 =
  '<html lang="en" dir=ltr><meta charset=utf-8><title>Error 429 (Too Many Requests)!!1</title>' +
  '<div id="af-error-container"><p>We’re sorry, but you have sent too many requests to us recently.';

const HTML_401 =
  '<html lang="en" dir=ltr><title>Error 401 (Bad Request)!!1</title><div id="af-error-container">';

const HTML_404_JA = "<html lang=ja><title>Error 404 (見つかりませんでした)!!1</title>";

function res(
  status: number,
  init: { contentType?: string; location?: string; setCookie?: string[]; body?: string } = {},
): Response {
  const headers = new Headers();
  if (init.contentType !== undefined) headers.set("content-type", init.contentType);
  if (init.location !== undefined) headers.set("location", init.location);
  for (const c of init.setCookie ?? []) headers.append("set-cookie", c);
  return new Response(init.body ?? null, { status, headers });
}

const NID_A = "534=aaaaaaaaaaaaaaaaaaaa";
const NID_B = "534=bbbbbbbbbbbbbbbbbbbb";
const cookieLine = (v: string) => `NID=${v}; expires=Sat, 09-Mar-2027 00:00:00 GMT; path=/; Secure`;

// ---------------------------------------------------------------------------
// 分類
// ---------------------------------------------------------------------------

Deno.test("成功は 200 かつ application/json のときだけ", () => {
  assertEquals(classifyResponse(200, "application/json; charset=utf-8", null), "ok-json");
  // 200 でも HTML ならエラーページを掴んでいる。res.ok では区別できない。
  assertEquals(classifyResponse(200, "text/html; charset=utf-8", null), "html-error");
});

Deno.test("302 は /sorry かどうかで意味が変わる", () => {
  assertEquals(
    classifyResponse(302, null, "https://www.google.com/sorry/index?continue=x"),
    "blocked",
  );
  assertEquals(classifyResponse(302, null, "https://trends.google.com/trending"), "redirect");
});

Deno.test("follow で /sorry に着地した場合も blocked として検出する", () => {
  // redirect:"follow" だと status 200 + text/html になってしまうので、
  // 最終 URL を見る保険が要る。
  assertEquals(
    classifyResponse(200, "text/html", null, "https://www.google.com/sorry/index?continue=x"),
    "blocked",
  );
});

Deno.test("その他のステータスの分類", () => {
  assertEquals(classifyResponse(429, "text/html", null), "rate-limited");
  assertEquals(classifyResponse(400, "text/html", null), "bad-request");
  assertEquals(classifyResponse(401, "text/html", null), "bad-request");
  assertEquals(classifyResponse(403, "text/html", null), "bad-request");
  assertEquals(classifyResponse(404, "text/html", null), "not-found");
  assertEquals(classifyResponse(502, "text/html", null), "server-error");
  assertEquals(classifyResponse(204, null, null), "unknown");
});

Deno.test("エラーページは理由文字列ではなく数値コードで判定する", () => {
  assertEquals(parseGoogleErrorPage(HTML_429), 429);
  // ★401 なのに理由文字列が "Bad Request" になる実例。文言分岐は不可能。
  assertEquals(parseGoogleErrorPage(HTML_401), 401);
  // ★全角括弧 + 日本語ローカライズにも対応する。
  assertEquals(parseGoogleErrorPage(HTML_404_JA), 404);
  assertEquals(parseGoogleErrorPage("<html>no title</html>"), null);
});

// ---------------------------------------------------------------------------
// NID
// ---------------------------------------------------------------------------

Deno.test("複数の Set-Cookie から NID を取り出せる", () => {
  assertEquals(
    extractNid(["OTZ=123; path=/", cookieLine(NID_A), "_ga=x; path=/"]),
    NID_A,
  );
  assertEquals(extractNid(["OTZ=123; path=/"]), null);
  assertEquals(extractNid([]), null);
});

Deno.test("NID の長さや書式を検証しない (2 系統が混在するため)", () => {
  const short = "534=" + "a".repeat(207);
  const long = "CuwBCAES" + "b".repeat(310);
  assertEquals(extractNid([cookieLine(short)]), short);
  assertEquals(extractNid([cookieLine(long)]), long);
});

Deno.test("429 の 2 種別 — 新しい NID を配れば未 Cookie ゲート", () => {
  assertEquals(classifyRateLimit([cookieLine(NID_A)], null), "cookie-gate");
  assertEquals(classifyRateLimit([cookieLine(NID_B)], NID_A), "cookie-gate");
});

Deno.test("429 の 2 種別 — 何も配らない/同一なら本物のレート制限", () => {
  // ★これがバケット枯渇。Cookie を替えても回復しないので待つしかない。
  assertEquals(classifyRateLimit([], NID_A), "rate-limit");
  assertEquals(classifyRateLimit([cookieLine(NID_A)], NID_A), "rate-limit");
});

// ---------------------------------------------------------------------------
// リトライ方針
// ---------------------------------------------------------------------------

Deno.test("429 は指数バックオフ + NID 再取得", () => {
  assertEquals(retryPlan("rate-limited", 0, 3, 0.5), {
    retry: true,
    delayMs: 2000,
    refreshNid: true,
  });
  assertEquals(retryPlan("rate-limited", 1, 3, 0.5), {
    retry: true,
    delayMs: 4000,
    refreshNid: true,
  });
  // 最終試行では待たない。
  assertEquals(retryPlan("rate-limited", 2, 3, 0.5).retry, false);
});

Deno.test("jitter は ±25% の範囲に写る", () => {
  assertEquals(retryPlan("rate-limited", 0, 3, 0).delayMs, 1500);
  assertEquals(retryPlan("rate-limited", 0, 3, 1).delayMs, 2500);
});

Deno.test("blocked / bad-request / not-found は絶対にリトライしない", () => {
  for (const outcome of ["blocked", "bad-request", "not-found", "html-error", "ok-json"] as const) {
    assertEquals(retryPlan(outcome, 0, 3).retry, false, outcome);
  }
});

Deno.test("5xx は短いバックオフでリトライする (NID は替えない)", () => {
  assertEquals(retryPlan("server-error", 0, 3, 0.5), {
    retry: true,
    delayMs: 1000,
    refreshNid: false,
  });
});

// ---------------------------------------------------------------------------
// 回復パターン (doFetch / sleepFn を注入した古典派テスト)
// ---------------------------------------------------------------------------

/** 応答を順番に返す偽 HTTP。実オブジェクトの経路をそのまま通す。 */
function scripted(responses: Response[]): { doFetch: DoFetch; sent: RequestInit[] } {
  const sent: RequestInit[] = [];
  let i = 0;
  const doFetch: DoFetch = (_url, init) => {
    sent.push(init ?? {});
    const r = responses[i++];
    if (r === undefined) throw new Error("スクリプトより多く呼ばれた");
    return Promise.resolve(r);
  };
  return { doFetch, sent };
}

/** 実時間を待たず、待機時間だけ記録する。 */
function recordingSleep(): { sleepFn: Sleep; waited: number[] } {
  const waited: number[] = [];
  const sleepFn: Sleep = (ms) => {
    waited.push(ms);
    return Promise.resolve();
  };
  return { sleepFn, waited };
}

Deno.test("429 で NID を拾って再試行し 200 に回復する", async () => {
  const { doFetch, sent } = scripted([
    res(429, { contentType: "text/html", setCookie: [cookieLine(NID_A)], body: HTML_429 }),
    res(200, { contentType: "application/json", body: ')]}\'\n{"ok":true}' }),
  ]);
  const { sleepFn, waited } = recordingSleep();

  const result = await fetchWithRecovery("https://trends.google.com/x", { doFetch, sleepFn });

  assertEquals(result.outcome, "ok-json");
  assertEquals(result.nid, NID_A, "429 が配った NID を保持している");
  assertEquals(result.attempts.length, 2);
  assertEquals(result.attempts[0]?.rateLimitKind, "cookie-gate");
  assertEquals(waited, [2000], "1 回だけバックオフした (実時間は待っていない)");
  // 2 回目のリクエストには Cookie が付いている。
  const second = sent[1]?.headers as Record<string, string>;
  assertEquals(second.cookie, `NID=${NID_A}`);
});

Deno.test("redirect は常に manual で送る", async () => {
  const { doFetch, sent } = scripted([res(200, { contentType: "application/json", body: "{}" })]);
  await fetchWithRecovery("https://trends.google.com/x", { doFetch });
  assertEquals(sent[0]?.redirect, "manual");
});

Deno.test("302 /sorry は 1 回で中止する (叩き続けない)", async () => {
  const { doFetch, sent } = scripted([
    res(302, { location: "https://www.google.com/sorry/index?continue=x" }),
  ]);
  const { sleepFn, waited } = recordingSleep();

  const result = await fetchWithRecovery("https://trends.google.com/x", { doFetch, sleepFn });

  assertEquals(result.outcome, "blocked");
  assertEquals(sent.length, 1, "1 回しか叩いていない");
  assertEquals(waited, [], "待機もしていない");
});

Deno.test("429 が続けば maxAttempts で打ち切る (無限リトライしない)", async () => {
  const rateLimited = () => res(429, { contentType: "text/html", body: HTML_429 });
  const { doFetch, sent } = scripted([rateLimited(), rateLimited(), rateLimited()]);
  const { sleepFn, waited } = recordingSleep();

  const result = await fetchWithRecovery("https://trends.google.com/x", {
    doFetch,
    sleepFn,
    maxAttempts: 3,
  });

  assertEquals(result.outcome, "rate-limited");
  assertEquals(sent.length, 3);
  assertEquals(waited.length, 2, "3 回目の後は待たずに諦める");
  // Set-Cookie を配らない = バケット枯渇なので、NID 再取得では回復しない。
  assertEquals(result.attempts[0]?.rateLimitKind, "rate-limit");
});

Deno.test("readJsonBody は成功時だけ本文を返し、失敗は型付きエラーにする", async () => {
  const okResult = await fetchWithRecovery("https://x/y", {
    doFetch: scripted([res(200, { contentType: "application/json", body: '{"a":1}' })]).doFetch,
  });
  assertEquals(await readJsonBody(okResult), '{"a":1}');

  const badResult = await fetchWithRecovery("https://x/y", {
    doFetch: scripted([res(401, { contentType: "text/html", body: HTML_401 })]).doFetch,
  });
  const err = await assertRejects(() => readJsonBody(badResult), TrendsHttpError);
  assertEquals(err.outcome, "bad-request");
  assertEquals(err.status, 401);
  assertEquals(err.googleErrorCode, 401, "本文からコードを読めている");
});

Deno.test("エラー応答の Set-Cookie も捨てない", async () => {
  // 400 / 401 でも NID は配られる。次のリクエストに使えるよう拾っておく。
  const { doFetch } = scripted([
    res(400, { contentType: "text/html", setCookie: [cookieLine(NID_B)], body: HTML_401 }),
  ]);
  const result = await fetchWithRecovery("https://x/y", { doFetch });
  assertEquals(result.nid, NID_B);
  assert(result.attempts[0]?.nid === NID_B);
});
