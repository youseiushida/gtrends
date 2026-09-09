import { assert, assertEquals } from "@std/assert";
import {
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
} from "./time.ts";
import type { Resolution } from "../types.ts";

const H = 3_600_000;
const D = 86_400_000;

Deno.test("粒度は 6 種ではなく 7 種 (SIXTEEN_MINUTE を含む)", () => {
  assertEquals(RESOLUTIONS.length, 7);
  assert(RESOLUTIONS.includes("SIXTEEN_MINUTE"));
});

Deno.test("窓長から粒度を予測する — 実測した代表点", () => {
  const cases: Array<[number, Resolution]> = [
    [1 * H, "MINUTE"],
    [4 * H, "MINUTE"],
    [24 * H, "EIGHT_MINUTE"],
    [33 * H, "EIGHT_MINUTE"],
    [48 * H, "SIXTEEN_MINUTE"],
    [60 * H, "SIXTEEN_MINUTE"],
    [7 * D, "HOUR"],
    [30 * D, "DAY"],
    [269 * D, "DAY"],
    [270 * D, "WEEK"],
    [365 * D, "WEEK"],
    [1827 * D, "WEEK"],
    [3650 * D, "MONTH"],
  ];
  for (const [span, expected] of cases) {
    assertEquals(resolutionForSpan(span), expected, `${span / D} 日`);
  }
});

Deno.test("DAY→WEEK の切替点は 269 日と 270 日の間 (1 日刻みで実測確定)", () => {
  assertEquals(resolutionForSpan(269 * D), "DAY");
  assertEquals(resolutionForSpan(269 * D + 1), "WEEK");
});

Deno.test("today 5-y は MONTH ではなく WEEK になる", () => {
  // 先行推定が実測で覆った箇所。5 年 = 約 1826 日 で WEEK の範囲に収まる。
  assertEquals(resolutionForSpan(1826 * D), "WEEK");
});

Deno.test("実測されていない境界区間は isNearResolutionBoundary で警告できる", () => {
  assert(isNearResolutionBoundary(4.5 * H), "(4h, 5h] は未測定");
  assert(isNearResolutionBoundary(35 * H), "(33h, 37h] は未測定");
  assert(isNearResolutionBoundary(7.5 * D), "(7d, 8d] は未測定");
  assert(!isNearResolutionBoundary(24 * H), "実測済みの点は警告しない");
  assert(!isNearResolutionBoundary(30 * D));
});

Deno.test("backend は粒度と 1 対 1 で対応する", () => {
  assertEquals(backendForResolution("MINUTE"), "CM");
  assertEquals(backendForResolution("EIGHT_MINUTE"), "CM");
  assertEquals(backendForResolution("SIXTEEN_MINUTE"), "CM");
  assertEquals(backendForResolution("HOUR"), "CM");
  assertEquals(backendForResolution("DAY"), "IZG");
  assertEquals(backendForResolution("WEEK"), "IZG");
  assertEquals(backendForResolution("MONTH"), "IZG");
});

Deno.test("日付精度の絶対期間をパースできる", () => {
  const r = parseTimeRange("2024-01-01 2024-03-31");
  assert(r !== null);
  assertEquals(r.hasTime, false);
  assertEquals(r.start.toISOString(), "2024-01-01T00:00:00.000Z");
  assertEquals(r.end.toISOString(), "2024-03-31T00:00:00.000Z");
});

Deno.test("サーバが返すエスケープ付きコロンをパースできる", () => {
  // 1 日未満の窓では "2026-09-07T15\:49\:55" の形で返ってくる。
  const r = parseTimeRange("2026-09-07T15\\:49\\:55 2026-09-08T15\\:49\\:55");
  assert(r !== null);
  assertEquals(r.hasTime, true);
  assertEquals(r.start.toISOString(), "2026-09-07T15:49:55.000Z");
  assertEquals(r.end.getTime() - r.start.getTime(), 24 * H);
});

Deno.test("窓は常に UTC として解釈する (tz は窓に効かない)", () => {
  const r = parseTimeRange("2026-09-07T15\\:49\\:55 2026-09-08T15\\:49\\:55");
  assert(r !== null);
  assertEquals(r.start.getUTCHours(), 15);
});

Deno.test("パースと整形が往復する", () => {
  for (const time of ["2024-01-01 2024-03-31", "2026-09-07T15\\:49\\:55 2026-09-08T15\\:49\\:55"]) {
    const r = parseTimeRange(time);
    assert(r !== null);
    assertEquals(formatTimeRange(r.start, r.end, r.hasTime), time);
  }
});

Deno.test("形式が合わない入力は null を返す", () => {
  assertEquals(parseTimeRange("2024-01-01"), null, "区切りが 1 つ足りない");
  assertEquals(parseTimeRange("not a date range"), null);
});

Deno.test("相対指定の文法を検証できる", () => {
  for (const preset of RELATIVE_PRESETS) {
    assert(isValidRelativeTime(preset), preset);
  }
  assert(isValidRelativeTime("all_2008"));
  assert(!isValidRelativeTime("now 1-D"), "d は小文字でなければならない");
  assert(!isValidRelativeTime("today 12-h"), "today に時間単位は無い");
  assert(!isValidRelativeTime("last 7 days"));
});

Deno.test("送信前に弾ける不正な絶対期間を検出する", () => {
  const now = new Date("2026-09-09T00:00:00Z");
  assertEquals(
    validateAbsoluteTime(new Date("2024-03-31Z"), new Date("2024-01-01Z"), now),
    ["start-not-before-end"],
  );
  assertEquals(
    validateAbsoluteTime(new Date("2030-01-01Z"), new Date("2030-03-31Z"), now),
    ["entirely-future"],
  );
  assertEquals(
    validateAbsoluteTime(new Date("2000-01-01Z"), new Date("2004-06-01Z"), now),
    ["before-trends-epoch"],
  );
  assertEquals(
    validateAbsoluteTime(new Date("2024-01-01Z"), new Date("2024-03-31Z"), now),
    [],
    "正常な期間は問題なし",
  );
});

Deno.test("データ開始時刻は 2004-01-01 UTC", () => {
  assertEquals(new Date(TRENDS_EPOCH_MS).toISOString(), "2004-01-01T00:00:00.000Z");
});
