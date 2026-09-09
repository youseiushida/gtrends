/**
 * 高レベルファサード。整形した型を返す。
 *
 * 低レベル API (`explore` / `widgetData` / `batchExecute`) も `mod.ts` から公開しているので、
 * 生の JSON が要る場合はそちらを使う。
 *
 * @module
 */

import { dataWidgets, type ExploreOptions, fetchExplore, findWidget } from "./api/explore.ts";
import {
  fetchWidgetData,
  mapGeoResult,
  mapRelatedResult,
  mapTimeSeries,
} from "./api/widgetdata.ts";
import {
  fetchTrendingFromHtml,
  fetchTrendingNow,
  fetchTrendingRss,
  type TrendingNowOptions,
} from "./api/trending.ts";
import { fetchAutocomplete, fetchCategoryPicker, fetchGeoPicker } from "./api/metadata.ts";
import { isWidgetTokenValid } from "./codec/token.ts";
import { parseTimeRange, resolutionForSpan } from "./codec/time.ts";
import { Session, type SessionOptions } from "./session.ts";
import type {
  ExploreRequest,
  ExploreResponse,
  GeoResolution,
  GeoResult,
  PickerNode,
  Property,
  RelatedResult,
  Resolution,
  RssTrendItem,
  TimeSeriesResult,
  Topic,
  TrendItem,
  Widget,
} from "./types.ts";

/** {@link GTrends} のオプション。 */
export interface GTrendsOptions extends SessionOptions {
  /** 既定の UI 言語。 */
  hl?: string;
  /** 既定のタイムゾーンオフセット (分)。JST は `-540`。 */
  tz?: number;
  /** 既定の地域コード。 */
  geo?: string;
}

/** Explore 系メソッドの共通オプション。 */
export interface QueryOptions {
  /** 期間指定。既定 `"today 12-m"`。 */
  time?: string;
  /** 地域コード。省略時はコンストラクタの既定値。 */
  geo?: string;
  /** カテゴリ ID。既定 0 (全カテゴリ)。**サーバは検証しない。** */
  category?: number;
  /** 検索プロパティ。既定 `""` (ウェブ検索)。**サーバは検証しない。** */
  property?: Property;
  hl?: string;
  tz?: number;
}

/** キャッシュされた explore の結果。 */
interface CachedExplore {
  response: ExploreResponse;
  keywords: string[];
}

/**
 * Google Trends の薄いラッパー。
 *
 * ```ts
 * const gt = new GTrends({ hl: "ja", tz: -540, geo: "JP" });
 * const trends = await gt.trendingNow();          // Cookie 不要・最も安定
 * const series = await gt.interestOverTime(["youtube"]);
 * ```
 *
 * **同時実行は内部で 1 に直列化され、既定で 60 件/分にペース制御される。**
 * これはサーバ側リミッタが容量 90〜100 件のトークンバケットとして振る舞い、
 * 並列化すると 429 から 302 ブロックへ昇格するため。
 */
export class GTrends {
  #session: Session;
  #hl: string;
  #tz: number;
  #geo: string;
  /** explore の結果を token の有効期限までキャッシュする。 */
  #exploreCache = new Map<string, CachedExplore>();
  #now: () => number;

  constructor(options: GTrendsOptions = {}) {
    this.#session = new Session(options);
    this.#hl = options.hl ?? "en-US";
    this.#tz = options.tz ?? 0;
    this.#geo = options.geo ?? "";
    this.#now = options.now ?? (() => Date.now());
  }

  /** 内部セッション。NID の永続化などに使う。 */
  get session(): Session {
    return this.#session;
  }

  #exploreOptions(o: QueryOptions): ExploreOptions {
    return { hl: o.hl ?? this.#hl, tz: o.tz ?? this.#tz };
  }

