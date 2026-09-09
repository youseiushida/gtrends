/**
 * =====================================================================================
 * Google Trends 旧 REST API: GET /trends/api/widgetdata/multiline
 *   ―― 「人気度の動向 (Interest over time)」= 時系列データ取得エンドポイント 完全仕様
 * =====================================================================================
 *
 * 実行:
 *   deno test --allow-net --no-check live_integration/03_widgetdata_multiline_test.ts
 *
 * ライブ検証日: 2026-09-09 (JST)。
 *
 * 【記述の出所について】本ファイルの記述は 3 系統に分かれる。読む側が信頼度を判断できるよう明記する。
 *   (A) HAR 由来 ― 13 エントリの URL / ヘッダ / content.size から機械的に確定。
 *       offline テストが毎回再検証するので陳腐化したら即座に落ちる。§0 §2 §3 §4 §7(一部) §9。
 *   (B) ライブ実測 ― 2026-09-09 に実際に叩いて得たレスポンス本体の観測。§5 §6 §7 §8。
 *       HAR に本文が無い以上、この系統だけが唯一の根拠になる。
 *   (C) 推測 ― 「推定」「未検証」と明示した箇所のみ。断定していない。
 *   ※ 同日の後刻に再検証を試みたが、共有 IP からの並行アクセスで
 *     GET /trends/api/explore が数分間 100% 429 になり、(B) の再取得はできなかった (§9 参照)。
 *     そのためライブテストは全て skip に倒れる可能性があり、それでも緑になる設計にしてある。
 *     レスポンスが取れたときだけ厳密にアサートする。
 *
 * 1 回のテスト実行が発行するライブ HTTP:
 *   - 全部通った場合 12 回 (NID 1 / explore 4 / multiline 7)
 *   - 429 が続いてブートストラップに失敗した場合 4 回で打ち切り (以降のライブテストは全 skip)
 *   - 429 リトライを含む最悪ケースでも **30 回** を超えない
 *     (LIVE_REQUEST_BUDGET でハード上限。超過分は送信せず skip に倒す)
 *
 * 根拠 HAR: .har/extracted/trends_api_widgetdata_multiline/
 *           00_entry100 〜 12_entry274 (全 13 エントリ / 200 x 12, 429 x 1)。
 *           ※ HAR にはレスポンス**本文**が 1 バイトも残っていない (Chrome は
 *              content-disposition: attachment のボディを HAR に保存しない)。
 *              ただし HAR の `content.size` (非圧縮バイト数) は残っているので、
 *              「空応答 = 51 バイト」「429 = 1,695 バイト」といったサイズ由来の事実は
 *              オフラインで確定できる。本文の中身 (スキーマ) はライブ実測で確定させた。
 *
 * -------------------------------------------------------------------------------------
 * 0. 根拠 HAR 13 エントリの一覧 (オフラインで機械照合できる事実。下の offline テストが検証する)
 * -------------------------------------------------------------------------------------
 * | # | entry | property | resolution   | time (窓)                        | status | size   |
 * |---|-------|----------|--------------|----------------------------------|--------|--------|
 * | 00| 100   | ""       | EIGHT_MINUTE | 2026-09-07T14:53:39 +24h         | 200    | 27,793 |
 * | 01| 118   | ""       | EIGHT_MINUTE | 〃 (+3s)                          | 200    | 27,649 |
 * | 02| 134   | ""       | EIGHT_MINUTE | 〃 (+10s)                         | 200    | 27,617 |
 * | 03| 151   | images   | EIGHT_MINUTE | 〃 (+21s)                         | 200    | **51** |
 * | 04| 163   | news     | EIGHT_MINUTE | 〃 (+23s)                         | 200    | **51** |
 * | 05| 176   | images   | EIGHT_MINUTE | 〃 (+27s)                         | 200    | 27,613 |
 * | 06| 191   | froogle  | EIGHT_MINUTE | 〃 (+30s)                         | 200    | 27,613 |
 * | 07| 205   | youtube  | EIGHT_MINUTE | 〃 (+32s)                         | 200    | **51** |
 * | 08| 219   | youtube  | MINUTE       | 2026-09-08T10:54:16 +4h          | 200    | **51** |
 * | 09| 231   | youtube  | MONTH        | 2008-01-01 2026-09-08            | 200    | 32,136 |
 * | 10| 246   | youtube  | MONTH        | 〃 (geo は {"region":"JP-13"})     | **429**| 1,695  |
 * | 11| 259   | youtube  | MONTH        | 〃                                | 200    | 32,136 |
 * | 12| 274   | youtube  | MONTH        | 〃 / **comparisonItem 2 件**      | 200    | 34,854 |
 *
 * この 13 件から読み取れること (全て本ファイルの offline テストでアサートしている):
 * - now 系 (1-d / 4-H) は backend="CM"、all_2008 は backend="IZG"。
 * - now 1-d -> EIGHT_MINUTE、now 4-H -> **MINUTE**、all_2008 -> MONTH。
 * - property は "" / images / news / froogle / youtube の 5 種が実在する。
 * - category は 0 とは限らない (HAR は cat=41 のページなので全件 category=41)。
 * - geo は {"country":"JP"} と {"region":"JP-13"} の 2 形がある。
 * - ★ #03 と #05 は **time の 6 秒差以外 req が完全に同一** なのに、
 *   #03 は 51 バイト (空) で #05 は 27,613 バイト (データ有り)。 -> §9 の「空応答」参照。
 *
 * -------------------------------------------------------------------------------------
 * 1. エンドポイントと呼び出しフロー
 * -------------------------------------------------------------------------------------
 * multiline は単体では呼べない。必ず以下の 3 段フローになる。
 *
 *   [1] NID Cookie の取得 (2 通り。どちらでも [2] に使える)
 *       (a) GET https://trends.google.com/trending?geo=<geo>&hl=<hl>
 *           -> status **200** / text/html、Set-Cookie: NID=... (2026-09-09 実測、値は 212 文字)。
 *              エラーを踏まないぶんこちらのほうが穏当。**推奨。**
 *       (b) GET https://trends.google.com/trends/explore?q=<kw>&geo=<geo>&hl=<hl>
 *           -> status **429** (本文は約 1.7KB のエラー HTML) だが Set-Cookie: NID=... は付く
 *              (2026-09-09 実測、値は 318 文字)。429 でも Cookie は取れるので失敗ではない。
 *       Cookie 無しで [2] を呼ぶと 429 になるので、どちらかは必ず必要。
 *       ※ Set-Cookie が複数返る実装差に備え、Deno では `headers.getSetCookie()` (配列) を使うこと。
 *          `headers.get("set-cookie")` はカンマ結合された 1 本の文字列になる。
 *
 *   [2] ウィジェット定義 + token の取得
 *       GET https://trends.google.com/trends/api/explore?hl=<hl>&tz=<tz>&req=<JSON>&tz=<tz>
 *       Cookie: NID=<[1]の値>
 *       -> 200 / application/json。レスポンスの widgets[] から id==="TIMESERIES" を選ぶ。
 *          その要素の .request (オブジェクト) と .token (44文字) を [3] に渡す。
 *
 *   [3] 時系列データ本体
 *       GET https://trends.google.com/trends/api/widgetdata/multiline
 *             ?hl=<hl>&tz=<tz>&req=<JSON.stringify(widget.request)>&token=<widget.token>&tz=<tz>
 *       -> 200 / application/json。
 *       ★ [3] は Cookie が一切不要 (実測: NID 無し・ヘッダのみで 200)。token が認証の役割を担う。
 *
 * -------------------------------------------------------------------------------------
 * 2. multiline のクエリパラメータ
 * -------------------------------------------------------------------------------------
 * | 名前  | 必須 | 型     | 意味                                                            |
 * |-------|------|--------|-----------------------------------------------------------------|
 * | hl    | 任意 | string | 表示言語。formattedTime / formattedAxisTime / formattedValue の  |
 * |       |      |        | 言語と書式を決める。req.locale とは独立で、こちらが優先される。  |
 * |       |      |        | (実測: req.locale="ja" のまま hl=en -> 出力は英語になった)       |
 * | tz    | 任意 | int    | 分単位のタイムゾーンオフセット。**JS の Date#getTimezoneOffset** |
 * |       |      |        | と同じ符号規約 (JST=UTC+9 -> -540, UTC -> 0, EDT=UTC-4 -> 240)。 |
 * |       |      |        | formattedTime/formattedAxisTime の表示時刻のみに効く。           |
 * |       |      |        | time (epoch) と value は tz を変えても不変。                     |
 * | req   | 必須 | JSON   | explore が返した widgets[i].request を JSON.stringify したもの。 |
 * | token | 必須 | string | explore が返した widgets[i].token (44文字 base64url)。           |
 *
 * ★ ブラウザは tz を 2 回付ける (`hl&tz&req&token&tz`, 両方 -540)。HAR 13/13 でこの形。
 *   ただし tz を 1 回だけにしても 200 が返る (実測)。Angular の interceptor による二重付与。
 *
 * ★ req のパーセントエンコード (ブラウザの実際の形):
 *     { } [ ] " \ はエンコードされる ( \ は %5C )
 *     : と , は **エンコードされない**
 *     半角スペースは **`+`**
 *   実装: encodeURIComponent(json).replace(/%3A/g,":").replace(/%2C/g,",").replace(/%20/g,"+")
 *   なお素の encodeURIComponent (: , も %エンコード、空白は %20) でも受理される見込みだが、
 *   本テストではブラウザ互換形のみを実測している (推測なので断定しない)。
 *
 * -------------------------------------------------------------------------------------
 * 3. req (= widget.request) のスキーマ  ※ TIMESERIES ウィジェット専用の形
 * -------------------------------------------------------------------------------------
 *   {
 *     "time": "2026-09-07T15\\:49\\:55 2026-09-08T15\\:49\\:55",   // <- JSON テキスト上の表記
 *     "resolution": "EIGHT_MINUTE",
 *     "locale": "ja",
 *     "comparisonItem": [
 *       { "geo": { "country": "JP" },                    // または { "region": "JP-13" }
 *         "complexKeywordsRestriction": {
 *           "keyword": [ { "type": "BROAD", "value": "iPhone" } ] } }
 *     ],
 *     "requestOptions": { "property": "", "backend": "CM", "category": 0 },
 *     "userConfig": { "userType": "USER_TYPE_SCRAPER" }
 *   }
 *
 * - キーはこの 6 個で全て (ライブ 7 パターン + HAR 13 件の和集合)。
 * - time は「開始 <半角スペース> 終了」。1 日未満のレンジでは秒精度の
 *   `YYYY-MM-DDTHH\:MM\:SS` 形式で、**コロンの前にバックスラッシュが 1 個入る**
 *   (JS 文字列としては `2026-09-07T15\:49\:55`、JSON テキストでは `\\:`、URL 上は `%5C%5C:`)。
 *   1 日以上のレンジでは `YYYY-MM-DD` でエスケープ無し。時刻は **UTC**。
 *   tz=-540 を送っていても窓は UTC で算出される。
 * - userConfig.userType は常に "USER_TYPE_SCRAPER"。Cookie 有りの正規ブラウザでも同値なので
 *   「スクレイパー判定された」という意味ではない (Trends が全一般ユーザに付ける固定値)。
 * - requestOptions.backend: "CM" = リアルタイム系 (now ...)、"IZG" = 非リアルタイム系 (today ..., all)。
 *   (HAR で CM x 9 / IZG x 4 を確認。now 1-d と now 4-H が CM、all_2008 が IZG)
 * - requestOptions.property: "" (ウェブ検索) / "images" / "news" / "froogle" (ショッピング) / "youtube"。
 *   5 種すべて HAR に実在する。
 * - requestOptions.category は **0 とは限らない**。explore に渡した cat がそのまま入る
 *   (HAR は cat=41 のページなので 13 件すべて category=41)。
 * - comparisonItem[].geo は国なら `{"country":"JP"}`、地方なら `{"region":"JP-13"}` (HAR #10)。
 *   (世界全体 geo="" のときの形は本調査では未観測。断定しない)
 * - ★★ req は 1 バイトでも書き換えてはならない。token は req 全体に対する署名であり、
 *   resolution を 1 語変えただけでも、keyword を変えただけでも **HTTP 401** になる (実測)。
 *   -> 期間や解像度を変えたければ explore からやり直して新しい token を取る必要がある。
 *
 * -------------------------------------------------------------------------------------
 * 4. token の構造 (ローカルで期限判定が可能)
 * -------------------------------------------------------------------------------------
 * - 常に 44 文字、charset は [A-Za-z0-9_-] (base64url、パディング無し)、先頭は "ANI_2wMAAAAA"。
 * - base64url デコードすると **33 バイト固定**:
 *     bytes[0..8]   9B  定数ヘッダ 00 d2 3f db 03 00 00 00 00
 *     bytes[9..12]  4B  ビッグエンディアン uint32 = **有効期限の UNIX 秒 (発行時刻 + 24h)**
 *     bytes[13..32] 20B ウィジェット固有の署名 (HMAC-SHA1 相当と推定 ― これは推測)
 * - ★ この構造は本グループの HAR **13 エントリすべての token をデコードして確認済み**:
 *   13/13 が 44 文字 / 33 バイト / 同一の定数ヘッダで、
 *   bytes[9..12] − リクエストの startedDateTime が **きっかり 24.000 時間**だった。
 *   (例: 2026-09-08T14:53:39Z のリクエスト -> 期限 2026-09-09T14:53:39Z)
 *   token 本体は署名付きクレデンシャルなので本ファイルには **一切埋め込まない**。
 *   オフラインテストは仕様どおりの合成 token を組み立てて検証している。
 * - 同一 explore レスポンス内でもウィジェットごとに token は別。
 * - **token は使い回せる**。同じ token + 同じ req で連続 2 回叩いても 200 で同一内容が返る (実測)。
 * - 期限切れ / 改竄 / 別ウィジェットの token -> **401 Bad Request**
 *   (content-type: text/html, 本文 1,691 バイト)。
 * - 「24 時間後まで実際に使えるか」は日をまたいだ検証をしていないため未確認 (期限フィールドの値のみ実測)。
 *
 * -------------------------------------------------------------------------------------
 * 5. レスポンス形式  ★ プレフィクスが explore と違うので注意
 * -------------------------------------------------------------------------------------
 * - status 200 / `content-type: application/json; charset=UTF-8`
 *   / `content-disposition: attachment; filename="json.txt"` / `cache-control: private, max-age=0`
 * - 本文の先頭は **`)]}',\n` (6 バイト。カンマ入り)**。
 *   ※ /trends/api/explore は `)]}'\n` (5 バイト、カンマ無し) なので **両者で違う**。
 *     実装は「先頭が `)]}'` なら最初の LF までを捨てる」で両対応させること。
 * - 本文の末尾に改行は **付かない** (最後の文字は `}`)。
 * - 本体 JSON:
 *     {
 *       "default": {
 *         "timelineData": [ <point>, ... ],
 *         "averages": [ <int>, ... ]
 *       }
 *     }
 *   トップレベルのキーは "default" ただ 1 つ。default のキーは timelineData と averages ただ 2 つ。
 *
 * - <point> のスキーマ (N = req.comparisonItem.length = 比較キーワード数):
 *     {
 *       "time":              "1788795840",       // string。**UNIX 秒の 10 進文字列** (数値ではない)
 *       "formattedTime":     "2026/09/08 0:44",  // string。hl と tz を適用した表示用文字列
 *       "formattedAxisTime": "9月8日 0:44",       // string。軸ラベル用の短い表示
 *       "value":             [83],               // number[N]。**0〜100 の整数**
 *       "hasData":           [true],             // boolean[N]
 *       "formattedValue":    ["83"],             // string[N]。hl でローカライズされた表示文字列
 *       "isPartial":         true,               // boolean。**最後の 1 点にのみ付く。任意プロパティ**
 *       "axisNote":          { "text": "..." }   // 任意。方法論変更の注記が入る点にのみ付く
 *     }
 *   ※ 観測されたフィールドはこの 8 個で全て (ライブ 7 レスポンス / 合計 1,000 点超を全走査)。
 *
 *   * time は UTC epoch 秒。バケットの **開始時刻**。MONTH 以外は等間隔 (下表の step)。
 *   * formattedTime = time を (-tz) 分ずらして書式化したもの。
 *     実測: time=1788795840 (=2026-09-07T15:44Z) に対し
 *       tz=-540 hl=ja -> "2026/09/08 0:44"           (+9h)
 *       tz=0    hl=en -> "Sep 7, 2026 at 3:44 PM"    (+-0)
 *       tz=240  hl=ja -> "2026/09/07 11:44"          (-4h)
 *     value / hasData / time は tz を変えても完全に不変。
 *     ★ hl=en の formattedTime は AM/PM の直前が **U+202F (narrow no-break space)** であり
 *       通常の半角スペースではない。`"3:44 PM"` のような素朴な文字列一致は失敗する。
 *       (2026-09-09 実測。ICU の新しい日時書式に由来)
 *   * value は「そのレンジ内の全系列の最大値を 100 とする相対値」。
 *     複数キーワードでも **系列ごとではなく全系列を通した最大が 100**
 *     (実測: iPhone/Android で max(value[0])=100, max(value[1])=36)。
 *   * value[i] の並びは req.comparisonItem[i] の順と一致する。
 *   * hasData[i]=false の点は value[i]=0 / formattedValue[i]="0"。
 *     **hasData=true でも value=0 になることがある** (0 < 実値 < 1 の場合)。そのとき
 *     formattedValue は "1 未満" (ja) / "<1" (en) のようなローカライズ文字列になる。
 *     -> 数値が欲しいなら必ず value を使い、formattedValue を parseInt しないこと。
 *   * axisNote は Google 側の計測方法変更の注記。実測例 (hl=ja):
 *       2011-01: 「Google の地域区分の変更は、2011 年 1 月 1 日に適用されました。」
 *       2016-01 / 2022-01: 「Google のデータ収集システムへの変更は、…から適用されました。」
 *     この点をまたぐ比較は不連続になりうる。
 *
 * - averages (int[N]):
 *   * comparisonItem が **1 件のときは常に空配列 `[]`** (実測 6/6 レンジ)。
 *     ウィジェット定義の `showAverages` が false であることと対応する。
 *     **`showAverages === (averages.length > 0)`** という連動関係が成り立つ
 *     (本ファイルの単一/複数キーワード両テストでこの不変条件をアサートしている)。
 *   * 2 件以上のとき各系列の平均が入る。**hasData=false の点も 0 として含めた
 *     全 timelineData の value[i] の算術平均を四捨五入した整数**。
 *     実測 (iPhone/Android, date=all, 273 点): 40.919 -> 41、10.993 -> 11 で averages=[41,11] と一致。
 *     (hasData=true の点だけの平均は 45.60 / 12.10 で一致しない ―「全点平均」で確定)
 *     本ファイルのライブテストは、覚え書きの数値ではなく **その場で返ってきた timelineData から
 *     computeAverages() を計算して averages と突き合わせる** ので、毎回この式を再検証している。
 *
 * -------------------------------------------------------------------------------------
 * 6. isPartial の出現条件 (実測)
 * -------------------------------------------------------------------------------------
 * - 観測した 7 レスポンス全てで **timelineData の最後の 1 点にだけ** `isPartial: true` が付いた。
 *   他の点には isPartial プロパティ自体が存在しない (false ではなく未定義)。
 * - 意味: 最終バケットが未完了 (集計途中) で、値が後から動く。グラフでは点線にする用途。
 *   確定値だけ欲しいなら最後の点を捨てる。
 * - 全レンジ (MINUTE 〜 MONTH) で発生した。date=all でも最後の月に付いた。
 *
 * -------------------------------------------------------------------------------------
 * 7. explore の date 指定 -> resolution / バケット幅 の対応表 (2026-09-09 ライブ実測)
 * -------------------------------------------------------------------------------------
 * キーワード "iPhone"、geo=JP、category=0、property="" で実測。
 *
 * | explore の date | widget.request.resolution | backend | req.time の書式  | step     | 点数 | 根拠 |
 * |-----------------|---------------------------|---------|------------------|----------|------|------|
 * | now 1-H         | MINUTE                    | CM      | 秒精度 (`\:` 有) | 60 s     | 58   | live |
 * | now 4-H         | MINUTE                    | CM      | 秒精度           | 60 s (*) | ―    | HAR#08|
 * | now 1-d         | EIGHT_MINUTE              | CM      | 秒精度           | 480 s    | 181  | live+HAR#00|
 * | now 7-d         | HOUR                      | CM      | 秒精度           | 3600 s   | 169  | live |
 * | today 1-m       | DAY                       | IZG     | `YYYY-MM-DD`     | 86400 s  | 32   | live |
 * | today 12-m      | WEEK                      | IZG     | `YYYY-MM-DD`     | 604800 s | 53   | live |
 * | today 5-y       | WEEK                      | IZG     | `YYYY-MM-DD`     | 604800 s | 262  | live |
 * | all             | MONTH                     | IZG     | `YYYY-MM-DD`     | 可変(月) | 273  | live |
 * | all_2008        | MONTH                     | IZG     | `YYYY-MM-DD`     | 可変(月) | ―    | HAR#09|
 *
 * (*) now 4-H は HAR #08 で resolution=MINUTE / 窓がちょうど 4 時間であることを確認済みだが、
 *     その応答は 51 バイトの空応答だったため step の実測値は無い (MINUTE からの推定)。
 * 「点数」は取得タイミング依存の参考値。**期間の長さから点数を計算で決め打ちしないこと。**
 * 本ファイルのライブテストは now 1-d / today 12-m / all の 3 パターンを毎回実測して
 * resolution・backend・time 書式・step を照合する (レート制限予算に収まる範囲で最低 3 パターン)。
 *
 * - **today 5-y は MONTH ではなく WEEK**。MONTH になるのは date=all / all_2008 だけ (実測)。
 * - MONTH のときだけ step が一定でない (28〜31 日)。等間隔チェックを掛けてはいけない。
 * - `now 1-H` は 60 点ではなく 58 点だった。**期間の長さから点数を計算で決め打ちしないこと。**
 * - date="all" の窓は `2004-01-01 <today>`、date="all_2008" は `2008-01-01 <today>`。
 * - WEEK の formattedTime は範囲表現になる ("2025年9月7日～13日")。
 *   formattedAxisTime は開始日だけ ("2025/09/07")。
 * - MONTH の formattedTime は "1月 2011" のような月表記、formattedAxisTime は "2011/01/01"。
 * - MINUTE / EIGHT_MINUTE / HOUR は「バケット開始の epoch」がそのまま並ぶ。開始位置は
 *   リクエスト時刻に依存して端数が付く (例: 15:44 開始)。
 *
 * -------------------------------------------------------------------------------------
 * 8. 複数キーワード比較 (実測: q=iPhone,Android / date=all / geo=JP)
 * -------------------------------------------------------------------------------------
 * - explore が返す widgets[].id は
 *     ["TIMESERIES","GEO_MAP","TITLE_0","GEO_MAP_0","RELATED_QUERIES_0",
 *      "TITLE_1","GEO_MAP_1","RELATED_QUERIES_1"]
 *   TIMESERIES は 1 つだけで、その request.comparisonItem に N 件が入る。
 *   RELATED_TOPICS は複数キーワード時には返らない (単一キーワード時は返る)。
 * - multiline のレスポンスは value/hasData/formattedValue が長さ N の配列になるだけで
 *   構造は変わらない。averages が長さ N で埋まる。
 * - 単一キーワード時の widgets は ["TIMESERIES","GEO_MAP","RELATED_TOPICS","RELATED_QUERIES"]。
 * - **value[i] の並びは req.comparisonItem[i] の並び** = explore に渡したキーワードの並び。
 *   widget.bullets[i].text も同じ並びで、系列と 1 対 1 に対応する。
 * - ★ 正規化は **系列ごとではない**。「全系列・全時点を通した最大値」が 100 になり、
 *   他系列はその相対値。したがって max(value[k]) が 100 になる系列はちょうど 1 本だけ。
 *   (本ファイルのライブテストは perSeriesMax を計算し、100 が 1 本だけであることを確認する)
 * - HAR にも複数キーワードの実例がある: #12 (Fanza,DLsite / all_2008 / youtube)。
 *   同条件の単一キーワード #11 が 32,136 バイトなのに対し #12 は 34,854 バイトで、
 *   配列 3 本が 1 系列ぶん伸びたことと整合する。
 *
 * -------------------------------------------------------------------------------------
 * 9. エラー挙動 / 既知の落とし穴
 * -------------------------------------------------------------------------------------
 * - **401 Bad Request**: token が req と一致しない / 期限切れ / 他ウィジェットの token。
 *   `content-type: text/html; charset=utf-8`、本文 1,691 バイトの Google 標準エラーページ。
 *   JSON ではないので JSON.parse すると壊れる。content-disposition は付かない。
 * - **429 Too Many Requests**: レート制限。`content-type: text/html; charset=utf-8`、本文 1,695 バイト
 *   (HAR #10 で実測)。**Retry-After ヘッダは付かない** (2026-09-09 ライブでも確認)。
 *   content-disposition も x-frame-options も付かない。
 *   HAR では正規ブラウザセッション (Cookie も reCAPTCHA トークンも完備) でも 1 件発生しており、
 *   同時並列に投げた他の 3 本は 200 だった -> セッション単位の恒久ブロックではなく
 *   **リクエスト単位の確率的スロットリング** の側面がある。
 *   ★ ただし 2026-09-09 の再検証では、同一グローバル IP から複数プロセスが並行アクセスした結果
 *     **GET /trends/api/explore が数分間にわたり 100% 429** になった (NID あり / 2s・15s・30s の
 *     バックオフ 3 回すべて 429、/trending は同時刻に 200 で通る)。
 *     つまり 429 は **エンドポイント単位 + 送信元 IP 単位** でも掛かる。数秒のバックオフでは
 *     抜けられないことがあるので、ラッパー実装は「数分〜数十分の冷却」も想定すること。
 *     この状態でも [1] の NID 取得と [3] の multiline (token 済み) は通ることがある。
 * - 成功判定は `status === 200 && content-type が application/json で始まる` を推奨。
 *   status だけ、あるいは res.ok だけでは不十分 (401/429 は必ず text/html)。
 * - **空応答 (51 バイト)**: データが 1 件も無い場合も 200 / application/json で
 *   `)]}',\n{"default":{"timelineData":[],"averages":[]}}` (前置 6 バイト込みで全 51 バイト)
 *   を返す。JSON としては正常応答であり、429 (text/html) とは明確に別物。
 *   ★★ **これは「そのプロパティに本当にデータが無い」とは限らない。**
 *   HAR #03 (property=images) は 51 バイトだが、その 6 秒後の #05 は
 *   **time の 6 秒差以外まったく同じ req** で 27,613 バイトのデータを返している。
 *   つまり空応答は **同一条件でも揺れる一時的なソフト失敗** でありうる。
 *   -> ラッパー実装は「200 かつ timelineData.length === 0」を最終結果と決めつけず、
 *      少なくとも 1 回は (新しい token を取り直して) 再試行し、
 *      それでも空なら初めて「データ無し」と判定するのが安全。
 *   -> 本ファイルのライブテストも、空応答を assertion failure にせず warn + skip 扱いにしている。
 *   HAR で 51 バイトが出たのは #03(images/now 1-d) #04(news/now 1-d) #07(youtube/now 1-d)
 *   #08(youtube/now 4-H) の 4 件。一方 #05(images) #06(froogle) は同じ now 1-d で非空。
 *   **property から空/非空は決まらない。**
 * - レスポンスは gzip で返るが fetch が自動展開する。
 * - Deno のテストでは未消費のレスポンスボディがリソースリーク扱いになるので
 *   必ず res.text() するか res.body?.cancel() すること。
 *
 * -------------------------------------------------------------------------------------
 * 10. 推奨リクエストヘッダ
 * -------------------------------------------------------------------------------------
 *   accept: application/json, text/plain, *\/*
 *   accept-language: <hl と揃える>
 *   user-agent: <普通の Chrome UA>
 *   referer: https://trends.google.com/trends/explore
 *   cookie: NID=<...>            <- /trends/api/explore にのみ必要。multiline には不要
 * 送らないほうがよいもの: x-browser-validation / x-browser-year / x-browser-channel /
 *   x-browser-copyright (Chrome 内部の定数)、sec-ch-ua-* (フィンガープリント材料)、
 *   __utm* / _ga* Cookie (GA の遺物でサーバは使わない)。
 * reCAPTCHA Enterprise トークンは **不要**。HAR ではブラウザが POST /trends/api/explore の
 *   ボディに載せていたが、GET + NID Cookie だけで 200 が返る。
 *
 * -------------------------------------------------------------------------------------
 * 11. 最小実装スケッチ (これをそのまま写せば動く)
 * -------------------------------------------------------------------------------------
 *   // (1) NID
 *   const r0 = await fetch("https://trends.google.com/trending?geo=JP&hl=ja", {redirect:"manual"});
 *   await r0.text();                                   // ボディは必ず消費する
 *   const nid = r0.headers.getSetCookie().join(";").match(/NID=([^;,\s]+)/)?.[1];
 *
 *   // (2) explore -> widget.request と widget.token
 *   const enc = (j) => encodeURIComponent(j)
 *       .replace(/%3A/g,":").replace(/%2C/g,",").replace(/%20/g,"+");
 *   const exReq = JSON.stringify({
 *     comparisonItem:[{keyword:"iPhone", geo:"JP", time:"now 1-d"}], category:0, property:"" });
 *   const ex = await fetch(
 *     `https://trends.google.com/trends/api/explore?hl=ja&tz=-540&req=${enc(exReq)}&tz=-540`,
 *     { headers: { cookie:`NID=${nid}`, "accept":"application/json, text/plain, *\/*" } });
 *   const strip = (s) => s.startsWith(")]}'") ? s.slice(s.indexOf("\n")+1) : s;  // 5B/6B 両対応
 *   const w = JSON.parse(strip(await ex.text())).widgets.find((x) => x.id === "TIMESERIES");
 *
 *   // (3) multiline (Cookie 不要)
 *   const ml = await fetch(
 *     "https://trends.google.com/trends/api/widgetdata/multiline" +
 *     `?hl=ja&tz=-540&req=${enc(JSON.stringify(w.request))}` +
 *     `&token=${encodeURIComponent(w.token)}&tz=-540`,
 *     { headers: { "accept":"application/json, text/plain, *\/*" } });
 *   if (ml.status !== 200 || !ml.headers.get("content-type")?.startsWith("application/json")) {
 *     await ml.body?.cancel(); throw new Error(`multiline failed: ${ml.status}`); // 401/429 は text/html
 *   }
 *   const series = JSON.parse(strip(await ml.text())).default.timelineData;
 *
 * 実装時の注意 (詳細は各節):
 *   a. w.request は 1 バイトも書き換えない (§3)。期間や解像度を変えるなら (2) からやり直す。
 *   b. 成功判定は status だけでなく content-type も見る (§9)。res.ok では不十分。
 *   c. timelineData が空でも 200 が返る。1 回は再試行してから「データ無し」と判定する (§9)。
 *   d. 最後の 1 点は isPartial (未確定)。確定値だけ欲しければ捨てる (§6)。
 *   e. 数値は value を使う。formattedValue は "1 未満" などのローカライズ文字列になりうる (§5)。
 *   f. w.token は 24 時間有効。使い回してよい (§4)。
 *
 * =====================================================================================
 */

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@^1";

