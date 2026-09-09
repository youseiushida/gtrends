/**
 * 期間指定 (`time`) の文法と、サーバが決める粒度 (`resolution`) の対応。
 *
 * ## 文法 5 形態
 *
 * | 形 | 例 | 精度 |
 * | --- | --- | --- |
 * | `now N-H` | `now 1-H` `now 4-H` | 秒 |
 * | `now N-d` | `now 1-d` `now 7-d` | 秒 |
 * | `today N-m` / `today N-y` | `today 12-m` `today 5-y` | 日 |
 * | `all` / `all_YYYY` | `all` `all_2008` | 日 |
 * | 絶対指定 | `2024-01-01 2024-03-31` / `2026-09-08T10 2026-09-09T10` | 日 or 時 |
 *
 * ## 急所
 *
 * - **`now` の基準は常に UTC。`tz` は窓の算出に一切効かない。**
 *   ローカル日付で切りたければ自分で UTC に換算して絶対指定を使う。
 * - **1 日未満の窓ではコロンがバックスラッシュでエスケープされる**
 *   (JS 文字列として `2026-09-07T15\:49\:55`)。
 * - `resolution` はクライアントから指示できない。**窓長だけ**でサーバが決める。
 * - **`now 1-H` は 60 点ではなく 58 点だった。** 期間 ÷ バケット幅で点数を決め打ちしないこと。
 *
 * @module
 */

import type { Backend, Resolution } from "../types.ts";

/** 取りうる粒度。**6 種ではなく 7 種。** */
export const RESOLUTIONS: readonly Resolution[] = [
  "MINUTE",
  "EIGHT_MINUTE",
  "SIXTEEN_MINUTE",
  "HOUR",
  "DAY",
  "WEEK",
  "MONTH",
];

/** Google Trends がデータを持つ最古の時刻 (2004-01-01 UTC)。 */
export const TRENDS_EPOCH_MS: number = Date.UTC(2004, 0, 1);

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** {@link parseTimeRange} の結果。 */
export interface ParsedTimeRange {
  start: Date;
  end: Date;
  /** 時刻まで含む指定なら `true`、日付のみなら `false`。 */
  hasTime: boolean;
}

/**
 * `widget.request.time` のような絶対期間文字列をパースする。
 *
 * サーバは 1 日未満の窓でコロンを `\:` にエスケープして返すので、それを外してから解釈する。
 * 窓は常に UTC として扱う。
 *
 * @param time `"2024-01-01 2024-03-31"` または `"2026-09-07T15\:49\:55 2026-09-08T15\:49\:55"`
 * @returns パース結果。形式が合わなければ `null`
 */
export function parseTimeRange(time: string): ParsedTimeRange | null {
  const cleaned = time.replace(/\\/g, "");
  const parts = cleaned.split(" ");
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return null;
  const hasTime = a.includes("T");
  const toDate = (s: string): Date => new Date(hasTime ? `${s}Z` : `${s}T00:00:00Z`);
  const start = toDate(a);
  const end = toDate(b);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end, hasTime };
}

/**
 * 絶対期間文字列を組み立てる。サーバが返すのと同じ書式にする。
 *
 * @param start 開始時刻
 * @param end 終了時刻
 * @param hasTime 時刻まで含めるなら `true`
 */
export function formatTimeRange(start: Date, end: Date, hasTime: boolean): string {
  const fmt = (d: Date): string => {
    const iso = d.toISOString();
    // 秒まで含む "YYYY-MM-DDTHH:MM:SS"
    return hasTime ? iso.slice(0, 19).replace(/:/g, "\\:") : iso.slice(0, 10);
  };
  return `${fmt(start)} ${fmt(end)}`;
}

/**
 * 窓長から `resolution` を予測する。
 *
 * 実測 37 点すべてで一致した閾値だが、**未測定の区間が残っている**:
 * (4h, 5h] / (33h, 37h] / (60h, 72h] / (7d, 8d] / (1827d, 2093d]。
 * 境界付近では実際のレスポンスを確認すること ({@link isNearResolutionBoundary})。
 *
 * @param spanMs 窓の長さ (ミリ秒)
 */
