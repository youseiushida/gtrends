// 実行: deno test --allow-net --no-check live_integration/04_widgetdata_comparedgeo_test.ts
//
// ============================================================================
// Google Trends 旧 REST API: GET /trends/api/widgetdata/comparedgeo
//   = Explore 画面の「地域別のインタレスト (Interest by region / 小区域別のインタレスト)」
// ============================================================================
//
// 【検証日】2026-09-09 (Deno 2.9.6 / Windows 11 / 日本の家庭用回線)
//
// 【本ファイルの証拠レベル表記】必ず読むこと。
//   [HAR]  … C:\Users\ushid\Documents\gtrend_claude\.har\extracted\
//              trends_api_widgetdata_comparedgeo\00_entry101.txt 〜 14_entry278.txt (全 15 件) と
//              trends_api_explore\09_entry229.txt / 10_entry244.txt / 12_entry272.txt から
//              **オフラインで機械的に確認済み**。本ファイルのオフラインテストが実際に検証する。
//   [LIVE] … 2026-09-09 にライブ HTTP で実測。本ファイルのライブテストが再検証する。
//   [要再検証] … 過去の調査で得られたが、本ファイルの最終検証パス (2026-09-09) では
//              /trends/api/explore が IP 単位で 429 に張り付いており **再現できなかった**。
//              ラッパー実装時に必ず自分で確かめること。断定として扱ってはならない。
//
//   ※ HAR は Chrome DevTools のボディ退避仕様 (content-disposition: attachment) により
//     /trends/api/* のレスポンス本文が 1 バイトも残っていない (全 15 件 bodylen=0)。
//     したがって **リクエスト仕様は [HAR] で確定、レスポンス仕様は [LIVE] / [要再検証] に依存する**。
//
// ----------------------------------------------------------------------------
// 1. エンドポイント概要
// ----------------------------------------------------------------------------
//   GET https://trends.google.com/trends/api/widgetdata/comparedgeo
//       ?hl=<言語>&tz=<分>&req=<JSON>&token=<44文字>
//
//   - [HAR] メソッドは GET のみ。15/15 件が GET で、POST ボディも reCAPTCHA トークンも無い。
//     (reCAPTCHA Enterprise トークンが載るのは /trends/api/explore の POST 版だけ。)
//   - 単独では呼べない。**必ず 2 段構え**になる:
//       (1) GET /trends/api/explore?req={comparisonItem,category,property} → widgets[] を得る
//       (2) widgets[] から id が "GEO_MAP" / "GEO_MAP_0" / "GEO_MAP_1" … のものを選び、
//           その `request` を req に、`token` を token にそのまま載せて comparedgeo を叩く
//     [HAR] この 2 段構えは HAR 上でも隣接エントリとして観測できる:
//       explore#09(har_idx=229, geo="JP")    → comparedgeo#09(har_idx=232, geo={"country":"JP"})
//       explore#10(har_idx=244, geo="JP-13") → comparedgeo#10(har_idx=247, geo={"region":"JP-13"})
//   - server: GSE 系 (レガシー AngularJS UI 用の REST API)。boq (/_/TrendsUi/*) とは別系統。
//
//   【ラッパー実装者への要約】
//     explore の応答は「そのまま次に投げるための完成済みリクエスト」を配ってくる設計。
//     req を自前で組み立てるのは token 署名 (7 章) の都合で危険。
//     **explore が返した request を deep-copy し、署名対象外のフィールドだけ差し替える**のが正解。
//
// ----------------------------------------------------------------------------
// 2. 認証 / Cookie 要件
// ----------------------------------------------------------------------------
//   - [LIVE] Cookie 無しで /trends/api/explore を叩くと 429。NID Cookie が実質の入場券。
//   - [LIVE] NID の入手経路: GET https://trends.google.com/trends/explore?... は
//     Cookie 無しだと **429 を返すが、同時に Set-Cookie: NID=... を返す** (2026-09-09 に
//     4 回とも再現。429 ボディ 1697 バイト、Set-Cookie は NID のみ)。
//     この NID を以後の /trends/api/* に付ける。
//   - [LIVE] OTZ は 2026-09-09 の実測では **そもそも発行されなかった**。NID だけで足りる。
//     _ga* / __utm* は Google Analytics 由来でサーバは見ていない。
//   - ログイン (Bearer / OAuth / authorization ヘッダ) は一切不要。
//   - [要再検証] comparedgeo 単体が NID 無しで通るかは未確認。explore に NID が要る以上、
//     実運用では常に NID を持ち回ることになるので実害は無い。
//
// ----------------------------------------------------------------------------
// 3. リクエストヘッダ要件
// ----------------------------------------------------------------------------
//   [LIVE] 必須ではないが送るのが無難:
//     accept: application/json, text/plain, */*
//     accept-language: ja                 (hl と揃える)
//     user-agent: <普通の Chrome UA>
//     referer: https://trends.google.com/trends/explore
//     cookie: NID=<値>
//   送らないほうがよい (Chrome 内部専用ヘッダ。偽装値を送っても実益が無く、不整合で目立つ):
//     x-browser-validation / x-browser-year / x-browser-channel / x-browser-copyright
//     sec-ch-ua-* (Accept-CH 由来のフィンガープリント材料)
//   [HAR] x-same-domain / origin は widgetdata 系 GET には元々付いていない (15/15 件で不在)。
//
// ----------------------------------------------------------------------------
// 4. クエリパラメータ
// ----------------------------------------------------------------------------
//   hl    : [HAR] 15/15 件で "ja"。UI 言語。実質的に必須。
//   tz    : [HAR] 15/15 件で "-540"。JS の Date#getTimezoneOffset() 規約の「分」(JST は -540)。
//           **comparedgeo では tz は URL 中にちょうど 1 回しか現れない** (15/15 件で確認済み)。
//           (tz が 2 回出るのは /trends/api/explore と /trends/api/widgetdata/multiline のみ。
//            本エンドポイントに写経しないこと。)
//   req   : 必須。下記 5 章の JSON。
//   token : [HAR] 15/15 件で長さ 44、先頭 12 文字が "ANI_2wMAAAAA" で固定。
//           [要再検証] 省略時のステータスコードは未確定 (過去実測では 401。本ファイルの
//           ライブテストが実測して console.log に出すので、実行結果を見ること)。
//
//   【req のパーセントエンコード】
//     [HAR] ブラウザ (AngularJS の $httpParamSerializer) は { } [ ] " のみをエンコードし、
//     ':' と ',' は生のまま、空白は '+' にする。よって HAR の生 URL には
//     `%7B%22geo%22:%7B%22country%22:%22JP%22%7D,` のように ':' と ',' が裸で現れる。
//     [LIVE] Deno の encodeURIComponent (':'→%3A, ','→%2C, 空白→%20) でも
//     **サーバは問題なく 200 を返す**。素直に encodeURIComponent(JSON.stringify(req)) で良い。
//
// ----------------------------------------------------------------------------
// 5. req スキーマ ([HAR] 15 件の和集合 + [LIVE] で足した任意フィールド)
// ----------------------------------------------------------------------------
//   {
//     "geo": {} | {"country":"JP"} | {"region":"JP-13"},   // ★トップレベル (multiline とは違う)
//     "comparisonItem": [                                   // 1〜5 要素
//       { "time": "2008-01-01 2026-09-08",                  // ★time は要素側 (multiline とは違う)
//         "complexKeywordsRestriction": {
//           "keyword": [ { "type": "BROAD", "value": "Fanza" } ] } }
//     ],
//     "resolution": "COUNTRY" | "REGION" | "CITY" | "DMA",
//     "locale": "ja",                                       // = explore の hl。15/15 件で "ja"
//     "requestOptions": { "property": "", "backend": "IZG", "category": 0 },
//     "dataMode": "PERCENTAGES",                            // ★複数キーワード統合 GEO_MAP のみ
//     "includeLowSearchVolumeGeos": true,                   // ★任意。UI は送らない。10 章参照
//     "userConfig": { "userType": "USER_TYPE_SCRAPER" }     // 15/15 件でこの固定値
//   }
//
//   [HAR] requestOptions.property の実測値域:
//     "" (ウェブ検索) / "images" / "news" / "froogle" (ショッピング) / "youtube"  ← 5 種すべて観測
//   [HAR] requestOptions.category の実測値: 0 (すべてのカテゴリ) / 8 / 41
//     ※ explore に渡した category がそのまま流れてくる。値域はカテゴリピッカー側の資料を参照。
//   [HAR] requestOptions.backend は **time の形と完全に相関する** (15/15 件で例外なし):
//     time が "YYYY-MM-DDTHH\:MM\:SS ..." (日内窓 = now 1-d / now 4-H) → backend "CM"
//     time が "YYYY-MM-DD YYYY-MM-DD"    (日単位窓 = today 12-m / all) → backend "IZG"
//     → backend は自分で決めるものではなく explore の出力を透過させるもの。
//
//   [HAR] comparisonItem[].time は **explore に渡した省略記法が展開済みの形で返ってくる**:
//     explore の "all_2008" → comparedgeo の "2008-01-01 2026-09-08"
//     explore の "now 1-d"  → "2026-09-07T14\:53\:39 2026-09-08T14\:53\:39"
//     explore の "now 4-H"  → "2026-09-08T10\:54\:16 2026-09-08T14\:54\:16"
//     日内窓ではコロンがバックスラッシュでエスケープされる (JSON 上は "\\:"、URL 上は %5C%5C: )。
//     この妙なエスケープは Google 側の仕様。
//     **explore が返した文字列をそのまま透過させること。自前で組むな。**
//
// ----------------------------------------------------------------------------
// 6. geo と resolution の対応
// ----------------------------------------------------------------------------
//   explore に渡す geo    → GEO_MAP.request.geo     → resolution  → widget.resolution / displayMode
//   ---------------------------------------------------------------------------------------------
//   ""      (世界全体)     {}                          COUNTRY       "countries" / "regions"   [要再検証]
//   "JP"    (国)           {"country":"JP"}            REGION        "provinces" / "regions"   [HAR]
//   "JP-13" (非 US の州県) {"region":"JP-13"}          CITY          "provinces" / "markers"   [HAR]
//   "US-CA" (US の州)      {"region":"US-CA"}          DMA           "metros"    / "regions"   [要再検証]
//
//   [HAR] 上表の JP 行と JP-13 行は explore→comparedgeo の隣接エントリ対で確定している
//         (har_idx 229→232 と 244→247)。ただし HAR にレスポンス本文が無いため
//         widget.resolution / displayMode の値そのものは [要再検証] 扱い。
//   ★ resolution は explore が geo から自動決定する。呼び出し側が explore に
//     resolution を直接指示する手段は無い。
//   [要再検証] comparedgeo 側で resolution を書き換えることは可能 (7 章の token 署名範囲)。
//     過去実測では geo={"country":"JP"} のまま REGION → CITY にすると日本全国の
//     市区町村が座標付きで返った。同 geo で COUNTRY にすると 400 になった。
//     いずれも 2026-09-09 の最終検証パスでは 429 のため再現できていない。
//
// ----------------------------------------------------------------------------
// 7. token の署名範囲
// ----------------------------------------------------------------------------
//   [HAR] token は 44 文字の base64url (パディング無し)、デコードすると 33 バイト。
//     bytes[0:9]   固定ヘッダ 00 d2 3f db 03 00 00 00 00  (= 先頭 12 文字 "ANI_2wMAAAAA")
//     bytes[9:13]  ビッグエンディアン uint32 = 有効期限 UNIX 秒 (= 発行時刻 + 86400 = 24h)
//     bytes[13:33] 20 バイトの署名 (ウィジェットごとに一意)
//     ※ 「+86400 が有効期限」は HAR の startedDateTime とバイト列の突き合わせで
//        オフライン検証できる。本ファイルのオフラインテストが実際に検証している。
//
//   [要再検証] 同じ token のまま req を書き換えたときの過去実測:
//     req.resolution を REGION → CITY                  … 200 (署名対象外)
//     req.includeLowSearchVolumeGeos を追加             … 200 (署名対象外)
//     req.locale を "ja" → "en"                         … 401
//     req.requestOptions.category を 0 → 5              … 401
//     req.geo を {"country":"JP"} → {"region":"JP-13"}  … 401
//     req.resolution を REGION → COUNTRY (geo は country のまま) … 400 (署名ではなく組合せ不正)
//
//   → 過去実測が正しければ「token は geo / locale / requestOptions / comparisonItem を署名するが、
//     resolution と includeLowSearchVolumeGeos は署名しない」。
//     これが正しければ explore 1 回分の GEO_MAP token を使い回して
//     「都道府県別」と「市区町村別」を追加 explore 無しで取り分けられ、
//     さらに token は 24h 有効なのでキャッシュして翌日まで再利用できる。
//     **ただし本検証パスでは再現できていないので、ラッパーは 401/400 を必ずハンドルすること。**
//     (本ファイルのライブテストは、この主張が崩れた場合に console.warn で警告を出す。)
//
// ----------------------------------------------------------------------------
// 8. レスポンス形式
// ----------------------------------------------------------------------------
//   [HAR] 200 のときのレスポンスヘッダ (15/15 件で同一):
//     content-type: application/json; charset=UTF-8   ← charset が **大文字**
//     content-disposition: attachment; filename="json.txt"   ← filename* は付かない
//     cache-control: private, max-age=0
//     content-encoding: gzip  (fetch が自動展開)
//     x-content-type-options: nosniff / x-frame-options: SAMEORIGIN
//
//   [LIVE] ボディは **`)]}'\n` (5 バイト) のプレフィックス**の後に JSON 本体、末尾に改行 1 個。
//
//     {"default":{"geoMapData":[ item, item, ... ]}}
//
//   item の形は resolution で 2 種類に分かれる:
//
//   (A) COUNTRY / REGION / DMA — キーは 6 つ
//       {
//         "geoCode":        "JP-05",     // 9 章の地域コード体系を参照
//         "geoName":        "秋田県",     // req.locale の言語でローカライズ済み
//         "value":          [100],       // 0〜100 の整数。要素数 = comparisonItem の数
//         "formattedValue": ["100"],     // 表示用文字列。PERCENTAGES モードでは "86%" のようになる
//         "maxValueIndex":  0,           // value 配列中の最大値のインデックス
//         "hasData":        [true]       // 要素数 = comparisonItem の数
//       }
//
//   (B) CITY — **geoCode が無く、代わりに coordinates が付く** (最大の落とし穴)
//       {
//         "coordinates":    { "lat": 27.0943662, "lng": 142.1919184 },
//         "geoName":        "小笠原村",
//         "value":          [0],
//         "formattedValue": [""],        // データ無しのとき **空文字列**
//         "maxValueIndex":  0,
//         "hasData":        [false]
//       }
//       → CITY では地域を一意に識別するコードが返らない。geoName と座標で扱うしかない。
//
//   共通の落とし穴:
//     - hasData[i] === false のとき value[i] は 0、formattedValue[i] は ""。
//       「値 0」と「データ無し」を value だけでは区別できない。**必ず hasData を見ること。**
//     - geoMapData は value の降順にソートされている。全件 hasData=false の場合の順序は不定。
//     - 空配列でも 200 が返る。エラーではない。
//     - [要再検証] 件数の過去実測: JP/REGION=47、JP/CITY=200、JP-13/CITY=58、
//       US-CA/DMA=14、world/COUNTRY=250。
//
//   エラー時:
//     - 401 Unauthorized      … token 不正 / 省略 / req の署名対象フィールドを書き換えた [要再検証]
//     - 400 Bad Request       … geo と resolution の組み合わせが不正 [要再検証]
//     - 429 Too Many Requests … レート制限 [LIVE 2026-09-09 に多数観測]
//     [LIVE] いずれも **content-type: text/html; charset=utf-8** で 1.7KB 前後の
//     Google 標準エラーページ。content-disposition は付かない。**JSON ではないので JSON.parse するな。**
//     → 成功判定は `res.status === 200 && /^application\/json/i.test(content-type)` が確実。
//
// ----------------------------------------------------------------------------
// 9. 地域コード体系 (geoCode)
// ----------------------------------------------------------------------------
//   COUNTRY : ISO 3166-1 alpha-2。"JP" "US" "MO" "CF" など。
//   REGION  : ISO 3166-2 サブディビジョンコード。"JP-05" (秋田県) … "JP-47" (沖縄県)。
//             米国は "US-CA" のような形。GB は "GB-ENG" など国により桁数・形式が異なるので
//             `^[A-Z]{2}-` 以外の仮定を置かないこと。
//   DMA     : **ISO ではなく Nielsen DMA (指定市場地域) の数値コードを文字列にしたもの**。
//             過去実測: "862" (サクラメント‐ストックトン‐モデスト)、"771" (ユマ‐エルチェントロ)。
//             US の州 (geo={"region":"US-XX"}) を指定したときだけ現れる。[要再検証]
//   CITY    : geoCode 自体が存在しない (8 章 (B) 参照)。
//
// ----------------------------------------------------------------------------
// 10. includeLowSearchVolumeGeos
// ----------------------------------------------------------------------------
//   [HAR] ブラウザセッションでは 15/15 件とも一度も送っていない任意フラグ。boolean。
//   [要再検証] token の署名対象外なので既存 token に後付けできる。過去実測
//     (geo={} / resolution=COUNTRY / "Fanza" / today 12-m):
//       フラグ無し … geoMapData 250 件中 hasData=true が   9 件
//       true 指定  … geoMapData 250 件中 hasData=true が 100 件
//     → **返る配列の長さは変わらない (常に全地域が入る)。変わるのは hasData / value の埋まり方。**
//       検索ボリュームが閾値未満の地域にも値を出すかどうかのフラグ。並び順も変わる。
//     REGION (JP 47 都道府県) では全件もともとデータがあるため、付けても結果は同一だった。
//
// ----------------------------------------------------------------------------
// 11. 複数キーワード比較時のウィジェット構成
// ----------------------------------------------------------------------------
//   [HAR] キーワード 2 件のときの呼び出しパターンは HAR 上で明確に観測できる。
//     explore  har_idx=272 : comparisonItem = [Fanza, DLsite] (2 件)
//     その直後の comparedgeo 3 連射:
//       har_idx=275 : comparisonItem 2 件 + **"dataMode":"PERCENTAGES"**  ← GEO_MAP (統合)
//       har_idx=276 : comparisonItem 1 件 (Fanza)  / dataMode 無し        ← GEO_MAP_0
//       har_idx=278 : comparisonItem 1 件 (DLsite) / dataMode 無し        ← GEO_MAP_1
//     3 本とも geo / resolution / requestOptions / time は完全に同一で、token だけが異なる。
//     → **1 回の explore で 3 つの GEO_MAP 系 token が配られ、3 回叩く**のが UI の挙動。
//
//   [要再検証] explore の widgets[] は 2 キーワードで 8 個になる:
//     TIMESERIES, GEO_MAP, TITLE_0, GEO_MAP_0, RELATED_QUERIES_0,
//     TITLE_1, GEO_MAP_1, RELATED_QUERIES_1
//     (単一キーワードでは TIMESERIES, GEO_MAP, RELATED_TOPICS, RELATED_QUERIES の 4 個。
//      複数キーワードでは RELATED_TOPICS が消え、代わりに TITLE_n が入る。)
//
//   [要再検証] 各ウィジェットの性格:
//     GEO_MAP   : type="fe_multi_heat_map"。dataMode:"PERCENTAGES" 付き。
//                 → value が [86,14] のような「その地域内での構成比 (%)」、
//                   formattedValue が ["86%","14%"]。bullet / index / color は付かない。
//     GEO_MAP_0 : type="fe_geo_chart_explore"。キーワード 0 のみ、dataMode 無し。
//                 → value は [100] のような単独正規化値。bullet="Fanza", index=0,
//                   color="PALETTE_COLOR_1"。
//     GEO_MAP_1 : 同上でキーワード 1 のみ。bullet="DLsite", index=1, color="PALETTE_COLOR_2"。
//   → 「地域ごとのシェア」が欲しいなら GEO_MAP、「キーワード単体の地域分布」なら GEO_MAP_n。
//
// ----------------------------------------------------------------------------
// 12. レート制限の挙動 ([LIVE] 2026-09-09。本調査で最も再現性が高かった部分)
// ----------------------------------------------------------------------------
//   - 429 は JSON ではなく text/html。**Retry-After ヘッダは無い。**
//   - ★重要な実測: **429 はエンドポイント単位で掛かる。**
//     2026-09-09、同一 IP / 同一プロセスから数秒差で叩いた結果:
//         GET /trends/api/autocomplete/fanza  → 200 application/json (388 バイト)
//         GET /trends/explore?...             → 429 text/html
//         GET /trends/api/explore?...         → 429 text/html
//     つまり explore 系だけが枯れていて autocomplete は通る。
//     「429 が出た = IP ごと BAN」ではないので、他エンドポイントは諦めなくてよい。
//   - 枯れると長い: 75 秒 / 240 秒 / 330 秒 / 420 秒のクールダウンを挟んで再試行しても
//     explore 系は 429 のままだった (同一 IP から複数プロセスが並列に叩いていた環境)。
//     **数分のスリープでは復帰しないことがある。バックオフで粘るより諦めて後で回すほうが速い。**
//   - 429 はセッション単位のブロックではなくリクエスト単位の確率的スロットリング。
//     HAR の正規ブラウザセッションでも並列 4 本のうち 1 本だけ 429 になっている例がある。
//   - 対策: リクエスト間に 1〜2 秒の間隔、429 なら指数バックオフ (最大 2〜3 回)、
//     そして何より **explore の token を 24 時間キャッシュして explore 呼び出し自体を減らす**。
//     comparedgeo は token さえあれば explore を経由しないので、キャッシュの効果が大きい。
//
// ============================================================================