// ------------------------------------------------------------------------------------
// 定数
// ------------------------------------------------------------------------------------
const ORIGIN = "https://trends.google.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const HL = "ja";
const TZ = -540; // JST。JS の getTimezoneOffset 規約
const KEYWORD = "iPhone";
const GEO = "JP";
const DATE = "now 1-d"; // -> resolution EIGHT_MINUTE / 480 秒バケット

/**
 * 解像度 -> バケット幅(秒)。MONTH は 28〜31 日で可変なので null。
 * MINUTE / EIGHT_MINUTE / HOUR / DAY / WEEK / MONTH は実測済み。
 * SIXTEEN_MINUTE は Trends の他 UI で使われる値で、本調査では未観測 (値は推定)。
 */
const STEP_SECONDS: Record<string, number | null> = {
  MINUTE: 60,
  EIGHT_MINUTE: 480,
  SIXTEEN_MINUTE: 960,
  HOUR: 3600,
  DAY: 86400,
  WEEK: 604800,
  MONTH: null,
};

/**
 * レスポンスヘッダの実測値。HAR 13 エントリ (200 x 12 / 429 x 1) から採った定数で、
 * オフラインの HAR 照合テストとライブテストの両方がこれを唯一の正とする。
 */
const RESPONSE_HEADERS = {
  /** 成功時 (HAR 12/12 で同一) */
  ok: {
    contentType: "application/json; charset=UTF-8",
    contentDisposition: 'attachment; filename="json.txt"',
    cacheControl: "private, max-age=0",
  },
  /** 429 時 (HAR #10)。content-disposition も Retry-After も付かない。 */
  rateLimited: {
    contentType: "text/html; charset=utf-8",
    contentDisposition: "",
    retryAfter: "",
    bodyBytes: 1695,
  },
} as const;

