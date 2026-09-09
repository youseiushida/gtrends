/**
 * batchexecute の実レスポンス。HAR キャプチャ (2026-09-08) とライブ実測 (2026-09-09) 由来。
 *
 * **秘密情報は含まない** (Cookie も reCAPTCHA トークンも入っていない)。
 *
 * @module
 */

/**
 * HAR entry330。rpcids=Tnt4U、引数 `[]`、ペイロード `[[]]`。
 * ASCII のみで 142 文字 = 142 バイトなので、**UTF-16 と UTF-8 が一致してしまい
 * 単位の違いに気付けない**例。小さい応答だけで実装してはいけない証拠。
 */
export const HAR_ENTRY330_BODY: string = ")]}'\n" +
  "\n" +
  "106\n" +
  '[["wrb.fr","Tnt4U","[[]]",null,null,null,"generic"],["di",10],["af.httprm",10,"8110329141056352168",20]]\n' +
  "25\n" +
  '[["e",4,null,null,142]]\n';

/**
 * HAR entry418 の第 1 チャンク。日本語 6 文字を含む。
 * 長さ行 57 / UTF-16 55 / UTF-8 67 → **長さ行はバイト長ではない**ことの直接の証拠。
 */
export const HAR_ENTRY418_CHUNK1: string =
  '57\n[["wrb.fr","wAgrOe","[\\"アイルランド\\"]",null,null,null,"3"]]\n';

/**
 * HAR entry418 のチャンク列 (巨大ペイロードを省いた縮約版)。
 * **レスポンス順がリクエスト順 (i0OFE → wAgrOe) と逆転している**ことを示す。
 */
export const HAR_ENTRY418_SHAPE: string = ")]}'\n\n" +
  HAR_ENTRY418_CHUNK1 +
  "55\n" +
  '[["di",48],["af.httprm",48,"3251696711060829550",18]]\n' +
  "26\n" +
  '[["e",5,null,null,3086]]\n';

/**
 * ライブ実測。slotId に `"s🇯🇵e"` を入れてサーバにエコーさせたもの。
 * 長さ行 111 / UTF-16 109 / コードポイント 107 / UTF-8 117
 * → **長さ行が UTF-16 コードユニット数であることの決定的証拠。**
 */
export const LIVE_SURROGATE_BODY: string = ")]}'\n" +
  "\n" +
  "111\n" +
  '[["wrb.fr","wAgrOe","[\\"日本\\"]",null,null,null,"s\u{1F1EF}\u{1F1F5}e"],["di",12],["af.httprm",11,"-5668663339315347667",17]]\n' +
  "25\n" +
  '[["e",4,null,null,155]]\n';

/** ライブ実測: 存在しない rpcid → HTTP 400 + `er` チャンク。 */
export const LIVE_ER_BODY: string = ")]}'\n" +
  "\n" +
  "102\n" +
  '[["er",null,null,null,null,400,null,null,null,3],["di",9],["af.httprm",8,"-1913695066988224335",16]]\n' +
  "25\n" +
  '[["e",4,null,null,138]]\n';

/**
 * ライブ実測: POST ではなく GET で投げた → HTTP 405。
 * `er[5]=405` / `er[9]=9` で、**`er[9]` が 3 固定ではない**ことの証拠。
 */
export const LIVE_ER_405_BODY: string = ")]}'\n" +
  "\n" +
  "102\n" +
  '[["er",null,null,null,null,405,null,null,null,9],["di",8],["af.httprm",8,"-6083195748611684957",17]]\n' +
  "25\n" +
  '[["e",4,null,null,138]]\n';

/**
 * ライブ実測: rpcid は正しいが引数が不正 → **HTTP 200 のまま** `wrb.fr[2]=null` /
 * `wrb.fr[5]=[3]`。`res.ok` では絶対に検出できない。
 */
export const LIVE_RPC_ERROR_BODY: string = ")]}'\n" +
  "\n" +
  "105\n" +
  '[["wrb.fr","wAgrOe",null,null,null,[3],"generic"],["di",17],["af.httprm",16,"-5609615246004551854",15]]\n' +
  "25\n" +
  '[["e",4,null,null,141]]\n';

/** ライブ実測: `rt` を省略したときの応答 (長さ行も `e` チャンクも無い)。 */
export const LIVE_UNCHUNKED_BODY: string = ")]}'\n" +
  "\n" +
  '[["wrb.fr","wAgrOe","[\\"日本\\"]",null,null,null,"generic"],["di",12],["af.httprm",11,"-7864793380069003492",16]]';

/** 合成した `WIZ_global_data` を含む HTML (f.sid / bl の抽出テスト用)。 */
export const WIZ_HTML: string = "<!doctype html><html><head>" +
  '<script data-id="_gd" nonce="abc">window.WIZ_global_data = ' +
  '{"cfb2h":"boq_trends-boq-servers-frontend_20260906.08_p0",' +
  '"FdrFJe":"-8959654384266786277","rtQCxc":-540};</script>' +
  "</head><body></body></html>";
