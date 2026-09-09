// 実行: deno test --allow-net --no-check live_integration/10_time_range_grammar_test.ts
//       HAR コーパスとの突き合わせテストも動かす場合は --allow-read を足す:
//         deno test --allow-net --allow-read --no-check live_integration/10_time_range_grammar_test.ts
//       (--allow-read が無いときはその 1 テストだけ console.warn してスキップする。他は全て動く。)
//
// ============================================================================
// Google Trends: `time` (期間) パラメータの文法 と resolution 決定規則
// ============================================================================
//
// 対象エンドポイント : POST (GET でも可) https://trends.google.com/trends/api/explore
// 主題               : explore に渡す `time` 文字列の文法と、サーバがそれをどう
//                      「絶対期間 + 粒度(resolution) + backend」へ正規化するか。
//
// ライブ検証日 : 2026-09-09 (JST)。実測は UTC 2026-09-08T19:27Z 〜 20:10Z。
//                本ファイルの実測値は 3 回のライブセッションの合算:
//                  セッション1 (19:27-19:34Z): 相対指定 9 種 + 絶対指定 + エラー系 + DAY/WEEK 境界
//                  セッション2 (19:50-20:10Z): resolution 切替点の挟み撃ち (21 リクエスト)
//                  セッション3 (2026-09-09T00:24Z): 敵対的な裏取り。widgets 配列の id/type の完全一致、
//                    TIMESERIES.request のキー集合、GEO_MAP.request.resolution、
//                    および tz=-540 / tz=0 の A/B を取り直して 5 節の主張を再確認。
//                いずれも Deno の素の fetch、Cookie は NID のみ、ヘッドレスブラウザ不使用。
// HAR 根拠     : .har/extracted/trends_api_explore/00_entry092.txt 〜 12_entry272.txt (13件)
//                .har/extracted/trends_api_widgetdata_multiline/00_entry100.txt 〜 12_entry274.txt (13件)
//                .har/extracted/trends_api_widgetdata_relatedsearches/*.txt (26件)
//                .har/extracted/trends_api_widgetdata_comparedgeo/*.txt (15件)
//
// ----------------------------------------------------------------------------
// 0. この `time` はどこに現れるか
// ----------------------------------------------------------------------------
//
//   (a) ブラウザ URL         : https://trends.google.com/trends/explore?...&date=<time>&...
//                              (URL 上のパラメータ名は `date`、API 上は `time`)
//   (b) explore のリクエスト : /trends/api/explore?hl=..&tz=..&req=<JSON>&tz=..
//                              req = { "comparisonItem":[{"keyword":..,"geo":..,"time":"<time>"}],
//                                      "category":<int>, "property":"<空|images|news|froogle|youtube>" }
//   (c) explore のレスポンス : widgets[].request の中に「正規化済みの絶対期間」として返る。
//                              ラッパーはこれを **そのまま透過** して widgetdata に渡すのが正しい。
//
//   つまり `time` は「ユーザが書く短縮文法」であり、サーバがそれを絶対期間へ展開する。
//   展開結果 (widget.request.time) と粒度 (widget.request.resolution) が本ファイルの主題。
//
// ----------------------------------------------------------------------------
// 0.5. explore レスポンスのスキーマ (time / resolution がどこに入っているか)
// ----------------------------------------------------------------------------
//
//   HTTP は POST・GET どちらでも通る (HAR 13/13 は POST、本調査のライブは GET で全て 200)。
//   URL は `?hl=<lang>&tz=<int>&req=<JSON>&tz=<int>` で **tz が 2 回出る** (HAR 13/13)。
//   req の JSON は AngularJS 流のエンコード: `:` と `,` は素通し、空白は `+`。
//   本ファイルの encodeReq() がその再現。素の encodeURIComponent でも通るかは未検証。
//
//   ボディは `)]}'\n` (4 バイト + 改行) のプレフィックス付き JSON。剥がしてから JSON.parse する。
//   剥がした後の形 (ライブ実測・単一キーワード・property="" の場合):
//
//     {
//       "widgets": [
//         { "id":"TIMESERIES",      "request": {...}, "token":"<base64ish>", "type":"fe_line_chart", ... },
//         { "id":"GEO_MAP",         "request": {...}, "token":"...",         "type":"fe_geo_chart_explore", ... },
//         { "id":"RELATED_TOPICS",  "request": {...}, "token":"...",         "type":"fe_related_searches", ... },
//         { "id":"RELATED_QUERIES", "request": {...}, "token":"...",         "type":"fe_related_searches", ... }
//       ]
//     }
//
//   ★ widgets の順序と id は実測で常に
//     ["TIMESERIES","GEO_MAP","RELATED_TOPICS","RELATED_QUERIES"] の 4 件、
//     type は ["fe_line_chart","fe_geo_chart_explore","fe_related_searches","fe_related_searches"]
//     だった (セッション1/2 の全 200 応答 15/15 + セッション3 の 2 応答 = 17/17。
//     keyword 1 個・property="" の場合)。本ファイルのライブテストはこの配列を完全一致で検証する。
//     比較キーワードを複数入れると COMPARED_GEO などが増える (HAR 12_entry272 は 2 キーワード)。
//     ラッパーは **順序に依存せず id で引く**こと (本ファイルの timeseriesOf() 参照)。
//
//   widget オブジェクトのキー (実測。ラッパーが使うのは request / token / id / type だけでよい):
//     ["request","lineAnnotationText","bullets","showLegend","showAverages","helpDialog",
//      "token","id","type","title","template","embedTemplate","version","isLong","isCurated"]
//
//   ★ 落とし穴: request.locale は **送った hl の文字列そのままとは限らない**。
//     サーバが言語コードを既定の地域付きロケールへ展開することがある (セッション3 で発見):
//       hl=ja  → "locale":"ja"      (HAR 13/13。展開されない)
//       hl=en  → "locale":"en-US"   (ライブ実測。en → en-US へ展開される)
//     したがって「送った hl と返った locale が等しい」ことを前提にした実装は壊れる。
//     ラッパーは locale を読み返さず、widget.request をそのまま透過させること (3 節)。
//
//   time / resolution の在り処は widget ごとに **形が違う**:
//
//     TIMESERIES.request = {
//       "time":"<正規化後の窓>",              // ← 3 節のエスケープ規則が効く
//       "resolution":"MINUTE|EIGHT_MINUTE|SIXTEEN_MINUTE|HOUR|DAY|WEEK|MONTH",  // ← 時間粒度
//       "locale":"<hl を正規化したもの>",     // ★ hl と一致するとは限らない (下記)