/** 空応答 (timelineData が 0 件) の本文と、その全長 (前置 6 バイト込み)。 */
const EMPTY_RESPONSE_BODY = ")]}',\n" + '{"default":{"timelineData":[],"averages":[]}}';
const EMPTY_RESPONSE_BYTES = 51;

// ------------------------------------------------------------------------------------
// 型 (仕様の TypeScript 表現。ラッパー実装者はこれをそのまま使える)
// ------------------------------------------------------------------------------------
interface TimelinePoint {
  time: string; // UNIX 秒の 10 進文字列
  formattedTime: string;
  formattedAxisTime: string;
  value: number[]; // 0..100
  hasData: boolean[];
  formattedValue: string[];
  isPartial?: boolean; // 最終点のみ
  axisNote?: { text: string };
}
interface MultilineResponse {
  default: { timelineData: TimelinePoint[]; averages: number[] };
}
interface TimeseriesRequest {
  time: string;
  resolution: string;
  locale: string;
  comparisonItem: Array<{
    geo: Record<string, string>;
    complexKeywordsRestriction: { keyword: Array<{ type: string; value: string }> };
  }>;
  requestOptions: { property: string; backend: string; category: number };
  userConfig: { userType: string };
}
interface TimeseriesWidget {
  id: string;
  type: string;
  title: string;
  template: string;
  embedTemplate: string;
  version: string;
  isLong: boolean;
  isCurated: boolean;
  showLegend: boolean;
  showAverages: boolean;
  token: string;
  request: TimeseriesRequest;
  bullets: { text: string }[];
  lineAnnotationText: string;
  helpDialog: { title: string; content: string };
}