import { assert, assertEquals } from "jsr:@std/assert@^1";

const ORIGIN = "https://trends.google.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
/**
 * XSSI プレフィックスの共通部分。**この 4 文字より後ろはエンドポイントで異なる。**
 *
 * ★2026-09-09 実測で確定 (README §8.1-3 の未解決事項はこれで解決):
 *   GET /trends/api/explore                      → `)]}'`  + LF = **5 バイト**
 *   GET /trends/api/widgetdata/multiline         → `)]}',` + LF = **6 バイト** (カンマ有り)
 *   GET /trends/api/widgetdata/comparedgeo       → `)]}',` + LF = **6 バイト** (カンマ有り)
 *   GET /trends/api/autocomplete/<kw>            → `)]}',` + LF = **6 バイト** (カンマ有り)
 * 「5 バイト説 / 6 バイト説」の対立ではなく、**explore だけがカンマ無し**というのが真相。
 * したがって `slice(5)` も `slice(6)` も決め打ちは壊れる。
 */
const JSON_PREFIX_HEAD = ")]}'";

/**
 * レスポンス本文から XSSI プレフィックスを剥がす。
 * バイト数を決め打ちせず **「先頭が `)]}'` なら最初の LF までを捨てる」** 規則で統一する。
 * これが全エンドポイントで唯一正しい実装。
 */
