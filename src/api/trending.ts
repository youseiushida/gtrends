/**
 * Trending Now (急上昇) の取得。**既存ライブラリが全滅している領域。**
 *
 * 旧 `/trends/api/dailytrends` と `/trends/api/realtimetrends` は **404 で廃止済み**。
 * `/trends/trendingsearches/daily` は `/trending` へ 302 でリダイレクトされる。
 * 現行の取得手段は 3 つある。
 *
 * | 経路 | 情報量 | Cookie | 備考 |
 * | --- | --- | --- | --- |
 * | RPC `i0OFE` | 最大 | 不要 | 時間窓とニュース件数を指定できる |
 * | `/trending` の HTML 埋め込み `ds:0` | 同等 | 不要 | GET 1 回。ただし `hours=24` 固定で 1.2MB |
 * | RSS `/trending/rss` | 最小 | 不要 | 10 件固定だが最軽量 |
 *
 * **explore に依存しないので、explore が 302 ブロック中でも動き続ける。**
 *
 * @module
 */

import {
  batchExecuteHeaders,
  buildBatchExecuteBody,
  buildBatchExecuteUrl,
  parseBatchExecute,
  type RpcCall,
} from "../codec/batchexecute.ts";
import { ORIGIN, type Session } from "../session.ts";
import type { NewsArticle, RssTrendItem, TrendItem } from "../types.ts";

/** {@link fetchTrendingNow} のオプション。 */
export interface TrendingNowOptions {
  /**
   * 遡る時間窓 (時間)。既定 24。
   *
   * 実測 (geo=JP): 4 → 65 件 / 13KB、24 → 428 件 / 102KB、
   * 48 → 777 件 / 193KB、168 (7 日) → 2,491 件 / 647KB。
   * **`hours` と `newsCount` を同時に大きくすると数 MB になる。**
   */
  hours?: number;
  /**
   * 各トレンドに展開するニュース記事の最大件数。既定 0 (展開しない)。
   *
   * これは絞り込みではなく展開数の指定で、**アイテム件数自体は変わらない**。
   */
  newsCount?: number;
  /** UI 言語。既定 `"en-US"`。 */
  hl?: string;
}

/** i0OFE のアイテム 1 件 (arity 13 固定)。 */
type RawTrendItem = [
  string, // 0 タイトル
  unknown[] | null, // 1 ニュース記事 (newsCount が 0 なら null)
  string, // 2 geo
  [number], // 3 開始 UNIX 秒 (要素 1 個の配列)
  [number] | null, // 4 終了 UNIX 秒。null は継続中
  null, // 5 常に null
  number, // 6 検索ボリューム下限
  null, // 7 常に null
  number, // 8 増加率 %
  string[], // 9 関連クエリ
  number[], // 10 カテゴリ ID
  unknown[], // 11 記事参照
  string, // 12 正規化キー
];

/**
 * トレンド語の正規化キーを計算する。
 *
 * 規則は NFD → 結合マーク除去 → NFC。濁点・半濁点だけでなくラテン文字のアクセントも落ちる
 * (`"séamus coleman"` → `"seamus coleman"`、`"男子バレー"` → `"男子ハレー"`)。
 * HAR 279/279 で機械検証済み。
 */
export function normalizeTrendKey(s: string): string {
  return s.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC");
}

function toDate(v: [number] | null | undefined): Date | null {
  const sec = v?.[0];
  return typeof sec === "number" ? new Date(sec * 1000) : null;
}

function parseNews(raw: unknown[] | null): NewsArticle[] {
  if (!Array.isArray(raw)) return [];
  const out: NewsArticle[] = [];
  for (const a of raw) {
    if (!Array.isArray(a)) continue;
    const [title, url, source, published, picture] = a as [
      string,
      string,
      string,
      [number] | null,
      string | undefined,
    ];
    out.push({
      title: title ?? "",
      url: url ?? "",
      source: source ?? "",
      publishedAt: toDate(published),
      // 画像が無い記事は要素ごと存在せず arity 4 になる。
      picture: typeof picture === "string" && picture !== "" ? picture : null,
    });
  }
  return out;
}

/** i0OFE の生ペイロードを {@link TrendItem} に整形する。 */
export function mapTrendItems(payload: unknown): TrendItem[] {
  // ペイロードは [null, items] の形。
  const items = Array.isArray(payload) ? payload[1] : null;
  if (!Array.isArray(items)) return [];
  const out: TrendItem[] = [];
  for (const raw of items) {
    if (!Array.isArray(raw)) continue;
    const it = raw as RawTrendItem;
    const startedAt = toDate(it[3]);
    if (startedAt === null) continue;
    const endedAt = toDate(it[4]);
    out.push({
      title: it[0] ?? "",
      geo: it[2] ?? "",
      startedAt,
      endedAt,
      active: endedAt === null,
      volumeAtLeast: it[6] ?? 0,
      growthPercent: it[8] ?? 0,
      relatedQueries: Array.isArray(it[9]) ? it[9] : [],
      categoryIds: Array.isArray(it[10]) ? it[10] : [],
      normalizedKey: it[12] ?? "",
      news: parseNews(it[1]),
    });
  }
  return out;
}

/**
 * RPC `i0OFE` で急上昇一覧を取得する。**Cookie 不要。**
 *
 * @throws {TrendsHttpError} HTTP レベルで失敗した場合
 * @throws {Error} RPC 単位で失敗した場合 (存在しない geo など)
 */