// ------------------------------------------------------------------------------------
// 小さなユーティリティ (全て純関数。外部ファイル依存なし)
// ------------------------------------------------------------------------------------

/** ブラウザ互換の req エンコード: `:` `,` は生のまま、空白は `+`。 */
function encodeReq(json: string): string {
  return encodeURIComponent(json)
    .replace(/%3A/g, ":")
    .replace(/%2C/g, ",")
    .replace(/%20/g, "+");
}

/**
 * `)]}'\n` (explore, 5B) / `)]}',\n` (widgetdata, 6B) の両方を剥がす。
 * 「先頭が )]}' なら最初の LF までを捨てる」で統一的に扱える。
 */
function stripAntiHijackPrefix(body: string): string {
  if (!body.startsWith(")]}'")) return body;
  const nl = body.indexOf("\n");
  if (nl < 0) throw new Error("anti-hijack prefix without newline");
  return body.slice(nl + 1);
}

/** base64url (パディング無し) -> Uint8Array */
function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** widget token をデコードして有効期限 (UNIX 秒) を返す。33 バイトでなければ null。 */
function tokenExpiryUnixSeconds(token: string): number | null {
  const b = b64urlDecode(token);
  if (b.length !== 33) return null;
  return b[9] * 0x1000000 + b[10] * 0x10000 + b[11] * 0x100 + b[12];
}

/**
 * averages の算出モデル:
 * 「hasData=false の点も value=0 として**分母に数え**、全点の算術平均を四捨五入」。
 * オフラインのモデルテストと、ライブ実データとの照合の両方で使う。
 */