function stripPrefix(body: string): string {
  if (!body.startsWith(JSON_PREFIX_HEAD)) return body;
  const lf = body.indexOf("\n");
  return lf === -1 ? body : body.slice(lf + 1);
}

/** 44 文字 base64url の widget token をバイト列に戻す */
function decodeToken(token: string): Uint8Array {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** widget token から有効期限 (UNIX 秒) を取り出す。bytes[9:13] のビッグエンディアン uint32 */
function tokenExpiry(token: string): number {
  const b = decodeToken(token);
  return ((b[9] << 24) >>> 0) + (b[10] << 16) + (b[11] << 8) + b[12];
}

/**
 * ラッパーが実装すべき「explore の geo 文字列 → comparedgeo の req.geo / resolution」の導出。
 * 6 章の対応表をコードにしたもの。
 * オフラインテストが HAR 15 件と、ライブテストが explore の実応答と突き合わせて検証する。
 */
function deriveGeoAndResolution(
  exploreGeo: string,
): { geo: Record<string, string>; resolution: string } {
  if (exploreGeo === "") return { geo: {}, resolution: "COUNTRY" };
  if (!exploreGeo.includes("-")) return { geo: { country: exploreGeo }, resolution: "REGION" };
  // 米国の州だけが DMA (Nielsen 指定市場地域)、それ以外の国の州県は CITY
  const resolution = exploreGeo.startsWith("US-") ? "DMA" : "CITY";
  return { geo: { region: exploreGeo }, resolution };
}

// --------------------------------------------------------------------------
// HAR 由来のリクエスト実測表 (trends_api_widgetdata_comparedgeo 全 15 エントリ)
//   .har/extracted/trends_api_widgetdata_comparedgeo/*.txt の
//   「# query params (decoded)」の req をそのまま転記したもの。
//   token の実値は転記しない (長さと先頭 12 文字だけが仕様上の意味を持つため)。
// --------------------------------------------------------------------------
type HarRow = {
  file: string;
  harIdx: number;
  geo: Record<string, string>;
  time: string;
  resolution: string;
  property: string;
  backend: string;
  category: number;
  dataMode?: string;
  keywords: string[];
};
const HAR_ROWS: HarRow[] = [
  { file: "00_entry101", harIdx: 101, geo: { country: "JP" }, time: "2026-09-07T14\\:53\\:39 2026-09-08T14\\:53\\:39", resolution: "REGION", property: "", backend: "CM", category: 0, keywords: ["Fanza"] },
  { file: "01_entry119", harIdx: 119, geo: { country: "JP" }, time: "2026-09-07T14\\:53\\:42 2026-09-08T14\\:53\\:42", resolution: "REGION", property: "", backend: "CM", category: 8, keywords: ["Fanza"] },
  { file: "02_entry135", harIdx: 135, geo: { country: "JP" }, time: "2026-09-07T14\\:53\\:49 2026-09-08T14\\:53\\:49", resolution: "REGION", property: "", backend: "CM", category: 41, keywords: ["Fanza"] },
  { file: "03_entry152", harIdx: 152, geo: { country: "JP" }, time: "2026-09-07T14\\:54\\:00 2026-09-08T14\\:54\\:00", resolution: "REGION", property: "images", backend: "CM", category: 41, keywords: ["Fanza"] },
  { file: "04_entry164", harIdx: 164, geo: { country: "JP" }, time: "2026-09-07T14\\:54\\:02 2026-09-08T14\\:54\\:02", resolution: "REGION", property: "news", backend: "CM", category: 41, keywords: ["Fanza"] },
  { file: "05_entry177", harIdx: 177, geo: { country: "JP" }, time: "2026-09-07T14\\:54\\:06 2026-09-08T14\\:54\\:06", resolution: "REGION", property: "images", backend: "CM", category: 41, keywords: ["Fanza"] },
  { file: "06_entry192", harIdx: 192, geo: { country: "JP" }, time: "2026-09-07T14\\:54\\:09 2026-09-08T14\\:54\\:09", resolution: "REGION", property: "froogle", backend: "CM", category: 41, keywords: ["Fanza"] },
  { file: "07_entry206", harIdx: 206, geo: { country: "JP" }, time: "2026-09-07T14\\:54\\:11 2026-09-08T14\\:54\\:11", resolution: "REGION", property: "youtube", backend: "CM", category: 41, keywords: ["Fanza"] },
  { file: "08_entry220", harIdx: 220, geo: { country: "JP" }, time: "2026-09-08T10\\:54\\:16 2026-09-08T14\\:54\\:16", resolution: "REGION", property: "youtube", backend: "CM", category: 41, keywords: ["Fanza"] },
  { file: "09_entry232", harIdx: 232, geo: { country: "JP" }, time: "2008-01-01 2026-09-08", resolution: "REGION", property: "youtube", backend: "IZG", category: 41, keywords: ["Fanza"] },
  { file: "10_entry247", harIdx: 247, geo: { region: "JP-13" }, time: "2008-01-01 2026-09-08", resolution: "CITY", property: "youtube", backend: "IZG", category: 41, keywords: ["Fanza"] },
  { file: "11_entry260", harIdx: 260, geo: { country: "JP" }, time: "2008-01-01 2026-09-08", resolution: "REGION", property: "youtube", backend: "IZG", category: 41, keywords: ["Fanza"] },
  { file: "12_entry275", harIdx: 275, geo: { country: "JP" }, time: "2008-01-01 2026-09-08", resolution: "REGION", property: "youtube", backend: "IZG", category: 41, dataMode: "PERCENTAGES", keywords: ["Fanza", "DLsite"] },
  { file: "13_entry276", harIdx: 276, geo: { country: "JP" }, time: "2008-01-01 2026-09-08", resolution: "REGION", property: "youtube", backend: "IZG", category: 41, keywords: ["Fanza"] },
  { file: "14_entry278", harIdx: 278, geo: { country: "JP" }, time: "2008-01-01 2026-09-08", resolution: "REGION", property: "youtube", backend: "IZG", category: 41, keywords: ["DLsite"] },
];

/** HAR 行から実際に投げる req JSON を組み立てる (ラッパーの組み立てロジックと同型) */
function buildReq(row: HarRow): Record<string, unknown> {
  const req: Record<string, unknown> = {
    geo: row.geo,
    comparisonItem: row.keywords.map((k) => ({
      time: row.time,
      complexKeywordsRestriction: { keyword: [{ type: "BROAD", value: k }] },
    })),
    resolution: row.resolution,
    locale: "ja",
    requestOptions: { property: row.property, backend: row.backend, category: row.category },
  };
  if (row.dataMode) req.dataMode = row.dataMode;
  req.userConfig = { userType: "USER_TYPE_SCRAPER" };
  return req;
}

// --------------------------------------------------------------------------
// ライブ呼び出しの共有状態 (1 ファイル内で explore を 1 回しか叩かないため)
// --------------------------------------------------------------------------
type GeoMapWidget = {
  id: string;
  token: string;
  // deno-lint-ignore no-explicit-any
  request: any;
  geo?: string;
  resolution?: string;
  displayMode?: string;
  type?: string;
};
type LiveState =
  | { ok: true; nid: string; widget: GeoMapWidget; widgetIds: string[] }
  | { ok: false; reason: string };

let liveCache: LiveState | null = null;
let liveRequestCount = 0;
/** ライブで実際に観測できた事実のログ。最後のテストでまとめて出す */
const liveNotes: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function apiHeaders(nid: string): HeadersInit {
  const h: Record<string, string> = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "ja",
    "user-agent": UA,
    "referer": `${ORIGIN}/trends/explore`,
  };
  if (nid) h["cookie"] = nid;
  return h;
}