//       "comparisonItem":[{ "geo":{"country":"JP"}, "complexKeywordsRestriction":{...} }],
//       "requestOptions":{ "property":"", "backend":"CM|IZG", "category":0 },
//       "userConfig":{ "userType":"USER_TYPE_SCRAPER" }
//     }
//
//     GEO_MAP.request = { "geo":{...}, "resolution":"REGION|CITY", "time":"<同じ窓>", ... }
//       ★ ここの resolution は **地理粒度** であって時間粒度ではない。time では決まらず geo で決まる
//         (HAR: geo={"country":"JP"} → REGION、geo={"region":"JP-13"} → CITY。15/15 一致)。
//         TIMESERIES の resolution と混同しないこと。
//
//     RELATED_TOPICS.request / RELATED_QUERIES.request = {
//       "restriction":{
//         "geo":{...},
//         "time":"<正規化後の窓。TIMESERIES.request.time と完全一致>",
//         "originalTimeRangeForExploreUrl":"<ユーザが送った生の time 文字列。now 1-d 等>",
//         "complexKeywordsRestriction":{...}
//       },
//       "keywordType":"QUERY|ENTITY",
//       "metric":["TOP","RISING"],
//       "trendinessSettings":{ "compareTime":"<比較窓。4 節の規則>" },
//       "requestOptions":{...}, "language":"<hl>", "userCountryCode":"<2文字>", "userConfig":{...}
//     }
//       ★ originalTimeRangeForExploreUrl は **短縮文法がそのまま残る唯一の場所**。
//         「ユーザが何を指定したか」を復元したいならここを読む
//         (HAR 26/26 と ライブ 15/15 で送信値と一致)。
//
// ----------------------------------------------------------------------------
// 1. `time` 文法 (5 形態)
// ----------------------------------------------------------------------------
//
//   [1] "now <N>-<U>"    U は H(時) または d(日)  ... 実測: "now 1-H" "now 4-H" "now 1-d" "now 7-d"
//       → 窓 = [ サーバ現在時刻(UTC) − N単位 , サーバ現在時刻(UTC) ]  (秒精度)
//       → 返る time は秒精度の日時形式 (下記 3 節のエスケープ付き)
//
//   [2] "today <N>-<U>"  U は m(月) または y(年) ... 実測: "today 1-m" "today 3-m" "today 12-m" "today 5-y"
//       → 窓 = [ 今日(UTC) − N単位 , 今日(UTC) ]  (日付精度、暦計算)
//       → 返る time は "YYYY-MM-DD YYYY-MM-DD" (エスケープ無し)
//
//   [3] "all"            → 窓 = "2004-01-01 <今日(UTC)>"      (実測: "2004-01-01 2026-09-08")
//       "all_<YYYY>"     → 窓 = "<YYYY>-01-01 <今日(UTC)>"    (HAR: all_2008 → "2008-01-01 2026-09-08")
//       ※ 2004-01-01 が Google Trends のデータ開始日。"all" はそこに固定される。
//
//   [4] "YYYY-MM-DD YYYY-MM-DD"        (半角スペース区切り、URL 上は "+")
//       → 窓はそのまま verbatim にエコーされる。正規化もクランプもされない。
//
//   [5] "YYYY-MM-DDTHH YYYY-MM-DDTHH"  (時までしか書けない。分秒付きの形式は未検証)
//       → 窓は "YYYY-MM-DDTHH\:00\:00 YYYY-MM-DDTHH\:00\:00" へ正規化される。
//       → 実測 (セッション2 で 12 回、全て一致): "2026-09-08T04 2026-09-08T18"
//          → "2026-09-08T04\:00\:00 2026-09-08T18\:00\:00"
//       → **これが resolution を細かく制御する唯一の手段**。相対指定 (now/today) では
//          UI プリセットの窓長しか作れず、下記 SIXTEEN_MINUTE には到達できない。
//
//   単位文字は **大小を区別する**。H(時) は大文字、d/m/y は小文字。
//   [未検証] "now 1-m" / "today 1-d" / "now 12-H" のような単位の組み替え、
//            および N に 1,3,4,5,7,12 以外を与えたときの受理可否。
//            相対指定は UI が出す 9 種以外を使わないのが安全 (8 節)。
//
// ----------------------------------------------------------------------------
// 2. resolution / backend 決定表 (全て実測)
// ----------------------------------------------------------------------------
//
//   resolution は **リクエストできない**。サーバが「正規化後の窓の長さ」だけから決める。
//   (req に resolution を書いても無視される。explore の req スキーマにそもそも入り口が無い。)
//
//   ★ 「窓長だけで決まる」ことの直接証拠 (HAR オフラインで完全再現でき、本ファイルの
//     HAR_RESOLUTION_INVARIANCE テストが検証している):
//       .har/extracted/trends_api_explore/*.txt の req と、対になる
//       .har/extracted/trends_api_widgetdata_multiline/*.txt の resolution を突き合わせると
//         time="now 1-d"   × category 0 / 8 / 41
//                          × property "" / images / news / froogle / youtube  → 8/8 EIGHT_MINUTE
//         time="now 4-H"   × category 41 × property youtube                   → MINUTE
//         time="all_2008"  × geo JP / JP-13 × 1〜2 キーワード                  → 4/4 MONTH
//       つまり category・property・geo・キーワード数・hl(ja) を動かしても resolution は不変で、
//       time を動かしたときだけ変わる。ライブ側でも tz=-540 と tz=0 の now 1-d が
//       ともに EIGHT_MINUTE だった (5 節)。
//
//   ★ resolution の値域は 7 種。**SIXTEEN_MINUTE が存在する**のが本調査の新発見で、
//     UI のプリセット期間 (1時間/4時間/1日/7日/…) では絶対に出てこない。
//     窓長がおよそ 1.5〜2.5 日のカスタム絶対指定でのみ現れる。
//
//     MINUTE → EIGHT_MINUTE → SIXTEEN_MINUTE → HOUR → DAY → WEEK → MONTH  (粗くなる順)
//
//   | 窓長 (正規化後)   | 入力例                                | resolution     | backend | 出典       |
//   |-------------------|---------------------------------------|----------------|---------|------------|
//   | 1 時間            | now 1-H                               | MINUTE         | CM      | セッション1 |
//   | 4 時間            | now 4-H                               | MINUTE         | CM      | S1 / HAR   |
//   | 5 時間            | 2026-09-08T13 2026-09-08T18           | EIGHT_MINUTE   | CM      | セッション2 |
//   | 6 / 9 / 14 時間   | 2026-09-08T12(09/04) 2026-09-08T18    | EIGHT_MINUTE   | CM      | セッション2 |
//   | 24 時間           | now 1-d / 2026-09-08T10 2026-09-09T10 | EIGHT_MINUTE   | CM      | S1 / HAR   |
//   | 33 時間           | 2026-09-07T09 2026-09-08T18           | EIGHT_MINUTE   | CM      | セッション2 |
//   | 37 時間           | 2026-09-07T05 2026-09-08T18           | SIXTEEN_MINUTE | CM      | セッション2 |
//   | 42 / 60 時間      | 2026-09-07T00 (09-06T06) .. T18       | SIXTEEN_MINUTE | CM      | セッション2 |
//   | 72 / 96 時間      | 2026-09-05T18 (09-04T18) .. T18       | HOUR           | CM      | セッション2 |
//   | 7 日 (168 時間)   | now 7-d                               | HOUR           | CM      | セッション1 |
//   | 8 日              | 2026-08-31 2026-09-08                 | DAY            | IZG     | セッション2 |
//   | 10 / 13 / 19 日   | 2026-08-29 (26/20) 2026-09-08         | DAY            | IZG     | セッション2 |
//   | 31 日             | today 1-m (2026-08-08 2026-09-08)     | DAY            | IZG     | セッション1 |
//   | 90 / 92 日        | 2024-01-01 2024-03-31 / today 3-m     | DAY            | IZG     | セッション1 |
//   | 269 日            | 2024-01-01 2024-09-26                 | DAY            | IZG     | S1 (境界)  |
//   | 270 日            | 2024-01-01 2024-09-27                 | WEEK           | IZG     | S1 (境界)  |
//   | 365 日            | today 12-m (2025-09-08 2026-09-08)    | WEEK           | IZG     | セッション1 |
//   | 1613 日           | 2000-01-01 2004-06-01                 | WEEK           | IZG     | セッション1 |
//   | 1826 日 (=5年)    | today 5-y (2021-09-08 2026-09-08)     | WEEK           | IZG     | セッション1 |
//   | 1827 日           | 2021-09-07 2026-09-08                 | WEEK           | IZG     | セッション2 |
//   | 2093 / 2360 日    | 2020-12-15 (03-23) 2026-09-08         | MONTH          | IZG     | セッション2 |
//   | 2894 / 3961 日    | 2018-10-06 (2015-11-04) 2026-09-08    | MONTH          | IZG     | セッション2 |
//   | 6095 日           | 2010-01-01 2026-09-09                 | MONTH          | IZG     | セッション1 |
//   | 6825 日           | all_2008 (2008-01-01 2026-09-08)      | MONTH          | IZG     | HAR        |
//   | 8286 日           | all (2004-01-01 2026-09-08)           | MONTH          | IZG     | セッション1 |
//
//   ★ 切替点 (挟み撃ちで確定した区間。区間内は未測定 = そこでの予測は保証されない)
//     | 切替             | 下側の実測点 | 上側の実測点 | 真の閾値の所在       |
//     |------------------|--------------|--------------|----------------------|
//     | MINUTE→8分       | 4 時間       | 5 時間       | (4h, 5h]  ほぼ確定   |
//     | 8分→16分         | 33 時間      | 37 時間      | (33h, 37h]           |
//     | 16分→HOUR        | 60 時間      | 72 時間      | (60h, 72h]           |
//     | HOUR→DAY         | 7 日         | 8 日         | (7d, 8d]  ほぼ確定   |
//     | DAY→WEEK         | 269 日       | 270 日       | **269d/270d で確定** |
//     | WEEK→MONTH       | 1827 日      | 2093 日      | (1827d, 2093d]       |
//
//   backend は resolution と 1:1 で連動する (実測 37 点すべてで一致):
//     MINUTE / EIGHT_MINUTE / SIXTEEN_MINUTE / HOUR → "CM"  (リアルタイム系)
//     DAY / WEEK / MONTH                            → "IZG" (非リアルタイム系)
//   → CM/IZG の切替点は HOUR→DAY の切替点 (7日と8日の間) と一致する。
//   ※ comparedgeo 側の resolution は別軸 (REGION / CITY) で、time ではなく geo で決まる
//     (HAR: geo=JP → REGION、geo=JP-13 → CITY)。混同しないこと。
//
// ----------------------------------------------------------------------------
// 3. 返る time 文字列のエスケープ (最重要の落とし穴)
// ----------------------------------------------------------------------------
//
//   窓が **日時精度** のとき、コロンがバックスラッシュでエスケープされて返る:
//
//     JSON のバイト列           : "2026-09-07T19\\:30\\:07 2026-09-08T19\\:30\\:07"
//     JSON.parse 後の JS 文字列 : 2026-09-07T19\:30\:07 2026-09-08T19\:30\:07
//                                            ↑ 実際にバックスラッシュ 1 文字が入っている
//     URL に載るとき            : 2026-09-07T19%5C%5C:30%5C%5C:07+...
//
//   窓が **日付精度** のとき (today系 / all / 絶対日付) はエスケープ無しの
//   "YYYY-MM-DD YYYY-MM-DD"。
//
//   ラッパーは widget.request を **一切いじらず JSON.stringify して widgetdata へ渡す**こと。
//   JSON.stringify すればバックスラッシュは自動で再エスケープされ、往復が透過する。
//   自前で \: を : に直したり、Date から組み立て直したりしてはいけない
//   (token が request の HMAC である可能性があり、改変で無効化しうる)。
//
// ----------------------------------------------------------------------------
// 4. trendinessSettings.compareTime (relatedsearches の比較窓) の決定規則
// ----------------------------------------------------------------------------
//
//   在り処: RELATED_TOPICS / RELATED_QUERIES の widget.request.trendinessSettings.compareTime。
//   TIMESERIES / GEO_MAP には無い。widgetdata/relatedsearches を叩くとき req にそのまま載る。
//
//   ★ 統一規則 (本ファイルの predictCompareTime() が実装。HAR 26 件 + ライブ 13 件 = 39 件中
//     38 件が一致。唯一の例外は下記「2004 より完全に前」のケース):
//
//     (a) originalTimeRangeForExploreUrl が "all" / "all_<YYYY>" のとき:
//           compare = [ 窓開始 , 窓開始 + 1 年 ]      ← 「最初の 1 年」。直前窓ではない
//     (b) 窓が日時精度 (T を含む) のとき:
//           compare = [ 窓開始 − 窓長 , 窓開始 ]      ← 直前の同じ長さの窓 (隙間なし)
//     (c) 窓が日付精度のとき:
//           end   = 窓開始 − 1 日
//           start = end − 窓長(日)                    ← (b) と違い 1 日の隙間が空く
//           start < 2004-01-01 なら start を 2004-01-01 にクランプ (end はそのまま)
//
//   実測の裏取り:
//     (a) all_2008 窓 2008-01-01..2026-09-08 → "2008-01-01 2009-01-01"  (HAR 8/8、確定)
//         all      窓 2004-01-01..2026-09-08 → "2004-01-01 2005-01-01"  (セッション1)
//         ※ 「2004-01-01 にクランプされる」のではない。all_2008 の compare が 2008 始まりで
//            あることがそれを否定する。all 系は「最初の1年」を比較窓に使う。
//     (b) now 1-d  窓 09-07T14:53:39..09-08T14:53:39 → 09-06T14:53:39..09-07T14:53:39 (HAR 16/16)
//         now 4-H  窓 09-08T10:54:16..09-08T14:54:16 → 09-08T06:54:16..09-08T10:54:16 (HAR 2/2)
//         now 1-H / now 7-d / 時刻付き絶対指定も同型 (セッション1)
//     (c) today 1-m  窓 2026-08-08..2026-09-08 (31d)  → 2026-07-07..2026-08-07
//         today 3-m  窓 2026-06-08..2026-09-08 (92d)  → 2026-03-07..2026-06-07
//         today 12-m 窓 2025-09-08..2026-09-08 (365d) → 2024-09-07..2025-09-07
//         today 5-y  窓 2021-09-08..2026-09-08 (1826d)→ 2016-09-07..2021-09-07
//         絶対 2024-01-01..2024-03-31 (90d)           → 2023-10-02..2023-12-31
//         絶対 2024-01-01..2024-09-26 (269d)          → 2023-04-06..2023-12-31
//         絶対 2024-01-01..2024-09-27 (270d)          → 2023-04-05..2023-12-31
//         クランプ例: 2010-01-01..2026-09-09 (6095d)  → 2004-01-01..2009-12-31
//                     (素直に引くと 1993 年始まりになるが 2004-01-01 で止まる)
//
//   ★ 唯一の例外 / 未解明: 窓全体が 2004-01-01 より前に食い込むと規則から外れる。
//       2000-01-01..2004-06-01 → compare "2004-01-01 2004-02-01"  (セッション1 実測)
//     (c) の計算では end=1999-12-31 になるはずだが、実際は 2004-01-01 開始の 31 日窓が返った。
//     データ開始日より前の窓は比較窓が無意味になるので、ラッパーは 2004-01-01 より前を
//     開始に取らないよう入力段で弾くのが安全。predictCompareTime() はこのケースで null を返す。
//
// ----------------------------------------------------------------------------
// 5. タイムゾーン tz の影響 (A/B 実測)
// ----------------------------------------------------------------------------
//
//   同じ "now 1-d" を tz=-540 と tz=0 で投げた結果 (セッション1):
//     tz=-540 (19:30:07Z 発) → "2026-09-07T19\:30\:07 2026-09-08T19\:30\:07"
//     tz=0    (19:33:12Z 発) → "2026-09-07T19\:33\:12 2026-09-08T19\:33\:12"
//   どちらも **発信時刻の UTC そのもの**。tz の値は窓の算出に一切影響しない。
//
//   セッション3 (2026-09-09T00:24Z) で 2 秒間隔の A/B を取り直して再確認した:
//     tz=-540 → "2026-09-08T00\:24\:55 2026-09-09T00\:24\:55"
//     tz=0    → "2026-09-08T00\:24\:57 2026-09-09T00\:24\:57"
//   窓末端の差は **2000 ms = 2 リクエストの送信間隔ちょうど**。
//   もし tz が窓に効いているなら差は 9 時間 (32,400,000 ms) になるはずで、そうならなかった。
//   本ファイルのライブテストはこの A/B を実行し、「差 < 5 分」かつ「9 時間ではない」を検証する。
//   (HAR でも tz=-540/JST を送っているのに窓末端が UTC 時刻と一致していた。)
//   → tz は widgetdata レスポンス側の formattedTime 等の表示整形にのみ効くと推定
//      (本ファイルでは未検証。multiline 担当の成果物を参照)。
//   → "today N-m" の「今日」も UTC 基準。JST 09-09 04:30 に投げた窓の終端は 2026-09-08 だった。
//   → ラッパーは「ユーザのローカル日付で期間を指定したい」場合、自前で UTC に換算してから
//      絶対指定 [4]/[5] で渡すこと。相対指定 (now/today) は必ず UTC 基準になる。
//
//   なお explore のクエリは `hl=..&tz=..&req=..&tz=..` と **tz が 2 回出現する** (HAR 13/13)。
//   本調査でも 2 回付けた形で全リクエストが正常応答した。1 回でよいかは未検証。
//
// ----------------------------------------------------------------------------
// 6. 不正 / 境界の time に対するエラー挙動 (セッション1 実測)
// ----------------------------------------------------------------------------
//
//   | time                          | 結果 | 備考                                                    |
//   |-------------------------------|------|---------------------------------------------------------|
//   | "garbage"                     | 400  | text/html 1691 バイト、"Error 400 (Bad Request)!!1"      |
//   | "2024-03-31 2024-01-01"       | 400  | 開始 > 終了                                              |
//   | "2030-01-01 2030-03-31"       | 400  | 完全に未来の日付範囲                                      |
//   | "2000-01-01 2004-06-01"       | 200  | データ開始 (2004-01-01) より前でも受理。verbatim エコー    |
//   | "2026-09-08T10 2026-09-09T10" | 200  | 終端が約15時間先の未来でも受理 (開始が過去なら通る)        |
//
//   ★ 400 は **JSON ではなく HTML** で返る。429 も HTML。content-type だけでは区別できない
//     ので **必ず status を見る**こと。
//       400 → 文法エラー。リトライしても無駄。事前のローカル検証で潰すべき。
//       429 → レート制限。指数バックオフして再試行。
//
//   [未検証] 開始が過去・終了が未来の **日付形式** (例 "2026-09-01 2030-01-01") が通るか。
//   [未検証] 窓長そのものの上限 (22.7年 = all が通るので実質無いと推定)。
//
// ----------------------------------------------------------------------------
// 7. 認証とレート制限 (本調査中の実測)
// ----------------------------------------------------------------------------
//
//   * /trends/api/explore は Cookie 無しだと 429。NID Cookie が必要。
//     NID は次のどちらでも取れる (どちらも Set-Cookie: NID が付く):
//       GET /trends/explore?q=..&date=..&geo=..&hl=..  → 429 だが NID 発行 (body 約1.7KB)
//       GET /trending?geo=..&hl=..                     → 200 で NID 発行 (body 約1.2MB)
//   * ★ NID を取った直後でも、その IP が既に絞られていると explore は 429 を返し続ける。
//     セッション1 では 6 連続 429 → 約 75 秒待機 → 同じ Cookie で 200、を観測した。
//     つまり 429 は **Cookie ではなく IP/レートの問題**。バックオフが唯一の対処。
//   * セッション2 は 1.8 秒間隔で 21 リクエスト連続、429 ゼロ。
//     「200 が返り始めたら 2 秒間隔なら概ね通る」というのが両セッション共通の体感。
//   * 一方その直後 (同 IP で計 28 リクエスト消費した後) は、100 秒バックオフしても explore が
//     429 のままだった。**短時間の連続利用で数分〜のクールダウンが必要になる**。
//     そのため本ファイルのライブテストは 429 を「失敗」ではなく console.warn + スキップ
//     として扱う。CI 等で確実に検証したいなら実行間隔を十分に空けること。
//
// ----------------------------------------------------------------------------
// 8. ラッパーライブラリ向けの設計指針
// ----------------------------------------------------------------------------
//
//   (1) 公開 API は Date / 期間オブジェクトで受け、内部で `time` 文字列へ変換する。
//       本ファイルの formatTimeRange() が最小実装。
//   (2) 相対指定は UI が出す 9 種 ("now 1-H" "now 4-H" "now 1-d" "now 7-d"
//       "today 1-m" "today 3-m" "today 12-m" "today 5-y" "all") に限定するのが安全。
//       任意の N を許すと 400 のリスクがある (未検証領域)。
//   (3) 「厳密な期間」が要るなら相対指定を使わず絶対指定 [4]/[5] を使う。
//       相対指定はサーバ時刻基準なので、呼ぶたびに窓がずれ、結果に再現性がない。
//   (4) resolution はリクエストできない。**欲しい粒度から逆算して窓長を決める**設計にする。
//       resolutionForSpan() の逆写像が spanHintForResolution()。
//       例: 日次データが欲しいなら窓長を 8〜269 日に収める。
//   (5) 窓長が切替点の未測定区間 (4-5h / 33-37h / 60-72h / 7-8d / 1827-2093d) に入るときは
//       予測が外れうる。isNearResolutionBoundary() で検出し、
//       「必ず日次が欲しい」ようなユースケースでは安全側の窓長に丸めること。
//   (6) 送信前にローカル検証する: start < end / start は今日以前 / できれば start >= 2004-01-01。
//       400 はリトライ不能なので事前検証の価値が高い。
//   (7) widget.request は絶対に改変せず透過させる (3 節)。
//   (8) 400 と 429 を別の例外型に分ける。両方 text/html で返るので status で判別すること。
//
// ============================================================================

