// 実行: deno test --allow-net --no-check live_integration/02_explore_widget_tokens_test.ts
//
// =============================================================================
// Google Trends 旧 REST API: /trends/api/explore  — ウィジェット & トークン発行
// =============================================================================
// ライブ検証日: 2026-09-09 (JST) / 2026-09-08T15:48Z 〜 15:52Z (UTC)
// HAR 根拠: C:\Users\ushid\Documents\gtrend_claude\.har\extracted\trends_api_explore\
//           00_entry092 〜 12_entry272 (計 13 エントリ, 全て status 200)
//           ※ HAR にはレスポンスボディが 1 バイトも残っていない (DevTools のページ単位
//             ボディ退避により page_1 のボディが全滅)。したがって本ファイルのレスポンス
//             仕様は「全てライブ実測」に基づく。リクエスト仕様のみ HAR 由来。
//
// -----------------------------------------------------------------------------
// 1. 位置づけ
// -----------------------------------------------------------------------------
// このエンドポイントはラッパーライブラリの心臓部。「キーワード + 地域 + 期間 + カテゴリ +
// プロパティ」を渡すと、後続の実データ取得エンドポイント
//   /trends/api/widgetdata/multiline        (時系列)
//   /trends/api/widgetdata/comparedgeo      (地域別)
//   /trends/api/widgetdata/relatedsearches  (関連トピック / 関連キーワード)
// を叩くために必要な (request, token) のペアを "ウィジェット" として返す。
// widgetdata 系は explore が返した request をそのまま透過させ、token を添えるだけで動く。
//
// -----------------------------------------------------------------------------
// 2. エンドポイントと HTTP メソッド
// -----------------------------------------------------------------------------
//   GET|POST https://trends.google.com/trends/api/explore
//
// * ブラウザは POST + reCAPTCHA ボディを送る (HAR 13/13)。
// * 【実測確定】GET でも 200。POST でもボディを完全に空にして 200。
//   同一 req に対して GET と POST(空ボディ) のレスポンスは (発行時刻由来の差を除いて)
//   バイト長まで一致する。→ **reCAPTCHA トークンは不要**。
// * ブラウザ POST のボディ形式 (参考。ラッパーは送らなくてよい):
//     "FE" + base64(JSON.stringify(["setoken", <reCAPTCHA v3 token>, <BotGuard blob>]))
//   第 3 要素はブラウザ内 VM 生成のため HTTP レベルでは再現不可能。送る必要が無いので無視する。
//
// -----------------------------------------------------------------------------
// 3. クエリパラメータ
// -----------------------------------------------------------------------------
//  hl  (string, 必須級)  UI 言語。"ja" / "en-US" など。
//                        → widget.request.locale と widget.title / helpDialog /
//                          keywords[].type の言語を決める。
//                          hl="ja" なら keywords[0].type = "検索キーワード"、
//                          hl="en-US" なら "Search term"。
//                        → relatedsearches の request.language は hl の言語部分のみ
//                          ("en-US" → "en")。
//  tz  (number, 必須級)  タイムゾーンオフセット (分)。JS の Date#getTimezoneOffset() 規約
//                        なので JST(UTC+9) は **-540**、UTC は 0。
//                        【実測】tz を -540 にしても 0 にしても widget.request.time の
//                        時間窓は **UTC のまま変わらない**。tz は explore の窓算出には
//                        一切効かない。効くのは widgetdata 側の formattedTime /
//                        formattedAxisTime の表示シフトのみ。
//  req (JSON string, 必須) 下記 §4。
//
//  ブラウザは URL に tz を 2 回付ける (?hl=..&tz=..&req=..&tz=..)。Angular の interceptor に
//  よる二重付与で、1 回でも 2 回でも動く (実測)。
//
//  【エンコード】ブラウザは { } [ ] " のみ %エンコードし、: と , は生、空白は + にする。
//  【実測確定】`new URLSearchParams({hl,tz,req}).toString()` の標準エンコード
//  (: → %3A, , → %2C, 空白 → +) でもサーバは受理して 200 を返す。
//  → ラッパーは encodeURIComponent / URLSearchParams のどちらでもよい。
//
// -----------------------------------------------------------------------------
// 4. req のスキーマ (HAR 13 エントリの和集合 + ライブ実験)
// -----------------------------------------------------------------------------
//  {
//    "comparisonItem": [                 // 1〜5 要素。6 要素以上は 400 (実測)
//      {
//        "keyword": "Fanza",             // string 必須。
//                                        //   通常のキーワード、または Knowledge Graph の
//                                        //   mid ("/m/02vqfm" など) を渡せる (実測)。
//                                        //   mid を渡すと complexKeywordsRestriction の
//                                        //   type が BROAD → ENTITY になり、
//                                        //   keywords[0].name/type にエンティティ名と
//                                        //   カテゴリが入る ("/m/02vqfm" → "Coffee"/"Beverage")。
//                                        //   キーワード自体に complexKeywordsRestriction を
//                                        //   直接書くのは **不可** (§8 参照)。
//        "geo": "JP",                    // "" (全世界) | "JP" (ISO-3166-1) | "JP-13" (ISO-3166-2)
//                                        //   不正コード ("ZZ") は 400 (実測)
//        "time": "now 1-d"               // §5 の書式。不正文字列は 400 (実測)
//      }
//    ],
//    "category": 0,                      // int。0 = すべてのカテゴリ。8 / 41 などを観測。
//                                        //   【実測】999999 でも 400 にならず 200 が返り、
//                                        //   requestOptions.category にそのままエコーされる。
//                                        //   explore 側でのバリデーションは無い。
//    "property": ""                      // "" (ウェブ検索) | "images" | "news" | "froogle"
//                                        //   (ショッピング) | "youtube"
//                                        //   【実測】"bogus" のような未知値でも 200 (無検証)。
//  }
//  観測されたフィールドはこの 5 つで全て。省略時の既定値は未検証なので必ず 3 キーとも書くこと。
//
// -----------------------------------------------------------------------------
// 5. time の入力書式 → widget.request への正規化 (実測)
// -----------------------------------------------------------------------------
//  入力 time      | request.time                                    | resolution   | backend | timeRanges
//  ---------------|-------------------------------------------------|--------------|---------|----------------
//  "now 1-d"      | "2026-09-07T15\:48\:50 2026-09-08T15\:48\:50"   | EIGHT_MINUTE | CM      | "Past day"       (実測)
//  "now 4-H"      | (同形式の 4 時間窓)                              | MINUTE       | CM      | (未実測/推定)     (HAR 由来)
//  "today 12-m"   | "2025-09-08 2026-09-08"                         | WEEK         | IZG     | "Past 12 months" (実測)
//  "all_2008"     | "2008-01-01 2026-09-08"                         | MONTH        | IZG     | "2008 - present" (実測)
//
//  ※ resolution / backend は入力 time から **サーバが自動決定**する。クライアントは指定できない。
//    "now 4-H" 行は HAR の widgetdata リクエストから逆算した値で、timeRanges のラベルだけ未実測。
//
//  * 1 日未満の窓は `YYYY-MM-DDTHH:MM:SS` 形式で、**コロンがバックスラッシュでエスケープ**
//    される。JSON 文字列としては "2026-09-07T15\\:48\\:50 ..." (実体は `\:`)。
//    URL に載せると `%5C%5C:` ではなく、JSON.stringify → encodeURIComponent の結果として
//    `%5C:` を含む形になる。**自前で組み立てず、explore が返した文字列をそのまま透過させること。**
//  * 2 つの日時は半角スペース区切り。
//  * 窓の末端 = リクエスト時刻 (UTC)。tz を渡しても UTC のまま (実測)。
//  * trendinessSettings.compareTime (relatedsearches のみ):
//      now 1-d    → 直前の同じ長さの窓
//      today 12-m → "2024-09-07 2025-09-07" (1 年前。端が 1 日ずれる)
//      all_2008   → "2008-01-01 2009-01-01" (最初の 1 年。直前窓ではない)
//
// -----------------------------------------------------------------------------
// 6. 認証 (Cookie) 要件 — 最重要の落とし穴
// -----------------------------------------------------------------------------
//  * Cookie 無しで /trends/api/explore を叩くと **429 Too Many Requests**
//    (content-type: text/html)。JSON ではない。ボディ長は URL 依存で変動するので
//    長さで判定してはいけない (§9)。
//  * 必要なのは **NID Cookie 1 個だけ**。OTZ も _ga* も __utm* も不要。
//  * NID の入手経路 (実測):
//      GET https://trends.google.com/trends/explore?q=..&date=..&geo=..&hl=..
//        → status 429 だが `Set-Cookie: NID=...` が付く。この NID を以後付ければ 200。
//      GET https://trends.google.com/trending?geo=..&hl=.. でも 200 + Set-Cookie: NID が付く
//        (ただし body 1.2MB なので前者のほうが軽い)。
//  * ログイン系ヘッダ (authorization / x-goog-*) は一切不要。
//
// -----------------------------------------------------------------------------
// 7. リクエストヘッダ要件
// -----------------------------------------------------------------------------
//  最小構成 (実測でこれだけで 200):
//    cookie: NID=<値>
//  推奨 (無害・低コスト):
//    accept: application/json, text/plain, */*
//    accept-language: <hl と揃える>
//    user-agent: <普通の Chrome UA>
//    referer: https://trends.google.com/trends/explore
//  POST の場合はブラウザは content-type: application/json;charset=UTF-8 と
//  origin: https://trends.google.com を送るが、空ボディなら content-type も不要 (実測)。
//  送るべきでないもの: x-browser-validation / x-browser-* / sec-ch-ua-* (Chrome 内部の定数。
//  偽装するとかえって目立つ)。
//
// -----------------------------------------------------------------------------
// 8. レスポンス形式
// -----------------------------------------------------------------------------
//  status 200 / content-type: application/json; charset=utf-8
//  content-disposition: attachment; filename="json.txt"; filename*=UTF-8''json.txt
//  cache-control: no-cache, no-store, max-age=0, must-revalidate
//
//  ボディは **`)]}'\n` の 5 文字プレフィックス**の後に JSON 本体。
//  (実測ではこのエンドポイントの本体末尾に改行は付かなかった。widgetdata 系は末尾改行が
//   付く実績があるので、パーサは `text.slice(5)` ではなく
//   `text.replace(/^\)\]\}'\s*/, "")` + trim で頑健に剥がすのが安全。)
//
//  JSON トップレベル (実測、5 キーで全て):
//  {
//    "widgets": [ ... ],                       // §8-1
//    "keywords": [ { "keyword": "Fanza",       // req で渡した文字列 (mid ならその mid)
//                    "name": "Fanza",          // 解決された表示名 (mid なら "Coffee")
//                    "type": "Search term" } ],// hl で局所化。mid なら "Beverage" 等の
//                                              //   エンティティ種別。ja では "検索キーワード"
//    "timeRanges": ["Past day"],               // comparisonItem と同数。hl で局所化
//    "shareText": "Explore search interest for Fanza by time, location and popularity on Google Trends",
//    "shouldShowMultiHeatMapMessage": false
//  }
//
//  ### 8-1. widget オブジェクト
//  共通フィールド (全 widget):
//    id, type, title, template ("fe" | "fe_explore"), embedTemplate ("fe_embed"),
//    version ("1"), isLong (bool), isCurated (bool)
//  データ取得可能な widget のみが持つ:
//    request (object) … widgetdata へそのまま渡す JSON
//    token   (string) … §8-3
//
//  id / type / 追加フィールドの対応 (実測):
//   | id                | type                  | 対応エンドポイント | 追加フィールド
//   |-------------------|-----------------------|--------------------|-------------------------------
//   | TIMESERIES        | fe_line_chart         | multiline          | lineAnnotationText, bullets[{text}], showLegend, showAverages, helpDialog
//   | GEO_MAP (単一kw)  | fe_geo_chart_explore  | comparedgeo        | geo, resolution, searchInterestLabel, displayMode, helpDialog, color, index, bullet
//   | GEO_MAP (複数kw)  | fe_multi_heat_map     | comparedgeo        | geo, resolution, searchInterestLabel, displayMode, showLegend, bullets[{value,color}]
//   | GEO_MAP_0/_1/..   | fe_geo_chart_explore  | comparedgeo        | 上の単一版と同じ (color, index, bullet がキーワード毎)
//   | RELATED_TOPICS    | fe_related_searches   | relatedsearches    | helpDialog, color, keywordName  (request.keywordType="ENTITY")
//   | RELATED_QUERIES(_N)| fe_related_searches  | relatedsearches    | 同上                            (request.keywordType="QUERY")
//   | TITLE_0/_1/..     | fe_text               | (なし)             | text:{text:"<キーワード>"} / template="fe_explore" / **request も token も無い**
//   | rt_note           | fe_text               | (なし)             | text:{text:"<注意書き>"} / **request も token も無い**
//
//  widget.geo / widget.resolution は UI 描画用のメタ情報で、request.resolution とは別物:
//    req.geo="JP"    → widget.geo="JP",    widget.resolution="provinces", request.resolution="REGION"
//    req.geo=""      → widget.geo="world", widget.resolution="countries", request.resolution="COUNTRY"
//    req.geo="JP-13" → (HAR より) request.resolution="CITY"
//
//  ### 8-2. widget id の集合 (実測)
//   * キーワード 1 個:
//       ["TIMESERIES","GEO_MAP","RELATED_TOPICS","RELATED_QUERIES"]  (4 個)
//   * キーワード 2 個 (2026-09-09 実測):
//       ["TIMESERIES","GEO_MAP","TITLE_0","GEO_MAP_0","RELATED_QUERIES_0",
//        "TITLE_1","GEO_MAP_1","RELATED_QUERIES_1"]                  (8 個)
//     → **複数キーワード時は RELATED_TOPICS が消え、RELATED_QUERIES_N だけになる。**
//       TITLE_N という request/token を持たない見出しウィジェットが挟まる。
//       統合 GEO_MAP は type が fe_multi_heat_map になり request に dataMode:"PERCENTAGES" が付く。
//     (注: 先行調査がバイト会計から「2kw は 6 ウィジェット」と推定していたが、実測は 8 個。
//      TITLE_N が request/token を持たず小さいため会計が合っていた。実測が正。)
//
//   【この主張の根拠の強さ】(2026-09-09 追試での再検証結果)
//     explore のレスポンスボディは HAR に無いので、id 文字列そのものはライブ実測 1 回が
//     唯一の一次証拠。ただし **explore 直後にブラウザが投げる widgetdata の並び** が
//     HAR に残っており、これが widget 配列の順序と 1:1 に対応することで裏が取れる:
//       1kw (HAR entry 092 の直後): multiline(100) → comparedgeo(101) →
//            relatedsearches keywordType=ENTITY(102) → relatedsearches QUERY(103)
//            = TIMESERIES / GEO_MAP / RELATED_TOPICS / RELATED_QUERIES と同順・同数。
//       2kw (HAR entry 272 の直後): multiline(274) → comparedgeo(275, dataMode=PERCENTAGES,
//            comparisonItem 2 件) → comparedgeo(276, Fanza 単独) → relatedsearches
//            QUERY(277, Fanza) → comparedgeo(278, DLsite 単独) → relatedsearches
//            QUERY(279, DLsite)
//            = TIMESERIES / GEO_MAP / GEO_MAP_0 / RELATED_QUERIES_0 / GEO_MAP_1 /
//              RELATED_QUERIES_1 と同順・同数で、**ENTITY(RELATED_TOPICS) が 1 本も無い**。
//     → 「token を持つ widget 6 個の顔ぶれと順序」「dataMode が統合地図だけに付く」
//       「複数キーワードでは RELATED_TOPICS が消える」は HAR で確定。
//       TITLE_N の存在と id 文字列だけがライブ実測 1 回に依存している。
//
//  ### 8-3. token の性質 (実測で完全解明)
//   * 常に 44 文字の base64url (charset [A-Za-z0-9_-]、パディング無し)。全て "ANI_2wMAAAAA" 始まり。
//   * base64url デコードで **33 バイト固定**:
//       bytes[0..8]  (9B) = 00 d2 3f db 03 00 00 00 00  … 固定ヘッダ (HAR 54 個 + ライブ全件で同一)
//       bytes[9..12] (4B) = ビッグエンディアン uint32 = **有効期限の UNIX 秒**
//       bytes[13..32](20B)= 署名 (HMAC-SHA1 相当)。widget ごとに一意
//   * **有効期限 = explore 応答時刻 + 24 時間ちょうど** (HAR 54/54 で 86399〜86400 秒、
//     ライブでも 4/4 が正確に +86400)。→ 期限はローカルで判定できる:
//       new DataView(bytes.buffer).getUint32(9,false) * 1000
//   * 同一 explore レスポンス内でも widget ごとに **全て異なる** token。
//   * **token は request の内容に紐付く**。【実測】explore が返した request.time /
//     resolution / backend を書き換えて同じ token で widgetdata/multiline を叩くと
//     **401 (content-type: text/html)**。→ 自前で時間範囲や resolution を差し替えることは
//     できない。範囲を変えたければ explore を叩き直すこと。
//   * URL に載せるときは encodeURIComponent すること (base64url なので実際に置換される
//     文字は無いが、将来の安全のため)。
//
// -----------------------------------------------------------------------------
// 9. 不正入力・エラー時の挙動 (全てライブ実測 2026-09-09)
// -----------------------------------------------------------------------------
//   Cookie (NID) 無し                    → 429, content-type: text/html, Retry-After 無し
//   geo="ZZ" (存在しない国)              → 400, content-type: text/html
//   time="banana" (不正書式)             → 400, content-type: text/html
//   comparisonItem 6 要素                → 400, content-type: text/html  (上限は 5)
//   category=999999 (範囲外)             → **200**。requestOptions.category にそのままエコー
//   property="bogus" (未知値)            → **200**。無検証
//   comparisonItem に keyword を書かず
//     complexKeywordsRestriction を直書き → **200 だが縮退**。widgets は
//                                          [{id:"rt_note", type:"fe_text", text:{text:
//                                          "Rising and top queries and topics are available
//                                           only for dates older than 7 days ago."}}] の 1 個だけ、
//                                          keywords は [{keyword:"",name:"",type:"Search term"}]。
//                                          → explore に complexKeywordsRestriction を直接渡すのは不可。
//                                            必ず keyword (文字列 or mid) を使うこと。
//   widgetdata に改変した request + 元 token → 401, content-type: text/html
//
//   【エラーボディの形】(2026-09-09 追試)
//     4xx / 429 のボディは Google 共通のエラー HTML で、必ず
//       `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">` で始まる。
//     ボディ長は **固定ではない**。エラー HTML はリクエスト URL 自身を本文に埋め込むため、
//     req が長いほど大きくなる (同日の実測で同一 URL なら 4150 B で再現、URL が違えば
//     3448 / 3877 / 4150 B と変動)。**バイト長でエラー種別を判定してはいけない。**
//     判定は status + content-type + 先頭が "<" か ")]}'" か、で行うこと。
//
//   【成功判定の推奨】
//     res.status === 200 && res.headers.get("content-type")?.startsWith("application/json")
//     エラー時は content-type が text/html になるので、status だけでなく必ず併用すること。
//     rt_note のみが返る「200 だが実質エラー」のケースがあるので、
//     widgets が token を 1 つも持たない場合も異常として扱うこと。
//
// -----------------------------------------------------------------------------
// 10. レート制限の挙動
// -----------------------------------------------------------------------------
//   * 429 は content-type: text/html、Retry-After 無し。ボディは Google 標準のエラー HTML
//     (長さは URL 依存で変動。§9 参照)。
//   * NID 無しなら初回から確実に 429。NID 付きでも短時間に叩きすぎると 429 になる。
//   * 【2026-09-09 追試】同一 IP から複数プロセスで並行検証すると **IP 単位で数分以上
//     429 が続く**状態に入る。この状態では NID を取り直しても explore は全て 429 で、
//     90 秒のクールダウンでは復帰しなかった。ラッパーは 429 を「一時的な失敗」ではなく
//     「しばらく全リクエストが通らない」状態として扱い、プロセス全体でサーキットブレーカを
//     持つのが安全 (このテストファイル自身も同じ設計にしてある。§12)。
//   * HAR の正規ブラウザセッション (Cookie も reCAPTCHA も完備) でも 111 件中 1 件 429 が
//     発生しており、同時並列の他 3 本は 200 だった。→ セッション単位のブロックではなく
//     **リクエスト単位の確率的スロットリング**。1 本落ちても他は生きるのでリトライが有効。
//   * ラッパーは指数バックオフ (2s → 4s → 8s、最大 3 回) を組み込むこと。
//
// -----------------------------------------------------------------------------
// 11. ラッパー実装チェックリスト
// -----------------------------------------------------------------------------
//   1. NID を 1 回取得してプロセス内で使い回す (GET /trends/explore の 429 から Set-Cookie)。
//   2. req はクエリに載せる。POST でもよいがボディは空でよい。reCAPTCHA は扱わない。
//   3. token は 24 時間有効。explore を 1 回叩けば翌日まで widgetdata を叩ける。
//      期限は token の bytes[9..12] をデコードすればオフラインで判定できる。
//   4. request は改変せず丸ごと透過させる (改変すると 401)。
//   5. 200 + application/json を成功条件にする。text/html が返ったら 400/401/429 系。
//   6. widget を id で引くときは、複数キーワードで RELATED_TOPICS が消えることと
//      TITLE_N / rt_note に token が無いことを考慮する。
//
// -----------------------------------------------------------------------------
// 12. このテストファイルの構成
// -----------------------------------------------------------------------------
//   * offline: … ネットワーク不要。URL 組み立て / プレフィックス剥がし / token デコーダ /
//     widget id 生成規則を検証。実トークン・実 Cookie・reCAPTCHA トークンは一切埋め込んで
//     いない (すべて合成データ)。
//   * live: …  ネットワークを **最大 5 リクエスト** 使う。全 live テストで結果を共有する:
//        (1) NID 取得                       GET /trends/explore
//        (2) 単一キーワード                 GET  /trends/api/explore
//        (3) 単一キーワード (空ボディ POST) POST /trends/api/explore
//        (4) 2 キーワード                   GET  /trends/api/explore
//        (5) 不正 geo="ZZ"                  GET  /trends/api/explore
//     429 を受けたら 2s → 4s のバックオフで最大 2 回再試行する。それでも 429 なら
//     **サーキットブレーカが開いて以降のライブ呼び出しを全て打ち切る** (§10 のとおり
//     429 は IP 単位で持続するため、叩き続けても無駄で有害)。落ちずに console.warn を
//     出して skip 扱いにするので、「緑だが live が skip」= レート制限。時間を置いて再実行する。
//   * したがってワーストケースのリクエスト数は 1 + 3 = 4 (最初の explore で 429 が続いた場合)、
//     ベストケースは 5。
//
//   【仕様の主張 → 検証手段の対応表】(この表に無い主張はドキュメントのみで、テストは無い)
//     §3  URL エンコードはどちらの方式でも可      → offline (組み立て往復)
//     §5  time 正規化 / resolution / backend      → live (単一キーワード)
//     §5  \: エスケープを透過させる               → live + offline
//     §8  )]}' プレフィックス                     → offline + live
//     §8-1 widget 共通フィールド                  → live (単一キーワード)
//     §8-2 単一キーワードの widget id 4 個        → live
//     §8-2 2 キーワードの widget id 8 個          → live (2 キーワード) + offline (id 生成規則)
//          ※ HAR 274〜279 による裏取りは §8-2 の「根拠の強さ」を参照。
//     §8-3 token 44 文字 / 33 バイト / +24h       → offline (合成) + live (実物)
//     §9  不正 geo はエラー HTML                  → live (不正 geo)
//     §9  time 不正 / category 範囲外 / property  → ドキュメントのみ (リクエスト数節約)
//     §4  mid を keyword に渡すと ENTITY になる   → ドキュメントのみ (リクエスト数節約)
//     §3  tz は time 窓に影響しない               → ドキュメントのみ (リクエスト数節約)
//
// -----------------------------------------------------------------------------
// 13. 検証ログ
// -----------------------------------------------------------------------------
//   2026-09-09 (初回)  : 単一キーワードの GET / POST(空ボディ) / token / request 正規化 /
//                        2 キーワードの widget id を実測。§4〜§9 の記述はこのときの実測。
//   2026-09-09 (追試)  : 同一 IP から他プロセスが並行検証していたため explore が
//                        **恒常的に 429**。90 秒 / 240 秒 / 420 秒のクールダウンを挟んでも
//                        復帰せず、ライブ再検証は不可能だった。この回で確定できたのは:
//                          - HAR 13 エントリのリクエスト仕様 (§3 のエンコード、§4 の req、
//                            全て POST であること) が記述と一致すること
//                          - HAR の widget token 3 本を実際にデコードし、33 バイト /
//                            固定ヘッダ 00d23fdb0300000000 / bytes[9..12] = 発行 +24h
//                            (2026-09-08T14:54:47Z 発行 → 2026-09-09T14:54:48Z 期限)
//                            であること = §8-3 は正しい
//                          - HAR の後続 widgetdata の並びが §8-2 の widget 順序と一致すること
//                          - エラー HTML のバイト長は固定ではなく URL 長に依存すること
//                            (旧記述の「1697 B / 1691 B」は誤り。§9 で訂正済み)
//                        ライブテストは 429 を握り潰して skip するので、この状態でも
//                        `deno test` は緑になる (12 passed / live は全て skip)。
//
// =============================================================================

