/**
 * `@uyu/gtrends` の公開型。
 *
 * JSR の slow types 制約により、公開 API に現れる構造はすべてここで名前付き型として定義し、
 * 関数側はインライン構造型を返さない。
 *
 * @module
 */

// ---------------------------------------------------------------------------
// 継ぎ目 (テストで差し替える唯一の境界)
// ---------------------------------------------------------------------------

/**
 * `fetch` 互換のリクエスト関数。テストではこれを差し替える。
 *
 * 既定は `globalThis.fetch.bind(globalThis)`。
 * **bind を省くと Deno では `Illegal invocation` になる**ので注意。
 */
export type DoFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** 待機関数。テストでは実時間を待たない実装に差し替える。 */
export type Sleep = (ms: number) => Promise<void>;

// ---------------------------------------------------------------------------
// レスポンス分類
// ---------------------------------------------------------------------------

/**
 * HTTP レスポンスの分類。**ボディを読む前に判定できる**ように設計してある。
 *
 * `res.ok` は使えない。Google Trends はエラーを `text/html` の 200 で返すことがあり、
 * `/sorry` へのリダイレクトを follow すると CAPTCHA ページを 200 として掴む。
 */
export type TrendsOutcome =
  /** 200 + `application/json`。唯一の成功。 */
  | "ok-json"
  /** 429。2 種類あるので {@link RateLimitKind} で区別する。 */
  | "rate-limited"
  /** 302 → `www.google.com/sorry/`。**IP 単位のブロック。リトライ厳禁。** */
  | "blocked"
  /** ブロックではない通常の 3xx。 */
  | "redirect"
  /** 400 / 401 / 403。入力エラー。リトライ不能。 */
  | "bad-request"
  /** 404。パス誤りまたは廃止済み API。 */
  | "not-found"
  /** 5xx。短いバックオフで再試行可。 */
  | "server-error"
  /** 200 だが `text/html`。エラーページを掴んでいる。 */
  | "html-error"
  /** 上記のいずれでもない。 */
  | "unknown";

/**
 * 429 の 2 種別。**混同すると誤った回復処理になる。**
 *
 * - `cookie-gate` … Cookie 無しでのアクセスに対し回数非依存で返る。
 *   **新しい NID を `Set-Cookie` で配るので、それを付けて即再試行すれば 200。** 待つ必要はない。
 * - `rate-limit` … バケット枯渇 (約 90〜100 件目)。
 *   **`Set-Cookie` を配らないか配っても既存と同一で、新品 NID でも回復しない (IP スコープ)。**
 *   時間経過を待つしかない。
 */
export type RateLimitKind = "cookie-gate" | "rate-limit";

// ---------------------------------------------------------------------------
// 期間と粒度
// ---------------------------------------------------------------------------

/**
 * サーバが窓長だけから決める時間粒度。クライアントからは指示できない。
 *
 * `SIXTEEN_MINUTE` は UI のプリセット期間では到達不能で、時刻付き絶対指定でのみ現れる。
 */
export type Resolution =
  | "MINUTE"
  | "EIGHT_MINUTE"
  | "SIXTEEN_MINUTE"
  | "HOUR"
  | "DAY"
  | "WEEK"
  | "MONTH";

/** `resolution` と 1 対 1 で対応するバックエンド識別子。 */
export type Backend = "CM" | "IZG";

/** 検索対象のプロパティ。空文字列がウェブ検索。 */
export type Property = "" | "images" | "news" | "froogle" | "youtube";

/** `comparedgeo` の地域粒度。 */
export type GeoResolution = "COUNTRY" | "REGION" | "CITY" | "DMA";

// ---------------------------------------------------------------------------
// explore
// ---------------------------------------------------------------------------

/** `explore` に渡す比較対象 1 件。 */
export interface ComparisonItem {
  /** 検索語。`/m/...` や `/g/...` の mid を渡すとエンティティ指定になる。 */
  keyword: string;
  /** 地域コード。`""` が全世界。大文字必須。 */
  geo: string;
  /** 期間指定。{@link formatTimeRange} で組み立てるか、文法どおりの文字列を直接渡す。 */
  time: string;
}

/** `explore` のリクエスト本体 (`req` クエリに JSON で載る)。 */
export interface ExploreRequest {
  /** 比較対象。**上限 5 件。6 件で 400。** */
  comparisonItem: ComparisonItem[];
  /** カテゴリ ID。0 が全カテゴリ。**サーバは妥当性を検証しない。** */
  category?: number;
  /** 検索プロパティ。**サーバは妥当性を検証しない。** */
  property?: Property;
}

/**
 * `explore` が返すウィジェット 1 件。
 *
 * **`request` は絶対に書き換えないこと。** `token` は `request` 全体の署名であり、
 * 1 バイトでも変えると 401 になる。そのまま `JSON.stringify` して透過させる。
 */
export interface Widget {
  /** `TIMESERIES` / `GEO_MAP` / `RELATED_QUERIES` / `TITLE_0` など。 */
  id: string;
  /** `fe_line_chart` / `fe_geo_chart_explore` / `fe_related_searches` / `fe_text` など。 */
  type?: string;
  title?: string;
  /** データ取得系ウィジェットのみ持つ。**中身を解釈して再構築しないこと。** */
  request?: Record<string, unknown>;
  /** データ取得系ウィジェットのみ持つ。44 文字の base64url。 */
  token?: string;
  [key: string]: unknown;
}