import { assert, assertEquals } from "jsr:@std/assert@^1";

// ---------------------------------------------------------------------------
// resolution の値域 (粗くなる順)。SIXTEEN_MINUTE を含むのが実測に基づく点。
// ---------------------------------------------------------------------------
export const RESOLUTIONS = [
  "MINUTE",
  "EIGHT_MINUTE",
  "SIXTEEN_MINUTE",
  "HOUR",
  "DAY",
  "WEEK",
  "MONTH",
] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

const H = 3600_000;
const D = 86400_000;

// ---------------------------------------------------------------------------
// 実測データ。テストの根拠であり仕様表そのもの。
//  - normalized : explore レスポンスの widgets[TIMESERIES].request.time を JSON.parse した
//                 後の生の JS 文字列 (日時精度ではバックスラッシュが 1 個入る)。
//                 TS ソース上は "\\:" と書くが、実行時の文字列は \: (バックスラッシュ+コロン)。
//  - spanMs     : normalized から計算できる場合は省略。resolution/backend だけを記録した
//                 切替点 probe では明示する (normalized を保存していないため)。
// ---------------------------------------------------------------------------
type Measured = {
  time: string;
  normalized?: string;
  spanMs?: number;
  resolution: Resolution;
  backend: "CM" | "IZG";
  source: "s1" | "s2" | "har";
};

const MEASURED: Measured[] = [
  // ---- セッション1 (2026-09-08T19:27-19:34Z): 相対指定と DAY/WEEK 境界 ----
  { time: "now 1-H", normalized: "2026-09-08T18\\:30\\:32 2026-09-08T19\\:30\\:32", resolution: "MINUTE", backend: "CM", source: "s1" },
  { time: "now 4-H", normalized: "2026-09-08T15\\:30\\:39 2026-09-08T19\\:30\\:39", resolution: "MINUTE", backend: "CM", source: "s1" },
  { time: "now 1-d", normalized: "2026-09-07T19\\:30\\:07 2026-09-08T19\\:30\\:07", resolution: "EIGHT_MINUTE", backend: "CM", source: "s1" },
  { time: "2026-09-08T10 2026-09-09T10", normalized: "2026-09-08T10\\:00\\:00 2026-09-09T10\\:00\\:00", resolution: "EIGHT_MINUTE", backend: "CM", source: "s1" },
  { time: "now 7-d", normalized: "2026-09-01T19\\:30\\:47 2026-09-08T19\\:30\\:47", resolution: "HOUR", backend: "CM", source: "s1" },
  { time: "today 1-m", normalized: "2026-08-08 2026-09-08", resolution: "DAY", backend: "IZG", source: "s1" },
  { time: "2024-01-01 2024-03-31", normalized: "2024-01-01 2024-03-31", resolution: "DAY", backend: "IZG", source: "s1" },
  { time: "today 3-m", normalized: "2026-06-08 2026-09-08", resolution: "DAY", backend: "IZG", source: "s1" },
  { time: "2024-01-01 2024-09-26", normalized: "2024-01-01 2024-09-26", resolution: "DAY", backend: "IZG", source: "s1" },
  { time: "2024-01-01 2024-09-27", normalized: "2024-01-01 2024-09-27", resolution: "WEEK", backend: "IZG", source: "s1" },
  { time: "today 12-m", normalized: "2025-09-08 2026-09-08", resolution: "WEEK", backend: "IZG", source: "s1" },
  { time: "2000-01-01 2004-06-01", normalized: "2000-01-01 2004-06-01", resolution: "WEEK", backend: "IZG", source: "s1" },
  { time: "today 5-y", normalized: "2021-09-08 2026-09-08", resolution: "WEEK", backend: "IZG", source: "s1" },
  { time: "2010-01-01 2026-09-09", normalized: "2010-01-01 2026-09-09", resolution: "MONTH", backend: "IZG", source: "s1" },
  { time: "all", normalized: "2004-01-01 2026-09-08", resolution: "MONTH", backend: "IZG", source: "s1" },

  // ---- セッション2 (2026-09-08T19:50-20:10Z): 切替点の挟み撃ち (normalized も採取した分) ----
  { time: "2026-09-08T12 2026-09-08T18", normalized: "2026-09-08T12\\:00\\:00 2026-09-08T18\\:00\\:00", resolution: "EIGHT_MINUTE", backend: "CM", source: "s2" },
  { time: "2026-09-08T09 2026-09-08T18", normalized: "2026-09-08T09\\:00\\:00 2026-09-08T18\\:00\\:00", resolution: "EIGHT_MINUTE", backend: "CM", source: "s2" },
  { time: "2026-09-08T04 2026-09-08T18", normalized: "2026-09-08T04\\:00\\:00 2026-09-08T18\\:00\\:00", resolution: "EIGHT_MINUTE", backend: "CM", source: "s2" },
  { time: "2026-09-07T00 2026-09-08T18", normalized: "2026-09-07T00\\:00\\:00 2026-09-08T18\\:00\\:00", resolution: "SIXTEEN_MINUTE", backend: "CM", source: "s2" },
  { time: "2026-09-06T06 2026-09-08T18", normalized: "2026-09-06T06\\:00\\:00 2026-09-08T18\\:00\\:00", resolution: "SIXTEEN_MINUTE", backend: "CM", source: "s2" },
  { time: "2026-09-04T18 2026-09-08T18", normalized: "2026-09-04T18\\:00\\:00 2026-09-08T18\\:00\\:00", resolution: "HOUR", backend: "CM", source: "s2" },
  { time: "2026-08-29 2026-09-08", normalized: "2026-08-29 2026-09-08", resolution: "DAY", backend: "IZG", source: "s2" },
  { time: "2026-08-26 2026-09-08", normalized: "2026-08-26 2026-09-08", resolution: "DAY", backend: "IZG", source: "s2" },
  { time: "2026-08-20 2026-09-08", normalized: "2026-08-20 2026-09-08", resolution: "DAY", backend: "IZG", source: "s2" },
  { time: "2021-09-07 2026-09-08", normalized: "2021-09-07 2026-09-08", resolution: "WEEK", backend: "IZG", source: "s2" },
  { time: "2018-10-06 2026-09-08", normalized: "2018-10-06 2026-09-08", resolution: "MONTH", backend: "IZG", source: "s2" },
  { time: "2015-11-04 2026-09-08", normalized: "2015-11-04 2026-09-08", resolution: "MONTH", backend: "IZG", source: "s2" },

  // ---- セッション2 の追い込み分 (resolution/backend のみ採取。窓長は入力から自明) ----
  { time: "2026-09-08T13 2026-09-08T18", spanMs: 5 * H, resolution: "EIGHT_MINUTE", backend: "CM", source: "s2" },
  { time: "2026-09-07T09 2026-09-08T18", spanMs: 33 * H, resolution: "EIGHT_MINUTE", backend: "CM", source: "s2" },
  { time: "2026-09-07T05 2026-09-08T18", spanMs: 37 * H, resolution: "SIXTEEN_MINUTE", backend: "CM", source: "s2" },
  { time: "2026-09-05T18 2026-09-08T18", spanMs: 72 * H, resolution: "HOUR", backend: "CM", source: "s2" },
  { time: "2026-08-31 2026-09-08", spanMs: 8 * D, resolution: "DAY", backend: "IZG", source: "s2" },
  { time: "2020-12-15 2026-09-08", spanMs: 2093 * D, resolution: "MONTH", backend: "IZG", source: "s2" },
  { time: "2020-03-23 2026-09-08", spanMs: 2360 * D, resolution: "MONTH", backend: "IZG", source: "s2" },

  // ---- HAR 由来 ----
  // .har/extracted/trends_api_widgetdata_multiline/09_entry231.txt (explore req の time = "all_2008")
  { time: "all_2008", normalized: "2008-01-01 2026-09-08", resolution: "MONTH", backend: "IZG", source: "har" },
  // .har/extracted/trends_api_widgetdata_multiline/08_entry219.txt (explore req の time = "now 4-H")
  { time: "now 4-H", normalized: "2026-09-08T10\\:54\\:16 2026-09-08T14\\:54\\:16", resolution: "MINUTE", backend: "CM", source: "har" },
  // .har/extracted/trends_api_widgetdata_multiline/00_entry100.txt (explore req の time = "now 1-d")
  { time: "now 1-d", normalized: "2026-09-07T14\\:53\\:39 2026-09-08T14\\:53\\:39", resolution: "EIGHT_MINUTE", backend: "CM", source: "har" },
];