import { assert, assertEquals } from "jsr:@std/assert@^1";

const ORIGIN = "https://trends.google.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// 純粋関数 (ネットワーク不要 / ラッパー実装にそのまま流用できる形)
// ---------------------------------------------------------------------------

/** `)]}'` プレフィックスを頑健に剥がして JSON.parse する。 */
function parseTrendsJson(text: string): unknown {
  const stripped = text.replace(/^\)\]\}'\s*/, "");
  return JSON.parse(stripped);
}

/** explore の URL を組み立てる (encodeURIComponent 方式 = ブラウザに近い形)。 */
function buildExploreUrl(
  req: unknown,
  hl: string,
  tz: number,
  method: "browser" | "urlsearchparams" = "browser",
): string {
  const reqJson = JSON.stringify(req);
  if (method === "urlsearchparams") {
    return `${ORIGIN}/trends/api/explore?` +
      new URLSearchParams({ hl, tz: String(tz), req: reqJson }).toString();
  }
  return `${ORIGIN}/trends/api/explore?hl=${encodeURIComponent(hl)}&tz=${tz}` +
    `&req=${encodeURIComponent(reqJson)}&tz=${tz}`;
}

/** 44 文字 base64url の widget token を 33 バイトへデコードする。 */
function decodeWidgetToken(token: string): Uint8Array {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (token.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** widget token の有効期限 (ミリ秒 epoch)。bytes[9..12] のビッグエンディアン uint32。 */
function widgetTokenExpiryMs(token: string): number {
  const b = decodeWidgetToken(token);
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(9, false) * 1000;
}

/**
 * JSON レスポンスとして成功しているか。
 * status だけでは足りない (§9): エラー時は 200 以外 + content-type: text/html になる。
 * ラッパーはこの 2 条件の AND を成功判定に使うこと。
 */
function isJsonSuccess(r: { status: number; contentType: string }): boolean {
  return r.status === 200 &&
    r.contentType.toLowerCase().includes("application/json");
}

/**
 * comparisonItem の個数から widget id の並びを予測する (§8-2)。
 * ラッパーが「欲しい widget を id で引く」ときの参照実装。
 *   1 個 : TIMESERIES, GEO_MAP, RELATED_TOPICS, RELATED_QUERIES
 *   n>=2 : TIMESERIES, GEO_MAP, then (TITLE_i, GEO_MAP_i, RELATED_QUERIES_i) * n
 *          → RELATED_TOPICS は消える。TITLE_i は token/request を持たない見出し。
 */
function expectedWidgetIds(keywordCount: number): string[] {
  if (keywordCount <= 1) {
    return ["TIMESERIES", "GEO_MAP", "RELATED_TOPICS", "RELATED_QUERIES"];
  }
  const ids = ["TIMESERIES", "GEO_MAP"];
  for (let i = 0; i < keywordCount; i++) {
    ids.push(`TITLE_${i}`, `GEO_MAP_${i}`, `RELATED_QUERIES_${i}`);
  }
  return ids;
}

/** id が「データを取得できる widget」(request + token を持つ) かどうか。 */
function isDataWidget(id: string): boolean {
  return !/^(TITLE_\d+|rt_note)$/.test(id);
}

// ---------------------------------------------------------------------------
// ライブ検証の共有セットアップ
//   ネットワークは合計 3 リクエストだけ使う:
//     (1) NID 取得   (2) GET /trends/api/explore   (3) POST /trends/api/explore (空ボディ)
//   429 / ネットワーク断のときは null を返し、各テストは console.warn で skip 扱いにする。
// ---------------------------------------------------------------------------

interface Widget {
  id: string;
  type: string;
  title: string;
  template: string;
  embedTemplate: string;
  version: string;
  isLong: boolean;
  isCurated: boolean;
  token?: string;
  request?: Record<string, unknown>;
  [k: string]: unknown;
}
interface ExploreResponse {
  widgets: Widget[];
  keywords: { keyword: string; name: string; type: string }[];
  timeRanges: string[];
  shareText: string;
  shouldShowMultiHeatMapMessage: boolean;
}
type Resp = { status: number; contentType: string; body: string };
interface Live {
  nid: string | null;
  get: Resp | null;
  post: Resp | null;
  multi: Resp | null;
  badGeo: Resp | null;
  requestedAtMs: number;
}

const REQ_SINGLE = {
  comparisonItem: [{ keyword: "Fanza", geo: "JP", time: "now 1-d" }],
  category: 0,
  property: "",
};
const REQ_MULTI = {
  comparisonItem: [
    { keyword: "Fanza", geo: "JP", time: "now 1-d" },
    { keyword: "DLsite", geo: "JP", time: "now 1-d" },
  ],
  category: 0,
  property: "",
};
const REQ_BAD_GEO = {
  comparisonItem: [{ keyword: "Fanza", geo: "ZZ", time: "now 1-d" }],
  category: 0,
  property: "",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 429 が再試行しても解けなかったら立つフラグ。
 * §10 のとおり Google の 429 は IP 単位でしばらく続くので、1 回諦めたら
 * 以降のライブ呼び出しは一切行わない (叩き続けても通らないうえ状況を悪化させる)。
 */
let rateLimited = false;

/**
 * 429 を受けたら指数バックオフ (2s → 4s) で最大 2 回だけ再試行する。
 * 無限リトライは絶対にしないこと (Google 側の締め付けが強くなる)。
 * サーキットブレーカが開いていたら 1 リクエストも発行せずに null を返す。
 */
async function fetchWithBackoff(url: string, init: RequestInit): Promise<Resp | null> {
  if (rateLimited) return null;
  let last: Resp = { status: 0, contentType: "", body: "" };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1)); // 2s, 4s
    const r = await fetch(url, init);
    const body = await r.text(); // 必ず消費する
    last = { status: r.status, contentType: r.headers.get("content-type") ?? "", body };
    if (last.status !== 429) return last;
  }
  rateLimited = true; // 以降は全部あきらめる
  return last;
}