export function resolutionForSpan(spanMs: number): Resolution {
  if (spanMs <= 4 * HOUR_MS) return "MINUTE";
  if (spanMs <= 33 * HOUR_MS) return "EIGHT_MINUTE";
  if (spanMs <= 60 * HOUR_MS) return "SIXTEEN_MINUTE";
  if (spanMs <= 7 * DAY_MS) return "HOUR";
  if (spanMs <= 269 * DAY_MS) return "DAY";
  if (spanMs <= 1827 * DAY_MS) return "WEEK";
  return "MONTH";
}

/** 実測で確定していない境界区間。 */
const UNMEASURED_GAPS: ReadonlyArray<readonly [number, number]> = [
  [4 * HOUR_MS, 5 * HOUR_MS],
  [33 * HOUR_MS, 37 * HOUR_MS],
  [60 * HOUR_MS, 72 * HOUR_MS],
  [7 * DAY_MS, 8 * DAY_MS],
  [1827 * DAY_MS, 2093 * DAY_MS],
];

/**
 * 窓長が「実測で確定していない境界区間」に入っているかを返す。
 *
 * `true` のときは {@link resolutionForSpan} の予測が外れる可能性がある。
 */
export function isNearResolutionBoundary(spanMs: number): boolean {
  return UNMEASURED_GAPS.some(([lo, hi]) => spanMs > lo && spanMs <= hi);
}

/**
 * `resolution` に対応するバックエンド識別子を返す。実測 37/37 で一致。
 */
export function backendForResolution(resolution: Resolution): Backend {
  return resolution === "DAY" || resolution === "WEEK" || resolution === "MONTH" ? "IZG" : "CM";
}

/** UI のプリセットに対応する相対指定。 */
export const RELATIVE_PRESETS: readonly string[] = [
  "now 1-H",
  "now 4-H",
  "now 1-d",
  "now 7-d",
  "today 1-m",
  "today 3-m",
  "today 12-m",
  "today 5-y",
  "all",
];

/**
 * 相対指定の文字列が文法に合っているかを検証する。
 *
 * @param time 検証する文字列
 * @returns 文法に合っていれば `true`
 */
export function isValidRelativeTime(time: string): boolean {
  if (time === "all") return true;
  if (/^all_\d{4}$/.test(time)) return true;
  return /^now \d+-[Hd]$/.test(time) || /^today \d+-[my]$/.test(time);
}

/** {@link validateAbsoluteTime} が返す問題の種類。 */
export type TimeRangeProblem =
  /** 開始が終了以降になっている。サーバは 400 を返す。 */
  | "start-not-before-end"
  /** 窓全体が未来。サーバは 400 を返す。 */
  | "entirely-future"
  /** 開始が 2004-01-01 より前。サーバは 200 で受理するがデータは無い。 */
  | "before-trends-epoch";

/**
 * 絶対期間をローカルで検証する。
 *
 * 不正な `time` はサーバが 400 (`text/html`) を返し、これはリトライ不能なので、
 * 送信前に弾けると 1 リクエスト分のレート制限予算を節約できる。
 *
 * @param start 開始時刻
 * @param end 終了時刻
 * @param now 現在時刻 (テストで固定できるように引数化)
 * @returns 検出した問題の一覧。問題が無ければ空配列
 */
export function validateAbsoluteTime(
  start: Date,
  end: Date,
  now: Date = new Date(),
): TimeRangeProblem[] {
  const problems: TimeRangeProblem[] = [];
  if (start.getTime() >= end.getTime()) problems.push("start-not-before-end");
  if (start.getTime() > now.getTime()) problems.push("entirely-future");
  if (start.getTime() < TRENDS_EPOCH_MS) problems.push("before-trends-epoch");
  return problems;
}