// ---------------------------------------------------------------------------
// HAR 由来の「resolution は time だけで決まる」不変性の証拠。
// .har/extracted/trends_api_explore/NN.txt の req (time/category/property/geo) と、
// 対になる .har/extracted/trends_api_widgetdata_multiline/NN.txt の resolution を
// 突き合わせたもの。13 組すべてを転記してある (2026-09-08 キャプチャ)。
// ---------------------------------------------------------------------------
type HarPair = {
  explore: string;   // trends_api_explore 側のファイル名
  multiline: string; // trends_api_widgetdata_multiline 側のファイル名
  time: string;
  category: number;
  property: string;
  geo: string;
  keywords: number;
  resolution: Resolution;
  backend: "CM" | "IZG";
};

const HAR_PAIRS: HarPair[] = [
  { explore: "00_entry092.txt", multiline: "00_entry100.txt", time: "now 1-d", category: 0, property: "", geo: "JP", keywords: 1, resolution: "EIGHT_MINUTE", backend: "CM" },
  { explore: "01_entry116.txt", multiline: "01_entry118.txt", time: "now 1-d", category: 8, property: "", geo: "JP", keywords: 1, resolution: "EIGHT_MINUTE", backend: "CM" },
  { explore: "02_entry132.txt", multiline: "02_entry134.txt", time: "now 1-d", category: 41, property: "", geo: "JP", keywords: 1, resolution: "EIGHT_MINUTE", backend: "CM" },
  { explore: "03_entry148.txt", multiline: "03_entry151.txt", time: "now 1-d", category: 41, property: "images", geo: "JP", keywords: 1, resolution: "EIGHT_MINUTE", backend: "CM" },
  { explore: "04_entry161.txt", multiline: "04_entry163.txt", time: "now 1-d", category: 41, property: "news", geo: "JP", keywords: 1, resolution: "EIGHT_MINUTE", backend: "CM" },
  { explore: "05_entry174.txt", multiline: "05_entry176.txt", time: "now 1-d", category: 41, property: "images", geo: "JP", keywords: 1, resolution: "EIGHT_MINUTE", backend: "CM" },
  { explore: "06_entry189.txt", multiline: "06_entry191.txt", time: "now 1-d", category: 41, property: "froogle", geo: "JP", keywords: 1, resolution: "EIGHT_MINUTE", backend: "CM" },
  { explore: "07_entry203.txt", multiline: "07_entry205.txt", time: "now 1-d", category: 41, property: "youtube", geo: "JP", keywords: 1, resolution: "EIGHT_MINUTE", backend: "CM" },
  { explore: "08_entry217.txt", multiline: "08_entry219.txt", time: "now 4-H", category: 41, property: "youtube", geo: "JP", keywords: 1, resolution: "MINUTE", backend: "CM" },
  { explore: "09_entry229.txt", multiline: "09_entry231.txt", time: "all_2008", category: 41, property: "youtube", geo: "JP", keywords: 1, resolution: "MONTH", backend: "IZG" },
  { explore: "10_entry244.txt", multiline: "10_entry246.txt", time: "all_2008", category: 41, property: "youtube", geo: "JP-13", keywords: 1, resolution: "MONTH", backend: "IZG" },
  { explore: "11_entry257.txt", multiline: "11_entry259.txt", time: "all_2008", category: 41, property: "youtube", geo: "JP", keywords: 1, resolution: "MONTH", backend: "IZG" },
  { explore: "12_entry272.txt", multiline: "12_entry274.txt", time: "all_2008", category: 41, property: "youtube", geo: "JP", keywords: 2, resolution: "MONTH", backend: "IZG" },
];

// ---------------------------------------------------------------------------
// compareTime (4 節) の実測。
//   window : widget.request.time (= restriction.time)。日時精度はエスケープ込み。
//   compare: trendinessSettings.compareTime。同じエスケープ規則。
//   orig   : restriction.originalTimeRangeForExploreUrl (ユーザが送った生の time)。
// ---------------------------------------------------------------------------
type CompareCase = {
  orig: string;
  window: string;
  compare: string;
  source: "har" | "s1";
  note?: string;
};

const COMPARE_MEASURED: CompareCase[] = [
  // ---- HAR (.har/extracted/trends_api_widgetdata_relatedsearches/) ----
  // 00..15_entry* : now 1-d が 16 件。窓末端の秒だけ違う同型なので代表 2 件を転記。
  { orig: "now 1-d", window: "2026-09-07T14\\:53\\:39 2026-09-08T14\\:53\\:39", compare: "2026-09-06T14\\:53\\:39 2026-09-07T14\\:53\\:39", source: "har" },
  { orig: "now 1-d", window: "2026-09-07T14\\:54\\:11 2026-09-08T14\\:54\\:11", compare: "2026-09-06T14\\:54\\:11 2026-09-07T14\\:54\\:11", source: "har" },
  // 16,17_entry221/222 : now 4-H
  { orig: "now 4-H", window: "2026-09-08T10\\:54\\:16 2026-09-08T14\\:54\\:16", compare: "2026-09-08T06\\:54\\:16 2026-09-08T10\\:54\\:16", source: "har" },
  // 18..25_entry* : all_2008 が 8 件、すべて同一値
  { orig: "all_2008", window: "2008-01-01 2026-09-08", compare: "2008-01-01 2009-01-01", source: "har", note: "all 系は「最初の1年」" },

  // ---- セッション1 (2026-09-08T19:27-19:34Z ライブ) ----
  { orig: "now 1-H", window: "2026-09-08T18\\:30\\:32 2026-09-08T19\\:30\\:32", compare: "2026-09-08T17\\:30\\:32 2026-09-08T18\\:30\\:32", source: "s1" },
  { orig: "now 4-H", window: "2026-09-08T15\\:30\\:39 2026-09-08T19\\:30\\:39", compare: "2026-09-08T11\\:30\\:39 2026-09-08T15\\:30\\:39", source: "s1" },
  { orig: "now 1-d", window: "2026-09-07T19\\:33\\:12 2026-09-08T19\\:33\\:12", compare: "2026-09-06T19\\:33\\:12 2026-09-07T19\\:33\\:12", source: "s1", note: "tz=0 で送った回" },
  { orig: "now 7-d", window: "2026-09-01T19\\:30\\:47 2026-09-08T19\\:30\\:47", compare: "2026-08-25T19\\:30\\:47 2026-09-01T19\\:30\\:47", source: "s1" },
  { orig: "2026-09-08T10 2026-09-09T10", window: "2026-09-08T10\\:00\\:00 2026-09-09T10\\:00\\:00", compare: "2026-09-07T10\\:00\\:00 2026-09-08T10\\:00\\:00", source: "s1" },
  { orig: "today 1-m", window: "2026-08-08 2026-09-08", compare: "2026-07-07 2026-08-07", source: "s1" },
  { orig: "today 3-m", window: "2026-06-08 2026-09-08", compare: "2026-03-07 2026-06-07", source: "s1" },
  { orig: "today 12-m", window: "2025-09-08 2026-09-08", compare: "2024-09-07 2025-09-07", source: "s1" },
  { orig: "today 5-y", window: "2021-09-08 2026-09-08", compare: "2016-09-07 2021-09-07", source: "s1" },
  { orig: "2024-01-01 2024-03-31", window: "2024-01-01 2024-03-31", compare: "2023-10-02 2023-12-31", source: "s1" },
  { orig: "2024-01-01 2024-09-26", window: "2024-01-01 2024-09-26", compare: "2023-04-06 2023-12-31", source: "s1" },
  { orig: "2024-01-01 2024-09-27", window: "2024-01-01 2024-09-27", compare: "2023-04-05 2023-12-31", source: "s1" },
  { orig: "2010-01-01 2026-09-09", window: "2010-01-01 2026-09-09", compare: "2004-01-01 2009-12-31", source: "s1", note: "2004-01-01 クランプ" },
  { orig: "all", window: "2004-01-01 2026-09-08", compare: "2004-01-01 2005-01-01", source: "s1", note: "all 系は「最初の1年」" },
];

/** 規則から外れる唯一の実測 (4 節参照)。predictCompareTime は null を返し、実測はこの値。 */
const COMPARE_ANOMALY = {
  orig: "2000-01-01 2004-06-01",
  window: "2000-01-01 2004-06-01",
  compare: "2004-01-01 2004-02-01",
} as const;

// ---------------------------------------------------------------------------
// ラッパー実装者向けの参考ユーティリティ (すべて純粋関数・依存なし)
// ---------------------------------------------------------------------------

/** Google Trends の全 /trends/api/* JSON レスポンスに付く `)]}'` プレフィックスを剥がす。 */
export function stripJsonPrefix(body: string): string {
  if (!body.startsWith(")]}'")) throw new SyntaxError("Trends の JSON プレフィックス )]}' が無い");
  return body.replace(/^\)\]\}'\n?/, "");
}

/** Google Trends のデータ開始日 (UTC)。これより前は比較窓がクランプされる。 */
export const TRENDS_EPOCH_MS = Date.UTC(2004, 0, 1);

/** widget.request.time (エスケープ込み) を [開始, 終了] の Date に分解する。窓は常に UTC。 */
export function parseWidgetTime(t: string): { start: Date; end: Date; hasTime: boolean } {
  const parts = t.split(" ");
  if (parts.length !== 2) throw new Error(`unexpected widget time: ${t}`);
  const hasTime = t.includes("T");
  const toDate = (s: string) => {
    const clean = s.replace(/\\/g, ""); // 2026-09-07T19\:30\:07 -> 2026-09-07T19:30:07
    return new Date(clean.includes("T") ? `${clean}Z` : `${clean}T00:00:00Z`);
  };
  return { start: toDate(parts[0]), end: toDate(parts[1]), hasTime };
}

/** widget.request.time と同じ書式へ戻す (日時精度ならコロンをバックスラッシュでエスケープ)。 */
export function formatWidgetTime(startMs: number, endMs: number, hasTime: boolean): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const one = (ms: number) => {
    const x = new Date(ms);
    const d = `${p(x.getUTCFullYear(), 4)}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}`;
    if (!hasTime) return d;
    // 実サーバと同じく "\:" (バックスラッシュ + コロン) を使う
    return `${d}T${p(x.getUTCHours())}\\:${p(x.getUTCMinutes())}\\:${p(x.getUTCSeconds())}`;
  };
  return `${one(startMs)} ${one(endMs)}`;
}