function computeAverages(points: TimelinePoint[], seriesCount: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < seriesCount; k++) {
    let sum = 0;
    for (const p of points) sum += p.value[k];
    out.push(Math.round(sum / points.length));
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Fetched {
  status: number;
  contentType: string;
  contentDisposition: string;
  setCookie: string;
  retryAfter?: string;
  body: string;
}

/**
 * 1 回のテスト実行が発行してよいライブ HTTP の総数。
 * 共有 IP から複数プロセスが同時に叩く前提なので、超えたら黙って打ち切って skip に倒す。
 * (超過時は status=0 の合成レスポンスを返し、呼び出し側の isJson()==false 経路に流す)
 */
const LIVE_REQUEST_BUDGET = 30;
let liveRequestCount = 0;
let budgetExhaustedWarned = false;

/** 429 を指数バックオフ (2s/4s/8s) で最大 3 回まで再試行する GET。 */
async function get(
  url: string,
  opts: { cookie?: string; redirect?: RequestRedirect; expect429?: boolean } = {},
): Promise<Fetched> {
  let delay = 2000;
  for (let attempt = 0;; attempt++) {
    if (liveRequestCount >= LIVE_REQUEST_BUDGET) {
      if (!budgetExhaustedWarned) {
        budgetExhaustedWarned = true;
        console.warn(
          `  ライブリクエスト予算 ${LIVE_REQUEST_BUDGET} 回を使い切ったので以降は送信しない`,
        );
      }
      return {
        status: 0,
        contentType: "",
        contentDisposition: "",
        setCookie: "",
        body: "",
      };
    }
    liveRequestCount++;
    const res = await fetch(url, {
      redirect: opts.redirect ?? "follow",
      headers: {
        "user-agent": UA,
        "accept": "application/json, text/plain, */*",
        "accept-language": HL,
        "referer": ORIGIN + "/trends/explore",
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
    });
    const out: Fetched = {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      contentDisposition: res.headers.get("content-disposition") ?? "",
      // Set-Cookie は複数返りうる。get() はカンマ結合するので getSetCookie() を使う。
      setCookie: res.headers.getSetCookie().join("; "),
      retryAfter: res.headers.get("retry-after") ?? "",
      body: await res.text(), // 必ず消費してリソースリークを防ぐ
    };
    // NID 取得用の GET /trends/explore は 429 が正常応答なので再試行しない
    if (out.status !== 429 || opts.expect429 || attempt >= 2) return out;
    console.warn(`  429 を受信。${delay}ms 待って再試行 (attempt ${attempt + 1}/3)`);
    await sleep(delay);
    delay *= 2;
  }
}

function isJson(f: Fetched): boolean {
  return f.status === 200 && f.contentType.toLowerCase().startsWith("application/json");
}

// ------------------------------------------------------------------------------------
// ライブフローの共有コンテキスト (テスト間で使い回してリクエスト数を節約する)
// ------------------------------------------------------------------------------------
const ctx: {
  attempted: boolean;
  ready: boolean;
  reason: string;
  nid: string;
  widget: TimeseriesWidget | null;
  multilineRaw: string;
  multiline: MultilineResponse | null;
} = {
  attempted: false,
  ready: false,
  reason: "",
  nid: "",
  widget: null,
  multilineRaw: "",
  multiline: null,
};

function multilineUrl(
  request: unknown,
  token: string,
  hl: string = HL,
  tz: number = TZ,
): string {
  // ブラウザ実物は tz を 2 回付ける (末尾にもう 1 個)。1 回でも 200 になることは実測済み。
  return `${ORIGIN}/trends/api/widgetdata/multiline?hl=${hl}&tz=${tz}` +
    `&req=${encodeReq(JSON.stringify(request))}` +
    `&token=${encodeURIComponent(token)}&tz=${tz}`;
}

/** [2] の URL を組み立てる。date と keyword 群を変えて使い回す。 */
function exploreUrl(date: string, keywords: string[], geo: string = GEO): string {
  const req = JSON.stringify({
    comparisonItem: keywords.map((k) => ({ keyword: k, geo, time: date })),
    category: 0,
    property: "",
  });
  return `${ORIGIN}/trends/api/explore?hl=${HL}&tz=${TZ}&req=${encodeReq(req)}&tz=${TZ}`;
}

/** explore を叩いて TIMESERIES ウィジェットを取り出す。取れなければ理由付きで null。 */
async function fetchTimeseriesWidget(
  date: string,
  keywords: string[],
): Promise<{ widget: TimeseriesWidget | null; reason: string }> {
  const ex = await get(exploreUrl(date, keywords), { cookie: `NID=${ctx.nid}` });
  if (!isJson(ex)) {
    return {
      widget: null,
      reason: `explore(date=${date}) が JSON を返さなかった ` +
        `(status=${ex.status}, ct=${ex.contentType})`,
    };
  }
  const exJson = JSON.parse(stripAntiHijackPrefix(ex.body)) as { widgets: TimeseriesWidget[] };
  const w = exJson.widgets.find((x) => x.id === "TIMESERIES");
  return w
    ? { widget: w, reason: "" }
    : { widget: null, reason: `explore(date=${date}) に TIMESERIES ウィジェットが無い` };
}

/**
 * [1] NID Cookie を取る。
 * 2026-09-09 実測では /trending が 200 で NID を返し、/trends/explore は 429 だが
 * やはり NID を返す。穏当な前者を先に試し、駄目なら後者にフォールバックする。
 */
async function fetchNid(): Promise<string> {
  const trending = await get(`${ORIGIN}/trending?geo=${GEO}&hl=${HL}`, { redirect: "manual" });
  const a = trending.setCookie.match(/NID=([^;,\s]+)/);
  if (a) return a[1];
  await sleep(1500);
  const explore = await get(
    `${ORIGIN}/trends/explore?q=${encodeURIComponent(KEYWORD)}&geo=${GEO}&hl=${HL}`,
    { redirect: "manual", expect429: true },
  );
  const b = explore.setCookie.match(/NID=([^;,\s]+)/);
  return b ? b[1] : "";
}

/** [1] NID -> [2] explore -> [3] multiline のフルフローを 1 回だけ実行する。 */
async function bootstrap(): Promise<void> {
  if (ctx.attempted) return;
  ctx.attempted = true;
  try {
    // --- [1] NID Cookie
    ctx.nid = await fetchNid();
    if (!ctx.nid) {
      ctx.reason = "NID Cookie を取得できなかった (/trending も /trends/explore も Set-Cookie 無し)";
      return;
    }
    await sleep(1500);

    // --- [2] explore でウィジェット定義 + token
    const got = await fetchTimeseriesWidget(DATE, [KEYWORD]);
    if (!got.widget) {
      ctx.reason = got.reason;
      return;
    }
    ctx.widget = got.widget;
    await sleep(1500);

    // --- [3] multiline (Cookie 無しで叩く: token だけで通ることの確認も兼ねる)
    const ml = await get(multilineUrl(got.widget.request, got.widget.token));
    if (!isJson(ml)) {
      ctx.reason = `multiline が JSON を返さなかった (status=${ml.status}, ct=${ml.contentType})`;
      return;
    }
    ctx.multilineRaw = ml.body;
    ctx.multiline = JSON.parse(stripAntiHijackPrefix(ml.body)) as MultilineResponse;
    // ★ 200 でも timelineData が空 (51 バイト応答) になることがある (§9 参照)。
    //   これは仕様違反ではなく既知のソフト失敗なので、assertion ではなく skip に倒す。
    if (ctx.multiline.default.timelineData.length === 0) {
      ctx.reason = "multiline が 200 で空応答 (51 バイト) を返した ― §9 の既知の揺らぎ";
      return;
    }
    ctx.ready = true;
  } catch (e) {
    ctx.reason = `ネットワークエラー: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** ライブが使えないときは警告して skip 扱いにする (ハードに落とさない)。 */
function skipIfNotReady(): boolean {
  if (ctx.ready) return false;
  console.warn(`[skip] ライブ検証を実施できなかった: ${ctx.reason || "未実行"}`);
  return true;
}

// ====================================================================================
// オフラインテスト (ネットワーク不要)
// ====================================================================================

Deno.test({
  name: "offline: req のパーセントエンコードがブラウザ実物 (HAR) と一致する",
  fn() {
    // HAR trends_api_widgetdata_multiline/00_entry100.txt の req をオブジェクトに戻したもの
    const request = {
      time: "2026-09-07T14\\:53\\:39 2026-09-08T14\\:53\\:39",
      resolution: "EIGHT_MINUTE",
      locale: "ja",
      comparisonItem: [{
        geo: { country: "JP" },
        complexKeywordsRestriction: { keyword: [{ type: "BROAD", value: "Fanza" }] },
      }],
      requestOptions: { property: "", backend: "CM", category: 0 },
      userConfig: { userType: "USER_TYPE_SCRAPER" },
    };
    const encoded = encodeReq(JSON.stringify(request));

    // HAR の URL に載っていた req= の値そのもの
    const fromHar =
      "%7B%22time%22:%222026-09-07T14%5C%5C:53%5C%5C:39+2026-09-08T14%5C%5C:53%5C%5C:39%22," +
      "%22resolution%22:%22EIGHT_MINUTE%22,%22locale%22:%22ja%22,%22comparisonItem%22:%5B%7B" +
      "%22geo%22:%7B%22country%22:%22JP%22%7D,%22complexKeywordsRestriction%22:%7B%22keyword%22" +
      ":%5B%7B%22type%22:%22BROAD%22,%22value%22:%22Fanza%22%7D%5D%7D%7D%5D,%22requestOptions%22" +
      ":%7B%22property%22:%22%22,%22backend%22:%22CM%22,%22category%22:0%7D,%22userConfig%22" +
      ":%7B%22userType%22:%22USER_TYPE_SCRAPER%22%7D%7D";
    assertEquals(encoded, fromHar, "encodeReq がブラウザのエンコードを再現できていない");

    // 個別の性質も明示的に確認
    assert(!encoded.includes("%3A"), ": はエンコードされない");
    assert(!encoded.includes("%2C"), ", はエンコードされない");
    assert(!encoded.includes("%20"), "空白は + になる");
    assert(encoded.includes("%5C%5C:"), "time のコロン直前のバックスラッシュは %5C%5C");

    // ラウンドトリップ: サーバ側の解釈 (+ -> 空白) を再現して元に戻せる
    const back = JSON.parse(decodeURIComponent(encoded.replace(/\+/g, "%20")));
    assertEquals(back, request);
  },
});

Deno.test({
  name: "offline: アンチハイジャックプレフィクスの除去 (explore 5B / widgetdata 6B)",
  fn() {
    // widgetdata/multiline は `)]}',\n` (カンマ入り 6 バイト)、末尾に改行は付かない
    const ml = EMPTY_RESPONSE_BODY;
    assert(ml.startsWith(")]}',\n"), "widgetdata の前置は 6 バイト (カンマ入り)");
    assertEquals(new TextEncoder().encode(")]}',\n").length, 6);
    assertEquals(new TextEncoder().encode(")]}'\n").length, 5, "explore の前置は 5 バイト");
    assertEquals(
      new TextEncoder().encode(ml).length,
      EMPTY_RESPONSE_BYTES,
      "空レスポンスは 51 バイト (HAR #03/#04/#07/#08 の content.size と一致)",
    );
    assert(!ml.endsWith("\n"), "本文末尾に改行は付かない");
    assertEquals(JSON.parse(stripAntiHijackPrefix(ml)), {
      default: { timelineData: [], averages: [] },
    });

    // explore は `)]}'\n` (カンマ無し 5 バイト)
    const ex = ")]}'\n" + '{"widgets":[]}';
    assertEquals(JSON.parse(stripAntiHijackPrefix(ex)), { widgets: [] });

    // プレフィクスが無い本文はそのまま
    assertEquals(stripAntiHijackPrefix('{"a":1}'), '{"a":1}');
  },
});

Deno.test({
  name: "offline: token の 33 バイト構造と期限デコーダ",
  fn() {
    // 実 token は秘密情報なので埋め込まない。仕様どおりの合成 token を作って検証する。
    const expiry = 1788965619; // 2026-09-09T14:53:39Z (= HAR の explore 時刻 + 24h)
    const raw = new Uint8Array(33);
    raw.set([0x00, 0xd2, 0x3f, 0xdb, 0x03, 0x00, 0x00, 0x00, 0x00], 0); // 定数ヘッダ 9B
    raw[9] = (expiry >>> 24) & 0xff;
    raw[10] = (expiry >>> 16) & 0xff;
    raw[11] = (expiry >>> 8) & 0xff;
    raw[12] = expiry & 0xff;
    for (let i = 13; i < 33; i++) raw[i] = (i * 37) & 0xff; // 署名部のダミー 20B

    let bin = "";
    for (const b of raw) bin += String.fromCharCode(b);
    const token = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    assertEquals(token.length, 44, "token は常に 44 文字");
    assertMatch(token, /^ANI_2wMAAAAA[A-Za-z0-9_-]{32}$/, "先頭 12 文字は定数ヘッダ由来で固定");
    assertEquals(tokenExpiryUnixSeconds(token), expiry);
    assertEquals(b64urlDecode(token).length, 33);

    // 33 バイト以外は null (期限を読めない token を誤って信用しないこと)
    assertEquals(tokenExpiryUnixSeconds("QUJD"), null, "3 バイトの token は期限を読めない");

    /*
     * HAR 13 エントリの token を全てデコードして得た事実 (token 本体は秘密なので埋め込まない):
     *   - 13/13 が 44 文字 / base64url デコードで 33 バイト
     *   - 13/13 の bytes[0..8] が [00 d2 3f db 03 00 00 00 00] で完全一致
     *   - 13/13 で bytes[9..12] (BE uint32) - リクエスト発行時刻 = **きっかり 24.000 時間**
     *     (例: startedDateTime 2026-09-08T14:53:39Z -> 期限 2026-09-09T14:53:39Z)
     * -> 「bytes[9..12] は発行時刻 + 24h の UNIX 秒」はサンプル 13/13 で確定。
     * 下の HAR_TOKEN_FACTS はその集計値で、ヘッダ §4 の記述と 1 対 1 に対応する。
     */
    const HAR_TOKEN_FACTS = {
      count: 13,
      tokenChars: 44,
      decodedBytes: 33,
      constantHeader: [0x00, 0xd2, 0x3f, 0xdb, 0x03, 0x00, 0x00, 0x00, 0x00],
      ttlHours: 24,
    };
    assertEquals(HAR_TOKEN_FACTS.tokenChars, token.length);
    assertEquals(HAR_TOKEN_FACTS.decodedBytes, b64urlDecode(token).length);
    assertEquals(HAR_TOKEN_FACTS.constantHeader, Array.from(b64urlDecode(token).slice(0, 9)));
    assertEquals(HAR_TOKEN_FACTS.count, HAR_ENTRIES.length, "§0 の表と件数が一致する");
    // 合成 token の期限は HAR #00 の実測値と同じ「発行 (2026-09-08T14:53:39Z) + 24h」
    assertEquals(
      expiry - Math.floor(Date.parse("2026-09-08T14:53:39Z") / 1000),
      HAR_TOKEN_FACTS.ttlHours * 3600,
    );
  },
});

Deno.test({
  name: "offline: computeAverages のモデル (hasData=false も 0 として分母に数える)",
  fn() {
    // hasData=false を「欠測として分母から外す」実装との違いが出るケースで、
    // 2 つのモデルが区別可能であることまで確認する。
    const mk = (v: number[], h: boolean[]): TimelinePoint => ({
      time: "0",
      formattedTime: "",
      formattedAxisTime: "",
      value: v,
      hasData: h,
      formattedValue: v.map(String),
    });
    const pts = [
      mk([0, 0], [false, false]),
      mk([0, 0], [false, false]),
      mk([100, 20], [true, true]),
      mk([50, 10], [true, true]),
      mk([30, 6], [true, true]),
    ];
    // 全点平均: 180/5=36 / 36/5=7.2 -> 7
    assertEquals(computeAverages(pts, 2), [36, 7]);
    // 欠測を分母から外すモデルなら 180/3=60 / 36/3=12 になり、上と一致しない
    const present = pts.filter((p) => p.hasData[0]);
    assertEquals(computeAverages(present, 2), [60, 12]);
    assert(
      computeAverages(pts, 2)[0] !== computeAverages(present, 2)[0],
      "2 モデルが区別できなければこのテストに意味が無い",
    );
    // 四捨五入であって切り捨てではない
    assertEquals(computeAverages([mk([1], [true]), mk([2], [true])], 1), [2]); // 1.5 -> 2
  },
});

