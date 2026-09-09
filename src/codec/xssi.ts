/**
 * XSSI (JSON ハイジャック対策) プレフィックスの除去。
 *
 * **Google Trends はエンドポイントごとに違うプレフィックスを返す。**
 * バイト数を決め打ちすると必ず壊れる。
 *
 * | エンドポイント | プレフィックス | バイト数 |
 * | --- | --- | --- |
 * | `/trends/api/explore` | `)]}'` + LF | 5 |
 * | `/trends/api/explore/pickers/*` | `)]}'` + LF | 5 |
 * | `/trends/api/widgetdata/multiline` | `)]}',` + LF | **6** |
 * | `/trends/api/widgetdata/comparedgeo` | `)]}',` + LF | **6** |
 * | `/trends/api/widgetdata/relatedsearches` | `)]}',` + LF | **6** |
 * | `/trends/api/autocomplete/<kw>` | `)]}',` + LF | **6** |
 * | `/_/TrendsUi/data/batchexecute` | `)]}'` + LF + LF | **6** |
 *
 * 唯一正しい実装は「先頭が `)]}'` なら最初の LF の次から返す」。
 *
 * @module
 */

/** 全エンドポイントに共通するプレフィックスの先頭 4 文字。 */
export const XSSI_PREFIX_HEAD = ")]}'";

/**
 * XSSI プレフィックスを取り除いて JSON 本体を返す。
 *
 * プレフィックスが無ければ入力をそのまま返す (HTML のエラーページなどをここで壊さないため)。
 *
 * @param text レスポンス本文
 * @returns プレフィックスを除いた本文
 *
 * @example
 * ```ts
 * import { assertEquals } from "@std/assert";
 * assertEquals(stripXssiPrefix(")]}'\n{\"a\":1}"), '{"a":1}');
 * assertEquals(stripXssiPrefix(")]}',\n{\"a\":1}"), '{"a":1}');
 * assertEquals(stripXssiPrefix('{"a":1}'), '{"a":1}');
 * ```
 */
export function stripXssiPrefix(text: string): string {
  if (!text.startsWith(XSSI_PREFIX_HEAD)) return text;
  const lf = text.indexOf("\n");
  // LF が無い壊れた応答でも、先頭に `,` を残さないようにする。
  if (lf === -1) return text.replace(/^\)\]\}'\,?/, "");
  return text.slice(lf + 1);
}

/**
 * XSSI プレフィックスを剥がして `JSON.parse` する。
 *
 * @param text レスポンス本文
 * @returns パース結果
 * @throws {SyntaxError} 本文が JSON でない場合 (HTML のエラーページを掴んだときなど)
 */
export function parseXssiJson<T = unknown>(text: string): T {
  return JSON.parse(stripXssiPrefix(text)) as T;
}