/**
 * trendinessSettings.compareTime を予測する (4 節の統一規則)。
 *
 * @param windowTime 正規化後の窓 = widget.request.time (エスケープ込みでよい)
 * @param originalTime restriction.originalTimeRangeForExploreUrl (ユーザが送った生の time)
 * @returns 予測される compareTime 文字列。規則が適用できない場合 (窓が 2004-01-01 より
 *          完全に前にある) は null。
 */
export function predictCompareTime(windowTime: string, originalTime: string): string | null {
  const { start, end, hasTime } = parseWidgetTime(windowTime);
  const span = end.getTime() - start.getTime();

  // (a) "all" / "all_<YYYY>" は「窓開始 .. 窓開始 + 1 年」
  if (originalTime === "all" || /^all_\d{4}$/.test(originalTime)) {
    const s = new Date(start.getTime());
    const plusYear = Date.UTC(s.getUTCFullYear() + 1, s.getUTCMonth(), s.getUTCDate());
    return formatWidgetTime(start.getTime(), plusYear, false);
  }

  // (b) 日時精度は「直前の同じ長さの窓」(隙間なし)
  if (hasTime) {
    return formatWidgetTime(start.getTime() - span, start.getTime(), true);
  }

  // (c) 日付精度は「窓開始の前日で終わる、同じ長さの窓」(1 日の隙間)
  const cmpEnd = start.getTime() - D;
  if (cmpEnd < TRENDS_EPOCH_MS) return null; // 実測 1 件だけ規則から外れる領域
  const cmpStart = Math.max(cmpEnd - span, TRENDS_EPOCH_MS);
  return formatWidgetTime(cmpStart, cmpEnd, false);
}

/**
 * 切替点の「確定していない区間」。lo はその resolution が実測できた上限、
 * hi は次の resolution が実測できた下限。真の閾値は (lo, hi] のどこか。
 */
export const RESOLUTION_BOUNDARIES: Array<{ below: Resolution; above: Resolution; loMs: number; hiMs: number }> = [
  { below: "MINUTE", above: "EIGHT_MINUTE", loMs: 4 * H, hiMs: 5 * H },
  { below: "EIGHT_MINUTE", above: "SIXTEEN_MINUTE", loMs: 33 * H, hiMs: 37 * H },
  { below: "SIXTEEN_MINUTE", above: "HOUR", loMs: 60 * H, hiMs: 72 * H },
  { below: "HOUR", above: "DAY", loMs: 7 * D, hiMs: 8 * D },
  { below: "DAY", above: "WEEK", loMs: 269 * D, hiMs: 270 * D }, // ここだけ 1 日刻みで確定
  { below: "WEEK", above: "MONTH", loMs: 1827 * D, hiMs: 2093 * D },
];

/**
 * 窓の長さから resolution を予測する。閾値は「その resolution を実測できた上限」に置いてあり、
 * 実測 37 点すべてと一致する (本ファイルのテストで検証)。
 * 未測定区間 (RESOLUTION_BOUNDARIES の lo と hi の間) では外れる可能性がある。
 */
export function resolutionForSpan(spanMs: number): Resolution {
  if (spanMs <= 4 * H) return "MINUTE";           // 実測: 1h, 4h
  if (spanMs <= 33 * H) return "EIGHT_MINUTE";    // 実測: 5h, 6h, 9h, 14h, 24h, 33h
  if (spanMs <= 60 * H) return "SIXTEEN_MINUTE";  // 実測: 37h, 42h, 60h
  if (spanMs <= 7 * D) return "HOUR";             // 実測: 72h, 96h, 168h
  if (spanMs <= 269 * D) return "DAY";            // 実測: 8d, 10d, 13d, 19d, 31d, 90d, 92d, 269d
  if (spanMs <= 1827 * D) return "WEEK";          // 実測: 270d, 365d, 1613d, 1826d, 1827d
  return "MONTH";                                 // 実測: 2093d, 2360d, 2894d, 3961d, 6095d, 6825d, 8286d
}

/**
 * 窓長が「未測定の切替区間」に入っているか (= resolution 予測が保証されない)。
 * loMs / hiMs 自体は実測点なので区間からは除く (開区間)。
 * DAY→WEEK だけは lo=269日 / hi=270日 と 1 日刻みで隣接しているので、日付精度の窓では
 * 該当しない (時刻付きで 269.5 日のような窓を作ったときだけ true になる)。
 */
export function isNearResolutionBoundary(spanMs: number): boolean {
  return RESOLUTION_BOUNDARIES.some((b) => spanMs > b.loMs && spanMs < b.hiMs);
}

/**
 * 欲しい resolution から「確実にその粒度になる窓長」の安全な範囲 [minMs, maxMs] を返す。
 * 未測定区間を避けるため、両端は実測点そのものにしてある。
 */
export function spanHintForResolution(r: Resolution): { minMs: number; maxMs: number } {
  switch (r) {
    case "MINUTE":
      return { minMs: 1 * H, maxMs: 4 * H };
    case "EIGHT_MINUTE":
      return { minMs: 5 * H, maxMs: 33 * H };
    case "SIXTEEN_MINUTE":
      return { minMs: 37 * H, maxMs: 60 * H };
    case "HOUR":
      return { minMs: 72 * H, maxMs: 7 * D };
    case "DAY":
      return { minMs: 8 * D, maxMs: 269 * D };
    case "WEEK":
      return { minMs: 270 * D, maxMs: 1827 * D };
    case "MONTH":
      return { minMs: 2093 * D, maxMs: 8286 * D };
  }
}

/** resolution から backend (CM=リアルタイム系 / IZG=非リアルタイム系) を導く。実測 37/37 一致。 */
export function backendForResolution(r: Resolution): "CM" | "IZG" {
  return r === "DAY" || r === "WEEK" || r === "MONTH" ? "IZG" : "CM";
}

/** UI が実際に発行する相対指定の全集合。これ以外は 400 のリスクがあるため許可しない。 */
export const SAFE_RELATIVE_RANGES = [
  "now 1-H",
  "now 4-H",
  "now 1-d",
  "now 7-d",
  "today 1-m",
  "today 3-m",
  "today 12-m",
  "today 5-y",
  "all",
] as const;

/** ユーザ入力 (Date) から explore に渡す `time` 文字列を組み立てる。 */
export function formatTimeRange(
  spec:
    | { kind: "relative"; preset: (typeof SAFE_RELATIVE_RANGES)[number] }
    | { kind: "allSince"; year: number }
    | { kind: "absolute"; start: Date; end: Date; granularity?: "date" | "hour" },
): string {
  if (spec.kind === "relative") return spec.preset;
  if (spec.kind === "allSince") return `all_${spec.year}`;
  const { start, end, granularity = "date" } = spec;
  if (!(start.getTime() < end.getTime())) throw new RangeError("start must be < end (サーバは 400 を返す)");
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const d = (x: Date) => `${p(x.getUTCFullYear(), 4)}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}`;
  // 時刻付きは「時」までしか書けない (分秒はサーバが :00:00 に正規化する)
  const f = (x: Date) => (granularity === "hour" ? `${d(x)}T${p(x.getUTCHours())}` : d(x));
  return `${f(start)} ${f(end)}`;
}

/** 実測エントリの窓長 (ms)。normalized があればそこから、無ければ記録値を使う。 */
function spanOf(m: Measured): number {
  if (m.normalized) {
    const { start, end } = parseWidgetTime(m.normalized);
    return end.getTime() - start.getTime();
  }
  return m.spanMs!;
}

// ---------------------------------------------------------------------------
// オフラインテスト (ネットワーク不要)
// ---------------------------------------------------------------------------

Deno.test({
  name: "オフライン: 実測 37 点すべてで resolutionForSpan / backendForResolution が一致する",
  fn() {
    assertEquals(MEASURED.length, 37);
    for (const m of MEASURED) {
      const span = spanOf(m);
      assert(span > 0, `${m.time}: 窓長が正でない`);
      assertEquals(
        resolutionForSpan(span),
        m.resolution,
        `${m.time} (窓長 ${(span / D).toFixed(3)} 日) の resolution 予測が実測と不一致`,
      );
      assertEquals(backendForResolution(m.resolution), m.backend, `${m.time} の backend が不一致`);
    }
    // 7 種すべてが実測でカバーされていること (SIXTEEN_MINUTE を含む)
    const covered = new Set<string>(MEASURED.map((m) => m.resolution));
    assertEquals([...RESOLUTIONS].filter((r) => !covered.has(r)), []);
  },
});

// ---------------------------------------------------------------------------
// 2 節の決定表に書いた「窓長」の転記表。ドキュメントの数値そのもので、
// 下のテストが MEASURED から再計算した実際の窓長と突き合わせる。
// (この表が無いと、表の日数を書き間違えてもテストが素通りしてしまう。
//  実際 2026-09-09 の検証で "2010-01-01 2026-09-09" を 6096 日と誤記していたのを
//  この突き合わせで発見し 6095 日へ訂正した。)
// ---------------------------------------------------------------------------
const DOC_TABLE_SPANS: Array<[time: string, spanMs: number]> = [
  ["now 1-H", 1 * H],
  ["now 4-H", 4 * H],
  ["2026-09-08T13 2026-09-08T18", 5 * H],
  ["2026-09-08T12 2026-09-08T18", 6 * H],
  ["2026-09-08T09 2026-09-08T18", 9 * H],
  ["2026-09-08T04 2026-09-08T18", 14 * H],
  ["now 1-d", 24 * H],
  ["2026-09-08T10 2026-09-09T10", 24 * H],
  ["2026-09-07T09 2026-09-08T18", 33 * H],
  ["2026-09-07T05 2026-09-08T18", 37 * H],
  ["2026-09-07T00 2026-09-08T18", 42 * H],
  ["2026-09-06T06 2026-09-08T18", 60 * H],
  ["2026-09-05T18 2026-09-08T18", 72 * H],
  ["2026-09-04T18 2026-09-08T18", 96 * H],
  ["now 7-d", 7 * D],
  ["2026-08-31 2026-09-08", 8 * D],
  ["2026-08-29 2026-09-08", 10 * D],
  ["2026-08-26 2026-09-08", 13 * D],
  ["2026-08-20 2026-09-08", 19 * D],
  ["today 1-m", 31 * D],
  ["2024-01-01 2024-03-31", 90 * D],
  ["today 3-m", 92 * D],
  ["2024-01-01 2024-09-26", 269 * D],
  ["2024-01-01 2024-09-27", 270 * D],
  ["today 12-m", 365 * D],
  ["2000-01-01 2004-06-01", 1613 * D],
  ["today 5-y", 1826 * D],
  ["2021-09-07 2026-09-08", 1827 * D],
  ["2020-12-15 2026-09-08", 2093 * D],
  ["2020-03-23 2026-09-08", 2360 * D],
  ["2018-10-06 2026-09-08", 2894 * D],
  ["2015-11-04 2026-09-08", 3961 * D],
  ["2010-01-01 2026-09-09", 6095 * D],
  ["all_2008", 6825 * D],
  ["all", 8286 * D],
];