function isJson(res: Response): boolean {
  return /^application\/json/i.test(res.headers.get("content-type") ?? "");
}

/** ライブ HTTP。呼び出し間隔を空ける。ボディは必ず消費する (Deno のリソースリーク対策) */
async function liveFetch(url: string, nid: string): Promise<{ res: Response; body: string }> {
  if (liveRequestCount > 0) await sleep(1500);
  liveRequestCount++;
  const res = await fetch(url, { headers: apiHeaders(nid) });
  const body = await res.text(); // 必ず消費
  return { res, body };
}

/**
 * NID Cookie を取得し、explore を 1 回叩いて GEO_MAP ウィジェットを得る。
 * 429 / ネットワーク断ならハードに落とさず理由を返す (スキップ扱い)。
 * ライブ HTTP 予算: NID 1 + explore 最大 3 = 最大 4 リクエスト。
 */
async function getLive(): Promise<LiveState> {
  if (liveCache) return liveCache;
  try {
    // --- (1) NID 取得: Cookie 無しの /trends/explore は 429 だが Set-Cookie: NID を返す
    liveRequestCount++;
    const boot = await fetch(
      `${ORIGIN}/trends/explore?q=Fanza&date=today%2012-m&geo=JP&hl=ja`,
      { headers: { "user-agent": UA, "accept-language": "ja" } },
    );
    const bootBody = await boot.text(); // 必ず消費
    let nid = "";
    for (const c of boot.headers.getSetCookie?.() ?? []) {
      if (c.startsWith("NID=")) nid = "NID=" + c.split(";")[0].slice(4);
    }
    // 2 章の主張「429 でも NID は配られる」をライブで確認した証跡を残す
    liveNotes.push(
      `GET /trends/explore -> status=${boot.status}, len=${bootBody.length}, NID=${
        nid ? "配布された" : "配布されず"
      }`,
    );
    if (!nid) {
      liveCache = {
        ok: false,
        reason: `NID Cookie を取得できなかった (status=${boot.status}, len=${bootBody.length})`,
      };
      return liveCache;
    }

    // --- (2) explore で GEO_MAP ウィジェット + token を取得
    const exploreReq = {
      comparisonItem: [{ keyword: "Fanza", geo: "JP", time: "today 12-m" }],
      category: 0,
      property: "",
    };
    const exploreUrl = `${ORIGIN}/trends/api/explore?hl=ja&tz=-540&req=` +
      encodeURIComponent(JSON.stringify(exploreReq));
    // 429 は指数バックオフ (2s / 4s) で最大 2 回まで再試行 = 合計 3 回。無限リトライはしない
    let res: Response;
    let body: string;
    let attempt = 0;
    for (;;) {
      ({ res, body } = await liveFetch(exploreUrl, nid));
      if (res.status !== 429 || attempt >= 2) break;
      await sleep(2000 * 2 ** attempt);
      attempt++;
    }
    liveNotes.push(
      `GET /trends/api/explore -> status=${res.status}, ct=${
        res.headers.get("content-type")
      }, 再試行=${attempt}`,
    );
    if (res.status !== 200 || !isJson(res)) {
      liveCache = {
        ok: false,
        reason: `/trends/api/explore が ${res.status} (content-type=${
          res.headers.get("content-type")
        })。レート制限のため未検証 (再試行 ${attempt} 回)`,
      };
      return liveCache;
    }
    const parsed = JSON.parse(stripPrefix(body));
    const widgets = parsed.widgets as GeoMapWidget[];
    const widget = widgets.find((w) => w.id === "GEO_MAP");
    if (!widget) {
      liveCache = { ok: false, reason: "explore レスポンスに GEO_MAP ウィジェットが無い" };
      return liveCache;
    }
    liveCache = { ok: true, nid, widget, widgetIds: widgets.map((w) => w.id) };
    return liveCache;
  } catch (e) {
    liveCache = { ok: false, reason: `ネットワークエラー: ${e instanceof Error ? e.message : e}` };
    return liveCache;
  }
}