/**
 * HAR 13 エントリから機械的に抜き出した事実表 (ヘッダ §0 の表と 1 対 1 対応)。
 * 本文が保存されていない HAR でも、URL のクエリと content.size からここまでは確定できる。
 * 出典: .har/extracted/trends_api_widgetdata_multiline/<n>.txt
 */
const HAR_ENTRIES: Array<{
  n: string;
  property: string;
  resolution: string;
  backend: string;
  time: string;
  category: number;
  geo: Record<string, string>;
  items: number;
  status: number;
  size: number;
}> = [
  { n: "00_entry100", property: "", resolution: "EIGHT_MINUTE", backend: "CM", time: "2026-09-07T14\\:53\\:39 2026-09-08T14\\:53\\:39", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 27793 },
  { n: "01_entry118", property: "", resolution: "EIGHT_MINUTE", backend: "CM", time: "2026-09-07T14\\:53\\:42 2026-09-08T14\\:53\\:42", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 27649 },
  { n: "02_entry134", property: "", resolution: "EIGHT_MINUTE", backend: "CM", time: "2026-09-07T14\\:53\\:49 2026-09-08T14\\:53\\:49", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 27617 },
  { n: "03_entry151", property: "images", resolution: "EIGHT_MINUTE", backend: "CM", time: "2026-09-07T14\\:54\\:00 2026-09-08T14\\:54\\:00", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 51 },
  { n: "04_entry163", property: "news", resolution: "EIGHT_MINUTE", backend: "CM", time: "2026-09-07T14\\:54\\:02 2026-09-08T14\\:54\\:02", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 51 },
  { n: "05_entry176", property: "images", resolution: "EIGHT_MINUTE", backend: "CM", time: "2026-09-07T14\\:54\\:06 2026-09-08T14\\:54\\:06", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 27613 },
  { n: "06_entry191", property: "froogle", resolution: "EIGHT_MINUTE", backend: "CM", time: "2026-09-07T14\\:54\\:09 2026-09-08T14\\:54\\:09", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 27613 },
  { n: "07_entry205", property: "youtube", resolution: "EIGHT_MINUTE", backend: "CM", time: "2026-09-07T14\\:54\\:11 2026-09-08T14\\:54\\:11", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 51 },
  { n: "08_entry219", property: "youtube", resolution: "MINUTE", backend: "CM", time: "2026-09-08T10\\:54\\:16 2026-09-08T14\\:54\\:16", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 51 },
  { n: "09_entry231", property: "youtube", resolution: "MONTH", backend: "IZG", time: "2008-01-01 2026-09-08", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 32136 },
  { n: "10_entry246", property: "youtube", resolution: "MONTH", backend: "IZG", time: "2008-01-01 2026-09-08", category: 41, geo: { region: "JP-13" }, items: 1, status: 429, size: 1695 },
  { n: "11_entry259", property: "youtube", resolution: "MONTH", backend: "IZG", time: "2008-01-01 2026-09-08", category: 41, geo: { country: "JP" }, items: 1, status: 200, size: 32136 },
  { n: "12_entry274", property: "youtube", resolution: "MONTH", backend: "IZG", time: "2008-01-01 2026-09-08", category: 41, geo: { country: "JP" }, items: 2, status: 200, size: 34854 },
];

Deno.test({
  name: "offline: HAR 13 エントリの事実表とヘッダの仕様記述が矛盾しない",
  fn() {
    assertEquals(HAR_ENTRIES.length, 13);
    assertEquals(HAR_ENTRIES.filter((e) => e.status === 200).length, 12);
    assertEquals(HAR_ENTRIES.filter((e) => e.status === 429).length, 1);

    // (a) 429 の本文は 1,695 バイト。RESPONSE_HEADERS の定数と一致していること。
    assertEquals(
      HAR_ENTRIES.find((e) => e.status === 429)!.size,
      RESPONSE_HEADERS.rateLimited.bodyBytes,
    );
    assertEquals(RESPONSE_HEADERS.rateLimited.retryAfter, "", "429 に Retry-After は付かない");
    assertEquals(
      RESPONSE_HEADERS.rateLimited.contentDisposition,
      "",
      "429 に content-disposition は付かない",
    );
    // 成功時のヘッダは JSON 判定に使える形をしている
    assert(RESPONSE_HEADERS.ok.contentType.toLowerCase().startsWith("application/json"));
    assert(!RESPONSE_HEADERS.rateLimited.contentType.startsWith("application/json"));

    // (b) backend は time の書式で決まる: 秒精度 (now 系) -> CM / 日付のみ -> IZG
    for (const e of HAR_ENTRIES) {
      assertEquals(e.backend, e.time.includes("T") ? "CM" : "IZG", `${e.n}: backend`);
    }

    // (c) time の書式 2 種
    for (const e of HAR_ENTRIES) {
      if (e.time.includes("T")) {
        assertMatch(
          e.time,
          /^\d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2} \d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2}$/,
          `${e.n}: 秒精度の time`,
        );
      } else {
        assertMatch(e.time, /^\d{4}-\d{2}-\d{2} \d{4}-\d{2}-\d{2}$/, `${e.n}: 日付のみの time`);
      }
    }

    // (d) 窓の長さ -> resolution (now 1-d=24h -> EIGHT_MINUTE / now 4-H=4h -> MINUTE)
    const spanHours = (t: string) => {
      const [a, b] = t.replace(/\\/g, "").split(" ");
      return (Date.parse(b + "Z") - Date.parse(a + "Z")) / 3600000;
    };
    const oneDay = HAR_ENTRIES.filter((e) => e.time.includes("T") && spanHours(e.time) === 24);
    const fourHour = HAR_ENTRIES.filter((e) => e.time.includes("T") && spanHours(e.time) === 4);
    assertEquals(oneDay.length, 8, "now 1-d (24h) の窓は 8 件");
    assertEquals(fourHour.length, 1, "now 4-H (4h) の窓は 1 件");
    for (const e of oneDay) assertEquals(e.resolution, "EIGHT_MINUTE", e.n);
    for (const e of fourHour) assertEquals(e.resolution, "MINUTE", `${e.n}: now 4-H は MINUTE`);

    // (e) MONTH は all_2008 = 2008-01-01 始まり
    for (const e of HAR_ENTRIES.filter((x) => x.resolution === "MONTH")) {
      assertMatch(e.time, /^2008-01-01 /, `${e.n}: all_2008 の窓`);
      assertEquals(e.backend, "IZG");
    }

    // (f) property は 5 種すべて実在
    assertEquals(
      [...new Set(HAR_ENTRIES.map((e) => e.property))].sort(),
      ["", "froogle", "images", "news", "youtube"],
    );

    // (g) category は 0 とは限らない
    assert(HAR_ENTRIES.every((e) => e.category === 41), "HAR は全件 category=41");

    // (h) geo は country 形と region 形の 2 種
    assert(HAR_ENTRIES.some((e) => "country" in e.geo));
    assert(HAR_ENTRIES.some((e) => "region" in e.geo));

    // (i) ★ 空応答 (51B) は property では決まらない。
    //     #03 と #05 は time が 6 秒違うだけで他は完全同一なのに、一方が空。
    const e03 = HAR_ENTRIES.find((e) => e.n === "03_entry151")!;
    const e05 = HAR_ENTRIES.find((e) => e.n === "05_entry176")!;
    assertEquals(e03.property, e05.property);
    assertEquals(e03.resolution, e05.resolution);
    assertEquals(e03.geo, e05.geo);
    assertEquals(e03.category, e05.category);
    assertEquals(e03.size, 51, "#03 は空応答");
    assert(e05.size > 20000, "#05 は同条件なのにデータ有り");
    assertEquals(
      HAR_ENTRIES.filter((e) => e.size === EMPTY_RESPONSE_BYTES).map((e) => e.n),
      ["03_entry151", "04_entry163", "07_entry205", "08_entry219"],
    );
    // images は空と非空の両方に出る -> property は空応答の説明にならない
    assertEquals(
      HAR_ENTRIES.filter((e) => e.property === "images").map((e) => e.size).sort((a, b) => a - b),
      [51, 27613],
    );

    // (j) comparisonItem 2 件 (#12) は同条件 1 件 (#11) より本文が大きい
    const e11 = HAR_ENTRIES.find((e) => e.n === "11_entry259")!;
    const e12 = HAR_ENTRIES.find((e) => e.n === "12_entry274")!;
    assertEquals([e11.items, e12.items], [1, 2]);
    assert(e12.size > e11.size, "系列が増えれば配列 3 本が伸びる");
  },
});

// ====================================================================================
// ライブテスト (bootstrap -> explore -> multiline を 1 回だけ実行し、以降は使い回す)
// ====================================================================================

Deno.test({
  name: "live: フルフロー (NID -> explore -> multiline) が 200 / application/json を返す",
  async fn() {
    await bootstrap();
    if (skipIfNotReady()) return;

    const w = ctx.widget as TimeseriesWidget;
    assertEquals(w.id, "TIMESERIES");
    assertEquals(w.type, "fe_line_chart");
    assertEquals(w.template, "fe");
    assertEquals(w.embedTemplate, "fe_embed");
    assertEquals(w.version, "1");
    assertEquals(typeof w.title, "string");
    assert(w.title.length > 0);
    assertEquals(w.isLong, true);
    assertEquals(w.isCurated, false);
    assertEquals(w.bullets.length, 1);
    assertEquals(w.bullets[0].text, KEYWORD);

    // 本文プレフィクスは `)]}',\n` (カンマ入り 6 バイト)。末尾に改行は付かない。
    assert(
      ctx.multilineRaw.startsWith(")]}',\n"),
      "multiline のプレフィクスが想定と違う: " + JSON.stringify(ctx.multilineRaw.slice(0, 8)),
    );
    assert(!ctx.multilineRaw.endsWith("\n"), "本文末尾に改行は付かない");
  },
});