Deno.test({
  name: "オフライン: 2 節の決定表に書いた窓長が実測データから再計算した値と一致する (ドキュメントの自己検証)",
  fn() {
    const doc = new Map(DOC_TABLE_SPANS);
    assertEquals(doc.size, DOC_TABLE_SPANS.length, "決定表に time の重複がある");

    // (1) 決定表の全行が、実測から再計算した窓長と一致すること
    for (const m of MEASURED) {
      const documented = doc.get(m.time);
      assert(documented !== undefined, `決定表に載っていない実測: ${m.time}`);
      assertEquals(
        spanOf(m),
        documented,
        `2 節の決定表の窓長が誤り: ${m.time} は実際 ${spanOf(m) / D} 日 (表は ${documented! / D} 日)`,
      );
      // 表の窓長から引ける resolution が、実測の resolution と一致すること
      assertEquals(resolutionForSpan(documented!), m.resolution, `${m.time}: 表の窓長→resolution が実測と不一致`);
    }

    // (2) 決定表に「実測に無い行」が紛れていないこと (書きすぎの検出)
    const measuredTimes = new Set(MEASURED.map((m) => m.time));
    assertEquals(
      DOC_TABLE_SPANS.map(([t]) => t).filter((t) => !measuredTimes.has(t)),
      [],
      "決定表に実測の裏付けが無い行がある",
    );
    // 37 件の実測は 35 種の time に対応する (now 1-d と now 4-H が s1/har で重複)
    assertEquals(measuredTimes.size, 35);
    assertEquals(MEASURED.length, 37);

    // (3) 同じ time が複数ソースで観測されている 2 件は、窓長も resolution も一致すること
    for (const t of ["now 1-d", "now 4-H"]) {
      const dup = MEASURED.filter((m) => m.time === t);
      assertEquals(dup.length, 2, `${t} は s1 と har の 2 件あるはず`);
      assertEquals(new Set(dup.map(spanOf)).size, 1, `${t}: ソース間で窓長が違う`);
      assertEquals(new Set(dup.map((m) => m.resolution)).size, 1, `${t}: ソース間で resolution が違う`);
    }
  },
});

Deno.test({
  name: "オフライン: 切替点の実測区間が一貫している (DAY/WEEK は 269d/270d で確定)",
  fn() {
    for (const b of RESOLUTION_BOUNDARIES) {
      // lo / hi はどちらも実測点なので、予測はそのまま実測 resolution と一致しなければならない
      assertEquals(resolutionForSpan(b.loMs), b.below, `${b.below}→${b.above} の lo 側`);
      assertEquals(resolutionForSpan(b.hiMs), b.above, `${b.below}→${b.above} の hi 側`);
      assert(b.hiMs > b.loMs);
      assert(!isNearResolutionBoundary(b.loMs) && !isNearResolutionBoundary(b.hiMs), "実測点は境界近傍ではない");
      // lo と hi の中点は必ず「未測定区間」に入る
      const mid = (b.loMs + b.hiMs) / 2;
      assert(isNearResolutionBoundary(mid), `${b.below}→${b.above} の中点 (${mid / H}h) は境界近傍のはず`);
    }
    // 唯一 1 日刻みで挟み撃ちできた境界
    assertEquals(resolutionForSpan(269 * D), "DAY");
    assertEquals(resolutionForSpan(270 * D), "WEEK");
    const d269 = MEASURED.find((m) => m.time === "2024-01-01 2024-09-26")!;
    const d270 = MEASURED.find((m) => m.time === "2024-01-01 2024-09-27")!;
    assertEquals(spanOf(d269) / D, 269);
    assertEquals(spanOf(d270) / D, 270);
    assertEquals(d269.resolution, "DAY");
    assertEquals(d270.resolution, "WEEK");
    // 安全域は境界近傍ではない / 未測定区間は境界近傍
    assert(!isNearResolutionBoundary(24 * H));
    assert(!isNearResolutionBoundary(100 * D));
    assert(isNearResolutionBoundary(4.5 * H));
    assert(isNearResolutionBoundary(2000 * D));
  },
});

Deno.test({
  name: "オフライン: SIXTEEN_MINUTE は 37〜60 時間の窓でのみ観測され、UI プリセットでは到達不能",
  fn() {
    const sixteen = MEASURED.filter((m) => m.resolution === "SIXTEEN_MINUTE");
    assertEquals(sixteen.length, 3);
    for (const m of sixteen) {
      const h = spanOf(m) / H;
      assert(h >= 37 && h <= 60, `SIXTEEN_MINUTE の実測窓長が想定外: ${h}h`);
      assertEquals(m.backend, "CM");
      // すべて時刻付きの絶対指定。相対指定では出ない
      assert(/^\d{4}-\d{2}-\d{2}T\d{2} /.test(m.time), `SIXTEEN_MINUTE は絶対指定のみ: ${m.time}`);
    }
    // UI プリセットの窓長 (1h/4h/24h/7d/1m/3m/12m/5y/all) はどれも SIXTEEN_MINUTE にならない
    for (const preset of [1 * H, 4 * H, 24 * H, 7 * D, 31 * D, 92 * D, 365 * D, 1826 * D, 8286 * D]) {
      assert(resolutionForSpan(preset) !== "SIXTEEN_MINUTE", `プリセット窓長 ${preset / H}h`);
    }
  },
});

Deno.test({
  name: "オフライン: spanHintForResolution の両端が実際にその resolution を返す (逆写像の健全性)",
  fn() {
    for (const r of RESOLUTIONS) {
      const { minMs, maxMs } = spanHintForResolution(r);
      assert(minMs <= maxMs, `${r}: minMs > maxMs`);
      assertEquals(resolutionForSpan(minMs), r, `${r}: 下端が別の resolution になる`);
      assertEquals(resolutionForSpan(maxMs), r, `${r}: 上端が別の resolution になる`);
      assert(!isNearResolutionBoundary(minMs) && !isNearResolutionBoundary(maxMs), `${r}: 推奨範囲が境界近傍`);
    }
  },
});

Deno.test({
  name: "オフライン: 日時精度の窓はコロンがバックスラッシュでエスケープされ、日付精度では素のまま",
  fn() {
    const sub = MEASURED.find((m) => m.time === "now 1-d" && m.source === "s1")!;
    // JSON.parse 後の JS 文字列にはバックスラッシュが実体として含まれる
    assert(sub.normalized!.includes("\\:"), "日時精度の窓に \\: が無い");
    assertEquals(sub.normalized!.split("\\:").length - 1, 4, "1 窓あたり 2 個 x 2 = 4 個の \\: が必要");
    // JSON.stringify で往復しても壊れない (= widget.request を透過できる)
    assertEquals(JSON.parse(JSON.stringify({ time: sub.normalized })).time, sub.normalized);
    // JSON 表現上はバックスラッシュ 2 個になる
    assert(JSON.stringify(sub.normalized).includes("\\\\:"));

    const dayRes = MEASURED.find((m) => m.time === "today 12-m")!;
    assert(!dayRes.normalized!.includes("\\"), "日付精度の窓にはエスケープが無いはず");
    assertEquals(dayRes.normalized, "2025-09-08 2026-09-08");

    // パーサが両形式を UTC として解釈できること
    assertEquals(parseWidgetTime(sub.normalized!).hasTime, true);
    assertEquals(parseWidgetTime(dayRes.normalized!).hasTime, false);
    assertEquals(parseWidgetTime(dayRes.normalized!).start.toISOString(), "2025-09-08T00:00:00.000Z");
    assertEquals(parseWidgetTime(sub.normalized!).start.toISOString(), "2026-09-07T19:30:07.000Z");
  },
});

Deno.test({
  name: "オフライン: 時刻付き絶対指定は THH -> THH\\:00\\:00 に正規化される",
  fn() {
    const m = MEASURED.find((x) => x.time === "2026-09-08T04 2026-09-08T18")!;
    assertEquals(m.normalized, "2026-09-08T04\\:00\\:00 2026-09-08T18\\:00\\:00");
    const { start, end } = parseWidgetTime(m.normalized!);
    assertEquals(start.toISOString(), "2026-09-08T04:00:00.000Z");
    assertEquals(end.toISOString(), "2026-09-08T18:00:00.000Z");
    assertEquals(end.getTime() - start.getTime(), 14 * H);
    // 日付のみの絶対指定は verbatim (正規化されない)
    const d = MEASURED.find((x) => x.time === "2024-01-01 2024-03-31")!;
    assertEquals(d.normalized, d.time);
  },
});

Deno.test({
  name: "オフライン: 相対指定の窓長が文法どおり (now N-H / now N-d / today N-m / today N-y)",
  fn() {
    const expect: Record<string, number> = {
      "now 1-H": 1 * H,
      "now 4-H": 4 * H,
      "now 1-d": 24 * H,
      "now 7-d": 7 * D,
      "today 1-m": 31 * D, // 2026-08-08 → 2026-09-08 (暦月なので月により 28〜31 日)
      "today 3-m": 92 * D, // 2026-06-08 → 2026-09-08
      "today 12-m": 365 * D,
      "today 5-y": 1826 * D, // 5 年 (うるう年 2024 を含む)
    };
    for (const m of MEASURED.filter((x) => x.source === "s1" && x.time in expect)) {
      assertEquals(spanOf(m), expect[m.time], `${m.time} の窓長が想定と違う`);
    }
    // "all" はデータ開始日 2004-01-01 に固定される
    const all = MEASURED.find((m) => m.time === "all")!;
    assertEquals(parseWidgetTime(all.normalized!).start.toISOString(), "2004-01-01T00:00:00.000Z");
    // "all_<YYYY>" は <YYYY>-01-01 開始 (HAR 由来)
    const all2008 = MEASURED.find((m) => m.time === "all_2008")!;
    assertEquals(parseWidgetTime(all2008.normalized!).start.toISOString(), "2008-01-01T00:00:00.000Z");
  },
});

Deno.test({
  name: "オフライン: resolution は time だけで決まる (HAR 13 組で category/property/geo/キーワード数と独立)",
  fn() {
    assertEquals(HAR_PAIRS.length, 13);
    // 同じ time なら、他のパラメータが何であれ resolution/backend は同一でなければならない
    const byTime = new Map<string, HarPair[]>();
    for (const p of HAR_PAIRS) {
      byTime.set(p.time, [...(byTime.get(p.time) ?? []), p]);
    }
    assertEquals([...byTime.keys()].sort(), ["all_2008", "now 1-d", "now 4-H"]);
    for (const [time, group] of byTime) {
      const rs = new Set(group.map((g) => g.resolution));
      const bs = new Set(group.map((g) => g.backend));
      assertEquals(rs.size, 1, `time=${time} で resolution が割れている: ${[...rs].join(",")}`);
      assertEquals(bs.size, 1, `time=${time} で backend が割れている: ${[...bs].join(",")}`);
      assertEquals(backendForResolution(group[0].resolution), group[0].backend);
    }
    // now 1-d の 8 件は category 3 種 x property 5 種を跨いでいる (= 独立性の実証力がある)
    const oneDay = byTime.get("now 1-d")!;
    assertEquals(oneDay.length, 8);
    assertEquals(new Set(oneDay.map((p) => p.category)).size, 3, "category が 3 種類あるはず");
    assertEquals(new Set(oneDay.map((p) => p.property)).size, 5, "property が 5 種類あるはず");
    assertEquals(new Set(oneDay.map((p) => p.resolution)), new Set(["EIGHT_MINUTE"]));
    // all_2008 の 4 件は geo (JP / JP-13) とキーワード数 (1 / 2) を跨いでいる
    const all2008 = byTime.get("all_2008")!;
    assertEquals(all2008.length, 4);
    assertEquals(new Set(all2008.map((p) => p.geo)), new Set(["JP", "JP-13"]));
    assertEquals(new Set(all2008.map((p) => p.keywords)), new Set([1, 2]));
    assertEquals(new Set(all2008.map((p) => p.resolution)), new Set(["MONTH"]));
    // 逆に time が違えば resolution も違う (now 1-d=8分 vs now 4-H=MINUTE vs all_2008=MONTH)
    assertEquals(new Set(HAR_PAIRS.map((p) => p.resolution)).size, 3);

    // MEASURED 側の HAR 行と矛盾していないこと
    for (const t of ["now 4-H", "now 1-d", "all_2008"]) {
      const m = MEASURED.find((x) => x.source === "har" && x.time === t)!;
      assertEquals(m.resolution, byTime.get(t)![0].resolution, `${t}: MEASURED と HAR_PAIRS が不一致`);
    }
  },
});

