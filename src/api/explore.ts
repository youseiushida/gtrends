/**
 * `/trends/api/explore` — ウィジェット定義と token の発行。
 *
 * このエンドポイントは**実データを返さない**。「どのウィジェットが作れるか」と、
 * それぞれに対する 24 時間有効な token を配るだけで、実データは
 * `widgetdata/*` を token 付きで叩いて取る。
 *
 * ## 急所
 *
 * - **`NID` Cookie が必須。** 無いと 429 になる。Explore 系で Cookie が要るのはここだけ。
 * - **POST でもボディは空でよい。** ブラウザは reCAPTCHA トークンを載せるが不要。
 * - **返ってきた `widget.request` は 1 バイトも触らない。** token はその署名なので 401 になる。
 * - **`comparisonItem` は上限 5 件。** 6 件で 400。
 * - **キーワードが 2 件以上だと `RELATED_TOPICS` が返らなくなり**、
 *   widget は `2 + 3N` 個 (`TITLE_i` / `GEO_MAP_i` / `RELATED_QUERIES_i`) になる。
 * - **`category` と `property` はサーバが検証しない。** 不正値でも 200 でエコーされる。
 *
 * @module
 */

import { parseXssiJson } from "../codec/xssi.ts";
import { ORIGIN, type Session } from "../session.ts";
import type { ExploreRequest, ExploreResponse, Widget } from "../types.ts";

/** `comparisonItem` の上限。これを超えると 400 になる。 */
export const MAX_COMPARISON_ITEMS = 5;

/** {@link fetchExplore} のオプション。 */
export interface ExploreOptions {
  /** UI 言語。既定 `"en-US"`。 */
  hl?: string;
  /**
   * タイムゾーンオフセット (分)。JS の `Date#getTimezoneOffset()` と同じ符号で、
   * **JST は `-540`**。
   *
   * **窓の算出には一切効かない** (効くのは `multiline` の表示書式だけ)。
   * 有効範囲は `|tz| < 1440` と推定される。
   */
  tz?: number;
}

/**
 * `req` クエリをパーセントエンコードする。
 *
 * ブラウザ (AngularJS) は `:` `,` を素通しし空白を `+` にする独特のエンコードをするが、
 * 素の `encodeURIComponent` でもサーバは受理する
 * (explore / multiline / comparedgeo / relatedsearches すべてで実測)。
 */
export function encodeReq(req: unknown): string {
  return encodeURIComponent(JSON.stringify(req));
}

/**
 * ウィジェット定義と token を取得する。
 *
 * @throws {RangeError} `comparisonItem` が上限を超えている場合 (送信前に弾く)
 * @throws {TrendsHttpError} HTTP レベルで失敗した場合
 * @throws {Error} token を 1 つも持たない異常な 200 応答だった場合
 */
export async function fetchExplore(
  session: Session,
  req: ExploreRequest,
  options: ExploreOptions = {},
): Promise<ExploreResponse> {
  if (req.comparisonItem.length === 0) {
    throw new RangeError("comparisonItem が空です");
  }
  if (req.comparisonItem.length > MAX_COMPARISON_ITEMS) {
    throw new RangeError(
      `comparisonItem は最大 ${MAX_COMPARISON_ITEMS} 件です (${req.comparisonItem.length} 件が指定されました)`,
    );
  }
  const hl = options.hl ?? "en-US";
  const tz = options.tz ?? 0;

  // NID が無いと 429 になるので先に確保する。
  await session.ensureNid();

  const body = {
    comparisonItem: req.comparisonItem,
    category: req.category ?? 0,
    property: req.property ?? "",
  };
  const url = `${ORIGIN}/trends/api/explore?hl=${encodeURIComponent(hl)}&tz=${tz}&req=${
    encodeReq(body)
  }`;
  const text = await session.getJson(url);
  const parsed = parseXssiJson<ExploreResponse>(text);

  // ★異常系の 200 に注意: 縮退すると widgets が rt_note テキスト 1 個だけになる。
  //   token を 1 つも持たない 200 は成功として扱ってはいけない。
  const hasToken = parsed.widgets?.some((w) => typeof w.token === "string");
  if (hasToken !== true) {
    const ids = (parsed.widgets ?? []).map((w) => w.id).join(", ");
    throw new Error(
      `explore が token を 1 つも返しませんでした (widgets: ${ids || "なし"})。` +
        "リクエストが縮退した可能性があります。",
    );
  }
  return parsed;
}

/**
 * ウィジェットを id で探す。
 *
 * キーワードが 2 件以上のときは `RELATED_QUERIES_0` のように連番が付くため、
 * 前方一致でも探せるようにしてある。
 *
 * @param widgets `explore` が返したウィジェット一覧
 * @param id 完全一致させたい id
 */
export function findWidget(widgets: readonly Widget[], id: string): Widget | null {
  return widgets.find((w) => w.id === id) ?? null;
}

/**
 * 指定した接頭辞を持つウィジェットをすべて返す。
 *
 * `GEO_MAP` を指定すると `GEO_MAP` / `GEO_MAP_0` / `GEO_MAP_1` … が返る。
 */
export function findWidgets(widgets: readonly Widget[], idPrefix: string): Widget[] {
  return widgets.filter((w) => typeof w.id === "string" && w.id.startsWith(idPrefix));
}

/**
 * データ取得系ウィジェット (`request` と `token` を持つもの) だけを返す。
 *
 * `TITLE_i` や `geos_note` は `type: "fe_text"` で両方持たない。
 */
export function dataWidgets(widgets: readonly Widget[]): Widget[] {
  return widgets.filter((w) => w.request !== undefined && typeof w.token === "string");
}