let livePromise: Promise<Live> | null = null;
function live(): Promise<Live> {
  if (!livePromise) livePromise = runLive();
  return livePromise;
}

async function runLive(): Promise<Live> {
  const out: Live = {
    nid: null,
    get: null,
    post: null,
    multi: null,
    badGeo: null,
    requestedAtMs: 0,
  };

  // (1) NID を取得する。/trends/explore は 429 を返すが Set-Cookie: NID が付く。
  try {
    const r = await fetch(
      `${ORIGIN}/trends/explore?q=Fanza&date=now%201-d&geo=JP&hl=en-US`,
      {
        headers: { "user-agent": UA, accept: "text/html", "accept-language": "en-US" },
        redirect: "manual",
      },
    );
    const setCookie = r.headers.get("set-cookie") ?? "";
    await r.text(); // ボディを必ず消費する (Deno のリソースリーク検出対策)
    const m = setCookie.match(/(?:^|,\s*)(NID=[^;]+)/);
    out.nid = m ? m[1] : null;
  } catch (e) {
    console.warn(`[skip] NID 取得に失敗: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
  if (!out.nid) {
    console.warn("[skip] Set-Cookie: NID が得られなかった");
    return out;
  }

  const headers: Record<string, string> = {
    "user-agent": UA,
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US",
    referer: `${ORIGIN}/trends/explore`,
    cookie: out.nid,
  };
  const url = buildExploreUrl(REQ_SINGLE, "en-US", 0);

  // (2) GET
  await sleep(1500);
  out.requestedAtMs = Date.now();
  try {
    out.get = await fetchWithBackoff(url, { headers });
    out.requestedAtMs = Date.now();
  } catch (e) {
    console.warn(`[skip] GET explore 失敗: ${e instanceof Error ? e.message : String(e)}`);
  }

  // (3) POST (ボディ完全に空 = reCAPTCHA トークン無し)
  await sleep(1500);
  try {
    out.post = await fetchWithBackoff(url, { method: "POST", headers });
  } catch (e) {
    console.warn(`[skip] POST explore 失敗: ${e instanceof Error ? e.message : String(e)}`);
  }

  // (4) 2 キーワード (widget id が GEO_MAP_N / RELATED_QUERIES_N に増えることの確認)
  await sleep(1500);
  try {
    out.multi = await fetchWithBackoff(buildExploreUrl(REQ_MULTI, "en-US", 0), { headers });
  } catch (e) {
    console.warn(`[skip] GET explore(2kw) 失敗: ${e instanceof Error ? e.message : String(e)}`);
  }

  // (5) 不正 geo (エラーが JSON ではなく HTML で返ることの確認)
  await sleep(1500);
  try {
    out.badGeo = await fetchWithBackoff(buildExploreUrl(REQ_BAD_GEO, "en-US", 0), { headers });
  } catch (e) {
    console.warn(`[skip] GET explore(bad geo) 失敗: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

function exploreOrSkip(r: Resp | null, label: string): ExploreResponse | null {
  if (!r) {
    console.warn(
      `[skip] ${label}: レスポンス無し (レート制限で打ち切り / ネットワーク不可のいずれか)`,
    );
    return null;
  }
  if (!isJsonSuccess(r)) {
    console.warn(
      `[skip] ${label}: レート制限またはエラー (status=${r.status} content-type=${r.contentType})`,
    );
    return null;
  }
  return parseTrendsJson(r.body) as ExploreResponse;
}

// ===========================================================================
// オフラインテスト (ネットワーク不要)
// ===========================================================================

Deno.test({
  name: "offline: )]}' プレフィックスを剥がして JSON.parse できる (末尾改行の有無に依存しない)",
  fn() {
    const payload = '{"widgets":[],"keywords":[],"timeRanges":[]}';
    assertEquals(parseTrendsJson(`)]}'\n${payload}`), JSON.parse(payload));
    // widgetdata 系は末尾に改行が付く実績があるので、その形でも壊れないこと
    assertEquals(parseTrendsJson(`)]}'\n${payload}\n`), JSON.parse(payload));
  },
});

Deno.test({
  name: "offline: explore の URL 組み立て — HAR のブラウザ形式と URLSearchParams 形式",
  fn() {
    // HAR 00_entry092 と同じ req
    const req = {
      comparisonItem: [{ keyword: "Fanza", geo: "JP", time: "now 1-d" }],
      category: 0,
      property: "",
    };
    const browser = buildExploreUrl(req, "ja", -540, "browser");
    // ブラウザ形式では tz が 2 回付く (HAR 13/13 でこの形)
    assertEquals((browser.match(/[?&]tz=-540/g) ?? []).length, 2);
    assert(browser.startsWith(`${ORIGIN}/trends/api/explore?hl=ja&tz=-540&req=`));
    // encodeURIComponent なので空白は %20 になる (ブラウザは + だがサーバはどちらも受理する)
    assert(browser.includes("now%201-d"));

    const usp = buildExploreUrl(req, "ja", -540, "urlsearchparams");
    // URLSearchParams は空白を + に、: と , も % エンコードする。実測でサーバは受理する。
    assert(usp.includes("now+1-d"));
    assert(usp.includes("%3A"));

    // どちらの形式でも req を復元できること
    for (const u of [browser, usp]) {
      const got = JSON.parse(new URL(u).searchParams.get("req")!);
      assertEquals(got, req);
    }
  },
});

Deno.test({
  name: "offline: widget token のバイナリ構造 (33バイト / 固定ヘッダ / BE-uint32 の期限)",
  fn() {
    // 実トークンは埋め込まない。仕様どおりの合成トークンで decoder を検証する。
    const expiry = 1788968930; // 2026-09-09T15:48:50Z (実測値と同じ形の期限)
    const bytes = new Uint8Array(33);
    bytes.set([0x00, 0xd2, 0x3f, 0xdb, 0x03, 0x00, 0x00, 0x00, 0x00], 0);
    new DataView(bytes.buffer).setUint32(9, expiry, false);
    for (let i = 13; i < 33; i++) bytes[i] = (i * 37) & 0xff; // ダミー署名
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    assertEquals(token.length, 44, "widget token は常に 44 文字");
    assert(token.startsWith("ANI_2wMAAAAA"), "固定ヘッダ由来のプレフィックス");
    assert(/^[A-Za-z0-9_-]{44}$/.test(token), "base64url のみ / パディング無し");

    const decoded = decodeWidgetToken(token);
    assertEquals(decoded.length, 33);
    assertEquals(
      Array.from(decoded.slice(0, 9)),
      [0x00, 0xd2, 0x3f, 0xdb, 0x03, 0x00, 0x00, 0x00, 0x00],
    );
    assertEquals(widgetTokenExpiryMs(token), expiry * 1000);
  },
});

Deno.test({
  name: "offline: widget id の生成規則 (1kw は RELATED_TOPICS 有り / 2kw 以上は _N に展開)",
  fn() {
    assertEquals(expectedWidgetIds(1), [
      "TIMESERIES",
      "GEO_MAP",
      "RELATED_TOPICS",
      "RELATED_QUERIES",
    ]);
    assertEquals(expectedWidgetIds(2), [
      "TIMESERIES",
      "GEO_MAP",
      "TITLE_0",
      "GEO_MAP_0",
      "RELATED_QUERIES_0",
      "TITLE_1",
      "GEO_MAP_1",
      "RELATED_QUERIES_1",
    ]);
    // 複数キーワードでは RELATED_TOPICS が存在しない (ラッパーが id 決め打ちで
    // 引くと undefined になる典型的な落とし穴)
    assert(!expectedWidgetIds(3).includes("RELATED_TOPICS"));
    assertEquals(expectedWidgetIds(3).length, 2 + 3 * 3);

    // データを持つ widget = HAR 272 の直後に飛んでいる widgetdata の本数と一致する:
    //   multiline 1 + comparedgeo 3 + relatedsearches 2 = 6 (HAR entry 274〜279)
    assertEquals(expectedWidgetIds(2).filter(isDataWidget).length, 6);
    assertEquals(expectedWidgetIds(1).filter(isDataWidget).length, 4);
    assert(!isDataWidget("TITLE_0"));
    assert(!isDataWidget("rt_note"));
    assert(isDataWidget("GEO_MAP_10"));
  },
});

// ===========================================================================
// ライブテスト (429 / 障害時は console.warn で skip)
// ===========================================================================

Deno.test({
  name: "live: NID Cookie 付き GET /trends/api/explore が JSON を返す (reCAPTCHA 不要)",
  async fn() {
    const l = await live();
    const j = exploreOrSkip(l.get, "GET explore");
    if (!j) return;

    assertEquals(l.get!.status, 200);
    assert(l.get!.contentType.includes("application/json"));
    assert(l.get!.body.startsWith(")]}'"), "本文は )]}' プレフィックスで始まる");

    assertEquals(
      Object.keys(j).sort(),
      ["keywords", "shareText", "shouldShowMultiHeatMapMessage", "timeRanges", "widgets"],
    );
    assertEquals(j.keywords.length, 1);
    assertEquals(j.keywords[0].keyword, "Fanza");
    assertEquals(j.keywords[0].name, "Fanza");
    assertEquals(j.keywords[0].type, "Search term", "hl=en-US なので英語で返る");
    assertEquals(j.timeRanges, ["Past day"], "time='now 1-d' の局所化ラベル");
    assertEquals(j.shouldShowMultiHeatMapMessage, false);
    assert(j.shareText.includes("Fanza"));
  },
});

Deno.test({
  name: "live: 単一キーワード時の widget id 集合は TIMESERIES/GEO_MAP/RELATED_TOPICS/RELATED_QUERIES",
  async fn() {
    const l = await live();
    const j = exploreOrSkip(l.get, "GET explore");
    if (!j) return;

    assertEquals(
      j.widgets.map((w) => w.id),
      expectedWidgetIds(1),
      "順序も含めてこの 4 個 (キーワード 1 個のとき)",
    );

    const byId = new Map(j.widgets.map((w) => [w.id, w]));
    assertEquals(byId.get("TIMESERIES")!.type, "fe_line_chart");
    assertEquals(byId.get("GEO_MAP")!.type, "fe_geo_chart_explore");
    assertEquals(byId.get("RELATED_TOPICS")!.type, "fe_related_searches");
    assertEquals(byId.get("RELATED_QUERIES")!.type, "fe_related_searches");

    // 共通フィールドが全 widget に揃っていること
    for (const w of j.widgets) {
      assertEquals(w.template, "fe");
      assertEquals(w.embedTemplate, "fe_embed");
      assertEquals(w.version, "1");
      assertEquals(typeof w.isLong, "boolean");
      assertEquals(w.isCurated, false);
      assert(typeof w.title === "string" && w.title.length > 0);
    }

    // GEO_MAP の描画メタ (geo="JP" のとき)
    const geoMap = byId.get("GEO_MAP")!;
    assertEquals(geoMap.geo, "JP");
    assertEquals(geoMap.resolution, "provinces");
    assertEquals(geoMap.displayMode, "regions");
  },
});

Deno.test({
  name: "live: widget.request が正規化される (time / resolution / backend / geo / userType)",
  async fn() {
    const l = await live();
    const j = exploreOrSkip(l.get, "GET explore");
    if (!j) return;

    const byId = new Map(j.widgets.map((w) => [w.id, w]));

    // --- TIMESERIES: multiline 用 ---
    const ts = byId.get("TIMESERIES")!.request as Record<string, any>;
    assertEquals(ts.resolution, "EIGHT_MINUTE", "'now 1-d' は 8 分刻みになる");
    assertEquals(ts.locale, "en-US", "locale は hl がそのまま入る");
    assertEquals(ts.requestOptions, { property: "", backend: "CM", category: 0 });
    assertEquals(ts.userConfig, { userType: "USER_TYPE_SCRAPER" });
    assertEquals(ts.comparisonItem.length, 1);
    assertEquals(ts.comparisonItem[0].geo, { country: "JP" }, "geo='JP' は {country:'JP'}");
    assertEquals(ts.comparisonItem[0].complexKeywordsRestriction, {
      keyword: [{ type: "BROAD", value: "Fanza" }],
    }, "素のキーワードは type=BROAD になる");

    // time は "A B" のスペース区切りで、コロンがバックスラッシュエスケープされている
    const [from, to] = (ts.time as string).split(" ");
    const RE_ESCAPED = /^\d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2}$/;
    assert(RE_ESCAPED.test(from), `time の始端が \\: エスケープ形式でない: ${from}`);
    assert(RE_ESCAPED.test(to), `time の終端が \\: エスケープ形式でない: ${to}`);
    const unesc = (s: string) => new Date(s.replace(/\\:/g, ":") + "Z").getTime();
    assertEquals(unesc(to) - unesc(from), 24 * 3600 * 1000, "'now 1-d' の窓はちょうど 24 時間");
    // 窓の末端 = リクエスト時刻 (UTC)。tz=0 を渡しているが tz は窓に影響しない。
    assert(
      Math.abs(unesc(to) - l.requestedAtMs) < 10 * 60 * 1000,
      "窓の末端はリクエスト時刻 (UTC) とほぼ一致する",
    );

    // --- GEO_MAP: comparedgeo 用。time が comparisonItem 側、geo がトップレベル ---
    const gm = byId.get("GEO_MAP")!.request as Record<string, any>;
    assertEquals(gm.geo, { country: "JP" });
    assertEquals(gm.resolution, "REGION", "国レベルの geo なら REGION (地域レベルなら CITY)");
    assertEquals(gm.comparisonItem[0].time, ts.time, "time は TIMESERIES と同一文字列");
    assertEquals(gm.userConfig, { userType: "USER_TYPE_SCRAPER" });
    assertEquals(gm.dataMode, undefined, "単一キーワードでは dataMode は付かない");

    // --- RELATED_*: relatedsearches 用 ---
    for (const [id, kwType] of [["RELATED_TOPICS", "ENTITY"], ["RELATED_QUERIES", "QUERY"]]) {
      const rs = byId.get(id)!.request as Record<string, any>;
      assertEquals(rs.keywordType, kwType);
      assertEquals(rs.metric, ["TOP", "RISING"], "metric は常に TOP/RISING の 2 要素");
      assertEquals(rs.restriction.geo, { country: "JP" });
      assertEquals(rs.restriction.time, ts.time);
      assertEquals(
        rs.restriction.originalTimeRangeForExploreUrl,
        "now 1-d",
        "このエンドポイントだけ元の time 文字列を保持する",
      );
      assertEquals(rs.language, "en", "hl='en-US' → language は言語部分だけ");
      assertEquals(rs.userCountryCode, "JP");
      assertEquals(rs.userConfig, { userType: "USER_TYPE_SCRAPER" });
      // compareTime は直前の同じ長さの窓
      const [cf, ct] = (rs.trendinessSettings.compareTime as string).split(" ");
      assertEquals(unesc(ct), unesc(from), "compareTime の終端 = time の始端");
      assertEquals(unesc(ct) - unesc(cf), 24 * 3600 * 1000);
    }
  },
});

Deno.test({
  name: "live: token は 44 文字 base64url / widget ごとに一意 / 有効期限は発行から 24 時間",
  async fn() {
    const l = await live();
    const j = exploreOrSkip(l.get, "GET explore");
    if (!j) return;

    const tokens = j.widgets.map((w) => w.token).filter((t): t is string => !!t);
    assertEquals(tokens.length, 4, "単一キーワードでは 4 widget すべてが token を持つ");
    assertEquals(new Set(tokens).size, 4, "同一レスポンス内でも token は widget ごとに異なる");

    for (const t of tokens) {
      assertEquals(t.length, 44);
      assert(/^[A-Za-z0-9_-]{44}$/.test(t), `base64url でない: ${t.slice(0, 12)}…`);
      assert(t.startsWith("ANI_2wMAAAAA"), "固定 9 バイトヘッダ由来のプレフィックス");

      const b = decodeWidgetToken(t);
      assertEquals(b.length, 33);
      assertEquals(
        Array.from(b.slice(0, 9)),
        [0x00, 0xd2, 0x3f, 0xdb, 0x03, 0x00, 0x00, 0x00, 0x00],
      );

      // 期限 = リクエスト時刻 + 24h (±10 分の余裕を見る)
      const ttlMs = widgetTokenExpiryMs(t) - l.requestedAtMs;
      assert(
        Math.abs(ttlMs - 24 * 3600 * 1000) < 10 * 60 * 1000,
        `token の有効期限が発行 +24h でない: ttl=${Math.round(ttlMs / 1000)}s`,
      );
    }

    // URL に載せても壊れないこと (base64url なので実質そのまま)
    assertEquals(encodeURIComponent(tokens[0]), tokens[0]);
  },
});

Deno.test({
  name: "live: POST に空ボディでも GET と同じ結果 → reCAPTCHA setoken ボディは不要",
  async fn() {
    const l = await live();
    const jGet = exploreOrSkip(l.get, "GET explore");
    const jPost = exploreOrSkip(l.post, "POST explore (空ボディ)");
    if (!jGet || !jPost) return;

    assertEquals(l.post!.status, 200);
    assert(l.post!.contentType.includes("application/json"));

    // widget の顔ぶれ・型・キーワード解決結果は GET と完全一致する
    assertEquals(jPost.widgets.map((w) => w.id), jGet.widgets.map((w) => w.id));
    assertEquals(jPost.widgets.map((w) => w.type), jGet.widgets.map((w) => w.type));
    assertEquals(jPost.keywords, jGet.keywords);
    assertEquals(jPost.timeRanges, jGet.timeRanges);
    assertEquals(jPost.shareText, jGet.shareText);

    // token と time は発行時刻に依存するので値は異なるが、形は同じ
    assertEquals(jPost.widgets.filter((w) => w.token).length, 4);
    for (const w of jPost.widgets) {
      if (w.token) assert(/^ANI_2wMAAAAA[A-Za-z0-9_-]{32}$/.test(w.token));
    }
    const tsPost = jPost.widgets[0].request as Record<string, any>;
    const tsGet = jGet.widgets[0].request as Record<string, any>;
    assertEquals(tsPost.resolution, tsGet.resolution);
    assertEquals(tsPost.requestOptions, tsGet.requestOptions);
    assertEquals(tsPost.userConfig, tsGet.userConfig);
  },
});

Deno.test({
  name: "live: レスポンスは widgetdata へ渡せる形になっている (request 透過 + token 添付)",
  async fn() {
    const l = await live();
    const j = exploreOrSkip(l.get, "GET explore");
    if (!j) return;

    // ラッパーが実際に組み立てる URL の形を検証する (このテストでは送信しない)。
    const ts = j.widgets.find((w) => w.id === "TIMESERIES")!;
    const url = `${ORIGIN}/trends/api/widgetdata/multiline?hl=en-US&tz=0` +
      `&req=${encodeURIComponent(JSON.stringify(ts.request))}` +
      `&token=${encodeURIComponent(ts.token!)}`;
    const parsed = new URL(url);
    assertEquals(parsed.searchParams.get("token"), ts.token);
    assertEquals(JSON.parse(parsed.searchParams.get("req")!), ts.request);
    // time の \: エスケープが往復しても保存されること (自前で : に直してはいけない)
    assert(
      (JSON.parse(parsed.searchParams.get("req")!).time as string).includes("\\:"),
      "time のコロンエスケープは透過させること",
    );

    // token を持たないウィジェットが将来混ざっても落ちないよう、存在チェックは必須
    for (const w of j.widgets) {
      assertEquals(
        typeof w.token === "string",
        typeof w.request === "object",
        `${w.id}: request と token は必ずセットで存在する (TITLE_N / rt_note は両方無い)`,
      );
    }
  },
});

Deno.test({
  name: "live: 2 キーワードでは widget が 8 個に増え、RELATED_TOPICS が消えて _N 系になる",
  async fn() {
    const l = await live();
    const j = exploreOrSkip(l.multi, "GET explore (2 キーワード)");
    if (!j) return;

    // §8-2 の主張そのもの。順序も含めて一致すること。
    assertEquals(j.widgets.map((w) => w.id), expectedWidgetIds(2));
    assert(
      !j.widgets.some((w) => w.id === "RELATED_TOPICS"),
      "複数キーワードでは RELATED_TOPICS は返らない",
    );

    const byId = new Map(j.widgets.map((w) => [w.id, w]));

    // 統合 GEO_MAP はヒートマップ型に変わり、request に dataMode が付く
    const gm = byId.get("GEO_MAP")!;
    assertEquals(gm.type, "fe_multi_heat_map", "2 キーワードの統合地図は multi_heat_map");
    const gmReq = gm.request as Record<string, any>;
    assertEquals(gmReq.dataMode, "PERCENTAGES", "統合地図だけ dataMode が付く");
    assertEquals(gmReq.comparisonItem.length, 2);
    assertEquals(
      gmReq.comparisonItem.map((c: any) => c.complexKeywordsRestriction.keyword[0].value),
      ["Fanza", "DLsite"],
      "req の comparisonItem の順序が保存される",
    );

    // キーワード別の GEO_MAP_N は単一キーワード版と同じ形 (dataMode 無し)
    for (const [i, kw] of [[0, "Fanza"], [1, "DLsite"]] as [number, string][]) {
      const g = byId.get(`GEO_MAP_${i}`)!;
      assertEquals(g.type, "fe_geo_chart_explore");
      const r = g.request as Record<string, any>;
      assertEquals(r.dataMode, undefined, "キーワード別の地図に dataMode は付かない");
      assertEquals(r.comparisonItem.length, 1);
      assertEquals(r.comparisonItem[0].complexKeywordsRestriction.keyword[0].value, kw);

      const rq = byId.get(`RELATED_QUERIES_${i}`)!;
      assertEquals(rq.type, "fe_related_searches");
      assertEquals((rq.request as Record<string, any>).keywordType, "QUERY");
      assertEquals(
        (rq.request as Record<string, any>).restriction.complexKeywordsRestriction
          .keyword[0].value,
        kw,
      );

      // TITLE_N は見出しだけ。request も token も持たない。
      const t = byId.get(`TITLE_${i}`)!;
      assertEquals(t.type, "fe_text");
      assertEquals(t.template, "fe_explore", "TITLE_N だけ template が fe_explore");
      assertEquals(t.token, undefined);
      assertEquals(t.request, undefined);
      assertEquals((t.text as Record<string, unknown>).text, kw);
    }

    // token を持つのはデータ widget 6 個だけ (TITLE_0/TITLE_1 を除く)
    const withToken = j.widgets.filter((w) => typeof w.token === "string");
    assertEquals(withToken.length, 6);
    assertEquals(withToken.map((w) => w.id), expectedWidgetIds(2).filter(isDataWidget));
    assertEquals(new Set(withToken.map((w) => w.token)).size, 6, "token は widget ごとに一意");

    // トップレベルもキーワード数に追従する
    assertEquals(j.keywords.map((k) => k.keyword), ["Fanza", "DLsite"]);
    assertEquals(j.timeRanges.length, 2, "timeRanges は comparisonItem と同数");
  },
});

Deno.test({
  name: "live: 不正な geo は JSON ではなくエラー HTML を返す (status だけで判定してはいけない)",
  async fn() {
    const l = await live();
    if (!l.badGeo) {
      console.warn(
        "[skip] GET explore (geo=ZZ): レスポンス無し (レート制限で打ち切り / ネットワーク不可)",
      );
      return;
    }
    const r = l.badGeo;

    // 成功判定は必ず status + content-type の AND で行う (§9)
    assert(!isJsonSuccess(r), `不正 geo なのに JSON 成功扱いになった (status=${r.status})`);
    assert(
      !r.body.startsWith(")]}'"),
      "エラー時は )]}' プレフィックス付き JSON ではない",
    );

    if (r.status === 429) {
      console.warn("[skip] geo=ZZ の判定: レート制限で 429 が返ったため 400 を確認できず");
      return;
    }
    assertEquals(r.status, 400, "存在しない ISO-3166 コードは 400");
    assert(
      r.contentType.toLowerCase().includes("text/html"),
      `400 の content-type が text/html でない: ${r.contentType}`,
    );
    // ★2026-09-09 実測で訂正: Google の 400 ページに DOCTYPE 宣言は無い。
    //   実体は `<html lang="en" dir=ltr><meta charset=utf-8>...<title>Error 400 (Bad Request)!!1</title>`
    //   で始まる約 1.7KB の HTML。以前は `<!DOCTYPE html` で始まると仮定していたため、
    //   このテストがライブで実行されたときに落ちた (自宅 IP ではレート制限で skip されていて露見しなかった)。
    //   判定は「DOCTYPE の有無」ではなく **`<title>Error NNN` の有無**で行うこと。
    assert(
      /^<html\b/i.test(r.body.trimStart()),
      `エラーボディは <html> で始まる (DOCTYPE 無し): ${JSON.stringify(r.body.slice(0, 60))}`,
    );
    assert(
      /<title>Error 400 \(Bad Request\)/.test(r.body),
      "エラーボディは Google 共通の Error 400 ページ",
    );
  },
});