Deno.test({
  name: "オフライン: HAR 実ファイルとの突き合わせ (--allow-read があるときだけ実行)",
  fn() {
    const base = new URL("../.har/extracted/", import.meta.url);
    let sample: string;
    try {
      sample = Deno.readTextFileSync(new URL("trends_api_widgetdata_multiline/00_entry100.txt", base));
    } catch (e) {
      console.warn(`[skip] HAR コーパスを読めない (--allow-read 無し or 未展開): ${e instanceof Error ? e.name : e}`);
      return;
    }
    assert(sample.length > 0);
    for (const p of HAR_PAIRS) {
      const ml = Deno.readTextFileSync(new URL(`trends_api_widgetdata_multiline/${p.multiline}`, base));
      const ex = Deno.readTextFileSync(new URL(`trends_api_explore/${p.explore}`, base));
      // multiline の req に転記どおりの resolution/backend が入っていること
      assert(ml.includes(`"resolution":"${p.resolution}"`), `${p.multiline}: resolution=${p.resolution} が無い`);
      assert(ml.includes(`"backend":"${p.backend}"`), `${p.multiline}: backend=${p.backend} が無い`);
      assert(ml.includes(`"category":${p.category}`), `${p.multiline}: category=${p.category} が無い`);
      assert(ml.includes(`"property":"${p.property}"`), `${p.multiline}: property=${p.property} が無い`);
      // explore の req に転記どおりの time/category/property/geo/キーワード数が入っていること
      const reqLine = ex.split("\n").find((l) => l.startsWith("  req = "))!;
      assert(reqLine, `${p.explore}: 'req = ' 行が無い`);
      const req = JSON.parse(reqLine.slice("  req = ".length));
      assertEquals(req.category, p.category, `${p.explore}: category`);
      assertEquals(req.property, p.property, `${p.explore}: property`);
      assertEquals(req.comparisonItem.length, p.keywords, `${p.explore}: キーワード数`);
      for (const ci of req.comparisonItem) {
        assertEquals(ci.time, p.time, `${p.explore}: time`);
        assertEquals(ci.geo, p.geo, `${p.explore}: geo`);
      }
      // explore は POST、URL 上に tz が 2 回出る (0.5 節の主張)
      const urlLine = ex.split("\n").find((l) => l.startsWith("POST https://") || l.startsWith("GET https://"))!;
      assert(urlLine.startsWith("POST "), `${p.explore}: HAR の explore は POST のはず`);
      assertEquals(urlLine.split("tz=").length - 1, 2, `${p.explore}: URL 上の tz は 2 回出るはず`);
    }
  },
});

Deno.test({
  name: "オフライン: predictCompareTime が実測 18 件を再現し、既知の例外だけ null になる",
  fn() {
    assertEquals(COMPARE_MEASURED.length, 18);
    for (const c of COMPARE_MEASURED) {
      assertEquals(
        predictCompareTime(c.window, c.orig),
        c.compare,
        `${c.orig} (窓 ${c.window}) の compareTime 予測が実測と不一致`,
      );
    }
    // 日時精度は「隙間なし」、日付精度は「1 日の隙間」という差が実際に出ていること
    const dt = COMPARE_MEASURED.find((c) => c.orig === "now 1-H")!;
    const w1 = parseWidgetTime(dt.window), c1 = parseWidgetTime(dt.compare);
    assertEquals(c1.end.getTime(), w1.start.getTime(), "日時精度: compare 終端 == 窓開始 (隙間なし)");
    assertEquals(c1.end.getTime() - c1.start.getTime(), w1.end.getTime() - w1.start.getTime());

    const dd = COMPARE_MEASURED.find((c) => c.orig === "today 3-m")!;
    const w2 = parseWidgetTime(dd.window), c2 = parseWidgetTime(dd.compare);
    assertEquals(w2.start.getTime() - c2.end.getTime(), D, "日付精度: compare 終端 == 窓開始の前日 (1 日の隙間)");
    assertEquals(c2.end.getTime() - c2.start.getTime(), w2.end.getTime() - w2.start.getTime());

    // "all" 系だけは直前窓ではなく「最初の 1 年」。all_2008 が 2004 始まりでないことが決定的。
    const a2008 = COMPARE_MEASURED.find((c) => c.orig === "all_2008")!;
    assertEquals(a2008.compare, "2008-01-01 2009-01-01");
    assert(!a2008.compare.startsWith("2004"), "all_2008 の compare が 2004 始まりなら『クランプ説』になってしまう");
    const aAll = COMPARE_MEASURED.find((c) => c.orig === "all")!;
    assertEquals(aAll.compare, "2004-01-01 2005-01-01");

    // 2004-01-01 クランプ (直前窓が epoch より前へ食い込むケース)
    const clamp = COMPARE_MEASURED.find((c) => c.orig === "2010-01-01 2026-09-09")!;
    assertEquals(clamp.compare, "2004-01-01 2009-12-31");
    assertEquals(parseWidgetTime(clamp.compare).start.getTime(), TRENDS_EPOCH_MS);
    // クランプされているので compare の長さは窓より短い
    const wc = parseWidgetTime(clamp.window), cc = parseWidgetTime(clamp.compare);
    assert(cc.end.getTime() - cc.start.getTime() < wc.end.getTime() - wc.start.getTime());

    // 既知の例外: 窓全体が 2004-01-01 より前 → 規則が当たらないので null を返す
    assertEquals(predictCompareTime(COMPARE_ANOMALY.window, COMPARE_ANOMALY.orig), null);
    assertEquals(COMPARE_ANOMALY.compare, "2004-01-01 2004-02-01");
  },
});

Deno.test({
  name: "オフライン: formatWidgetTime / parseWidgetTime が往復し、stripJsonPrefix が仕様どおり",
  fn() {
    // 窓文字列 → Date → 窓文字列 の往復で情報が落ちないこと (全実測分)
    for (const m of MEASURED) {
      if (!m.normalized) continue;
      const { start, end, hasTime } = parseWidgetTime(m.normalized);
      assertEquals(formatWidgetTime(start.getTime(), end.getTime(), hasTime), m.normalized, `往復失敗: ${m.time}`);
    }
    for (const c of COMPARE_MEASURED) {
      const p = parseWidgetTime(c.compare);
      assertEquals(formatWidgetTime(p.start.getTime(), p.end.getTime(), p.hasTime), c.compare);
    }
    // )]}' プレフィックス
    assertEquals(stripJsonPrefix(")]}'\n{\"widgets\":[]}"), '{"widgets":[]}');
    assertEquals(stripJsonPrefix(")]}'{\"a\":1}"), '{"a":1}'); // 改行が無い形も許容
    assertEquals(JSON.parse(stripJsonPrefix(")]}'\n{\"widgets\":[]}")).widgets, []);
    let threw = false;
    try {
      stripJsonPrefix('{"widgets":[]}');
    } catch (e) {
      threw = e instanceof SyntaxError;
    }
    assert(threw, "プレフィックスが無いボディは SyntaxError にすべき");
  },
});

Deno.test({
  name: "オフライン: formatTimeRange が正しい文法を組み立て、start>=end を拒否する",
  fn() {
    assertEquals(formatTimeRange({ kind: "relative", preset: "now 1-d" }), "now 1-d");
    assertEquals(formatTimeRange({ kind: "allSince", year: 2008 }), "all_2008");
    assertEquals(
      formatTimeRange({
        kind: "absolute",
        start: new Date("2024-01-01T00:00:00Z"),
        end: new Date("2024-03-31T00:00:00Z"),
      }),
      "2024-01-01 2024-03-31",
    );
    assertEquals(
      formatTimeRange({
        kind: "absolute",
        start: new Date("2026-09-08T10:00:00Z"),
        end: new Date("2026-09-09T10:00:00Z"),
        granularity: "hour",
      }),
      "2026-09-08T10 2026-09-09T10",
    );
    // 実測で 400 になった順序反転をローカルで弾く
    let threw = false;
    try {
      formatTimeRange({
        kind: "absolute",
        start: new Date("2024-03-31T00:00:00Z"),
        end: new Date("2024-01-01T00:00:00Z"),
      });
    } catch (e) {
      threw = e instanceof RangeError;
    }
    assert(threw, "start > end は RangeError にすべき (サーバは 400 を返す)");
    assertEquals(SAFE_RELATIVE_RANGES.length, 9);
  },
});

// ---------------------------------------------------------------------------
// ライブテスト
//   使用リクエスト数: 最大 6 (NID 取得 1 + explore 5)
//   429 / ネットワーク断ではハード失敗させず console.warn してスキップする。
//   各ステップの間に 2 秒空ける (7 節のレート制限の実測に基づく)。
// ---------------------------------------------------------------------------

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** req を AngularJS ($http) と同じ流儀でパーセントエンコードする (: と , は素通し、空白は +)。 */
function encodeReq(req: unknown): string {
  return encodeURIComponent(JSON.stringify(req))
    .replace(/%3A/g, ":")
    .replace(/%2C/g, ",")
    .replace(/%20/g, "+");
}

/** NID Cookie を 1 リクエストで取得する。/trends/explore は 429 を返すが Set-Cookie: NID が付く。 */
async function acquireNid(): Promise<string> {
  const res = await fetch(
    "https://trends.google.com/trends/explore?q=coffee&date=now%201-d&geo=US&hl=en",
    {
      headers: { "user-agent": UA, accept: "text/html,*/*", "accept-language": "en-US,en;q=0.9" },
      redirect: "manual",
    },
  );
  const setCookies = res.headers.getSetCookie();
  await res.text(); // 必ず消費する (リソースリーク回避)
  for (const c of setCookies) {
    if (c.startsWith("NID=")) return c.split(";")[0];
  }
  return "";
}

type Widget = { id: string; type: string; token: string; request: Record<string, unknown> };

/** 単一キーワード・property="" の explore が返すウィジェット (0.5 節。実測 17/17)。 */
const EXPECTED_WIDGET_IDS = ["TIMESERIES", "GEO_MAP", "RELATED_TOPICS", "RELATED_QUERIES"];
const EXPECTED_WIDGET_TYPES = [
  "fe_line_chart",
  "fe_geo_chart_explore",
  "fe_related_searches",
  "fe_related_searches",
];
/** TIMESERIES.request のキー集合 (0.5 節。実測)。 */
const EXPECTED_TIMESERIES_REQUEST_KEYS = [
  "time",
  "resolution",
  "locale",
  "comparisonItem",
  "requestOptions",
  "userConfig",
];
type ExploreResult =
  | { ok: true; widgets: Widget[] }
  | { ok: false; status: number; contentType: string; body: string };