export async function fetchTrendingNow(
  session: Session,
  geo: string,
  options: TrendingNowOptions = {},
): Promise<TrendItem[]> {
  const hours = options.hours ?? 24;
  const newsCount = options.newsCount ?? 0;
  const hl = options.hl ?? "en-US";
  const calls: RpcCall[] = [
    { rpcid: "i0OFE", args: [null, null, geo, newsCount, hl, hours] },
  ];
  const text = await session.postForm(
    buildBatchExecuteUrl(calls, { hl }),
    buildBatchExecuteBody(calls),
    batchExecuteHeaders(),
  );
  const env = parseBatchExecute(text);
  const result = env.results.find((r) => r.rpcid === "i0OFE");
  if (result === undefined) {
    throw new Error(`i0OFE の応答がありません (transportError=${env.transportError})`);
  }
  if (result.data === null) {
    // ★HTTP 200 のまま RPC だけ失敗するケース。存在しない geo で起きる。
    throw new Error(
      `i0OFE が失敗しました (geo=${geo} が不正の可能性): ${JSON.stringify(result.error)}`,
    );
  }
  return mapTrendItems(result.data);
}

/**
 * `/trending` の HTML に埋め込まれた `ds:0` から急上昇一覧を取り出す。
 *
 * RPC を呼ばず GET 1 回で済むが、**`hours=24` 固定**で HTML が 1.2MB ある。
 */
export function extractEmbeddedTrends(html: string): TrendItem[] {
  // AF_initDataCallback({key: 'ds:0', ..., data: <JSON>});
  const re = /AF_initDataCallback\(\{[^}]*?key:\s*'ds:0'[\s\S]*?data:\s*(\[[\s\S]*?)\}\s*\)\s*;/;
  const m = html.match(re);
  if (m?.[1] === undefined) return [];
  // data: の後ろから、対応する括弧までを切り出す。
  const json = sliceBalanced(m[1]);
  if (json === null) return [];
  try {
    return mapTrendItems(JSON.parse(json));
  } catch {
    return [];
  }
}

/** 先頭の `[` に対応する `]` までを切り出す (文字列リテラル内の括弧は無視する)。 */
function sliceBalanced(s: string): string | null {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}

/**
 * `/trending` の HTML を取得して埋め込み一覧を返す。
 *
 * @param hl UI 言語
 */
export async function fetchTrendingFromHtml(
  session: Session,
  geo: string,
  hl = "en-US",
): Promise<TrendItem[]> {
  const html = await session.getText(
    `${ORIGIN}/trending?geo=${encodeURIComponent(geo)}&hl=${encodeURIComponent(hl)}`,
    { withCookie: false },
  );
  return extractEmbeddedTrends(html);
}

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------

/** XML のタグ 1 個分の中身を取り出す (正規表現のみ。DOM パーサは使わない)。 */
function pickTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (m?.[1] === undefined) return null;
  return decodeXmlEntities(m[1]);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 急上昇 RSS をパースする。
 *
 * **`<ht:news_item>` は 0〜3 件の可変。** 3 件固定ではない
 * (実測 40 item の分布: 0件=4 / 1件=1 / 2件=3 / 3件=34)。
 * **`<ht:picture>` と `<ht:news_item_picture>` は要素があっても中身が空のことがある**ので、
 * 空文字は `null` に正規化する。
 */
export function parseTrendingRss(xml: string): RssTrendItem[] {
  const out: RssTrendItem[] = [];
  const items = xml.split("<item>").slice(1);
  for (const chunk of items) {
    const item = chunk.split("</item>")[0] ?? "";
    const pubDate = pickTag(item, "pubDate");
    const picture = pickTag(item, "ht:picture");
    const pictureSource = pickTag(item, "ht:picture_source");
    const news: NewsArticle[] = [];
    for (const n of item.match(/<ht:news_item>[\s\S]*?<\/ht:news_item>/g) ?? []) {
      const np = pickTag(n, "ht:news_item_picture");
      const npub = pickTag(n, "ht:news_item_published");
      news.push({
        title: pickTag(n, "ht:news_item_title") ?? "",
        url: pickTag(n, "ht:news_item_url") ?? "",
        source: pickTag(n, "ht:news_item_source") ?? "",
        publishedAt: npub !== null && npub !== "" ? new Date(npub) : null,
        picture: np !== null && np !== "" ? np : null,
      });
    }
    out.push({
      title: pickTag(item, "title") ?? "",
      approxTraffic: pickTag(item, "ht:approx_traffic") ?? "",
      publishedAt: pubDate !== null && pubDate !== "" ? new Date(pubDate) : null,
      picture: picture !== null && picture !== "" ? picture : null,
      pictureSource: pictureSource !== null && pictureSource !== "" ? pictureSource : null,
      news,
    });
  }
  return out;
}

/**
 * 急上昇 RSS を取得する。**Cookie 不要。10 件固定。**
 *
 * 件数を指定するパラメータは見つかっていない。
 */
export async function fetchTrendingRss(
  session: Session,
  geo: string,
): Promise<RssTrendItem[]> {
  const xml = await session.getText(
    `${ORIGIN}/trending/rss?geo=${encodeURIComponent(geo)}`,
    { withCookie: false },
  );
  return parseTrendingRss(xml);
}
