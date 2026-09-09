/**
 * メタデータ系 — オートコンプリート (キーワード → mid) と、地域 / カテゴリのマスタデータ。
 *
 * ## 急所
 *
 * - **オートコンプリートは Cookie 不要で、しかも 200 に `Set-Cookie: NID` が付く。**
 *   「エンティティ解決 + NID 取得」を 1 発で済ませられるので、
 *   ブートストラップ経路としても優秀。
 * - **キーワードは URL パスに入るので `encodeURIComponent` が必須。**
 *   `encodeURI` では不足で、`AC/DC` がそのままだと 404 になる。
 * - **`pickers/*` に Cookie を付けると 302 `/sorry` になる。** 必ず Cookie 無しで叩く。
 * - ピッカーのレスポンスは大きい (geo 約 130KB / category 約 60KB) ので**日単位でキャッシュする**。
 * - **`pickers/geo` の下位地域 id は親からの相対コード** (`JP` の子は `"23"`)。
 *   explore に渡すときは `親id + "-" + 子id` で組み立てる。
 *   一方 `DqDTgb` は完全形 (`"JP-23"`) を返す。**混ぜないこと。**
 * - **カテゴリ ID はツリー内で一意ではない** (DAG を木に展開しているため)。
 *   ただし同じ ID なら name も必ず同じなので `Map<number, string>` は安全。
 *
 * @module
 */

import { parseXssiJson } from "../codec/xssi.ts";
import { ORIGIN, type Session } from "../session.ts";
import type { PickerNode, Topic } from "../types.ts";

interface RawAutocomplete {
  default?: { topics?: Topic[] };
}

/**
 * キーワードからエンティティ (mid) を解決する。**Cookie 不要。**
 *
 * 実測では**常にちょうど 5 件**返る (1 文字クエリでも 5 件)。
 *
 * @param keyword 検索語。スラッシュを含んでもよい (内部でエンコードする)
 * @param hl UI 言語
 * @throws {TrendsHttpError} HTTP レベルで失敗した場合
 */
export async function fetchAutocomplete(
  session: Session,
  keyword: string,
  hl = "en-US",
): Promise<Topic[]> {
  // ★encodeURIComponent が必須。encodeURI だと "AC/DC" が 404 になる。
  const path = encodeURIComponent(keyword);
  const url = `${ORIGIN}/trends/api/autocomplete/${path}?hl=${encodeURIComponent(hl)}&tz=0`;
  const text = await session.getJson(url, { withCookie: false });
  return parseXssiJson<RawAutocomplete>(text).default?.topics ?? [];
}

interface RawPickerNode {
  id?: string | number;
  name?: string;
  children?: RawPickerNode[];
}

function mapPicker(nodes: readonly RawPickerNode[] | undefined): PickerNode[] {
  return (nodes ?? []).map((n) => ({
    id: n.id ?? "",
    name: n.name ?? "",
    children: mapPicker(n.children),
  }));
}

/**
 * 地域マスタを取得する。**Cookie を付けてはいけない** (302 になる)。
 *
 * 実測: 国 250 件 / 下位地域を持つ国 192 / 下位地域ノード 3,130。
 * レスポンスは約 130KB あるので**日単位でキャッシュすること**。
 */
export async function fetchGeoPicker(session: Session, hl = "en-US"): Promise<PickerNode[]> {
  const url = `${ORIGIN}/trends/api/explore/pickers/geo?hl=${encodeURIComponent(hl)}&tz=0`;
  const text = await session.getJson(url, { withCookie: false });
  const raw = parseXssiJson<{ children?: RawPickerNode[] }>(text);
  return mapPicker(raw.children);
}

/**
 * カテゴリマスタを取得する。**Cookie を付けてはいけない。**
 *
 * 実測: ノード 1,426 / ユニーク ID 1,132 (231 個が複数箇所に出現する DAG)。
 * ID は `hl` 非依存なので、**構造を 1 本と `id → name` 辞書を言語ごとに持つ**と
 * 多言語対応時のメモリが減る。
 */
export async function fetchCategoryPicker(
  session: Session,
  hl = "en-US",
): Promise<PickerNode[]> {
  const url = `${ORIGIN}/trends/api/explore/pickers/category?hl=${encodeURIComponent(hl)}&tz=0`;
  const text = await session.getJson(url, { withCookie: false });
  const raw = parseXssiJson<{ children?: RawPickerNode[] }>(text);
  return mapPicker(raw.children);
}

/**
 * ピッカーのツリーを `id → name` の辞書に平坦化する。
 *
 * カテゴリ ID はツリー内で重複するが、**同じ ID なら name も必ず同じ**なので安全。
 */
export function flattenPicker(nodes: readonly PickerNode[]): Map<string | number, string> {
  const out = new Map<string | number, string>();
  const walk = (list: readonly PickerNode[]): void => {
    for (const n of list) {
      out.set(n.id, n.name);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * 親 id と子 id から explore に渡せる geo コードを組み立てる。
 *
 * `pickers/geo` の下位地域 id は親からの相対コードなので、そのままでは使えない。
 *
 * @example
 * ```ts
 * import { assertEquals } from "@std/assert";
 * assertEquals(joinGeoCode("JP", "23"), "JP-23");
 * assertEquals(joinGeoCode("JP", null), "JP");
 * ```
 */
export function joinGeoCode(parentId: string, childId: string | null): string {
  return childId === null || childId === "" ? parentId : `${parentId}-${childId}`;
}