async function explore(cookie: string, time: string, tz = "-540"): Promise<ExploreResult> {
  const req = { comparisonItem: [{ keyword: "coffee", geo: "US", time }], category: 0, property: "" };
  const url = `https://trends.google.com/trends/api/explore?hl=en&tz=${tz}&req=${encodeReq(req)}&tz=${tz}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      referer: "https://trends.google.com/trends/explore",
      cookie,
    },
  });
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (res.status === 200 && contentType.includes("json")) {
    // レスポンスは )]}' + 改行 のプレフィックス付き JSON
    assert(body.startsWith(")]}'"), "explore 200 は )]}' で始まるはず");
    const parsed = JSON.parse(body.replace(/^\)\]\}'\n?/, ""));
    return { ok: true, widgets: parsed.widgets };
  }
  return { ok: false, status: res.status, contentType, body };
}

function timeseriesOf(r: { widgets: Widget[] }) {
  const w = r.widgets.find((x) => x.id === "TIMESERIES");
  assert(w, "TIMESERIES ウィジェットが無い");
  return w.request as unknown as {
    time: string;
    resolution: Resolution;
    locale: string;
    comparisonItem: unknown[];
    requestOptions: { backend: string; category: number; property: string };
    userConfig: { userType: string };
  };
}

Deno.test({
  name: "ライブ: 代表 time パターンの正規化と resolution がドキュメントどおり",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let cookie = "";
    try {
      cookie = await acquireNid();
    } catch (e) {
      console.warn(`[skip] NID 取得でネットワークエラー: ${e}`);
      return;
    }
    if (!cookie) {
      console.warn("[skip] Set-Cookie: NID が得られなかった");
      return;
    }
    assert(cookie.startsWith("NID="), "取得した Cookie は NID= で始まるはず");
    await sleep(1500);

    // tz A/B (ステップ 1b) 用に、tz=-540 で観測した窓末端と粒度を持ち回る
    let tz540: { end: number; resolution: Resolution; backend: string } | null = null;

    // (1) now 1-d → 24 時間窓 / EIGHT_MINUTE / CM
    await t.step("now 1-d は 24 時間窓 + EIGHT_MINUTE + CM", async () => {
      let r: ExploreResult;
      try {
        r = await explore(cookie, "now 1-d");
      } catch (e) {
        console.warn(`[skip] ネットワークエラー: ${e}`);
        return;
      }
      if (!r.ok) {
        console.warn(`[skip] explore が ${r.status} (${r.contentType})。レート制限のため未検証`);
        return;
      }
      // 0.5 節の主張: 単一キーワード・property="" の explore は必ずこの 4 件をこの順で返す
      assertEquals(r.widgets.map((w) => w.id), EXPECTED_WIDGET_IDS, "widgets の id 配列が仕様と不一致");
      assertEquals(r.widgets.map((w) => w.type), EXPECTED_WIDGET_TYPES, "widgets の type 配列が仕様と不一致");
      // 各ウィジェットは widgetdata を叩くための token を持つ (空文字ではない)
      for (const w of r.widgets) {
        assert(typeof w.token === "string" && w.token.length > 0, `${w.id} に token が無い`);
      }

      const ts = timeseriesOf(r);
      // TIMESERIES.request のキー集合も 0.5 節の記述どおりであること
      assertEquals(
        Object.keys(ts as unknown as Record<string, unknown>),
        EXPECTED_TIMESERIES_REQUEST_KEYS,
        "TIMESERIES.request のキー集合が仕様と不一致",
      );
      // 0.5 節の落とし穴: hl=en を送っても locale は "en-US" に展開されて返る
      // (hl=ja のときは HAR 13/13 で "ja" のまま)。hl とバイト一致させてはいけない。
      assert(
        /^en(-[A-Z]{2})?$/.test(ts.locale),
        `hl=en に対する locale が想定外: ${ts.locale}`,
      );
      assertEquals(ts.locale, "en-US", "hl=en は locale=en-US へ展開される (hl とは一致しない)");
      assertEquals(ts.userConfig.userType, "USER_TYPE_SCRAPER", "Cookie のみのアクセスは SCRAPER 扱いになる");
      assertEquals(ts.requestOptions.category, 0);
      assertEquals(ts.requestOptions.property, "");
      assertEquals(ts.resolution, "EIGHT_MINUTE");
      assertEquals(ts.requestOptions.backend, "CM");

      // 2 節の注意書き: GEO_MAP.request.resolution は「地理粒度」であって時間粒度ではない。
      // geo が国 (country) なら REGION になり、time を変えても変わらない。
      const gm = r.widgets.find((w) => w.id === "GEO_MAP")!.request as unknown as {
        resolution: string;
        geo: Record<string, string>;
      };
      assertEquals(gm.resolution, "REGION", "国指定の GEO_MAP は REGION (時間粒度と混同しないこと)");
      assertEquals(gm.geo, { country: "US" });
      assert(
        !RESOLUTIONS.includes(gm.resolution as Resolution),
        "GEO_MAP の resolution は時間粒度の値域とは別集合のはず",
      );
      // 日時精度なのでエスケープ済みコロンが 4 個入る
      assertEquals(ts.time.split("\\:").length - 1, 4, `time のエスケープ数が想定外: ${ts.time}`);
      const { start, end, hasTime } = parseWidgetTime(ts.time);
      assert(hasTime);
      assertEquals(end.getTime() - start.getTime(), 24 * H, "now 1-d の窓はちょうど 24 時間");
      // 窓の末端はサーバ現在時刻(UTC)。時計ずれを見込んで 10 分以内で確認する
      assert(
        Math.abs(end.getTime() - Date.now()) < 10 * 60_000,
        `窓末端が現在時刻から離れすぎ: ${end.toISOString()}`,
      );
      assertEquals(resolutionForSpan(end.getTime() - start.getTime()), ts.resolution);
      assertEquals(backendForResolution(ts.resolution), ts.requestOptions.backend);

      // relatedsearches 側には元の time 文字列がそのままエコーされる
      const rq = r.widgets.find((w) => w.id === "RELATED_QUERIES")!.request as unknown as {
        restriction: { originalTimeRangeForExploreUrl: string; time: string };
        trendinessSettings: { compareTime: string };
      };
      assertEquals(rq.restriction.originalTimeRangeForExploreUrl, "now 1-d");
      assertEquals(rq.restriction.time, ts.time);
      // 日時精度の窓では compareTime は「直前の同じ長さの窓」(隙間なし)
      const cmp = parseWidgetTime(rq.trendinessSettings.compareTime);
      assertEquals(cmp.end.getTime(), start.getTime(), "compareTime の終端は窓の開始と一致するはず");
      assertEquals(cmp.end.getTime() - cmp.start.getTime(), 24 * H);
      tz540 = { end: end.getTime(), resolution: ts.resolution, backend: ts.requestOptions.backend };
      await sleep(2000);
    });

    // (1b) 5 節の主張の直接検証: tz を変えても窓は動かない (窓は常に UTC)。
    //      tz=-540 (JST) と tz=0 (UTC) は 9 時間ずれているので、もし tz が窓に効いていれば
    //      窓末端の差は 9 時間になるはず。実際は 2 リクエストの送信間隔しか差が出ない。
    await t.step("tz=-540 と tz=0 で窓が変わらない (窓末端は常に UTC 現在時刻)", async () => {
      if (!tz540) {
        console.warn("[skip] tz=-540 側が取れていないので A/B できない");
        return;
      }
      let r: ExploreResult;
      try {
        r = await explore(cookie, "now 1-d", "0");
      } catch (e) {
        console.warn(`[skip] ネットワークエラー: ${e}`);
        return;
      }
      if (!r.ok) {
        console.warn(`[skip] explore が ${r.status} (${r.contentType})。レート制限のため未検証`);
        return;
      }
      const ts = timeseriesOf(r);
      const { start, end } = parseWidgetTime(ts.time);
      // 窓長・粒度・backend は tz に依らず同一
      assertEquals(end.getTime() - start.getTime(), 24 * H);
      assertEquals(ts.resolution, tz540.resolution, "tz を変えたら resolution が変わってしまった");
      assertEquals(ts.requestOptions.backend, tz540.backend, "tz を変えたら backend が変わってしまった");
      // 窓末端の差は「2 リクエストの間隔」程度で、9 時間ではない
      const delta = Math.abs(end.getTime() - tz540.end);
      assert(
        delta < 5 * 60_000,
        `tz=0 と tz=-540 で窓末端が ${delta} ms ずれた。tz が窓に影響している可能性がある ` +
          `(9 時間 = ${9 * H} ms なら tz がタイムゾーン補正として効いていることになる)`,
      );
      assert(Math.abs(delta - 9 * H) > 60_000, "窓末端の差がちょうど 9 時間 = tz が窓を動かしている");
      // 窓末端はこちらの UTC 現在時刻とほぼ一致する (= サーバ現在時刻 UTC)
      assert(
        Math.abs(end.getTime() - Date.now()) < 10 * 60_000,
        `tz=0 の窓末端が現在時刻(UTC)から離れすぎ: ${end.toISOString()}`,
      );
      await sleep(2000);
    });

    // (2) today 12-m → 1 年窓 / WEEK / IZG / 日付精度 (エスケープ無し)
    await t.step("today 12-m は 1 年窓 + WEEK + IZG + 日付精度", async () => {
      let r: ExploreResult;
      try {
        r = await explore(cookie, "today 12-m");
      } catch (e) {
        console.warn(`[skip] ネットワークエラー: ${e}`);
        return;
      }
      if (!r.ok) {
        console.warn(`[skip] explore が ${r.status} (${r.contentType})。レート制限のため未検証`);
        return;
      }
      const ts = timeseriesOf(r);
      assertEquals(ts.resolution, "WEEK");
      assertEquals(ts.requestOptions.backend, "IZG");
      assert(!ts.time.includes("\\"), `日付精度の窓にエスケープがある: ${ts.time}`);
      assert(/^\d{4}-\d{2}-\d{2} \d{4}-\d{2}-\d{2}$/.test(ts.time), `形式が想定外: ${ts.time}`);
      const { start, end } = parseWidgetTime(ts.time);
      const days = (end.getTime() - start.getTime()) / D;
      assert(days === 365 || days === 366, `1 年窓のはずが ${days} 日`); // うるう年を跨ぐと 366
      // 終端は「今日 (UTC)」。tz を送っていても UTC 基準になる
      assertEquals(end.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
      assertEquals(resolutionForSpan(end.getTime() - start.getTime()), "WEEK");
      assertEquals(backendForResolution(ts.resolution), ts.requestOptions.backend);
      await sleep(2000);
    });

    // (3) 48 時間のカスタム絶対指定 → SIXTEEN_MINUTE (UI では到達できない粒度)
    await t.step("48 時間の絶対指定は SIXTEEN_MINUTE + CM になる", async () => {
      // 直近の「時」境界から 48 時間さかのぼる (終端は過去なので必ず受理される)
      const endD = new Date(Math.floor((Date.now() - 1 * H) / H) * H);
      const startD = new Date(endD.getTime() - 48 * H);
      const time = formatTimeRange({ kind: "absolute", start: startD, end: endD, granularity: "hour" });
      let r: ExploreResult;
      try {
        r = await explore(cookie, time);
      } catch (e) {
        console.warn(`[skip] ネットワークエラー: ${e}`);
        return;
      }
      if (!r.ok) {
        console.warn(`[skip] explore が ${r.status} (${r.contentType})。レート制限のため未検証`);
        return;
      }
      const ts = timeseriesOf(r);
      assertEquals(ts.resolution, "SIXTEEN_MINUTE", `48 時間窓 (${time}) の resolution`);
      assertEquals(ts.requestOptions.backend, "CM");
      // "THH" は "THH\:00\:00" に正規化される
      const p = (n: number) => String(n).padStart(2, "0");
      const expectPart = (x: Date) =>
        `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}T${p(x.getUTCHours())}\\:00\\:00`;
      assertEquals(ts.time, `${expectPart(startD)} ${expectPart(endD)}`);
      const { start, end } = parseWidgetTime(ts.time);
      assertEquals(end.getTime() - start.getTime(), 48 * H);
      assertEquals(resolutionForSpan(48 * H), "SIXTEEN_MINUTE");
      await sleep(2000);
    });

    // (4) 不正な time は 400 (HTML)。429 とは status でしか区別できない。
    await t.step("不正な time 文字列は HTTP 400 (text/html) を返す", async () => {
      let r: ExploreResult;
      try {
        r = await explore(cookie, "garbage");
      } catch (e) {
        console.warn(`[skip] ネットワークエラー: ${e}`);
        return;
      }
      if (r.ok) throw new Error("不正な time なのに 200 が返った (仕様変更の可能性)");
      if (r.status === 429) {
        console.warn("[skip] 429。レート制限のため 400 の検証は未実施");
        return;
      }
      assertEquals(r.status, 400);
      assert(r.contentType.startsWith("text/html"), `400 は text/html で返るはず: ${r.contentType}`);
      assert(
        r.body.includes("Error 400 (Bad Request)"),
        "400 のボディに Error 400 (Bad Request) が含まれるはず",
      );
      // JSON ではないのでプレフィックスは無い
      assert(!r.body.startsWith(")]}'"));
    });
  },
});