/** comparedgeo を叩く。token に "" を渡すと token パラメータ自体を省略する */
// deno-lint-ignore no-explicit-any
async function fetchComparedGeo(req: any, token: string, nid: string) {
  const url = `${ORIGIN}/trends/api/widgetdata/comparedgeo?hl=ja&tz=-540&req=` +
    encodeURIComponent(JSON.stringify(req)) + (token ? `&token=${token}` : "");
  return await liveFetch(url, nid);
}

/** 8 章の geoMapData アイテム共通スキーマを検証する */
// deno-lint-ignore no-explicit-any
function assertGeoMapItemCommon(item: any, keywordCount: number, label: string) {
  assertEquals(typeof item.geoName, "string", `${label}: geoName は string`);
  assert(item.geoName.length > 0, `${label}: geoName は非空`);
  assert(Array.isArray(item.value), `${label}: value は配列`);
  assertEquals(item.value.length, keywordCount, `${label}: value の要素数 = キーワード数`);
  for (const v of item.value) {
    assertEquals(typeof v, "number", `${label}: value の要素は number`);
    assert(v >= 0 && v <= 100, `${label}: value は 0〜100 (実際: ${v})`);
    assertEquals(v, Math.trunc(v), `${label}: value は整数`);
  }
  assert(Array.isArray(item.formattedValue), `${label}: formattedValue は配列`);
  assertEquals(item.formattedValue.length, keywordCount, `${label}: formattedValue の要素数`);
  for (const f of item.formattedValue) {
    assertEquals(typeof f, "string", `${label}: formattedValue の要素は string`);
  }
  assertEquals(typeof item.maxValueIndex, "number", `${label}: maxValueIndex は number`);
  assert(
    item.maxValueIndex >= 0 && item.maxValueIndex < keywordCount,
    `${label}: maxValueIndex は value のインデックス範囲内 (実際: ${item.maxValueIndex})`,
  );
  assert(Array.isArray(item.hasData), `${label}: hasData は配列`);
  assertEquals(item.hasData.length, keywordCount, `${label}: hasData の要素数`);
  for (const h of item.hasData) {
    assertEquals(typeof h, "boolean", `${label}: hasData の要素は boolean`);
  }
  // hasData=false のとき value=0 / formattedValue="" という不変条件 (8 章の落とし穴)
  for (let i = 0; i < keywordCount; i++) {
    if (item.hasData[i] === false) {
      assertEquals(item.value[i], 0, `${label}: hasData=false なら value は 0`);
      assertEquals(item.formattedValue[i], "", `${label}: hasData=false なら formattedValue は ""`);
    }
  }
}

// ==========================================================================
// オフラインテスト (ネットワーク不要 / 常に実行される)
//   HAR から機械的に読み取れる事実だけを検証する。
//   ここが落ちたらドキュメントの [HAR] 表記が嘘になっている。
// ==========================================================================

Deno.test({
  name: "オフライン[HAR]: req の組み立てとパーセントエンコードが entry101 の生 URL と一致する",
  fn() {
    const req = buildReq(HAR_ROWS[0]);
    const json = JSON.stringify(req);
    // 5 章: JS 文字列としてはバックスラッシュ 1 個、JSON 化すると "\\:" になる
    assertEquals(
      json,
      '{"geo":{"country":"JP"},"comparisonItem":[{"time":"2026-09-07T14\\\\:53\\\\:39 2026-09-08T14\\\\:53\\\\:39",' +
        '"complexKeywordsRestriction":{"keyword":[{"type":"BROAD","value":"Fanza"}]}}],"resolution":"REGION",' +
        '"locale":"ja","requestOptions":{"property":"","backend":"CM","category":0},' +
        '"userConfig":{"userType":"USER_TYPE_SCRAPER"}}',
    );

    // ブラウザ (AngularJS) 流のエンコード: { } [ ] " のみ %, ':' と ',' は生、空白は '+'
    const browserEnc = encodeURIComponent(json)
      .replace(/%3A/g, ":").replace(/%2C/g, ",").replace(/%20/g, "+");
    // HAR 00_entry101.txt の :path に現れる生断片と完全一致すること
    assertEquals(
      browserEnc,
      "%7B%22geo%22:%7B%22country%22:%22JP%22%7D,%22comparisonItem%22:%5B%7B%22time%22:%22" +
        "2026-09-07T14%5C%5C:53%5C%5C:39+2026-09-08T14%5C%5C:53%5C%5C:39%22,%22complexKeywords" +
        "Restriction%22:%7B%22keyword%22:%5B%7B%22type%22:%22BROAD%22,%22value%22:%22Fanza%22%7D%5D%7D%7D%5D," +
        "%22resolution%22:%22REGION%22,%22locale%22:%22ja%22,%22requestOptions%22:%7B%22property%22:%22%22," +
        "%22backend%22:%22CM%22,%22category%22:0%7D,%22userConfig%22:%7B%22userType%22:%22USER_TYPE_SCRAPER%22%7D%7D",
      "HAR entry101 の生 URL の req= 部分と文字単位で一致",
    );

    // Deno 標準の encodeURIComponent でも decode すれば同じ JSON に戻る (実測でサーバも受理)
    assertEquals(decodeURIComponent(encodeURIComponent(json)), json);
    assertEquals(decodeURIComponent(browserEnc.replace(/\+/g, "%20")), json);
  },
});

Deno.test({
  name: "オフライン[HAR]: 15 エントリのリクエスト不変条件 (backend/time 相関・geo/resolution 相関・dataMode)",
  fn() {
    assertEquals(HAR_ROWS.length, 15, "trends_api_widgetdata_comparedgeo は 15 エントリ");

    const properties = new Set<string>();
    const categories = new Set<number>();
    for (const row of HAR_ROWS) {
      const req = buildReq(row);

      // 5 章: locale と userConfig は 15/15 件で固定値
      assertEquals(req.locale, "ja", `${row.file}: locale`);
      assertEquals(req.userConfig, { userType: "USER_TYPE_SCRAPER" }, `${row.file}: userConfig`);

      // 5 章: backend は time の形と完全に相関する (例外ゼロ)
      const isIntraday = row.time.includes("T");
      assertEquals(
        row.backend,
        isIntraday ? "CM" : "IZG",
        `${row.file}: 日内窓なら CM / 日単位窓なら IZG (time=${row.time})`,
      );
      if (isIntraday) {
        // 日内窓はコロンがバックスラッシュエスケープされている
        assert(row.time.includes("\\:"), `${row.file}: 日内窓の time はコロンがエスケープされる`);
        assert(
          /^\d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2} \d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2}$/.test(
            row.time,
          ),
          `${row.file}: 日内窓の time 書式 (実際: ${row.time})`,
        );
      } else {
        assert(
          /^\d{4}-\d{2}-\d{2} \d{4}-\d{2}-\d{2}$/.test(row.time),
          `${row.file}: 日単位窓の time 書式 (実際: ${row.time})`,
        );
      }

      // 6 章: geo のキーと resolution の相関
      const geoKeys = Object.keys(row.geo);
      assertEquals(geoKeys.length, 1, `${row.file}: geo のキーは 1 個`);
      if (geoKeys[0] === "country") {
        assertEquals(row.resolution, "REGION", `${row.file}: geo.country なら REGION`);
        assert(/^[A-Z]{2}$/.test(row.geo.country), `${row.file}: country は ISO 3166-1 alpha-2`);
      } else {
        assertEquals(geoKeys[0], "region", `${row.file}: geo のキーは country か region`);
        assertEquals(row.resolution, "CITY", `${row.file}: 非 US の geo.region なら CITY`);
        assert(/^[A-Z]{2}-/.test(row.geo.region), `${row.file}: region は ISO 3166-2 形式`);
      }
      // deriveGeoAndResolution() が HAR と同じ結論を出すこと (6 章の対応表の検証)
      const exploreGeo = row.geo.country ?? row.geo.region;
      const derived = deriveGeoAndResolution(exploreGeo);
      assertEquals(derived.geo, row.geo, `${row.file}: 導出した geo オブジェクト`);
      assertEquals(derived.resolution, row.resolution, `${row.file}: 導出した resolution`);

      // 11 章: dataMode は複数キーワードのときだけ付く
      if (row.keywords.length > 1) {
        assertEquals(row.dataMode, "PERCENTAGES", `${row.file}: 複数キーワードなら PERCENTAGES`);
        assertEquals(req.dataMode, "PERCENTAGES");
      } else {
        assertEquals(row.dataMode, undefined, `${row.file}: 単一キーワードに dataMode は無い`);
        assert(!("dataMode" in req), `${row.file}: req に dataMode キー自体が現れない`);
      }

      // comparisonItem の要素数 = キーワード数、各要素は BROAD 固定、time は要素側
      const items = req.comparisonItem as Array<Record<string, unknown>>;
      assertEquals(items.length, row.keywords.length, `${row.file}: comparisonItem 要素数`);
      for (let i = 0; i < items.length; i++) {
        assertEquals(items[i].time, row.time, `${row.file}: time は要素側に入る`);
        const kw = (items[i].complexKeywordsRestriction as {
          keyword: Array<{ type: string; value: string }>;
        }).keyword;
        assertEquals(kw.length, 1);
        assertEquals(kw[0].type, "BROAD", `${row.file}: HAR は全件 BROAD`);
        assertEquals(kw[0].value, row.keywords[i]);
      }

      properties.add(row.property);
      categories.add(row.category);
    }

    // 5 章: HAR で観測された property / category の値域
    assertEquals(
      [...properties].sort(),
      ["", "froogle", "images", "news", "youtube"],
      "property は 5 種すべてが HAR に現れる",
    );
    assertEquals([...categories].sort((a, b) => a - b), [0, 8, 41], "category の実測値");

    // 6 章: geo.region を使ったのは JP-13 の 1 件だけ
    const regionRows = HAR_ROWS.filter((r) => "region" in r.geo);
    assertEquals(regionRows.length, 1);
    assertEquals(regionRows[0].harIdx, 247);
    assertEquals(regionRows[0].geo.region, "JP-13");
  },
});

