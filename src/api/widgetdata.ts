/**
 * `/trends/api/widgetdata/*` — 実データの取得。
 *
 * `explore` が配った `widget.request` と `widget.token` をそのまま渡す。
 * **Cookie は不要** (token だけで通る)。
 *
 * ## 急所
 *
 * - **`request` を 1 バイトでも書き換えると 401。** token は req 全体の署名。
 *   ただし **`comparedgeo` の `resolution` と `includeLowSearchVolumeGeos` だけは署名対象外**で、
 *   書き換えても 200 になる。`multiline` の `resolution` は署名対象なので**一般化しないこと**。
 * - プレフィックスは `)]}',\n` の **6 バイト** (explore の 5 バイトと違う)。
 * - **`hasData[i] === true` でも `value[i] === 0` になる** (実値が 0 超 1 未満のとき)。
 * - **`isPartial` は末尾 1 点にだけ付く** (他の点はプロパティ自体が存在しない)。
 * - **データ 0 件も 200 の正常応答。** 429 と混同しないこと。
 * - `RELATED_TOPICS` (`keywordType: "ENTITY"`) は**常に空**を返す。
 *
 * @module
 */

import { parseXssiJson } from "../codec/xssi.ts";
import { ORIGIN, type Session } from "../session.ts";
import type {
  GeoArea,
  GeoResolution,
  GeoResult,
  RankedItem,
  RelatedResult,
  Resolution,
  TimePoint,
  TimeSeriesResult,
  Widget,
} from "../types.ts";
import { encodeReq, type ExploreOptions } from "./explore.ts";

/** widgetdata のエンドポイント種別。 */
export type WidgetDataPath = "multiline" | "comparedgeo" | "relatedsearches";

/**
 * widgetdata の生 JSON を取得する。
 *
 * @param widget `explore` が返したウィジェット (`request` と `token` を持つもの)
 * @throws {Error} ウィジェットが `request` / `token` を持たない場合
 * @throws {TrendsHttpError} HTTP レベルで失敗した場合 (token 失効なら 401)
 */
export async function fetchWidgetData<T>(
  session: Session,
  path: WidgetDataPath,
  widget: Widget,
  options: ExploreOptions & { requestOverride?: Record<string, unknown> } = {},
): Promise<T> {
  if (widget.request === undefined || typeof widget.token !== "string") {
    throw new Error(`ウィジェット ${String(widget.id)} は request / token を持ちません`);
  }
  const hl = options.hl ?? "en-US";
  const tz = options.tz ?? 0;
  // ★requestOverride は comparedgeo の resolution 上書き専用。
  //   それ以外のフィールドを触ると token 署名が壊れて 401 になる。
  const req = options.requestOverride ?? widget.request;
  const url = `${ORIGIN}/trends/api/widgetdata/${path}` +
    `?hl=${encodeURIComponent(hl)}&tz=${tz}` +
    `&req=${encodeReq(req)}&token=${encodeURIComponent(widget.token)}`;
  const text = await session.getJson(url, { withCookie: false });
  return parseXssiJson<T>(text);
}

// ---------------------------------------------------------------------------
// multiline (時系列)
// ---------------------------------------------------------------------------

interface RawTimelinePoint {
  time: string;
  formattedTime?: string;
  value: number[];
  hasData?: boolean[];
  formattedValue?: string[];
  isPartial?: boolean;
}

interface RawMultiline {
  default?: { timelineData?: RawTimelinePoint[]; averages?: number[] };
}

/**
 * multiline の生レスポンスを整形する。
 *
 * **`timelineData` が空配列で返ることがある** (ボリューム 0 の語) ので、
 * `timelineData[0]` を無条件に触ってはいけない。
 */
export function mapTimeSeries(
  raw: unknown,
  keywords: string[],
  resolution: Resolution,
): TimeSeriesResult {
  const d = (raw as RawMultiline).default;
  const rows = d?.timelineData ?? [];
  const points: TimePoint[] = rows.map((p) => ({
    // time は UNIX 秒の 10 進「文字列」。数値ではない。
    at: new Date(Number(p.time) * 1000),
    values: p.value ?? [],
    hasData: p.hasData ?? (p.value ?? []).map(() => true),
    formatted: p.formattedValue ?? [],
    // isPartial は末尾 1 点にだけ付き、他の点ではプロパティ自体が存在しない。
    partial: p.isPartial === true,
  }));
  return { points, averages: d?.averages ?? [], keywords, resolution };
}

// ---------------------------------------------------------------------------
// comparedgeo (地域別)
// ---------------------------------------------------------------------------

interface RawGeoPoint {
  geoCode?: string;
  geoName?: string;
  coordinates?: { lat: number; lng: number };
  value?: number[];
  hasData?: boolean[];
  formattedValue?: string[];
}

interface RawComparedGeo {
  default?: { geoMapData?: RawGeoPoint[] };
}

/**
 * comparedgeo の生レスポンスを整形する。
 *
 * **`CITY` 粒度だけ `geoCode` が無く `coordinates` になる**ため、
 * `code` は `string | null` になる。
 */
export function mapGeoResult(
  raw: unknown,
  keywords: string[],
  resolution: GeoResolution,
): GeoResult {
  const rows = (raw as RawComparedGeo).default?.geoMapData ?? [];
  const areas: GeoArea[] = rows.map((a) => ({
    code: a.geoCode ?? null,
    name: a.geoName ?? "",
    coords: a.coordinates ?? null,
    values: a.value ?? [],
    hasData: a.hasData ?? [],
    formatted: a.formattedValue ?? [],
  }));
  return { areas, keywords, resolution };
}

// ---------------------------------------------------------------------------
// relatedsearches (関連キーワード)
// ---------------------------------------------------------------------------

interface RawRankedKeyword {
  query?: string;
  value?: number;
  formattedValue?: string;
  link?: string;
}

interface RawRelated {
  default?: { rankedList?: Array<{ rankedKeyword?: RawRankedKeyword[] }> };
}

/**
 * ブレイクアウト (増加率が測定不能なほど大きい) かどうかを判定する。
 *
 * **閾値ではなく「表示値に数字が含まれないか」で判定する。**
 * よく言われる 5000 という閾値は推定にすぎず、実測で絞れたのは `(4650, 5200]` まで。
 * 一方、表示は `hl=en-US` で `"Breakout"`、`hl=ja` で `"急激増加"` と必ず非数値になる。
 */
export function isBreakout(formattedValue: string): boolean {
  return !/\d/.test(formattedValue);
}

/**
 * relatedsearches の生レスポンスを整形する。
 *
 * `rankedList` は `metric` (`["TOP","RISING"]`) と順序まで 1 対 1 で対応する。
 * **`RISING` のアイテムには `hasData` が無い** (TOP とキー集合が違う)。
 */
export function mapRelatedResult(raw: unknown): RelatedResult {
  const lists = (raw as RawRelated).default?.rankedList ?? [];
  const toItems = (i: number): RankedItem[] =>
    (lists[i]?.rankedKeyword ?? []).map((k) => {
      const formatted = k.formattedValue ?? "";
      return {
        query: k.query ?? "",
        value: k.value ?? 0,
        formatted,
        breakout: isBreakout(formatted),
        link: k.link ?? "",
      };
    });
  return { top: toItems(0), rising: toItems(1) };
}
