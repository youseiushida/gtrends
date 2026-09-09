import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { decodeWidgetToken, isWidgetTokenValid, TOKEN_BYTE_LENGTH, TOKEN_LENGTH } from "./token.ts";

/** HAR 54/54 で共通だった固定ヘッダ。 */
const FIXED_HEADER = [0x00, 0xd2, 0x3f, 0xdb, 0x03, 0x00, 0x00, 0x00, 0x00];

/** 指定した失効時刻を持つ合成 token を作る (実物の秘密情報は使わない)。 */
function makeToken(expiresAtSec: number): string {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  bytes.set(FIXED_HEADER, 0);
  new DataView(bytes.buffer).setUint32(9, expiresAtSec, false);
  for (let i = 13; i < TOKEN_BYTE_LENGTH; i++) bytes[i] = i; // 署名部のダミー
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.test("合成 token が実物と同じ 44 文字 / 33 バイトになる", () => {
  const token = makeToken(1_800_000_000);
  assertEquals(token.length, TOKEN_LENGTH);
  const decoded = decodeWidgetToken(token);
  assert(decoded !== null);
  assertEquals(decoded.bytes.length, TOKEN_BYTE_LENGTH);
});

Deno.test("先頭 12 文字は固定ヘッダ由来で常に ANI_2wMAAAAA になる", () => {
  assertEquals(makeToken(1_800_000_000).slice(0, 12), "ANI_2wMAAAAA");
});

Deno.test("bytes[9..12] のビッグエンディアン uint32 が失効時刻になる", () => {
  const expiresAtSec = 1_788_883_200;
  const decoded = decodeWidgetToken(makeToken(expiresAtSec));
  assert(decoded !== null);
  assertEquals(decoded.expiresAt.getTime(), expiresAtSec * 1000);
});

Deno.test("44 文字はパディング不要 — 無条件に == を足すと atob が落ちる", () => {
  // "=".repeat((4 - 44 % 4) % 4) === "" を実装が守っているかの回帰テスト。
  // 守っていなければ decodeWidgetToken が null を返す (atob が例外を投げるため)。
  assertEquals(TOKEN_LENGTH % 4, 0);
  assert(decodeWidgetToken(makeToken(1_800_000_000)) !== null);
});

Deno.test("形式が違う token は例外ではなく null を返す", () => {
  assertEquals(decodeWidgetToken("short"), null);
  assertEquals(decodeWidgetToken("!".repeat(TOKEN_LENGTH)), null, "base64url でない文字");
  assertEquals(decodeWidgetToken(""), null);
});

Deno.test("有効期限の判定は現在時刻を注入して決定的に検証できる", () => {
  const expiresAtSec = 1_800_000_000;
  const token = makeToken(expiresAtSec);
  const justBefore = new Date((expiresAtSec - 3600) * 1000);
  const justAfter = new Date((expiresAtSec + 1) * 1000);
  assert(isWidgetTokenValid(token, justBefore));
  assert(!isWidgetTokenValid(token, justAfter));
});

Deno.test("失効直前は skew の分だけ無効側に倒す", () => {
  const expiresAtSec = 1_800_000_000;
  const token = makeToken(expiresAtSec);
  const thirtySecBefore = new Date((expiresAtSec - 30) * 1000);
  assert(!isWidgetTokenValid(token, thirtySecBefore), "既定 skew 60 秒より内側なので無効");
  assert(isWidgetTokenValid(token, thirtySecBefore, 10_000), "skew を縮めれば有効");
});

Deno.test("FakeTime で 24 時間経過をシミュレートできる", () => {
  using time = new FakeTime(new Date("2026-09-09T00:00:00Z"));
  const expiresAtSec = Math.floor(Date.now() / 1000) + 86400;
  const token = makeToken(expiresAtSec);
  assert(isWidgetTokenValid(token), "発行直後は有効");
  time.tick(24 * 60 * 60 * 1000);
  assert(!isWidgetTokenValid(token), "24 時間後は失効している");
});
