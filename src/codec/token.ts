/**
 * widget token のデコード。
 *
 * `explore` が各ウィジェットに配る `token` は 44 文字の base64url で、
 * デコードすると 33 バイトになる。
 *
 * ```text
 * bytes[0..8]   固定ヘッダ 00 d2 3f db 03 00 00 00 00  (先頭 12 文字は常に "ANI_2wMAAAAA")
 * bytes[9..12]  ビッグエンディアン uint32 = 失効 UNIX 秒 (発行 + 86400)
 * bytes[13..32] 20 バイトの署名。req 全体に対して計算されている
 * ```
 *
 * 署名対象に `userConfig` まで含まれるため、**`widget.request` を 1 バイトでも
 * 書き換えると 401 になる**。
 *
 * @module
 */

import type { DecodedToken } from "../types.ts";

/** widget token の文字数。 */
export const TOKEN_LENGTH = 44;

/** デコード後のバイト数。 */
export const TOKEN_BYTE_LENGTH = 33;

/**
 * base64url をデコードする。
 *
 * **パディングは `"=".repeat((4 - len % 4) % 4)` で計算すること。**
 * token は 44 文字 = 4 の倍数なのでパディング不要であり、
 * 無条件に `"=="` を足すと `atob` が `InvalidCharacterError` で落ちる。
 */
function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64 + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * token をデコードして失効時刻と生バイト列を返す。
 *
 * @param token `explore` が返した 44 文字の token
 * @returns デコード結果。形式が想定と違う場合は `null`
 */
export function decodeWidgetToken(token: string): DecodedToken | null {
  if (typeof token !== "string" || token.length !== TOKEN_LENGTH) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(token);
  } catch {
    return null;
  }
  if (bytes.length !== TOKEN_BYTE_LENGTH) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expiresAtSec = view.getUint32(9, false); // big endian
  return { expiresAt: new Date(expiresAtSec * 1000), bytes };
}

/**
 * token が現時点で有効かを**ローカルで**判定する。
 *
 * 送信前にこれを通しておくと、失効済み token で 401 を食らって
 * レート制限の予算を無駄に消費するのを避けられる。
 *
 * ただし **24 時間有効という性質は日を跨いで実証されていない**ため、
 * これが `true` でも 401 が返る可能性は残る。401 を受けたら
 * `explore` を叩き直す経路を必ず用意しておくこと。
 *
 * @param token 判定対象
 * @param now 現在時刻 (テストで固定できるように引数化)
 * @param skewMs 失効直前を無効とみなす余裕。既定 60 秒
 */
export function isWidgetTokenValid(
  token: string,
  now: Date = new Date(),
  skewMs: number = 60_000,
): boolean {
  const decoded = decodeWidgetToken(token);
  if (decoded === null) return false;
  return decoded.expiresAt.getTime() - skewMs > now.getTime();
}
