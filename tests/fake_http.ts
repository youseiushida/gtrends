/**
 * 録画済みフィクスチャを再生する偽 HTTP。
 *
 * **古典派 (Detroit school) テストの唯一の継ぎ目。**
 * これを {@link GTrends} に注入すると、codec → transport → session → api → client の
 * **実オブジェクトをすべて通した**うえで結果を検証できる。内部の協力者はモックしない。
 *
 * @module
 */

import type { DoFetch, Sleep } from "../src/types.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** フィクスチャを読む。 */
export function readFixture(name: string): string {
  return Deno.readTextFileSync(new URL(name, FIXTURES));
}

/** 1 件のルート定義。 */
export interface Route {
  /** URL にこの文字列が含まれていればマッチする。 */
  match: string;
  status?: number;
  contentType?: string;
  /** 本文。省略時は `fixture` から読む。 */
  body?: string;
  /** フィクスチャ名。読んだ内容を本文にする。 */
  fixture?: string;
  /** XSSI プレフィックスを付ける (フィクスチャが JSON そのものの場合)。 */
  prefix?: string;
  setCookie?: string[];
  location?: string;
}

/** {@link fakeHttp} の記録。 */
export interface FakeHttpLog {
  url: string;
  init: RequestInit;
}

/** テスト用の NID。実物ではない。 */
export const TEST_NID = "534=fixture-nid-value-not-a-real-cookie";

/** ブートストラップ (NID 配布) のルート。実サーバと同じく 429 で NID を配る。 */
export const bootstrapRoute: Route = {
  match: "/trending?geo=",
  status: 429,
  contentType: "text/html; charset=utf-8",
  body: "<html><title>Error 429 (Too Many Requests)!!1</title></html>",
  setCookie: [`NID=${TEST_NID}; path=/; domain=.google.com; Secure; HttpOnly`],
};

/**
 * ルート表に従って応答する偽 HTTP を作る。
 *
 * マッチしない URL には 404 を返す (テストが黙って通らないようにするため)。
 */
export function fakeHttp(routes: Route[]): { doFetch: DoFetch; log: FakeHttpLog[] } {
  const log: FakeHttpLog[] = [];
  const doFetch: DoFetch = (url, init) => {
    log.push({ url, init: init ?? {} });
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) {
      return Promise.resolve(
        new Response(`<html><title>Error 404 (Not Found)!!1</title>${url}</html>`, {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
      );
    }
    const headers = new Headers();
    headers.set("content-type", route.contentType ?? "application/json; charset=UTF-8");
    if (route.location !== undefined) headers.set("location", route.location);
    for (const c of route.setCookie ?? []) headers.append("set-cookie", c);
    const raw = route.body ?? (route.fixture !== undefined ? readFixture(route.fixture) : "");
    const body = (route.prefix ?? "") + raw;
    return Promise.resolve(new Response(body, { status: route.status ?? 200, headers }));
  };
  return { doFetch, log };
}

/** 実時間を待たず、待機時間だけ記録する。 */
export function recordingSleep(): { sleepFn: Sleep; waited: number[] } {
  const waited: number[] = [];
  const sleepFn: Sleep = (ms) => {
    waited.push(ms);
    return Promise.resolve();
  };
  return { sleepFn, waited };
}

/** Explore 系のフルフローを再生する標準ルート表。 */
export function exploreRoutes(): Route[] {
  return [
    bootstrapRoute,
    // 録画した explore_single.json はパース済みの JSON なので、
    // 実サーバと同じ 5 バイトのプレフィックスを付け直す。
    {
      match: "/trends/api/explore?",
      fixture: "explore_single.json",
      prefix: ")]}'\n",
      contentType: "application/json; charset=utf-8",
    },
    // widgetdata 系は録画時のプレフィックス (6 バイト) が本文に含まれている。
    { match: "/widgetdata/multiline", fixture: "multiline.txt" },
    { match: "/widgetdata/comparedgeo", fixture: "comparedgeo.txt" },
    { match: "/widgetdata/relatedsearches", fixture: "relatedsearches.txt" },
    { match: "/trends/api/autocomplete/", fixture: "autocomplete.txt" },
    { match: "/data/batchexecute", fixture: "i0OFE_jp_4h.txt" },
    {
      match: "/trending/rss",
      fixture: "trending_rss.xml",
      contentType: "text/xml; charset=utf-8",
    },
  ];
}