Deno.test({
  name: "オフライン[HAR]: 複数キーワード時の 3 連射パターン (GEO_MAP / GEO_MAP_0 / GEO_MAP_1)",
  fn() {
    // 11 章: explore(har_idx=272, 2 キーワード) の直後に 275 / 276 / 278 が撃たれている
    const merged = HAR_ROWS.find((r) => r.harIdx === 275)!;
    const kw0 = HAR_ROWS.find((r) => r.harIdx === 276)!;
    const kw1 = HAR_ROWS.find((r) => r.harIdx === 278)!;

    // (a) 統合 GEO_MAP は 2 キーワード + PERCENTAGES
    assertEquals(merged.keywords, ["Fanza", "DLsite"]);
    assertEquals(merged.dataMode, "PERCENTAGES");

    // (b) GEO_MAP_0 / GEO_MAP_1 は単一キーワード + dataMode 無し
    assertEquals(kw0.keywords, ["Fanza"]);
    assertEquals(kw0.dataMode, undefined);
    assertEquals(kw1.keywords, ["DLsite"]);
    assertEquals(kw1.dataMode, undefined);
    // 個別ウィジェットのキーワード順は explore の comparisonItem 順と一致する
    assertEquals([kw0.keywords[0], kw1.keywords[0]], merged.keywords);

    // (c) 3 本とも geo / resolution / requestOptions / time が完全に同一で、token だけが違う
    for (const r of [kw0, kw1]) {
      assertEquals(r.geo, merged.geo, `har_idx=${r.harIdx}: geo が統合版と同一`);
      assertEquals(r.resolution, merged.resolution, `har_idx=${r.harIdx}: resolution が同一`);
      assertEquals(r.property, merged.property, `har_idx=${r.harIdx}: property が同一`);
      assertEquals(r.backend, merged.backend, `har_idx=${r.harIdx}: backend が同一`);
      assertEquals(r.category, merged.category, `har_idx=${r.harIdx}: category が同一`);
      assertEquals(r.time, merged.time, `har_idx=${r.harIdx}: time が同一`);
    }

    // (d) 3 本は連続した HAR インデックスに並ぶ = 1 回の explore の直後にまとめて撃たれる
    assertEquals([merged.harIdx, kw0.harIdx, kw1.harIdx], [275, 276, 278]);

    // (e) 統合版の req だけが dataMode キーを持つ (シリアライズ結果で確認)
    assert(JSON.stringify(buildReq(merged)).includes('"dataMode":"PERCENTAGES"'));
    assert(!JSON.stringify(buildReq(kw0)).includes("dataMode"));

    // (f) 単一キーワードの comparedgeo は HAR 15 件中 14 件、複数は 1 件だけ
    assertEquals(HAR_ROWS.filter((r) => r.keywords.length > 1).length, 1);
    assertEquals(HAR_ROWS.filter((r) => r.dataMode !== undefined).length, 1);
  },
});