  /**
   * explore を叩いてウィジェット定義を得る。**token が有効な間はキャッシュを使う。**
   *
   * token は発行から 24 時間有効だが、**日を跨いだ実証はしていない**ため、
   * 401 を受けたら呼び出し側でキャッシュを捨てて叩き直せるようにしてある
   * ({@link GTrends.invalidate})。
   */
  async explore(keywords: string[], o: QueryOptions = {}): Promise<ExploreResponse> {
    const req: ExploreRequest = {
      comparisonItem: keywords.map((keyword) => ({
        keyword,
        geo: o.geo ?? this.#geo,
        time: o.time ?? "today 12-m",
      })),
      category: o.category ?? 0,
      property: o.property ?? "",
    };
    const key = JSON.stringify([req, this.#exploreOptions(o)]);
    const cached = this.#exploreCache.get(key);
    if (cached !== undefined && this.#stillValid(cached.response)) return cached.response;

    const response = await fetchExplore(this.#session, req, this.#exploreOptions(o));
    this.#exploreCache.set(key, { response, keywords });
    return response;
  }

  /** キャッシュ済み explore の token がまだ有効か。 */
  #stillValid(response: ExploreResponse): boolean {
    const now = new Date(this.#now());
    return dataWidgets(response.widgets).every((w) =>
      typeof w.token === "string" && isWidgetTokenValid(w.token, now)
    );
  }

  /** explore のキャッシュを破棄する。401 を受けたときに呼ぶ。 */
  invalidate(): void {
    this.#exploreCache.clear();
  }

  async #widget(keywords: string[], id: string, o: QueryOptions): Promise<Widget> {
    const res = await this.explore(keywords, o);
    const w = findWidget(res.widgets, id);
    if (w === null) {
      const available = res.widgets.map((x) => x.id).join(", ");
      throw new Error(`ウィジェット ${id} が見つかりません (返ってきたのは: ${available})`);
    }
    return w;
  }

  /**
   * 時系列 (Interest over time) を取得する。
   *
   * **`points` が空配列で返ることがある** (検索ボリュームが 0 の語)。
   * また末尾 1 点は `partial: true` の未確定値なので、確定値だけ欲しいなら捨てること。
   */
  async interestOverTime(keywords: string[], o: QueryOptions = {}): Promise<TimeSeriesResult> {
    const w = await this.#widget(keywords, "TIMESERIES", o);
    const raw = await fetchWidgetData(this.#session, "multiline", w, this.#exploreOptions(o));
    return mapTimeSeries(raw, keywords, this.#resolutionOf(w));
  }

  /** ウィジェットの `request.time` から粒度を求める (サーバの値があればそれを使う)。 */
  #resolutionOf(w: Widget): Resolution {
    const req = w.request as { resolution?: Resolution; time?: string } | undefined;
    if (req?.resolution !== undefined) return req.resolution;
    const parsed = req?.time !== undefined ? parseTimeRange(req.time) : null;
    return parsed === null
      ? "DAY"
      : resolutionForSpan(parsed.end.getTime() - parsed.start.getTime());
  }

  /**
   * 地域別 (Interest by region) を取得する。
   *
   * **`resolution` を指定すると、explore を叩き直さずに粒度を変えられる。**
   * comparedgeo に限り `resolution` が token の署名対象外であることを利用している
   * (`multiline` では同じことをすると 401 になるので一般化しないこと)。
   *
   * **`CITY` 粒度では `code` が `null` になり、代わりに `coords` が入る。**
   */
  async interestByRegion(
    keywords: string[],
    o: QueryOptions & { resolution?: GeoResolution; includeLowVolume?: boolean } = {},
  ): Promise<GeoResult> {
    const w = await this.#widget(keywords, "GEO_MAP", o);
    const base = w.request as Record<string, unknown>;
    let requestOverride: Record<string, unknown> | undefined;
    if (o.resolution !== undefined || o.includeLowVolume !== undefined) {
      requestOverride = { ...base };
      if (o.resolution !== undefined) requestOverride.resolution = o.resolution;
      if (o.includeLowVolume !== undefined) {
        requestOverride.includeLowSearchVolumeGeos = o.includeLowVolume;
      }
    }
    const raw = await fetchWidgetData(this.#session, "comparedgeo", w, {
      ...this.#exploreOptions(o),
      ...(requestOverride !== undefined ? { requestOverride } : {}),
    });
    const resolution =
      (requestOverride?.resolution ?? base.resolution ?? "COUNTRY") as GeoResolution;
    return mapGeoResult(raw, keywords, resolution);
  }

  /**
   * 関連キーワード (Related queries) を取得する。
   *
   * **関連トピック (`RELATED_TOPICS`) は Google 側が常に空を返す**ため提供しない。
   * また**キーワードが 2 件以上だと `RELATED_QUERIES` は `RELATED_QUERIES_0` のように連番になる**ので、
   * 単一キーワードでの利用を推奨する。
   */
  async relatedQueries(keywords: string[], o: QueryOptions = {}): Promise<RelatedResult> {
    const id = keywords.length > 1 ? "RELATED_QUERIES_0" : "RELATED_QUERIES";
    const w = await this.#widget(keywords, id, o);
    const raw = await fetchWidgetData(this.#session, "relatedsearches", w, this.#exploreOptions(o));
    return mapRelatedResult(raw);
  }

  // -------------------------------------------------------------------------
  // Trending Now (explore に依存しない。Cookie 不要)
  // -------------------------------------------------------------------------

  /**
   * 急上昇トレンドを取得する。**Cookie 不要・explore に依存しない。**
   *
   * explore が 302 ブロック中でもこちらは動き続ける。
   */
  trendingNow(geo?: string, o: TrendingNowOptions = {}): Promise<TrendItem[]> {
    return fetchTrendingNow(this.#session, geo ?? this.#geo, { hl: this.#hl, ...o });
  }

  /**
   * `/trending` の HTML 埋め込みから急上昇トレンドを取得する。
   *
   * GET 1 回で済むが **`hours=24` 固定**で HTML が 1.2MB ある。
   */
  trendingNowFromHtml(geo?: string, hl?: string): Promise<TrendItem[]> {
    return fetchTrendingFromHtml(this.#session, geo ?? this.#geo, hl ?? this.#hl);
  }

  /** 急上昇 RSS を取得する。**10 件固定**だが最軽量。 */
  trendingRss(geo?: string): Promise<RssTrendItem[]> {
    return fetchTrendingRss(this.#session, geo ?? this.#geo);
  }

  // -------------------------------------------------------------------------
  // メタデータ
  // -------------------------------------------------------------------------

  /** キーワードからエンティティ (mid) を解決する。**Cookie 不要。常に 5 件返る。** */
  autocomplete(keyword: string, hl?: string): Promise<Topic[]> {
    return fetchAutocomplete(this.#session, keyword, hl ?? this.#hl);
  }

  /** 地域マスタを取得する。約 130KB あるので**日単位でキャッシュすること**。 */
  geoTree(hl?: string): Promise<PickerNode[]> {
    return fetchGeoPicker(this.#session, hl ?? this.#hl);
  }

  /** カテゴリマスタを取得する。約 60KB あるので**日単位でキャッシュすること**。 */
  categoryTree(hl?: string): Promise<PickerNode[]> {
    return fetchCategoryPicker(this.#session, hl ?? this.#hl);
  }
}