/** `explore` のレスポンス。 */
export interface ExploreResponse {
  widgets: Widget[];
  keywords?: Array<{ keyword: string; name: string; type: string }>;
  timeRanges?: string[];
  shareText?: string;
  shouldShowMultiHeatMapMessage?: boolean;
}

/** widget token をデコードして得られる情報。 */
export interface DecodedToken {
  /** 失効時刻。発行から 24 時間後。 */
  expiresAt: Date;
  /** デコード後の生バイト列 (33 バイト)。 */
  bytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// 高レベル API の戻り値
// ---------------------------------------------------------------------------

/** 時系列の 1 点。 */
export interface TimePoint {
  /** 観測時刻。サーバは UNIX 秒の文字列で返すので `Date` に変換済み。 */
  at: Date;
  /** キーワードごとの値 (0〜100)。並びは `comparisonItem` の順。 */
  values: number[];
  /**
   * キーワードごとのデータ有無。
   * **`hasData` が true でも `value` が 0 になることがある** (実値が 0 超 1 未満のとき)。
   */
  hasData: boolean[];
  /** サーバのローカライズ済み表示値。**数値としてパースしないこと。** */
  formatted: string[];
  /** 未確定の点かどうか。**末尾 1 点にだけ true が付く。** */
  partial: boolean;
}

/** 時系列の取得結果。 */
export interface TimeSeriesResult {
  points: TimePoint[];
  /** キーワードごとの平均。**比較対象が 1 件のときは空配列。** */
  averages: number[];
  /** リクエストしたキーワード。`points[].values` の並びと対応する。 */
  keywords: string[];
  /** サーバが決めた時間粒度。 */
  resolution: Resolution;
}

/** 地域別の 1 件。 */
export interface GeoArea {
  /**
   * 地域コード。**`CITY` 粒度では取得できないため `null`** になり、
   * 代わりに {@link GeoArea.coords} が入る。
   */
  code: string | null;
  name: string;
  /** `CITY` 粒度のときのみ入る。 */
  coords: { lat: number; lng: number } | null;
  values: number[];
  hasData: boolean[];
  formatted: string[];
}

/** 地域別の取得結果。 */
export interface GeoResult {
  areas: GeoArea[];
  keywords: string[];
  resolution: GeoResolution;
}

/** 関連キーワードの 1 件。 */
export interface RankedItem {
  query: string;
  value: number;
  /** ローカライズ済み表示値 (`"+300%"` / `"Breakout"` / `"急激増加"` など)。 */
  formatted: string;
  /**
   * ブレイクアウト (増加率が測定不能なほど大きい) かどうか。
   * **閾値ではなく「`formatted` に数字が含まれないか」で判定している。**
   */
  breakout: boolean;
  /** Trends UI への相対リンク。 */
  link: string;
}

/**
 * 関連検索の取得結果。
 *
 * **`RELATED_TOPICS` (エンティティ) は常に空を返す**ため、v1 では
 * 関連キーワード (`RELATED_QUERIES`) のみを扱う。
 */
export interface RelatedResult {
  top: RankedItem[];
  rising: RankedItem[];
}

// ---------------------------------------------------------------------------
// Trending Now
// ---------------------------------------------------------------------------

/** 急上昇トレンドに紐づくニュース記事。 */
export interface NewsArticle {
  title: string;
  /** 媒体の実 URL。Google のリダイレクタではない。 */
  url: string;
  source: string;
  publishedAt: Date | null;
  /** サムネイル URL。無い場合は `null`。 */
  picture: string | null;
}

/** 急上昇トレンド 1 件。 */
export interface TrendItem {
  title: string;
  geo: string;
  startedAt: Date;
  /** 終了時刻。**`null` はトレンド継続中を意味する。** */
  endedAt: Date | null;
  /** 継続中かどうか (`endedAt === null` と同値)。 */
  active: boolean;
  /** 検索ボリュームの下限値。`20000` なら「20,000+」。 */
  volumeAtLeast: number;
  /** 増加率 (%)。 */
  growthPercent: number;
  /** 関連クエリ。先頭は必ず {@link TrendItem.title} と一致する。 */
  relatedQueries: string[];
  /**
   * カテゴリ ID (1〜20)。
   * **explore のカテゴリ体系とは完全に別物なので混同しないこと。**
   */
  categoryIds: number[];
  /** 正規化済みキー (NFD → 結合マーク除去 → NFC)。 */
  normalizedKey: string;
  /** 展開されたニュース記事。`newsCount: 0` で取得すると常に空。 */
  news: NewsArticle[];
}

/** RSS フィードの 1 件。 */
export interface RssTrendItem {
  title: string;
  /** `"2000+"` のような閾値文字列。 */
  approxTraffic: string;
  publishedAt: Date | null;
  picture: string | null;
  pictureSource: string | null;
  /** **0〜3 件の可変。3 件固定ではない。** */
  news: NewsArticle[];
}

// ---------------------------------------------------------------------------
// メタデータ
// ---------------------------------------------------------------------------

/** オートコンプリートの候補。 */
export interface Topic {
  /** `/m/...` (旧 Freebase) または `/g/...` (Knowledge Graph)。 */
  mid: string;
  title: string;
  /** 型ラベル。`"Topic"` / `"トピック"` は「型不明」の汎用ラベル。 */
  type: string;
}

/** 地域ピッカー / カテゴリピッカーのツリーノード。 */
export interface PickerNode {
  /** 地域は文字列コード、カテゴリは数値 ID。 */
  id: string | number;
  name: string;
  children: PickerNode[];
}