Deno.test({
  name: "live: token が 44 文字 base64url / 33 バイト / 期限は約 24 時間後",
  async fn() {
    await bootstrap();
    if (skipIfNotReady()) return;

    const token = (ctx.widget as TimeseriesWidget).token;
    assertEquals(token.length, 44);
    assertMatch(token, /^[A-Za-z0-9_-]{44}$/);
    assert(token.startsWith("ANI_2wMAAAAA"), "token の定数ヘッダが違う: " + token.slice(0, 12));

    const raw = b64urlDecode(token);
    assertEquals(raw.length, 33);
    assertEquals(
      Array.from(raw.slice(0, 9)),
      [0x00, 0xd2, 0x3f, 0xdb, 0x03, 0x00, 0x00, 0x00, 0x00],
      "先頭 9 バイトの定数ヘッダ",
    );

    const exp = tokenExpiryUnixSeconds(token) as number;
    const ttl = exp - Math.floor(Date.now() / 1000);
    // 発行直後なら ttl はほぼ 86400。取得から時間が経つほど減るので下限は緩めに取る。
    assert(
      ttl > 0 && ttl <= 86400 + 300,
      `token の期限は未来かつ発行から 24 時間以内のはず (実測 ttl=${ttl} 秒)`,
    );
    assert(
      ttl > 82800,
      `token を取得した直後なので ttl は 23 時間超のはず (実測 ttl=${ttl} 秒)`,
    );
  },
});

Deno.test({
  name: "live: widget.request (= multiline の req) のスキーマ",
  async fn() {
    await bootstrap();
    if (skipIfNotReady()) return;

    const r = (ctx.widget as TimeseriesWidget).request;

    assertEquals(
      Object.keys(r).sort(),
      ["comparisonItem", "locale", "requestOptions", "resolution", "time", "userConfig"],
      "req のキーはこの 6 個で全て",
    );
    assertEquals(r.locale, HL);
    assertEquals(r.resolution, "EIGHT_MINUTE", "date='now 1-d' の解像度は EIGHT_MINUTE");
    assertEquals(r.requestOptions.backend, "CM", "now 系のバックエンドは CM");
    assertEquals(r.requestOptions.category, 0);
    assertEquals(r.requestOptions.property, "");
    assertEquals(r.userConfig.userType, "USER_TYPE_SCRAPER");

    // time: 1 日レンジなので秒精度 + コロン直前のバックスラッシュ (JS 文字列としては 1 個)
    assertMatch(
      r.time,
      /^\d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2} \d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2}$/,
      "time の書式が想定と違う: " + r.time,
    );
    // 窓は UTC で、ちょうど 24 時間
    const parts = r.time.replace(/\\/g, "").split(" ");
    const spanSec = (Date.parse(parts[1] + "Z") - Date.parse(parts[0] + "Z")) / 1000;
    assertEquals(spanSec, 86400, "now 1-d の窓はちょうど 24 時間");

    assertEquals(r.comparisonItem.length, 1);
    assertEquals(r.comparisonItem[0].geo, { country: GEO });
    assertEquals(r.comparisonItem[0].complexKeywordsRestriction.keyword, [
      { type: "BROAD", value: KEYWORD },
    ]);
  },
});

Deno.test({
  name: "live: multiline レスポンス本体のスキーマを厳密検証",
  async fn() {
    await bootstrap();
    if (skipIfNotReady()) return;

    const body = ctx.multiline as MultilineResponse;
    assertEquals(Object.keys(body), ["default"], "トップレベルのキーは default のみ");
    assertEquals(
      Object.keys(body.default).sort(),
      ["averages", "timelineData"],
      "default のキーは timelineData と averages のみ",
    );

    const td = body.default.timelineData;
    assert(Array.isArray(td));
    // 空応答 (51 バイト) は §9 の既知のソフト失敗。bootstrap 側で skip 済みだが二重に守る。
    assert(td.length > 10, `timelineData が少なすぎる (${td.length})`);

    const w = ctx.widget as TimeseriesWidget;
    const seriesCount = w.request.comparisonItem.length;
    assertEquals(seriesCount, 1);
    const step = STEP_SECONDS[w.request.resolution];

    const allowedKeys = new Set([
      "time",
      "formattedTime",
      "formattedAxisTime",
      "value",
      "hasData",
      "formattedValue",
      "isPartial",
      "axisNote",
    ]);

    let maxValue = -1;
    let partialCount = 0;
    let lastTs = -1;

    for (let i = 0; i < td.length; i++) {
      const p = td[i];
      for (const k of Object.keys(p)) {
        assert(allowedKeys.has(k), `未知のフィールド ${k} が point[${i}] にある`);
      }
      // time は「UNIX 秒の 10 進文字列」であって数値ではない
      assertEquals(typeof p.time, "string", `point[${i}].time は string`);
      assertMatch(p.time, /^\d{9,11}$/);
      const ts = Number(p.time);
      if (lastTs >= 0 && step !== null) {
        assertEquals(ts - lastTs, step, `バケット幅は ${step} 秒 (i=${i})`);
      }
      lastTs = ts;

      assertEquals(typeof p.formattedTime, "string");
      assert(p.formattedTime.length > 0);
      assertEquals(typeof p.formattedAxisTime, "string");
      assert(p.formattedAxisTime.length > 0);

      assert(Array.isArray(p.value) && p.value.length === seriesCount, "value は長さ N の配列");
      assert(Array.isArray(p.hasData) && p.hasData.length === seriesCount);
      assert(Array.isArray(p.formattedValue) && p.formattedValue.length === seriesCount);

      for (let k = 0; k < seriesCount; k++) {
        assertEquals(typeof p.value[k], "number");
        assert(Number.isInteger(p.value[k]), "value は整数");
        assert(p.value[k] >= 0 && p.value[k] <= 100, `value は 0..100 (${p.value[k]})`);
        assertEquals(typeof p.hasData[k], "boolean");
        assertEquals(typeof p.formattedValue[k], "string");
        // hasData=false の点は必ず value=0
        if (!p.hasData[k]) assertEquals(p.value[k], 0);
        maxValue = Math.max(maxValue, p.value[k]);
      }

      if (p.isPartial !== undefined) {
        assertEquals(p.isPartial, true, "isPartial は true のときだけ現れる");
        assertEquals(i, td.length - 1, "isPartial が付くのは最後の点だけ");
        partialCount++;
      }
      if (p.axisNote !== undefined) {
        assertEquals(typeof p.axisNote.text, "string");
      }
    }

    // 正規化: レンジ内の最大値が 100
    assertEquals(maxValue, 100, "value の最大値は 100 に正規化される");
    // 未完了バケットは最後の 1 点のみ
    assertEquals(partialCount, 1, "isPartial は最後の 1 点にのみ付く");

    // 単一キーワードでは averages は空配列 (widget.showAverages=false と対応)
    assert(Array.isArray(body.default.averages));
    assertEquals(
      body.default.averages.length,
      0,
      "comparisonItem が 1 件のとき averages は []",
    );
    assertEquals(w.showAverages, false);
    assertEquals(w.showLegend, false);
    // ★ 不変条件: showAverages と averages の有無は連動する (複数系列テストでも同じ式を検証)
    assertEquals(
      w.showAverages,
      body.default.averages.length > 0,
      "showAverages === (averages.length > 0)",
    );

    // 窓との整合: 先頭点は窓の開始付近、末尾点は窓の終了以前
    const parts = w.request.time.replace(/\\/g, "").split(" ");
    const ws = Math.floor(Date.parse(parts[0] + "Z") / 1000);
    const we = Math.floor(Date.parse(parts[1] + "Z") / 1000);
    assert(Number(td[0].time) >= ws - 600, "先頭点は窓の開始付近");
    assert(Number(td[td.length - 1].time) <= we, "末尾点は窓の終了以前");
  },
});

Deno.test({
  name: "live: token は使い回せる (同じ token+req で再度 200) / Cookie 無しでも通る",
  async fn() {
    await bootstrap();
    if (skipIfNotReady()) return;
    await sleep(1500);

    const w = ctx.widget as TimeseriesWidget;
    // Cookie を一切送らない。NID が必要なのは /trends/api/explore だけで multiline には不要。
    const again = await get(multilineUrl(w.request, w.token));
    if (!isJson(again)) {
      console.warn(
        `[skip] token 再利用の検証をスキップ (status=${again.status}, ct=${again.contentType})`,
      );
      return;
    }
    const j = JSON.parse(stripAntiHijackPrefix(again.body)) as MultilineResponse;
    const base = (ctx.multiline as MultilineResponse).default.timelineData;
    if (j.default.timelineData.length === 0) {
      // §9: 200 でも空応答が返ることがある。仕様違反ではないので skip に倒す。
      console.warn("[skip] token 再利用で空応答 (51 バイト) が返った ― §9 の既知の揺らぎ");
      return;
    }
    assertEquals(
      j.default.timelineData.length,
      base.length,
      "token 再利用でも同じ点数が返る",
    );
    assertEquals(j.default.timelineData[0].time, base[0].time);
    // レスポンスヘッダは HAR 12/12 の実測値 (RESPONSE_HEADERS.ok) と一致する
    assertEquals(
      again.contentDisposition,
      RESPONSE_HEADERS.ok.contentDisposition,
      "widgetdata の content-disposition には filename* が付かない",
    );
    assertEquals(
      again.contentType,
      RESPONSE_HEADERS.ok.contentType,
      "content-type は application/json; charset=UTF-8",
    );
  },
});

Deno.test({
  name: "live: req を 1 箇所でも改竄すると 401 (token は req 全体の署名)",
  async fn() {
    await bootstrap();
    if (skipIfNotReady()) return;
    await sleep(1500);

    const w = ctx.widget as TimeseriesWidget;
    // resolution だけを EIGHT_MINUTE -> SIXTEEN_MINUTE に書き換える
    const tampered = JSON.parse(JSON.stringify(w.request)) as TimeseriesRequest;
    tampered.resolution = "SIXTEEN_MINUTE";

    const res = await get(multilineUrl(tampered, w.token));
    if (res.status === 429 || res.status === 0) {
      console.warn(
        `[skip] req 改竄テストは未検証 (${res.status === 0 ? "ライブ予算切れ" : "レート制限"})`,
      );
      return;
    }
    assertEquals(
      res.status,
      401,
      `req を改竄すると 401 Bad Request になるはず (実際 ${res.status} / ${res.contentType})。` +
        "ここが 400 等になった場合はヘッダ §9 の記述を更新すること。",
    );
    assert(
      res.contentType.startsWith("text/html"),
      `401 の content-type は text/html (実際: ${res.contentType})`,
    );
    assert(res.body.includes("401"), "本文は Google 標準のエラーページ HTML");
    assertEquals(res.contentDisposition, "", "エラー応答に content-disposition は付かない");
    // 成功判定に status だけ / res.ok だけを使ってはいけないことの証拠
    assert(!isJson(res));
  },
});

