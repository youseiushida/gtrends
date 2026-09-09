/**
 * `@uyu/gtrends` — Google Trends の薄いラッパー (Deno)。
 *
 * ブラウザ自動化も外部依存も不要で、`fetch` + 文字列処理 + `JSON.parse` だけで動く。
 *
 * ## 使い方
 *
 * ```ts
 * import { GTrends } from "@uyu/gtrends";
 *
 * const gt = new GTrends({ hl: "ja", tz: -540, geo: "JP" });
 *
 * // 急上昇トレンド (Cookie 不要・最も安定)
 * const trends = await gt.trendingNow();
 *
 * // 時系列
 * const series = await gt.interestOverTime(["youtube"], { time: "today 12-m" });
 * ```
 *
 * ## 2 系統が同居していることに注意
 *
 * Google Trends には性質の異なる 2 つの API が同居している。
 *
 * | | Explore 系 | Trending 系 |
 * | --- | --- | --- |
 * | エンドポイント | `/trends/api/*` | `/_/TrendsUi/data/batchexecute` |
 * | 認証 | **`NID` Cookie が必要** | 不要 |
 * | レート制限 | 厳しい (容量 90〜100 件のバケット) | 緩い |
 * | XSSI プレフィックス | 5 バイト or 6 バイト | 6 バイト (LF 2 個) |
 *
 * **片方がブロックされても、もう片方は動き続ける。**
 *
 * ## 注意
 *
 * これは Google の**非公開の内部 API** を利用しており、予告なく変更・廃止されうる。
 * 大量取得が要件なら BigQuery 公開データセット `bigquery-public-data.google_trends`、
 * Google Trends 公式 API、ライセンス済みの商用プロバイダを検討すること。
 *
 * @module
 */

// 高レベル API
export { GTrends } from "./src/client.ts";
export type { GTrendsOptions, QueryOptions } from "./src/client.ts";

// セッション (NID の永続化やペース調整に使う)
export { DEFAULT_MIN_INTERVAL_MS, ORIGIN, Session } from "./src/session.ts";
export type { SessionOptions } from "./src/session.ts";

// transport (レスポンス分類とリトライ方針)
export {
  classifyRateLimit,
  classifyResponse,
  DEFAULT_USER_AGENT,
  extractNid,
  fetchWithRecovery,
  parseGoogleErrorPage,
  readJsonBody,
  retryPlan,
  TrendsHttpError,
} from "./src/transport.ts";
export type {
  RecoveryAttempt,
  RecoveryOptions,
  RecoveryResult,
  RetryPlan,
} from "./src/transport.ts";

// codec (純粋関数。ネットワーク不要)
export { parseXssiJson, stripXssiPrefix, XSSI_PREFIX_HEAD } from "./src/codec/xssi.ts";
export {
  BATCH_EXECUTE_URL,
  batchExecuteHeaders,
  buildBatchExecuteBody,
  buildBatchExecuteUrl,
  extractBl,
  extractFSid,
  extractWizString,
  parseBatchExecute,
  serializeBatchExecute,
} from "./src/codec/batchexecute.ts";
export type {
  BatchEnvelope,
  BatchExecuteUrlOptions,
  RpcCall,
  RpcResult,
} from "./src/codec/batchexecute.ts";
export {
  decodeWidgetToken,
  isWidgetTokenValid,
  TOKEN_BYTE_LENGTH,
  TOKEN_LENGTH,
} from "./src/codec/token.ts";
export {
  backendForResolution,
  formatTimeRange,
  isNearResolutionBoundary,
  isValidRelativeTime,
  parseTimeRange,
  RELATIVE_PRESETS,
  resolutionForSpan,
  RESOLUTIONS,
  TRENDS_EPOCH_MS,
  validateAbsoluteTime,
} from "./src/codec/time.ts";
export type { ParsedTimeRange, TimeRangeProblem } from "./src/codec/time.ts";

// 低レベル API
export {
  dataWidgets,
  encodeReq,
  fetchExplore,
  findWidget,
  findWidgets,
  MAX_COMPARISON_ITEMS,
} from "./src/api/explore.ts";
export type { ExploreOptions } from "./src/api/explore.ts";
export {
  fetchWidgetData,
  isBreakout,
  mapGeoResult,
  mapRelatedResult,
  mapTimeSeries,
} from "./src/api/widgetdata.ts";
export type { WidgetDataPath } from "./src/api/widgetdata.ts";
export {
  extractEmbeddedTrends,
  fetchTrendingFromHtml,
  fetchTrendingNow,
  fetchTrendingRss,
  mapTrendItems,
  normalizeTrendKey,
  parseTrendingRss,
} from "./src/api/trending.ts";
export type { TrendingNowOptions } from "./src/api/trending.ts";
export {
  fetchAutocomplete,
  fetchCategoryPicker,
  fetchGeoPicker,
  flattenPicker,
  joinGeoCode,
} from "./src/api/metadata.ts";

// 型
export type * from "./src/types.ts";