Deno.test({
  name: "オフライン: `)]}'\\n` プレフィックスの剥がし方と 200/エラーの判別ロジック",
  async fn() {
    // ★ comparedgeo の実際のプレフィックスは `)]}',\n` (カンマ有り・6 バイト)。
    //   以前このフィクスチャは `)]}'\n` (5 バイト) を使っており、
    //   「実装もフィクスチャも同じ誤った前提」だったため緑になっていた。
    //   両方の形をここで剥がせることを検証する。
    const body = `)]}',\n{"default":{"geoMapData":[]}}\n`;      // widgetdata 系 (6 バイト)
    const bodyNoComma = `)]}'\n{"default":{"geoMapData":[]}}\n`; // explore 系 (5 バイト)
    assert(body.startsWith(JSON_PREFIX_HEAD));
    assert(bodyNoComma.startsWith(JSON_PREFIX_HEAD));
    assertEquals(new TextEncoder().encode(")]}',\n").length, 6, "widgetdata 系は 6 バイト");
    assertEquals(new TextEncoder().encode(")]}'\n").length, 5, "explore 系は 5 バイト");
    const parsed = JSON.parse(stripPrefix(body));
    assertEquals(parsed.default.geoMapData, []);
    // バイト数を決め打ちしない実装なので、カンマ無しの 5 バイト版も同じ関数で剥がせる
    assertEquals(JSON.parse(stripPrefix(bodyNoComma)).default.geoMapData, []);
    // 空データでも 200 で返る = エラーではない
    assert(Array.isArray(parsed.default.geoMapData));
    // プレフィックスが無い (= HTML エラーページ) 場合は素通しする
    assertEquals(stripPrefix("<html>"), "<html>");

    // 8 章: 成功判定は status と content-type の両方を見る
    const htmlErr = new Response("<html>429</html>", {
      status: 429,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    assertEquals(isJson(htmlErr), false, "text/html は JSON ではない");
    await htmlErr.text();
    const jsonOk = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
    assertEquals(isJson(jsonOk), true, "charset が大文字でも application/json と判定できる");
    await jsonOk.text();
  },
});

Deno.test({
  name: "オフライン[HAR]: widget token (44文字 base64url / 33バイト) の構造と有効期限デコード",
  fn() {
    // HAR 00_entry101.txt の token。
    // ※ これは「特定の公開クエリ 1 件を 24 時間だけ許可する署名付きリクエスト記述子」であり、
    //   ユーザ識別情報 (Cookie / セッション / アカウント) は一切含まない。
    //   発行時刻 2026-09-08T14:53:39Z + 24h = 2026-09-09T14:53:39Z に失効する。
    //   バイト構造を検証するには実物が 1 個必要なので、これだけを転記している。
    const token = "ANI_2wMAAAAAaqFy8xmkqLpRa74AiC1BhcZT0ahXbar7";
    assertEquals(token.length, 44);
    assert(/^[A-Za-z0-9_-]+$/.test(token), "base64url 文字集合 (パディング無し)");
    // 15/15 エントリでこの 12 文字プレフィックスが共通だった
    assert(token.startsWith("ANI_2wMAAAAA"), "先頭 9 バイトは固定ヘッダ 00d23fdb0300000000");

    const bytes = decodeToken(token);
    assertEquals(bytes.length, 33, "デコード後は 33 バイト固定");
    assertEquals(
      Array.from(bytes.slice(0, 9)),
      [0x00, 0xd2, 0x3f, 0xdb, 0x03, 0x00, 0x00, 0x00, 0x00],
      "固定ヘッダ",
    );
    assertEquals(bytes.slice(13).length, 20, "末尾 20 バイトが署名");

    // bytes[9:13] = BE uint32 = 有効期限。
    // HAR entry101 の startedDateTime は 2026-09-08T14:53:39.193Z
    const exp = tokenExpiry(token);
    const issued = Date.parse("2026-09-08T14:53:39Z") / 1000;
    assertEquals(exp - issued, 86400, "token は発行から 24 時間有効");
    assertEquals(new Date(exp * 1000).toISOString(), "2026-09-09T14:53:39.000Z");

    // 手計算とも一致すること (シフト演算の取り違え検出)
    assertEquals(
      exp,
      bytes[9] * 2 ** 24 + bytes[10] * 2 ** 16 + bytes[11] * 2 ** 8 + bytes[12],
      "ビッグエンディアン uint32",
    );
  },
});

Deno.test({
  name: "オフライン: deriveGeoAndResolution() が 6 章の対応表どおりに動く",
  fn() {
    // 世界全体
    assertEquals(deriveGeoAndResolution(""), { geo: {}, resolution: "COUNTRY" });
    // 国 → REGION (HAR で確定)
    assertEquals(deriveGeoAndResolution("JP"), { geo: { country: "JP" }, resolution: "REGION" });
    assertEquals(deriveGeoAndResolution("US"), { geo: { country: "US" }, resolution: "REGION" });
    // 非 US の州県 → CITY (HAR で確定)
    assertEquals(deriveGeoAndResolution("JP-13"), { geo: { region: "JP-13" }, resolution: "CITY" });
    assertEquals(deriveGeoAndResolution("GB-ENG"), {
      geo: { region: "GB-ENG" },
      resolution: "CITY",
    });
    // US の州 → DMA (Nielsen 指定市場地域) [要再検証]
    assertEquals(deriveGeoAndResolution("US-CA"), { geo: { region: "US-CA" }, resolution: "DMA" });

    // 8 章 / 9 章: resolution ごとにアイテムのキー構成が変わる。CITY だけが geoCode を持たない
    const keysFor = (resolution: string) =>
      resolution === "CITY"
        ? ["coordinates", "formattedValue", "geoName", "hasData", "maxValueIndex", "value"]
        : ["formattedValue", "geoCode", "geoName", "hasData", "maxValueIndex", "value"];
    assert(keysFor("CITY").includes("coordinates"));
    assert(!keysFor("CITY").includes("geoCode"));
    for (const r of ["COUNTRY", "REGION", "DMA"]) {
      assert(keysFor(r).includes("geoCode"), `${r} は geoCode を持つ`);
      assert(!keysFor(r).includes("coordinates"), `${r} は coordinates を持たない`);
    }
    // どの resolution でもキー数は 6 個
    for (const r of ["COUNTRY", "REGION", "CITY", "DMA"]) assertEquals(keysFor(r).length, 6);
  },
});

// ==========================================================================
// ライブテスト (429 / ネットワーク断では console.warn してスキップ扱い)
//   ライブ HTTP 予算: NID 1 + explore 最大 3 + comparedgeo 3 = 最大 7
// ==========================================================================

Deno.test({
  name: "ライブ: /trends/api/explore が GEO_MAP ウィジェットと 44 文字 token を返す",
  async fn() {
    const st = await getLive();
    if (!st.ok) {
      console.warn(`[SKIP] ${st.reason}`);
      return;
    }
    const w = st.widget;
    assertEquals(w.id, "GEO_MAP");
    assertEquals(w.token.length, 44);
    assert(/^[A-Za-z0-9_-]{44}$/.test(w.token), "token は base64url 44 文字");
    // 4 章: HAR 15 件と同じ固定ヘッダを持つこと
    assert(w.token.startsWith("ANI_2wMAAAAA"), `token 固定ヘッダ (実際: ${w.token.slice(0, 12)})`);
    assertEquals(decodeToken(w.token).length, 33);

    // 7 章: token の有効期限が「今から約 24 時間後」であること
    const exp = tokenExpiry(w.token);
    const dt = exp - Math.floor(Date.now() / 1000);
    assert(dt > 86000 && dt <= 86400, `token 残り有効期間が 24h 前後 (実際 ${dt} 秒)`);

    // 11 章: 単一キーワードのウィジェット構成
    assert(
      st.widgetIds.includes("TIMESERIES"),
      `widgets に TIMESERIES (実際: ${st.widgetIds.join(",")})`,
    );
    assert(
      !st.widgetIds.some((id) => /^GEO_MAP_\d+$/.test(id)),
      `単一キーワードでは GEO_MAP_n は出ない (実際: ${st.widgetIds.join(",")})`,
    );
    liveNotes.push(`単一キーワードの widgets[]: ${st.widgetIds.join(", ")}`);

    // 5 章 / 6 章: request の形
    const r = w.request;
    assertEquals(r.geo, { country: "JP" }, "explore geo=JP → {country:'JP'}");
    assertEquals(r.resolution, "REGION", "国指定 → REGION");
    // deriveGeoAndResolution() の予測とサーバの実応答が一致すること
    assertEquals(deriveGeoAndResolution("JP"), { geo: r.geo, resolution: r.resolution });
    assertEquals(r.locale, "ja");
    assertEquals(r.userConfig.userType, "USER_TYPE_SCRAPER");
    assertEquals(r.requestOptions.property, "");
    assertEquals(r.requestOptions.category, 0);
    assertEquals(r.requestOptions.backend, "IZG", "today 12-m は日単位窓 → IZG");
    assertEquals(r.comparisonItem.length, 1);
    assertEquals(
      r.comparisonItem[0].complexKeywordsRestriction.keyword[0],
      { type: "BROAD", value: "Fanza" },
    );
    // 5 章: explore の省略記法 "today 12-m" が具体的な日付窓に展開されている
    const time = r.comparisonItem[0].time as string;
    assert(
      /^\d{4}-\d{2}-\d{2} \d{4}-\d{2}-\d{2}$/.test(time),
      `日単位窓は "YYYY-MM-DD YYYY-MM-DD" 形式 (実際: ${time})`,
    );
    const [from, to] = time.split(" ");
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86400000;
    assert(spanDays > 300 && spanDays < 400, `today 12-m は約 1 年の窓 (実際 ${spanDays} 日)`);
    // 5 章: 日単位窓なのでエスケープコロンは現れない (backend=IZG と整合)
    assert(!time.includes("\\:"), "日単位窓にエスケープコロンは無い");
    // 11 章: dataMode は単一キーワードでは付かない
    assertEquals(r.dataMode, undefined);

    // 6 章: ウィジェットのメタ情報 (HAR に本文が無いので、ここが唯一の一次証拠)
    assertEquals(w.geo, "JP");
    assertEquals(w.resolution, "provinces", "国指定の GEO_MAP は provinces");
    assertEquals(w.displayMode, "regions");
    assertEquals(w.type, "fe_geo_chart_explore");
    liveNotes.push(
      `GEO_MAP メタ: resolution=${w.resolution}, displayMode=${w.displayMode}, type=${w.type}`,
    );
  },
});

Deno.test({
  name: "ライブ: comparedgeo (REGION) が geoCode/geoName/value/hasData を持つ 47 都道府県を返す",
  async fn() {
    const st = await getLive();
    if (!st.ok) {
      console.warn(`[SKIP] ${st.reason}`);
      return;
    }
    const { res, body } = await fetchComparedGeo(st.widget.request, st.widget.token, st.nid);
    if (res.status !== 200 || !isJson(res)) {
      console.warn(
        `[SKIP] comparedgeo が ${res.status} (content-type=${
          res.headers.get("content-type")
        })。レート制限のため未検証`,
      );
      return;
    }

    // 8 章: レスポンスヘッダの特徴 (HAR 15/15 件と一致するか)
    assertEquals(res.headers.get("cache-control"), "private, max-age=0");
    assertEquals(res.headers.get("content-disposition"), 'attachment; filename="json.txt"');
    assertEquals(res.headers.get("content-type"), "application/json; charset=UTF-8");
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");

    // 8 章: プレフィックスと末尾改行
    // ★ comparedgeo は `)]}',\n` (カンマ有り・6 バイト)。explore の `)]}'\n` (5 バイト) と違う。
    assert(body.startsWith(JSON_PREFIX_HEAD), "`)]}'` で始まる");
    assertEquals(
      body.slice(0, body.indexOf("\n") + 1),
      ")]}',\n",
      "comparedgeo のプレフィックスは `)]}',\\n` (カンマ有り・6 バイト) — 2026-09-09 実測",
    );
    // ★2026-09-09 実測で訂正: **末尾に改行は付かない**。
    //   explore / multiline / comparedgeo の 3 つとも body.endsWith("\n") === false。
    //   以前は「末尾に改行が 1 個付く」と仮定していたが、この行はプレフィックスの
    //   アサーションより後ろにあったため、ライブで実行されるまで誤りが露見しなかった。
    assert(
      !body.endsWith("\n"),
      `末尾に改行は付かない (実際の末尾: ${JSON.stringify(body.slice(-3))})`,
    );
    const parsed = JSON.parse(stripPrefix(body));
    assertEquals(Object.keys(parsed), ["default"], "トップレベルは default のみ");
    assertEquals(Object.keys(parsed.default), ["geoMapData"], "default 直下は geoMapData のみ");

    const items = parsed.default.geoMapData;
    assert(Array.isArray(items));
    assertEquals(items.length, 47, "日本の REGION は 47 都道府県 (データ無しの県も含めて全件返る)");

    // 全アイテムのキー集合が完全に同一であること
    const keysets = new Set(items.map((x: unknown) => Object.keys(x as object).sort().join(",")));
    assertEquals(
      [...keysets],
      ["formattedValue,geoCode,geoName,hasData,maxValueIndex,value"],
      "REGION のアイテムキーは 6 個で全件同一 (coordinates は無い)",
    );

    for (const item of items) {
      assertGeoMapItemCommon(item, 1, `geoCode=${item.geoCode}`);
      assert(
        /^JP-\d{2}$/.test(item.geoCode),
        `REGION の geoCode は ISO 3166-2 (実際: ${item.geoCode})`,
      );
      assert(!("coordinates" in item), "REGION に coordinates は無い");
    }

    // 9 章: JP-01〜JP-47 が欠番なく揃う
    const codes = (items as Array<{ geoCode: string }>).map((x) => x.geoCode).sort();
    assertEquals(new Set(codes).size, 47, "geoCode は重複しない");
    assertEquals(codes[0], "JP-01");
    assertEquals(codes[46], "JP-47");
    assertEquals(
      codes.map((c) => Number(c.slice(3))),
      Array.from({ length: 47 }, (_, i) => i + 1),
      "JP-01..JP-47 が欠番なく揃う",
    );

    // 8 章: value 降順にソートされている / 最大値は 100
    const vals = (items as Array<{ value: number[] }>).map((x) => x.value[0]);
    assertEquals(vals[0], 100, "先頭は正規化最大値の 100");
    for (let i = 1; i < vals.length; i++) {
      assert(vals[i - 1] >= vals[i], `value は降順 (index ${i}: ${vals[i - 1]} < ${vals[i]})`);
    }

    // 8 章: 単一キーワードなので formattedValue は数値の文字列表現、% は付かない
    for (const item of items) {
      if (item.hasData[0]) {
        assertEquals(item.formattedValue[0], String(item.value[0]));
        assert(!item.formattedValue[0].includes("%"), "PERCENTAGES でなければ % は付かない");
      }
    }
    // 単一キーワードなので maxValueIndex は常に 0
    for (const item of items) assertEquals(item.maxValueIndex, 0);

    liveNotes.push(
      `comparedgeo REGION: ${items.length} 件 / hasData=true ${
        (items as Array<{ hasData: boolean[] }>).filter((x) => x.hasData[0]).length
      } 件 / 先頭 ${items[0].geoCode} ${items[0].geoName}=${vals[0]}`,
    );
  },
});

Deno.test({
  name: "ライブ: token は resolution を署名対象に含まない (REGION→CITY 上書きで座標付き応答)",
  async fn() {
    const st = await getLive();
    if (!st.ok) {
      console.warn(`[SKIP] ${st.reason}`);
      return;
    }
    // ★ explore を叩き直さずに resolution だけ書き換える (7 章の主張の検証)
    const req = JSON.parse(JSON.stringify(st.widget.request));
    assertEquals(req.resolution, "REGION");
    req.resolution = "CITY";

    const { res, body } = await fetchComparedGeo(req, st.widget.token, st.nid);
    if (res.status === 401 || res.status === 400) {
      // 7 章の主張が崩れた場合。ハードには落とさず、事実として記録する
      liveNotes.push(
        `!! 7 章の主張と矛盾: resolution 上書きが ${res.status} で拒否された。` +
          "token は resolution も署名している可能性がある",
      );
      console.warn(
        `[要注意] resolution 上書きが ${res.status}。7 章「token は resolution を署名しない」は ` +
          "本日の環境では成立しない。ドキュメントの [要再検証] 表記どおり、ラッパーは 400/401 を必ず扱うこと",
      );
      return;
    }
    if (res.status !== 200 || !isJson(res)) {
      console.warn(
        `[SKIP] resolution 上書きの comparedgeo が ${res.status} (content-type=${
          res.headers.get("content-type")
        })。レート制限のため未検証`,
      );
      return;
    }

    // 200 が返る = token の署名は resolution を含まない
    const items = JSON.parse(stripPrefix(body)).default.geoMapData;
    assert(Array.isArray(items));
    assert(items.length > 47, `CITY は REGION より細かい (実際 ${items.length} 件)`);

    // 8 章 (B): CITY のアイテムは geoCode を持たず coordinates を持つ
    const keysets = new Set(items.map((x: unknown) => Object.keys(x as object).sort().join(",")));
    assertEquals(
      [...keysets],
      ["coordinates,formattedValue,geoName,hasData,maxValueIndex,value"],
      "CITY のアイテムキーは coordinates を含み geoCode を含まない",
    );

    for (const item of items) {
      assertGeoMapItemCommon(item, 1, `city=${item.geoName}`);
      assert(!("geoCode" in item), "CITY に geoCode は無い");
      assertEquals(
        Object.keys(item.coordinates).sort(),
        ["lat", "lng"],
        "coordinates は lat/lng のみ",
      );
      assertEquals(typeof item.coordinates.lat, "number");
      assertEquals(typeof item.coordinates.lng, "number");
      // 日本国内の緯度経度の範囲に収まる
      assert(item.coordinates.lat > 20 && item.coordinates.lat < 46, `lat=${item.coordinates.lat}`);
      assert(
        item.coordinates.lng > 122 && item.coordinates.lng < 154,
        `lng=${item.coordinates.lng}`,
      );
    }

    // 8 章: CITY でも value 降順は保たれる
    const vals = (items as Array<{ value: number[] }>).map((x) => x.value[0]);
    for (let i = 1; i < vals.length; i++) {
      assert(vals[i - 1] >= vals[i], `CITY でも value は降順 (index ${i})`);
    }
    // 9 章: CITY は一意識別子が無いので geoName で扱うしかない。重複の有無を記録する
    const names = (items as Array<{ geoName: string }>).map((x) => x.geoName);
    liveNotes.push(
      `comparedgeo CITY: ${items.length} 件 / geoName ユニーク ${new Set(names).size} 件 / ` +
        `hasData=true ${(items as Array<{ hasData: boolean[] }>).filter((x) => x.hasData[0]).length} 件`,
    );
  },
});

Deno.test({
  name: "ライブ: token を省略すると JSON ではなくエラーページが返る (4 章 / 8 章の検証)",
  async fn() {
    const st = await getLive();
    if (!st.ok) {
      console.warn(`[SKIP] ${st.reason}`);
      return;
    }
    const { res, body } = await fetchComparedGeo(st.widget.request, "", st.nid);
    if (res.status === 429) {
      console.warn("[SKIP] token 省略テストが 429。レート制限のため未検証");
      return;
    }
    // 8 章: エラーは 200 ではなく、JSON でもない
    assert(res.status >= 400, `token 省略は 4xx になる (実際 ${res.status})`);
    assertEquals(isJson(res), false, "エラー応答は application/json ではない");
    assert(
      /^text\/html/i.test(res.headers.get("content-type") ?? ""),
      `エラーは text/html (実際 ${res.headers.get("content-type")})`,
    );
    assertEquals(res.headers.get("content-disposition"), null, "エラーに content-disposition は無い");
    assert(!body.startsWith(JSON_PREFIX_HEAD), "エラー本文に `)]}'` プレフィックスは無い");
    assert(body.length < 20000, `エラーページは小さい (実際 ${body.length} バイト)`);
    liveNotes.push(
      `token 省略 -> status=${res.status}, ct=${res.headers.get("content-type")}, len=${body.length}`,
    );
  },
});

Deno.test({
  name: "情報: ライブで実際に観測できた事実とリクエスト消費量",
  fn() {
    console.log(`  live HTTP requests issued by this file: ${liveRequestCount}`);
    if (liveNotes.length === 0) {
      console.log("  (ライブ観測なし)");
    } else {
      for (const n of liveNotes) console.log(`  - ${n}`);
    }
    // 内訳: NID 1 + explore 最大 3 (429 時の再試行込み) + comparedgeo 3
    assert(liveRequestCount <= 7, `1 回の実行で 7 リクエストまで (実際 ${liveRequestCount})`);
  },
});