Deno.test({
  name: "live: tz は表示書式だけに効き、time と value は不変",
  async fn() {
    await bootstrap();
    if (skipIfNotReady()) return;
    await sleep(1500);

    const w = ctx.widget as TimeseriesWidget;
    // 同じ req/token のまま hl=en, tz=0 (UTC) で取り直す
    const utc = await get(multilineUrl(w.request, w.token, "en", 0));
    if (!isJson(utc)) {
      console.warn(`[skip] tz 検証をスキップ (status=${utc.status}, ct=${utc.contentType})`);
      return;
    }
    const j = JSON.parse(stripAntiHijackPrefix(utc.body)) as MultilineResponse;
    const a = (ctx.multiline as MultilineResponse).default.timelineData;
    const b = j.default.timelineData;
    assertEquals(b.length, a.length);

    // time (epoch) と value は tz/hl を変えても同一
    assertEquals(b[0].time, a[0].time, "time は tz に影響されない");
    assertEquals(b[0].value, a[0].value, "value は tz に影響されない");
    assertEquals(b[0].hasData, a[0].hasData);

    // formattedTime は tz=0 のとき UTC そのもの。書式は hl に従う (en は 12 時間表記)。
    const utcIso = new Date(Number(b[0].time) * 1000).toISOString(); // 2026-09-07T15:44:00.000Z
    const hh = Number(utcIso.slice(11, 13));
    const mm = utcIso.slice(14, 16);
    const ampm = hh >= 12 ? "PM" : "AM";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    assert(
      b[0].formattedTime.indexOf(`${h12}:${mm}`) >= 0 &&
        b[0].formattedTime.indexOf(ampm) >= 0,
      "tz=0/hl=en の formattedTime は UTC の 12 時間表記になるはず: " +
        `${b[0].formattedTime} (epoch=${utcIso})`,
    );
    // tz=-540 (JST) 側は同じ epoch が +9 時間ずれて表示されている
    assert(a[0].formattedTime !== b[0].formattedTime, "tz が違えば formattedTime も違う");
  },
});

Deno.test({
  name: "live: date -> resolution / バケット幅 の対応を 3 パターン実測して照合する",
  async fn() {
    await bootstrap();
    // bootstrap が通っていないなら explore も通らないので、無駄弾を撃たずに諦める
    if (skipIfNotReady()) return;

    // 期待値はヘッダ §7 の表そのもの。now 1-d は bootstrap の結果を流用し、
    // 残り 2 パターンだけ追加で叩く (ライブ予算の節約)。
    const cases: Array<{
      date: string;
      resolution: string;
      backend: string;
      secondPrecision: boolean;
      step: number | null;
    }> = [
      { date: DATE, resolution: "EIGHT_MINUTE", backend: "CM", secondPrecision: true, step: 480 },
      { date: "today 12-m", resolution: "WEEK", backend: "IZG", secondPrecision: false, step: 604800 },
      { date: "all", resolution: "MONTH", backend: "IZG", secondPrecision: false, step: null },
    ];

    let verified = 0;
    for (const c of cases) {
      let widget: TimeseriesWidget;
      let points: TimelinePoint[];

      if (c.date === DATE) {
        widget = ctx.widget as TimeseriesWidget;
        points = (ctx.multiline as MultilineResponse).default.timelineData;
      } else {
        await sleep(1500);
        const got = await fetchTimeseriesWidget(c.date, [KEYWORD]);
        if (!got.widget) {
          console.warn(`[skip] date=${c.date}: ${got.reason}`);
          continue;
        }
        widget = got.widget;
        await sleep(1500);
        const ml = await get(multilineUrl(widget.request, widget.token));
        if (!isJson(ml)) {
          console.warn(
            `[skip] date=${c.date} の multiline (status=${ml.status}, ct=${ml.contentType})`,
          );
          continue;
        }
        points = (JSON.parse(stripAntiHijackPrefix(ml.body)) as MultilineResponse)
          .default.timelineData;
        if (points.length === 0) {
          console.warn(`[skip] date=${c.date}: 200 だが空応答 (§9 の既知の揺らぎ)`);
          continue;
        }
      }

      const r = widget.request;
      assertEquals(r.resolution, c.resolution, `date=${c.date} の resolution`);
      assertEquals(r.requestOptions.backend, c.backend, `date=${c.date} の backend`);

      // time の書式は resolution ではなく「1 日未満かどうか」で決まる
      if (c.secondPrecision) {
        assertMatch(
          r.time,
          /^\d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2} \d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2}$/,
          `date=${c.date} の time は秒精度 (コロン直前に \\)`,
        );
      } else {
        assertMatch(
          r.time,
          /^\d{4}-\d{2}-\d{2} \d{4}-\d{2}-\d{2}$/,
          `date=${c.date} の time は日付のみ: ${r.time}`,
        );
      }

      // STEP_SECONDS の表が実データと合っているか
      const steps = new Set<number>();
      for (let i = 1; i < points.length; i++) {
        steps.add(Number(points[i].time) - Number(points[i - 1].time));
      }
      assertEquals(
        STEP_SECONDS[r.resolution],
        c.step,
        `STEP_SECONDS[${r.resolution}] の表が期待値と食い違っている`,
      );
      if (c.step === null) {
        // MONTH は 28〜31 日で可変。等間隔チェックを掛けてはいけないことの実証。
        assert(steps.size > 1, "MONTH のバケット幅は一定ではない");
        for (const s of steps) {
          assert(
            s >= 28 * 86400 && s <= 31 * 86400,
            `MONTH の step は 28〜31 日の範囲 (実測 ${s} 秒)`,
          );
        }
      } else {
        assertEquals(
          [...steps],
          [c.step],
          `date=${c.date} (${r.resolution}) のバケット幅は ${c.step} 秒で一定`,
        );
      }

      // date=all の窓は 2004-01-01 始まり (Google Trends のデータ開始日)
      if (c.date === "all") {
        assertMatch(
          r.time,
          /^2004-01-01 /,
          `date=all の窓は 2004-01-01 始まりのはず (実際: ${r.time})。` +
            "変わっていたらヘッダ §7 を更新すること。",
        );
      }

      console.log(
        `  date=${c.date.padEnd(10)} resolution=${r.resolution.padEnd(12)} ` +
          `backend=${r.requestOptions.backend} points=${points.length} ` +
          `steps=${JSON.stringify([...steps].slice(0, 3))}`,
      );
      verified++;
    }

    assert(verified >= 1, "1 パターンも実測できなかった");
    if (verified < cases.length) {
      console.warn(`[warn] ${cases.length} パターン中 ${verified} パターンのみ実測 (残りは 429)`);
    }
  },
});

Deno.test({
  name: "live: 複数キーワード比較 ― 配列の並び / 全系列を通した 0-100 正規化 / averages",
  async fn() {
    await bootstrap();
    if (skipIfNotReady()) return;
    await sleep(1500);

    const kws = ["iPhone", "Android"];
    const got = await fetchTimeseriesWidget("today 12-m", kws);
    if (!got.widget) {
      console.warn(`[skip] ${got.reason}`);
      return;
    }
    const w = got.widget;

    // req.comparisonItem の並びは explore に渡したキーワード順
    assertEquals(w.request.comparisonItem.length, kws.length);
    assertEquals(
      w.request.comparisonItem.map((c) => c.complexKeywordsRestriction.keyword[0].value),
      kws,
      "comparisonItem の並びはリクエスト順",
    );
    // bullets は系列と 1 対 1 (単一キーワード時に bullets.length===1 だったことの自然な一般化)
    assertEquals(w.bullets.length, kws.length, "bullets は系列数と同じ長さ");
    for (const b of w.bullets) {
      assert(kws.includes(b.text), `bullets のテキストはキーワードのいずれか: ${b.text}`);
    }

    await sleep(1500);
    const ml = await get(multilineUrl(w.request, w.token));
    if (!isJson(ml)) {
      console.warn(`[skip] 複数キーワードの multiline (status=${ml.status}, ct=${ml.contentType})`);
      return;
    }
    const body = JSON.parse(stripAntiHijackPrefix(ml.body)) as MultilineResponse;
    const td = body.default.timelineData;
    if (td.length === 0) {
      console.warn("[skip] 複数キーワードで空応答 (§9 の既知の揺らぎ)");
      return;
    }
    const N = kws.length;

    // 3 本の配列はすべて長さ N
    for (const p of td) {
      assertEquals(p.value.length, N, "value は長さ N");
      assertEquals(p.hasData.length, N, "hasData は長さ N");
      assertEquals(p.formattedValue.length, N, "formattedValue は長さ N");
    }

    // ★ 正規化は「系列ごと」ではなく「全系列を通して」最大が 100
    const perSeriesMax = Array.from(
      { length: N },
      (_, k) => Math.max(...td.map((p) => p.value[k])),
    );
    assertEquals(Math.max(...perSeriesMax), 100, "全系列を通した最大値が 100");
    // 「系列ごとに正規化」なら全系列の最大が 100 になるはず。そうなっていないことが決定的な証拠。
    assert(
      perSeriesMax.some((m) => m < 100),
      "系列ごと正規化ではないなら、最大が 100 未満の系列が少なくとも 1 本あるはず " +
        `(実測 perSeriesMax=${JSON.stringify(perSeriesMax)})。` +
        "全系列が同着 100 になる稀なケースならキーワードを変えて再確認すること。",
    );

    // ★ averages は「hasData=false も 0 として分母に数えた全点平均の四捨五入」
    const avgs = body.default.averages;
    assertEquals(avgs.length, N, "複数系列では averages が長さ N で埋まる");
    // ウィジェット定義の showAverages と averages の有無は連動する
    // (単一キーワード時は showAverages=false / averages=[] であることを別テストで確認済み)
    assertEquals(
      w.showAverages,
      avgs.length > 0,
      "showAverages と averages の有無は連動する",
    );
    console.log(`  multi-kw widget: showLegend=${w.showLegend} showAverages=${w.showAverages}`);
    assertEquals(
      avgs,
      computeAverages(td, N),
      "averages が『全点平均の四捨五入』モデルと一致しない",
    );
    // 欠測を分母から外すモデルでは説明できないことも (欠測がある場合のみ) 確認する
    const present = td.filter((p) => p.hasData[0]);
    if (present.length !== td.length && present.length > 0) {
      assert(
        JSON.stringify(computeAverages(present, N)) !== JSON.stringify(avgs),
        "欠測を除いた平均モデルとは一致しないはず",
      );
    }

    console.log(
      `  multi-kw: points=${td.length} perSeriesMax=${JSON.stringify(perSeriesMax)} ` +
        `averages=${JSON.stringify(avgs)}`,
    );
  },
});

Deno.test({
  name: "summary: このテスト実行が発行したライブ HTTP リクエスト数",
  fn() {
    console.log(`  live HTTP requests issued: ${liveRequestCount} / 予算 ${LIVE_REQUEST_BUDGET}`);
    assert(
      liveRequestCount <= LIVE_REQUEST_BUDGET,
      `ライブリクエストは ${LIVE_REQUEST_BUDGET} 回以内に収めること (実際 ${liveRequestCount})`,
    );
  },
});
