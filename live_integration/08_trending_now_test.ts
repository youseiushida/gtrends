// 実行: deno test --allow-net --no-check live_integration/08_trending_now_test.ts
//
// =============================================================================
// Google Trends "Trending Now" 一覧 (batchexecute RPC `i0OFE`) 仕様書 + 検証テスト
// =============================================================================
//
// ライブ検証日: 2026-09-09 (JST)。HAR キャプチャ日: 2026-09-08。
// HAR 根拠エントリ (C:\Users\ushid\Documents\gtrend_claude\.har\extracted\
//   TrendsUi_data_batchexecute\ 配下):
//     11_entry402 … i0OFE geo=JP   args=[null,null,"JP",0,"ja",4]        slot="1"
//     12_entry405 … i0OFE geo=JP   args=[null,null,"JP",0,"ja",4,1]      slot="generic"
//     16_entry418 … i0OFE geo=IE (+wAgrOe を同一 POST でバッチ)          slot="1"/"3"
//     17_entry419 … i0OFE geo=IE   args=[null,null,"IE",0,"ja",4,1]      slot="generic"
//     21_entry433 … i0OFE geo=JP-13 (東京都)                             slot="generic"
//     25_entry450 … i0OFE geo=JP-27 (大阪府)                             slot="generic"
//   上記 6 件はいずれもレスポンスボディが HAR に保存されており、合計 279 アイテムを
//   オフラインで全数解析した。本ファイルの「HAR 実測」表記はこの 279 件が根拠。
//
// -----------------------------------------------------------------------------
// 0. これは何か / 旧 API からの移行
// -----------------------------------------------------------------------------
// 旧「Daily Search Trends」「Realtime Search Trends」は廃止され、新 UI /trending
// (boq/Wiz アプリ "TrendsUi") に統合された。現在の一覧取得手段は 3 つある。
//
//   (A) batchexecute RPC `i0OFE`     … 本ファイルの主題。最も情報量が多く、
//       geo/hl/hours/newsCount を自由に指定できる唯一の手段。
//   (B) /trending の HTML に埋め込まれた AF_initDataCallback の `ds:0`
//       … GET 1 回・POST 不要・Cookie 不要。2026-09-09 にライブ実測して確認:
//           GET /trending?geo=JP&hl=ja → 200 / text/html / 約 1.30MB
//           <script class="ds:0" ...>AF_initDataCallback({key: 'ds:0', hash: '2',
//             data:[null,[[...アイテム...]]], sideChannel: {}});</script>
//         data の中身は **i0OFE のペイロードと完全に同じ [null, items] 構造**
//         (実測 439 件 / 全件 arity 13 / items[i][1] は全て null = newsCount 0 相当 /
//          最古の開始時刻は 23.96 時間前 = hours 24 相当)。
//         同じ HTML には key 'ds:1' もあり、中身は `["日本"]` = geo のローカライズ表示名。
//         **hours も newsCount も変えられない** ので、24h・ニュース無しで良いときだけ有効。
//         取り出し方 (正規表現のみ): `AF_initDataCallback({key: 'ds:0'` を探し、
//         直後の `data:` から次の `sideChannel:` の手前までを JSON.parse する。
//   (C) RSS フィード /trending/rss?geo=JP
//       … 最も軽量だが 10 件固定・ニュース最大 3 件。ニュース記事の URL/画像/媒体名
//         が最初から入っているのが利点 (§7)。
//   → 一覧だけ欲しいなら (B) か (C)、条件を変えたいなら (A)。(A) は §3.1 のとおり
//     rt を省略すれば長さ行のパースすら不要で、実装コストは (B) とほぼ変わらない。
//
// 旧エンドポイントの現況 (2026-09-09 実測、本ファイルのテストでも毎回確認する):
//   GET /trends/api/dailytrends?hl=ja&tz=-540&geo=JP&ns=15
//        → 404 / text/html; charset=UTF-8 / 134 バイトの最小 404 ドキュメント (廃止)
//   GET /trends/api/realtimetrends?hl=ja&tz=-540&cat=all&fi=0&fs=0&geo=JP&ri=300&rs=20&sort=0
//        → 404 / text/html; charset=utf-8 / 約 1.6KB の Google 標準 404 ページ (廃止)
//   GET /trends/trendingsearches/daily?geo=JP&hl=ja
//        → 302 Found, location: https://trends.google.com/trending?geo=JP&hl=ja
//          (GSE の "Moved Temporarily" ページ 260 バイト)。redirect:"manual" で観測。
//
// -----------------------------------------------------------------------------
// 1. リクエスト仕様 (RPC i0OFE)
// -----------------------------------------------------------------------------
// メソッド/URL:
//   POST https://trends.google.com/_/TrendsUi/data/batchexecute?<query>
//
// クエリパラメータ:
//   必須 (実測):
//     rpcids      = "i0OFE"                 … 複数 RPC をバッチする場合はカンマ区切り
//   任意だが**レスポンス形式を左右する**:
//     rt          = "c"                     … 付けると「長さ行+チャンク」ストリーム形式 (§3)。
//                                             ★省略しても 200 が返る。省略時は
//                                             `)]}'\n\n` + **チャンク配列そのものの JSON 1 個**
//                                             という素の形式になり、長さ行も終端 "e" も無い (§3.1)。
//                                             ラッパーを書くなら **rt を省略する方が実装が単純**。
//                                             2026-09-09 にライブで両形式を実測して確認済み。
//   任意 (省略しても 200。2026-09-09 にライブで省略して同一形式のレスポンスを確認):
//     source-path = "/trending"             … SPA の現在ルート
//     hl          = "ja"                    … UI 言語。args[4] と別に置くのがブラウザの流儀
//     _reqid      = 整数                     … 単なるキャッシュバスター。任意の整数で可
//     f.sid       = <WIZ_global_data.FdrFJe> … 省略可。付ける場合は必ず「文字列」で扱う
//                                              (負の 64bit 値があり Number 化すると壊れる)
//     bl          = <WIZ_global_data.cfb2h>  … 省略可。ビルドラベル。ハードコード禁止
//     soc-app=1 / soc-platform=1 / soc-device=1 … 省略可
//
// リクエストヘッダ:
//   必須:
//     content-type: application/x-www-form-urlencoded;charset=UTF-8
//   ブラウザは必ず送るので保険として推奨 (無くても 200 だった):
//     x-same-domain: 1
//     origin:  https://trends.google.com
//     referer: https://trends.google.com/
//     user-agent: <普通の Chrome UA>
//   不要:
//     Cookie (NID すら不要)。reCAPTCHA トークン。XSRF トークン (`at=` は 27/27 エントリで不在)。
//     x-browser-validation 等の Chrome 内部ヘッダ、sec-ch-ua-* は送らないこと。
//
// POST ボディ (application/x-www-form-urlencoded):
//   f.req=<percent-encoded JSON>&        ← キーは f.req ただ 1 つ。末尾に裸の & が付く
//   デコード後:
//     [[ [ "i0OFE", <argsを更にJSON文字列化したもの>, null, <slotId> ] ]]
//   slotId は "1" / "3" / "generic" が観測されている。レスポンスの wrb.fr[6] に
//   そのままエコーされるだけなので任意文字列でよい。本ファイルは "generic" を使う。
//
// -----------------------------------------------------------------------------
// 2. args (i0OFE の引数配列) の各要素 — 実験で確定させた内容
// -----------------------------------------------------------------------------
//   args = [ null, null, geo, newsCount, hl, hours ]        (6 要素)
//   args = [ null, null, geo, newsCount, hl, hours, 1 ]     (7 要素。末尾 1 は無意味)
//
//   [0] null   … 全観測で null。意味不明。null 固定でよい。
//   [1] null   … 全観測で null。意味不明。null 固定でよい。
//   [2] geo    … string。国コード "JP"/"IE"/"US" または下位地域コード "JP-13"/"JP-27"。
//                DqDTgb (地域ピッカー) と同じコード体系。**必須**。
//                不正値 ("XX") を渡すと HTTP は 200 のまま RPC 単位のエラーになる (§4)。
//   [3] newsCount … int。**「各トレンドに展開するニュース記事の最大件数」**。
//                ★これが本調査の最大の発見。HAR ではブラウザが常に 0 を送っていたため
//                  「カテゴリフィルタ?」と推測されていたが、カテゴリとは無関係。
//                実測 (2026-09-09, geo=JP, hours=4):
//                  0  → item[1] は全アイテムで null。レスポンス 13,195 バイト。
//                  1  → item[1] に記事 1 件の配列。66 アイテム中 61 件が非 null。30,414 バイト。
//                  16 → item[1] に最大 16 件。227,895 バイト。
//                  17 → item[1] に最大 17 件。232,356 バイト。
//                件数・カテゴリ分布・開始時刻分布は newsCount を変えても変化しない
//                (0 と 17 でどちらも 65 アイテム、cats も一致) ので、絞り込みではなく
//                「ニュースをどれだけ hydrate するか」のノブである。
//                item[11] (記事 ID のみの参照配列) とは独立で、長さも一致しない
//                (例: "石神井川" は item[1] が 16 件なのに item[11] は 3 件)。
//   [4] hl     … string。UI 言語 ("ja"/"en")。ニュース見出しや表示語の言語に効く。
//   [5] hours  … int。**遡る時間窓 (時間単位)**。確定。
//                実測 (geo=JP, 2026-09-09):
//                  hours=4   → 65 アイテム   / start の幅 3.17h  / 13KB
//                  hours=24  → 428 アイテム  / start の幅 22.50h / 102KB
//                  hours=48  → 777 アイテム  / start の幅 47.17h / 193KB
//                  hours=168 → 2,491 アイテム/ start の幅 166.83h / 647KB
//                再測 (同日、時刻が数時間ずれた別測定): hours=4 → 52 件 / 13KB、
//                  hours=24 → 439 件 / start の幅 23.67h / 109KB。
//                  **件数は時々刻々変わるので絶対値に依存しないこと。**
//                  安定して成り立つ不変条件は「最も古い start が概ね hours 時間前まで
//                  遡り、hours+1 時間より前には遡らない」こと (実測: hours=4 で 3.92h、
//                  hours=24 で 23.86h)。テスト 6 はこの不変条件を検証している。
//                ブラウザ UI は 4 を送り、/trending の HTML 埋め込み (ds:0) は 24。
//                168 (7日) まで 200 で通ることを確認済み。上限値は未検証。
//   [6] 1 (任意) … 付けても付けなくてもペイロードは同一。HAR の 11_entry402 (6要素) と
//                12_entry405 (7要素) の 95 アイテムが順序含め完全一致。ライブでも
//                6 要素/7 要素で同一結果を確認。**省略してよい**。
//
// -----------------------------------------------------------------------------
// 3. レスポンス封筒 (batchexecute 共通)
// -----------------------------------------------------------------------------
//   HTTP 200 / content-type: application/json; charset=utf-8
//   content-disposition: attachment; filename="response.bin" (fetch では無害)
//
//   )]}'\n          ← 4 文字 + LF
//   \n              ← 空行 (ここまで 6 文字)
//   <10進長さ>\n<チャンクJSON>\n
//   <10進長さ>\n<チャンクJSON>\n
//   ...
//
//   ★長さ行の単位は **UTF-16 コードユニット (JS の String.length)**。UTF-8 バイトではない。
//     厳密な規則: 長さ数字列を終端する LF の位置を nl、値を N とすると
//       body.slice(nl, nl + N) === "\n" + <チャンクJSON> + "\n"
//     すなわち JSON は body.slice(nl+1, nl+N-1) で、その長さは N-2。
//     次の長さ行は nl + N から始まる。「LF を読み飛ばして N 文字読む」と 1 文字ずれる。
//
//   チャンク内アイテムは 4 種:
//     ["wrb.fr", rpcid, payloadJSONString|null, null, null, errInfo|null, slotId]  (arity 7)
//     ["di", n]                                                                    (arity 2)
//     ["af.httprm", n, "<乱数10進文字列>", m]                                       (arity 4)
//     ["e", k, null, null, T]                                                      (arity 5)
//   ★終端の "e" チャンクの T は **レスポンスボディ全体の UTF-8 バイト長**。
//     つまり同一レスポンス内で長さ行 (UTF-16) と e (UTF-8) の単位が混在している。
//   チャンク境界はフラッシュ点にすぎず意味を持たないので必ず平坦化してから
//   [0]==="wrb.fr" を拾うこと。また複数 RPC をバッチした場合、レスポンス順は
//   リクエスト順と一致しない (rpcid か slotId で突き合わせること)。
//   ペイロードは二段 JSON (wrb.fr[2] が JSON 文字列)。
//
//   3.1 rt=c を **省略** したときの形式 (2026-09-09 ライブ実測)
//   ---------------------------------------------------------------------------
//   同じ POST から rt を落とすだけで、レスポンスは長さ行の無い素の JSON になる:
//
//     )]}'\n\n[["wrb.fr","i0OFE","<payload JSON string>",null,null,null,"generic"],
//              ["di",81],["af.httprm",80,"203535826010736274",16]]
//
//   * プレフィックス `)]}'\n\n` (6 文字) は rt の有無に関わらず必ず付く。
//   * 6 文字目以降は **チャンク配列そのものが JSON 1 個** なので
//     `JSON.parse(body.slice(6))` だけで全アイテムが取れる。
//   * 長さ行が無い ⇒ §3 の UTF-16/UTF-8 の罠を踏まずに済む。
//   * 終端の ["e",k,null,null,T] チャンクは **付かない**。ボディ長の自己申告は無い。
//   * content-type は rt=c 時と同じ application/json; charset=utf-8。
//   → **薄いラッパーを書くなら rt を送らないのが最も安全**。本ファイルはテスト 6 で
//     この形式を、テスト 2 で rt=c 形式を、それぞれ実際に検証している。
//
// -----------------------------------------------------------------------------
// 4. RPC 単位のエラー表現 (ライブで意図的に発生させて確定)
// -----------------------------------------------------------------------------
//   args[2] に存在しない geo ("XX") を渡すと:
//     HTTP は **200**。ボディは 140 バイト。wrb.fr は
//       ["wrb.fr", "i0OFE", null, null, null, [3], "generic"]
//     つまり **wrb.fr[2] (ペイロード) が null**、**wrb.fr[5] にエラーコード配列 [3]**。
//   → ラッパーは HTTP status だけでなく wrb.fr[2] === null を必ずチェックすること。
//     3 が何を表すか (INVALID_ARGUMENT 相当?) は未確定。
//
// -----------------------------------------------------------------------------
// 5. ペイロード (i0OFE) の配列レイアウト
// -----------------------------------------------------------------------------
//   payload = [ null, items ]              … トップは常に長さ 2、[0] は全観測で null
//   items[i] は **arity 13 固定** (HAR 279/279、ライブでも全件 13)。
//
//   idx | 型                       | 意味
//   ----+--------------------------+--------------------------------------------------
//    0  | string                   | 表示用トレンド語。例 "石神井川" / "時のオカリナ"
//    1  | null | NewsArticle[]     | args[3] (newsCount) が 0 なら常に null。
//       |                          | >0 なら最大 newsCount 件のニュース記事 (下記)。
//       |                          | 記事が無いトレンドでは >0 でも null になりうる。
//    2  | string                   | geo コード。リクエストの args[2] と同値
//    3  | [int]                    | **トレンド開始 Unix 秒** (要素 1 個の配列)。
//       |                          | 全観測で 600 の倍数 (10 分刻み)
//    4  | [int] | null             | **トレンド終了 Unix 秒。null は「継続中」**。
//       |                          | HAR 279 件中 125 件が null。値ありは常に > start、
//       |                          | 継続時間は最短 0.33h / 最長 3.17h (hours=4 時)
//    5  | null                     | 全観測 null
//    6  | int                      | **検索ボリュームの下限値**。UI の「5万+ 件の検索」。
//       |                          | HAR (hours=4) 実測値域 {100,200,500,1000,2000,5000,
//       |                          | 10000,20000,50000}。ライブ hours=24 では上に
//       |                          | {100000,200000,1000000} も観測。1,2,5 系列の
//       |                          | 10 進閾値であって実数ではない。最小は 100。
//    7  | null                     | 全観測 null
//    8  | int                      | **増加率 (%)**。UI の「+1,000%」。HAR 実測値域
//       |                          | {50,75,100,200,300,400,500,600,700,800,900,1000}
//    9  | string[]                 | **関連クエリ (trend breakdown)**。空配列は観測なし。
//       |                          | **[9][0] は必ず [0] と一致** (HAR 279/279)
//   10  | int[]                    | **カテゴリ ID (1〜3 個)**。下の対応表参照
//   11  | [int,string,string][]    | **関連ニュース記事の参照** [記事ID, 言語, geo]。
//       |                          | ID のみで本文・URL・画像は含まない。idx 1 とは
//       |                          | 別物で長さも一致しない
//   12  | string                   | **正規化キー**。[0] から Unicode 結合文字 (\p{Mn}) を
//       |                          | 除去したもの。NFD → \p{Mn} 除去 → NFC で 279/279 一致。
//       |                          | 濁点/半濁点だけでなくラテン文字のアクセントも落ちる
//       |                          | ("séamus coleman" → "seamus coleman")。ソート用と推定
//
//   NewsArticle (items[i][1] の要素) — arity 4 または 5:
//     [0] string        記事タイトル
//     [1] string        記事 URL (媒体の実 URL。Google のリダイレクタではない)
//     [2] string        媒体名 ("Nintendo" / "ウェザーニュース" / "Yahoo!ニュース")
//     [3] [int]         公開時刻 Unix 秒 (要素 1 個の配列)
//     [4] string (任意) サムネイル画像 URL (encrypted-tbnN.gstatic.com)。
//                       画像が無い記事は arity 4 になり、この要素ごと存在しない
//
//   カテゴリ ID (idx 10) — HAR 実データから推定した対応 (ラベル文字列はどのレスポンスにも
//   含まれないため、日本語/英語の実例からの推定である点に注意):
//     2=不明 / 3=Business & Finance / 4=Entertainment / 6=Games /
//     8=Hobbies & Leisure / 9=Jobs & Education / 10=Law & Government / 11=Other /
//     14=Science か Politics (未確定) / 16=不明 / 17=Sports / 18=Technology /
//     20=Climate & Weather
//   出現集合の実測 (訂正済み。以前の記述は 2 を取りこぼしていた):
//     HAR (JP, hours=4, 95 件)      = {2,3,4,6,8,9,10,11,14,16,17,18,20}
//     HAR (IE, hours=4, 14 件)      = {3,4,6,10,11,17,18}
//     HAR 6 レスポンス全 279 件の和 = {2,3,4,6,8,9,10,11,14,16,17,18,20}
//     ライブ (JP, hours=24, 439 件) = {1,2,3,4,5,6,7,8,9,10,11,13,14,15,16,17,18,19,20}
//       … 12 だけ未観測。ID の実効レンジは 1〜20 とみてよい。
//     1 アイテムあたりの個数は 1〜3 個 (HAR 279 件: 1個=255, 2個=22, 3個=2。
//     ライブ 439 件でも 1〜3 個)。第 1 要素が主カテゴリらしい。
//
// -----------------------------------------------------------------------------
// 6. ページング / 件数上限
// -----------------------------------------------------------------------------
//   **ページングの仕組みは無い。** 1 リクエストで時間窓内の全件が返る。
//   件数は hours にほぼ比例して増える (JP の一測定: 4h→65, 24h→428, 48h→777, 168h→2491。
//   数時間後の再測では 4h→52, 24h→439 だった。**絶対値は時刻依存なので当てにしない**)。
//   cursor / offset / limit に相当する引数は観測されていない。
//   件数を絞りたければクライアント側で item[6] (ボリューム) 等でフィルタするしかない。
//   並び順は「開始時刻順」でも「ボリューム降順」でも「継続中が先」でもない
//   (HAR 6 レスポンスすべてで検証)。**順序に依存した実装をしないこと。**
//
// -----------------------------------------------------------------------------
// 7. RSS フィード (軽量な代替)
// -----------------------------------------------------------------------------
//   GET https://trends.google.com/trending/rss?geo=JP
//     → 200 / text/xml; charset=utf-8 / 約 19KB / Cookie 不要
//   ルート: <rss version="2.0" xmlns:atom=... xmlns:ht="https://trends.google.com/trending/rss">
//   <channel> の <title> は "Daily Search Trends"、<description> は "Recent searches"。
//   <item> は **ちょうど 10 件** (件数指定パラメータは見つかっていない)。各 item:
//     <title>              … トレンド語
//     <ht:approx_traffic>  … "100+" / "200+" / "500+" / "2000+" のような閾値文字列
//     <description/>       … 常に空
//     <link>               … フィード自身の URL (無意味。個別ページへのリンクではない)
//     <pubDate>            … RFC822。**オフセットは -0700 固定** (米国太平洋時間)。
//                            geo=JP でも -0700 なので、ローカル時刻とみなさず必ず
//                            オフセット込みでパースすること
//     <ht:picture>         … サムネイル URL (https://encrypted-tbnN.gstatic.com/images?q=...)。
//                            ★**必ず存在するとは限らない**。2026-09-09 の実行中に
//                            この要素が欠落した item を実際に踏んで検証テストが落ちた。
//                            通常は 10/10 件に存在するが、画像の無いトレンドでは
//                            要素ごと欠落 (または空タグ) になりうる。**任意として扱うこと。**
//     <ht:picture_source>  … 画像の出典媒体名。同じく任意扱いが安全
//     <ht:news_item> × **0〜3 件 (上限 3、可変)**
//        <ht:news_item_title> / <ht:news_item_snippet> (常に空) /
//        <ht:news_item_url> / <ht:news_item_picture> (要素は必ず存在するが中身が空のことがある) /
//        <ht:news_item_source>
//        ★訂正の経緯 (2026-09-09、2 度誤っている):
//          誤1「いずれのフィードでも常に 3 件」→ ニュース 0 件の item を踏んで否定。
//          誤2「0 件か 3 件の二値」      → 1 件・2 件の item を踏んで否定。
//          いずれも 1 回のサンプルからの過剰な一般化が原因。
//          確定: **0〜3 の可変**。geo=JP×2 + US + GB の計 40 item での分布は
//                0件=4 / 1件=1 / 2件=3 / 3件=34 (3 件が多数派だが保証はない)。
//          → **0〜2 件の item をすべて許容する実装にすること。**
//   実測 (2026-09-09): geo=JP 14.6KB / geo=US 21.2KB、いずれも item 10 件固定・
//   pubDate オフセット -0700。
//   i0OFE と違い開始/終了時刻・増加率・カテゴリ・関連クエリは取れない。
//   逆に i0OFE の newsCount=0 では取れないニュース URL/画像/媒体名が最初から入る。
//   ★XML パーサは不要。<item>…</item> と各タグを正規表現で拾えば足りる
//     (本ファイルのテスト 8 が実際にその方法だけで検証している)。
//
// -----------------------------------------------------------------------------
// 8. レート制限と落とし穴
// -----------------------------------------------------------------------------
//   * batchexecute は Cookie も reCAPTCHA も不要で、本調査中 429 は一度も観測されなかった。
//     ただし /trends/api/* 系は Cookie 無しだと即 429 になるため、同一 IP からの
//     高頻度アクセスは避けること。429 は content-type: text/html で返り Retry-After は無い。
//     → 成功判定は `status===200 && content-type が application/json` で行う。
//   * Deno のテストは未消費のレスポンスボディでリソースリークになる。必ず
//     res.text() / res.json() で消費するか res.body?.cancel() すること。
//   * 長さ行を TextEncoder でバイト数として数えると日本語で破綻する (§3)。
//   * item[3]/item[4] は「数値」ではなく「要素 1 個の配列」。剥がし忘れに注意。
//   * hours を大きくするとレスポンスが数百 KB〜数 MB になる。newsCount を同時に
//     大きくすると容易に 10MB を超えるので併用時は注意 (hours=4/newsCount=17 で 232KB)。
//   * RSS の <ht:picture> のように「普段は必ずあるが稀に欠ける」要素がある。
//     一覧系のフィールドは基本的に **optional 前提** でパースすること (§7)。
//   * 秘密情報 (実 Cookie 値, reCAPTCHA トークン) はこのファイルに一切含まれていない。
//
// -----------------------------------------------------------------------------
// 9. 本ファイルのテスト構成 (何がどこで証明されているか)
// -----------------------------------------------------------------------------
//   1 封筒パーサ規則 (UTF-16 長さ行)            … オフライン。ネットワーク不要
//   2 JP/hours=4/newsCount=0 の配列レイアウト   … ライブ 1 req。§5 の全インデックス
//   3 args[3]=newsCount がニュース展開件数      … ライブ 1 req。§2 [3]
//   4 不正 geo の RPC エラー表現                … ライブ 1 req。§4
//   5 旧 API の 404 / 旧 UI の 302              … ライブ 3 req。§0
//   6 rt 省略時の素 JSON 形式 + args[5]=hours   … ライブ 1 req。§3.1 と §2 [5]
//   7 /trending HTML の ds:0 埋め込み           … ライブ 1 req。§0 (B)
//   8 RSS のスキーマ                            … ライブ 1 req。§7
//   合計 9 リクエスト / 実行 1 回。ライブ系は 429・ネットワーク断で console.warn を
//   出して skip する (ハードに落ちない)。逆に **レスポンスが取れたときは必ず
//   構造アサーションを通す**ので、status だけ見て通るテストは 1 つも無い。
//
//   未検証 / 不明として残っている点 (正直に列挙):
//     * args[0] / args[1] の意味 (全観測 null)
//     * hours の上限値 (168 まで 200 は確認済み。それ以上は未検証)
//     * カテゴリ ID のラベル文字列 (どのレスポンスにも含まれない。§5 の対応は推定)
//     * RPC エラーコード [3] の正確な意味
//     * RSS の件数 (10) を変えるパラメータの有無
// =============================================================================

import { assert, assertEquals } from "jsr:@std/assert@^1";

const ORIGIN = "https://trends.google.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 連続リクエストの間隔を最低 1.5 秒空ける (同一 IP からの多重検証を想定した配慮) */
let lastFetchAt = 0;
async function politeFetch(url: string, init?: RequestInit): Promise<Response> {
  const wait = 1500 - (Date.now() - lastFetchAt);
  if (wait > 0) await sleep(wait);
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    lastFetchAt = Date.now();
    if (res.status !== 429 || attempt >= 3) return res;
    await res.body?.cancel();
    await sleep(delay); // 2s -> 4s -> 8s
    delay *= 2;
  }
}

/** ネットワーク断・レート制限で落とさず skip 扱いにするためのラッパ */
async function tryFetch(
  label: string,
  url: string,
  init?: RequestInit,
): Promise<Response | null> {
  try {
    return await politeFetch(url, init);
  } catch (e) {
    console.warn(`[skip] ${label}: ネットワークエラーのため検証をスキップ: ${e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// batchexecute 封筒パーサ (§3 の規則そのままの実装)
// ---------------------------------------------------------------------------
type Envelope = { items: unknown[][]; totalUtf8: number | null };

function parseBatchExecute(text: string): Envelope {
  if (!text.startsWith(")]}'\n\n")) {
    throw new Error("不正なプレフィックス: " + JSON.stringify(text.slice(0, 16)));
  }
  const items: unknown[][] = [];
  let totalUtf8: number | null = null;
  let pos = 6;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) break;
    const digits = text.slice(pos, nl);
    if (!/^\d+$/.test(digits)) break;
    const n = Number(digits);
    // ★ 長さ行の値 N は「LF + JSON + LF」を数えた UTF-16 コードユニット数
    const framed = text.slice(nl, nl + n);
    if (framed[0] !== "\n" || framed[framed.length - 1] !== "\n") {
      throw new Error("長さ行の規則に合致しない (UTF-16 単位ではない?)");
    }
    const json = text.slice(nl + 1, nl + n - 1);
    if (json.length !== n - 2) throw new Error("JSON 長 !== N-2");
    for (const it of JSON.parse(json) as unknown[][]) {
      items.push(it);
      if (it[0] === "e") totalUtf8 = it[4] as number;
    }
    pos = nl + n;
  }
  return { items, totalUtf8 };
}

type WrbFr = { rpcid: string; slot: string; payload: unknown | null; error: unknown };

function wrbFrames(env: Envelope): WrbFr[] {
  return env.items
    .filter((it) => it[0] === "wrb.fr")
    .map((it) => ({
      rpcid: it[1] as string,
      slot: it[6] as string,
      payload: it[2] == null ? null : JSON.parse(it[2] as string),
      error: it[5] ?? null,
    }));
}

/**
 * i0OFE を呼ぶ。f.sid / bl / soc-* は意図的に省略している (省略可であることの検証も兼ねる)。
 * @param rt true なら `rt=c` を付けて長さ行付きストリーム形式 (§3)、
 *           false なら rt を送らず素の JSON 配列形式 (§3.1) を要求する。
 */
function buildI0ofeRequest(
  args: unknown[],
  hl: string,
  rt = true,
): { url: string; init: RequestInit } {
  const q = new URLSearchParams({
    rpcids: "i0OFE",
    "source-path": "/trending",
    hl,
    _reqid: String(Math.floor(Math.random() * 100000)),
  });
  if (rt) q.set("rt", "c");
  const fReq = JSON.stringify([[["i0OFE", JSON.stringify(args), null, "generic"]]]);
  return {
    url: `${ORIGIN}/_/TrendsUi/data/batchexecute?${q}`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1",
        origin: ORIGIN,
        referer: `${ORIGIN}/`,
        "user-agent": UA,
        accept: "*/*",
      },
      body: "f.req=" + encodeURIComponent(fReq) + "&",
    },
  };
}

/** items[i][12] の生成規則: NFD → 結合文字 (\p{Mn}) 除去 → NFC。HAR 279/279 で一致 */
function stripCombiningMarks(s: string): string {
  return s.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC");
}

/** レスポンスが JSON (=429 の HTML ではない) か */
function isJson(res: Response): boolean {
  return res.status === 200 &&
    (res.headers.get("content-type") ?? "").startsWith("application/json");
}

// ===========================================================================
// テスト 1: 封筒パーサの規則をオフラインで検証 (ネットワーク不要 / 常に実行される)
// ===========================================================================
Deno.test({
  name: "i0OFE/封筒: 長さ行は UTF-16 コードユニットであり UTF-8 バイトではない (オフライン)",
  fn() {
    // HAR 11_entry402 の先頭アイテムを模した最小ペイロード (日本語入りが重要)
    const payload = JSON.stringify([
      null,
      [[
        "石神井川", null, "JP", [1788870600], null, null, 50000, null, 1000,
        ["石神井川", "氾濫"], [20], [[4816199647, "ja", "JP"]], "石神井川",
      ]],
    ]);
    const chunk1 = JSON.stringify([["wrb.fr", "i0OFE", payload, null, null, null, "generic"]]);
    const chunk2 = JSON.stringify([["di", 42], ["af.httprm", 42, "1234567890", 7]]);
    const body = ")]}'\n\n" +
      `${chunk1.length + 2}\n${chunk1}\n` +
      `${chunk2.length + 2}\n${chunk2}\n`;

    // UTF-16 長と UTF-8 バイト長が食い違うことをまず確認 (この差が罠の本体)
    const utf8Len = new TextEncoder().encode(chunk1).length;
    assert(
      utf8Len > chunk1.length,
      "日本語を含むチャンクは UTF-8 バイト長 > UTF-16 長になるはず",
    );

    const env = parseBatchExecute(body);
    assertEquals(env.items.map((i) => i[0]), ["wrb.fr", "di", "af.httprm"]);
    const frames = wrbFrames(env);
    assertEquals(frames.length, 1);
    assertEquals(frames[0].rpcid, "i0OFE");
    assertEquals(frames[0].slot, "generic");
    const data = frames[0].payload as [null, unknown[][]];
    assertEquals(data.length, 2);
    assertEquals(data[0], null);
    assertEquals(data[1].length, 1);
    assertEquals(data[1][0].length, 13);
    assertEquals(data[1][0][0], "石神井川");
    assertEquals(data[1][0][12], "石神井川");

    // 正規化キーの生成規則 (§5 idx12)
    assertEquals(stripCombiningMarks("男子バレー アジア選手権"), "男子ハレー アシア選手権");
    assertEquals(stripCombiningMarks("デヴィ スカルノ"), "テウィ スカルノ");
    assertEquals(stripCombiningMarks("séamus coleman"), "seamus coleman");
    assertEquals(stripCombiningMarks("時のオカリナ"), "時のオカリナ");
  },
});

// ===========================================================================
// テスト 2: ライブ — geo=JP / hours=4 / newsCount=0 の配列レイアウトを厳密検証
// ===========================================================================
Deno.test({
  name: "i0OFE: JP/hours=4/newsCount=0 のレスポンス配列レイアウト (ライブ)",
  async fn() {
    const HOURS = 4;
    const { url, init } = buildI0ofeRequest([null, null, "JP", 0, "ja", HOURS], "ja");
    const res = await tryFetch("i0OFE JP hours=4", url, init);
    if (!res) return;
    const text = await res.text();
    if (!isJson(res)) {
      console.warn(
        `[skip] i0OFE: status=${res.status} content-type=${res.headers.get("content-type")} ` +
          `— レート制限のため未検証`,
      );
      return;
    }

    const env = parseBatchExecute(text);
    // 封筒: 4 種のアイテムのみ / 終端 e の値は本文全体の UTF-8 バイト長
    for (const it of env.items) {
      assert(
        ["wrb.fr", "di", "af.httprm", "e"].includes(it[0] as string),
        `未知のチャンクアイテム種別: ${String(it[0])}`,
      );
    }
    assertEquals(
      env.totalUtf8,
      new TextEncoder().encode(text).length,
      '終端 ["e",k,null,null,T] の T はボディ全体の UTF-8 バイト長のはず',
    );

    const frames = wrbFrames(env);
    assertEquals(frames.length, 1);
    assertEquals(frames[0].rpcid, "i0OFE");
    assertEquals(frames[0].slot, "generic", "slotId はリクエストの call[3] がエコーされる");
    assertEquals(frames[0].error, null);
    assert(frames[0].payload !== null, "正常時 wrb.fr[2] は非 null");

    const payload = frames[0].payload as unknown[];
    assertEquals(payload.length, 2, "ペイロードは [null, items] の長さ 2");
    assertEquals(payload[0], null, "ペイロード [0] は常に null");
    const items = payload[1] as unknown[][];
    assert(Array.isArray(items), "ペイロード [1] は配列");
    assert(items.length > 0, "アイテムが 1 件も無い (地域/時間帯によっては起こりうる)");
    console.log(`  [info] JP hours=${HOURS}: ${items.length} 件 / ${text.length} 文字`);

    const nowSec = Math.floor(Date.now() / 1000);
    let ongoing = 0;
    const catIds = new Set<number>();
    const volumes = new Set<number>();

    for (const it of items) {
      assertEquals(it.length, 13, "アイテムは arity 13 固定");

      // [0] タイトル
      assert(typeof it[0] === "string" && (it[0] as string).length > 0);
      // [1] newsCount=0 なので必ず null
      assertEquals(it[1], null, "newsCount=0 のとき index 1 は null");
      // [2] geo
      assertEquals(it[2], "JP");
      // [3] 開始 epoch 秒 (要素 1 個の配列 / 10 分刻み)
      const start = it[3] as number[];
      assert(Array.isArray(start) && start.length === 1, "index 3 は要素 1 個の配列");
      assert(Number.isInteger(start[0]) && start[0] > 1_500_000_000);
      assertEquals(start[0] % 600, 0, "開始時刻は 600 秒 (10 分) の倍数");
      assert(
        start[0] >= nowSec - (HOURS + 2) * 3600,
        `hours=${HOURS} の窓を大きく外れた開始時刻: ${new Date(start[0] * 1000).toISOString()}`,
      );
      // [4] 終了 epoch 秒 または null (継続中)
      if (it[4] === null) {
        ongoing++;
      } else {
        const end = it[4] as number[];
        assert(Array.isArray(end) && end.length === 1, "index 4 は要素 1 個の配列か null");
        assertEquals(end[0] % 600, 0, "終了時刻も 600 秒の倍数");
        assert(end[0] > start[0], "終了時刻は開始時刻より後");
      }
      // [5] / [7] は常に null
      assertEquals(it[5], null);
      assertEquals(it[7], null);
      // [6] 検索ボリューム下限
      assert(Number.isInteger(it[6]) && (it[6] as number) >= 100, `index 6 が不正: ${it[6]}`);
      volumes.add(it[6] as number);
      // [8] 増加率 %
      assert(Number.isInteger(it[8]) && (it[8] as number) > 0, `index 8 が不正: ${it[8]}`);
      // [9] 関連クエリ。先頭は必ずタイトルと一致
      const related = it[9] as string[];
      assert(Array.isArray(related) && related.length > 0, "index 9 は非空の文字列配列");
      assert(related.every((s) => typeof s === "string"));
      assertEquals(related[0], it[0], "index 9 の先頭要素は index 0 と一致する");
      // [10] カテゴリ ID
      const cats = it[10] as number[];
      assert(Array.isArray(cats) && cats.length >= 1 && cats.length <= 3, "index 10 は 1〜3 要素");
      for (const c of cats) {
        assert(Number.isInteger(c) && c >= 1 && c <= 40, `カテゴリ ID が想定外: ${c}`);
        catIds.add(c);
      }
      // [11] ニュース記事参照 [記事ID, 言語, geo]
      const refs = it[11] as unknown[][];
      assert(Array.isArray(refs), "index 11 は配列");
      for (const r of refs) {
        assertEquals(r.length, 3, "index 11 の要素は [記事ID, 言語, geo] の 3 要素");
        assert(Number.isInteger(r[0]) && (r[0] as number) > 0);
        assert(typeof r[1] === "string" && (r[1] as string).length >= 2, "言語コード");
        assert(typeof r[2] === "string" && (r[2] as string).length >= 2, "geo コード");
      }
      // [12] 正規化キー = NFD → \p{Mn} 除去 → NFC
      assertEquals(
        it[12],
        stripCombiningMarks(it[0] as string),
        `index 12 の正規化規則に不一致: ${String(it[0])} / ${String(it[12])}`,
      );
    }

    assert(ongoing >= 0 && ongoing <= items.length);
    console.log(
      `  [info] 継続中 (index4=null): ${ongoing}/${items.length}, ` +
        `カテゴリID: ${[...catIds].sort((a, b) => a - b).join(",")}, ` +
        `ボリューム値域: ${[...volumes].sort((a, b) => a - b).join(",")}`,
    );

    // ページングの仕組みが無いこと = ペイロードに cursor/token 相当が無いことの確認
    assertEquals(payload.length, 2, "ページトークンを入れる余地のある 3 番目の要素は存在しない");
  },
});

// ===========================================================================
// テスト 3: ライブ — args[3] (newsCount) がニュース記事の展開件数であることの確認
// ===========================================================================
Deno.test({
  name: "i0OFE: args[3] はニュース記事の最大展開件数 (index 1 が hydrate される) (ライブ)",
  async fn() {
    const NEWS = 3;
    const { url, init } = buildI0ofeRequest([null, null, "JP", NEWS, "ja", 4], "ja");
    const res = await tryFetch("i0OFE newsCount=3", url, init);
    if (!res) return;
    const text = await res.text();
    if (!isJson(res)) {
      console.warn(`[skip] i0OFE newsCount: status=${res.status} — レート制限のため未検証`);
      return;
    }
    const frames = wrbFrames(parseBatchExecute(text));
    assertEquals(frames.length, 1);
    assert(frames[0].payload !== null);
    const items = (frames[0].payload as unknown[])[1] as unknown[][];
    assert(items.length > 0);

    const hydrated = items.filter((it) => it[1] !== null);
    assert(
      hydrated.length > 0,
      "newsCount>0 なのに index 1 が全て null。仕様が変わった可能性がある",
    );
    console.log(`  [info] index1 が非 null: ${hydrated.length}/${items.length} 件`);

    for (const it of hydrated) {
      const news = it[1] as unknown[][];
      assert(Array.isArray(news) && news.length > 0, "index 1 は非空の配列");
      assert(
        news.length <= NEWS,
        `記事件数 ${news.length} が要求した ${NEWS} を超えている`,
      );
      for (const a of news) {
        assert(a.length === 4 || a.length === 5, `記事は arity 4 か 5: ${a.length}`);
        assert(typeof a[0] === "string" && (a[0] as string).length > 0, "記事タイトル");
        assert(
          typeof a[1] === "string" && /^https?:\/\//.test(a[1] as string),
          `記事 URL が絶対 URL でない: ${String(a[1])}`,
        );
        assert(typeof a[2] === "string" && (a[2] as string).length > 0, "媒体名");
        const pub = a[3] as number[];
        assert(
          Array.isArray(pub) && pub.length === 1 && Number.isInteger(pub[0]),
          "公開時刻は要素 1 個の配列",
        );
        assert(pub[0] > 1_500_000_000, "公開時刻 Unix 秒");
        if (a.length === 5) {
          assert(
            typeof a[4] === "string" && /^https?:\/\//.test(a[4] as string),
            "画像 URL",
          );
        }
      }
      // index 11 (ID 参照) は index 1 とは独立で長さも一致しない
      assert(Array.isArray(it[11]), "index 11 は newsCount に関係なく常に存在する");
    }

    // 他のフィールドは newsCount を変えても壊れない
    for (const it of items) {
      assertEquals(it.length, 13);
      assertEquals(it[2], "JP");
      assertEquals(it[5], null);
      assertEquals(it[7], null);
    }
  },
});

// ===========================================================================
// テスト 4: ライブ — 不正 geo のときのエラー表現 (HTTP 200 + wrb.fr[2]=null)
// ===========================================================================
Deno.test({
  name: "i0OFE: 不正な geo は HTTP 200 のまま wrb.fr[2]=null / wrb.fr[5]=[3] になる (ライブ)",
  async fn() {
    const { url, init } = buildI0ofeRequest([null, null, "XX", 0, "ja", 4], "ja");
    const res = await tryFetch("i0OFE invalid geo", url, init);
    if (!res) return;
    const text = await res.text();
    if (!isJson(res)) {
      console.warn(`[skip] i0OFE invalid geo: status=${res.status} — レート制限のため未検証`);
      return;
    }
    // ★ HTTP レベルでは成功扱い
    assertEquals(res.status, 200, "RPC エラーでも HTTP は 200");
    const env = parseBatchExecute(text);
    const frames = wrbFrames(env);
    assertEquals(frames.length, 1);
    assertEquals(frames[0].rpcid, "i0OFE");
    assertEquals(frames[0].payload, null, "エラー時 wrb.fr[2] は null");
    assertEquals(frames[0].error, [3], "エラー時 wrb.fr[5] にエラーコード配列 [3] が入る");
    assertEquals(env.totalUtf8, new TextEncoder().encode(text).length);
  },
});

// ===========================================================================
// テスト 5: ライブ — 旧エンドポイントの現況 (移行ガイド用)
// ===========================================================================
Deno.test({
  name: "旧 dailytrends / realtimetrends は 404、trendingsearches/daily は /trending へ 302 (ライブ)",
  async fn() {
    const hdr = { "user-agent": UA, accept: "*/*" };

    // (1) 旧デイリートレンド API — 廃止済み
    const daily = await tryFetch(
      "dailytrends",
      `${ORIGIN}/trends/api/dailytrends?hl=ja&tz=-540&geo=JP&ns=15`,
      { headers: hdr },
    );
    if (daily) {
      const body = await daily.text();
      if (daily.status === 429) {
        console.warn("[skip] dailytrends: 429 のため未検証");
      } else {
        assertEquals(daily.status, 404, "/trends/api/dailytrends は廃止され 404 を返す");
        assert(
          (daily.headers.get("content-type") ?? "").startsWith("text/html"),
          "404 は JSON ではなく HTML で返る",
        );
        assert(/404/.test(body), "本文に 404 の表記があるはず");
      }
    }

    // (2) 旧リアルタイムトレンド API — 廃止済み
    const rt = await tryFetch(
      "realtimetrends",
      `${ORIGIN}/trends/api/realtimetrends?hl=ja&tz=-540&cat=all&fi=0&fs=0&geo=JP&ri=300&rs=20&sort=0`,
      { headers: hdr },
    );
    if (rt) {
      const body = await rt.text();
      if (rt.status === 429) {
        console.warn("[skip] realtimetrends: 429 のため未検証");
      } else {
        assertEquals(rt.status, 404, "/trends/api/realtimetrends は廃止され 404 を返す");
        assert((rt.headers.get("content-type") ?? "").startsWith("text/html"));
        assert(body.length > 0);
      }
    }

    // (3) 旧デイリートレンド UI — /trending へ 302
    const redir = await tryFetch(
      "trendingsearches/daily",
      `${ORIGIN}/trends/trendingsearches/daily?geo=JP&hl=ja`,
      { headers: hdr, redirect: "manual" },
    );
    if (redir) {
      await redir.body?.cancel();
      if (redir.status === 429) {
        console.warn("[skip] trendingsearches/daily: 429 のため未検証");
      } else {
        assertEquals(redir.status, 302, "旧 UI は 302 でリダイレクトされる");
        assertEquals(
          redir.headers.get("location"),
          `${ORIGIN}/trending?geo=JP&hl=ja`,
          "location は新 Trending Now UI (geo/hl が引き継がれる)",
        );
      }
    }
  },
});

// ===========================================================================
// テスト 6: ライブ — (a) rt=c を省略すると素の JSON 配列で返る (§3.1)
//                    (b) args[5] (hours) が「遡る時間窓 (時間単位)」であること
// 1 リクエストで両方を検証する (レート制限予算の節約)。
// ===========================================================================
Deno.test({
  name: "i0OFE: rt=c 省略時は素の JSON 配列 / args[5]=hours は時間窓である (ライブ)",
  async fn() {
    const HOURS = 24;
    // rt を送らない = §3.1 の形式を要求する
    const { url, init } = buildI0ofeRequest([null, null, "JP", 0, "ja", HOURS], "ja", false);
    assert(!url.includes("rt="), "この検証では rt パラメータを送ってはいけない");
    const res = await tryFetch("i0OFE no-rt hours=24", url, init);
    if (!res) return;
    const text = await res.text();
    if (!isJson(res)) {
      console.warn(`[skip] i0OFE no-rt: status=${res.status} — レート制限のため未検証`);
      return;
    }

    // --- (a) 形式: プレフィックスは同じだが長さ行が無く、以降が JSON 1 個 -------------
    assert(text.startsWith(")]}'\n\n"), "rt 省略時もプレフィックス )]}'\\n\\n は付く");
    assert(
      !/^\d+\n/.test(text.slice(6)),
      "rt 省略時に長さ行が現れた。仕様が変わった可能性がある",
    );
    const chunks = JSON.parse(text.slice(6)) as unknown[][];
    assert(Array.isArray(chunks) && chunks.length > 0, "6 文字目以降は非空の JSON 配列");
    for (const c of chunks) {
      assert(
        ["wrb.fr", "di", "af.httprm", "e"].includes(c[0] as string),
        `未知のチャンク種別: ${String(c[0])}`,
      );
    }
    assertEquals(
      chunks.filter((c) => c[0] === "e").length,
      0,
      "rt 省略時は終端の ['e',k,null,null,T] チャンクが付かない",
    );
    const fr = chunks.find((c) => c[0] === "wrb.fr");
    assert(fr !== undefined, "wrb.fr チャンクが無い");
    assertEquals(fr![1], "i0OFE");
    assertEquals(fr![6], "generic", "slotId はそのままエコーされる");
    assert(fr![2] !== null, "ペイロードが null (RPC エラー)");

    // --- (b) hours の意味: 開始時刻の最古が概ね HOURS 時間前まで遡る -------------------
    const payload = JSON.parse(fr![2] as string) as unknown[];
    assertEquals(payload.length, 2);
    assertEquals(payload[0], null);
    const items = payload[1] as unknown[][];
    assert(items.length > 0, "アイテムが 0 件");

    const nowSec = Math.floor(Date.now() / 1000);
    const starts = items.map((it) => (it[3] as number[])[0]);
    const oldestAgoH = (nowSec - Math.min(...starts)) / 3600;
    const newestAgoH = (nowSec - Math.max(...starts)) / 3600;
    console.log(
      `  [info] hours=${HOURS}: ${items.length} 件 / ${text.length} 文字 / ` +
        `最古 ${oldestAgoH.toFixed(2)}h 前, 最新 ${newestAgoH.toFixed(2)}h 前`,
    );
    // hours=4 のテスト 2 と違い、ここでは 24 時間ぶん遡っていることを積極的に示す
    assert(
      oldestAgoH > 6,
      `hours=${HOURS} なのに最古の開始時刻が ${oldestAgoH.toFixed(2)}h 前しか遡らない。` +
        `args[5] は時間窓ではないかもしれない`,
    );
    assert(
      oldestAgoH <= HOURS + 1,
      `hours=${HOURS} の窓を超えて ${oldestAgoH.toFixed(2)}h 前まで遡っている`,
    );
    assert(newestAgoH < 2, "最新の開始時刻は直近 2 時間以内のはず");

    // hours を変えてもアイテムのスキーマ (arity 13 / 各インデックスの規則) は不変
    let ongoing = 0;
    const cats = new Set<number>();
    for (const it of items) {
      assertEquals(it.length, 13, "hours を変えてもアイテムは arity 13 固定");
      assertEquals(it[1], null, "newsCount=0 なので index 1 は null");
      assertEquals(it[2], "JP");
      assertEquals(it[5], null);
      assertEquals(it[7], null);
      assertEquals((it[3] as number[])[0] % 600, 0, "開始時刻は 600 秒の倍数");
      if (it[4] === null) ongoing++;
      else assert((it[4] as number[])[0] > (it[3] as number[])[0]);
      assertEquals((it[9] as string[])[0], it[0], "index 9 の先頭は index 0 と一致");
      assertEquals(it[12], stripCombiningMarks(it[0] as string), "index 12 の正規化規則");
      const c = it[10] as number[];
      assert(c.length >= 1 && c.length <= 3, `カテゴリは 1〜3 個: ${c.length}`);
      for (const x of c) cats.add(x);
    }
    // hours=4 より広い窓なのでカテゴリの種類も増える (§5 の出現集合の根拠)
    assert(cats.size >= 5, `hours=${HOURS} なのにカテゴリが ${cats.size} 種類しか出ていない`);
    console.log(
      `  [info] 継続中: ${ongoing}/${items.length}, ` +
        `カテゴリID: ${[...cats].sort((a, b) => a - b).join(",")}`,
    );
  },
});

// ===========================================================================
// テスト 7: ライブ — /trending の HTML に埋め込まれた ds:0 が
//           i0OFE と同一構造 (hours=24 / newsCount=0 相当) であること (§0 の (B))
// ===========================================================================
Deno.test({
  name: "/trending の HTML 埋め込み ds:0 は i0OFE と同一構造の [null, items] である (ライブ)",
  async fn() {
    const res = await tryFetch("trending html", `${ORIGIN}/trending?geo=JP&hl=ja`, {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ja,en;q=0.9",
      },
    });
    if (!res) return;
    const html = await res.text();
    if (res.status !== 200 || !(res.headers.get("content-type") ?? "").startsWith("text/html")) {
      console.warn(`[skip] /trending: status=${res.status} — レート制限のため未検証`);
      return;
    }

    // §0 (B) の取り出し規則: 'ds:0' の直後の data: 〜 sideChannel: の手前を JSON.parse
    const at = html.indexOf("AF_initDataCallback({key: 'ds:0'");
    assert(at >= 0, "ds:0 の AF_initDataCallback が見つからない。埋め込み方式が変わった可能性");
    const dataAt = html.indexOf("data:", at);
    const sideAt = html.indexOf("sideChannel:", dataAt);
    assert(dataAt > at && sideAt > dataAt, "data: / sideChannel: の並びが想定と違う");
    const raw = html.slice(dataAt + "data:".length, sideAt).trim().replace(/,$/, "");
    const payload = JSON.parse(raw) as unknown[];

    // i0OFE のペイロードと同じ [null, items]
    assertEquals(payload.length, 2, "ds:0 の data も [null, items] の長さ 2");
    assertEquals(payload[0], null);
    const items = payload[1] as unknown[][];
    assert(Array.isArray(items) && items.length > 0, "items が空");

    const nowSec = Math.floor(Date.now() / 1000);
    const starts = items.map((it) => (it[3] as number[])[0]);
    const oldestAgoH = (nowSec - Math.min(...starts)) / 3600;
    console.log(
      `  [info] ds:0: ${items.length} 件 / HTML ${html.length} 文字 / ` +
        `最古 ${oldestAgoH.toFixed(2)}h 前`,
    );
    // 埋め込みは hours=24 相当で固定 (パラメータで変えられない)
    assert(
      oldestAgoH > 6 && oldestAgoH <= 25,
      `ds:0 の時間窓が 24h 相当でない: 最古 ${oldestAgoH.toFixed(2)}h 前`,
    );

    for (const it of items) {
      assertEquals(it.length, 13, "ds:0 のアイテムも arity 13 固定");
      assertEquals(it[1], null, "ds:0 は newsCount=0 相当なので index 1 は常に null");
      assertEquals(it[2], "JP", "geo はクエリの geo と一致");
      assertEquals(it[5], null);
      assertEquals(it[7], null);
      assertEquals((it[3] as number[])[0] % 600, 0);
      assertEquals((it[9] as string[])[0], it[0], "index 9 の先頭は index 0 と一致");
      assertEquals(it[12], stripCombiningMarks(it[0] as string), "index 12 の正規化規則");
    }

    // ds:1 は geo のローカライズ表示名 (hl=ja なので "日本")
    const at1 = html.indexOf("AF_initDataCallback({key: 'ds:1'");
    if (at1 >= 0) {
      const d1 = html.indexOf("data:", at1);
      const s1 = html.indexOf("sideChannel:", d1);
      const v1 = JSON.parse(html.slice(d1 + 5, s1).trim().replace(/,$/, "")) as unknown[];
      assertEquals(v1.length, 1, "ds:1 は要素 1 個の配列");
      assert(typeof v1[0] === "string" && (v1[0] as string).length > 0, "ds:1[0] は geo の表示名");
      console.log(`  [info] ds:1 (geo 表示名): ${JSON.stringify(v1[0])}`);
    } else {
      console.warn("[info] ds:1 は見つからなかった (必須ではない)");
    }
  },
});

// ===========================================================================
// テスト 8: ライブ — RSS フィードのスキーマ (軽量ラッパーの最有力候補)
// ===========================================================================
Deno.test({
  name: "Trending RSS (/trending/rss?geo=JP) は生きており ht: 名前空間のスキーマを持つ (ライブ)",
  async fn() {
    const res = await tryFetch("trending/rss", `${ORIGIN}/trending/rss?geo=JP`, {
      headers: { "user-agent": UA, accept: "*/*" },
    });
    if (!res) return;
    const xml = await res.text();
    if (res.status !== 200) {
      console.warn(`[skip] RSS: status=${res.status} — レート制限のため未検証`);
      return;
    }
    assert(
      (res.headers.get("content-type") ?? "").startsWith("text/xml"),
      `content-type は text/xml のはず: ${res.headers.get("content-type")}`,
    );
    assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8"'), "XML 宣言");
    assert(
      xml.includes('xmlns:ht="https://trends.google.com/trending/rss"'),
      "ht 名前空間の宣言",
    );
    assert(xml.includes("<rss") && xml.includes('version="2.0"'), "RSS 2.0");
    assert(xml.includes("<title>Daily Search Trends</title>"), "channel のタイトルは固定文字列");

    // 正規表現のみでパース (DOM パーサ・外部ライブラリ不要)
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    console.log(`  [info] RSS item 数: ${items.length}`);
    assertEquals(items.length, 10, "RSS は 10 件固定 (件数指定パラメータは見つかっていない)");

    const pick = (s: string, tag: string) =>
      s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? null;

    // ★ <ht:picture> / <ht:picture_source> / <ht:news_item_picture> は
    //   **欠落しうる** (2026-09-09 の実行で実際に踏んだ)。個々の item では任意とし、
    //   フィード全体で最低 1 件は存在することをループ後にまとめて検証する。
    let picCount = 0;
    let picSourceCount = 0;
    let newsPicCount = 0;
    let newsTotal = 0;
    let maxNewsPerItem = 0;

    for (const item of items) {
      const title = pick(item, "title");
      assert(title !== null && title.length > 0, "<title> はトレンド語");

      const traffic = pick(item, "ht:approx_traffic");
      assert(
        traffic !== null && /^[\d,]+\+$/.test(traffic),
        `<ht:approx_traffic> は "500+" 形式のはず: ${String(traffic)}`,
      );

      const pubDate = pick(item, "pubDate");
      assert(pubDate !== null, "<pubDate> が必要");
      assert(
        /[+-]\d{4}$/.test(pubDate),
        `<pubDate> は RFC822 でオフセット付き (実測は -0700 固定): ${pubDate}`,
      );
      assert(
        !Number.isNaN(Date.parse(pubDate)),
        `<pubDate> がパースできない: ${pubDate}`,
      );

      // <ht:picture> は任意。存在するなら gstatic のサムネイル絶対 URL であること。
      // ★2026-09-09 実測で訂正: <ht:news_item_picture> と同じく、**要素が存在しても中身が空文字**
      //   のことがある (`<ht:picture></ht:picture>`)。空文字を「画像あり」と誤判定しないこと。
      const pic = pick(item, "ht:picture");
      if (pic !== null && pic !== "") {
        assert(
          /^https?:\/\/\S+$/.test(pic),
          `<ht:picture> が絶対 URL でない: ${JSON.stringify(pic)}`,
        );
        assert(
          /\.gstatic\.com\//.test(pic),
          `<ht:picture> は gstatic のサムネイルのはず: ${pic}`,
        );
        picCount++;
      }
      if (pick(item, "ht:picture_source") !== null) picSourceCount++;

      // description は常に空タグ (<description/>)
      assert(
        item.includes("<description/>") || pick(item, "description") === "",
        "<description> は常に空",
      );

      const news = item.match(/<ht:news_item>[\s\S]*?<\/ht:news_item>/g) ?? [];
      // ★ 実測 (2026-09-09): 件数は **0〜3 の任意の値**。上限は 3。
      //    geo=JP × 2 回 + US + GB の計 40 item での分布: 0件=4, 1件=1, 2件=3, 3件=34。
      //    観測例 geo=JP: [3,3,3,3,1,3,3,0,3,0] / [3,3,3,3,3,2,3,3,0,0]
      //                geo=US, GB: 全 item が 3 件。
      //    ※調査の途中で「常に 3 件」→「0 か 3 の二値」と 2 度誤った結論を出している。
      //      どちらも 1 回のサンプルからの過剰な一般化が原因。
      //      正しくは **0〜3 の可変** で、3 件が多数派 (34/40) というだけ。
      //      ラッパーは 0 件・1 件・2 件の item をすべて許容すること。
      assert(
        news.length >= 0 && news.length <= 3,
        `各 item のニュースは 0〜3 件 (上限 3): ${news.length}`,
      );
      maxNewsPerItem = Math.max(maxNewsPerItem, news.length);
      newsTotal += news.length;
      for (const n of news) {
        const nt = pick(n, "ht:news_item_title");
        const nu = pick(n, "ht:news_item_url");
        const ns = pick(n, "ht:news_item_source");
        assert(nt !== null && nt.length > 0, "ニュース見出し");
        assert(nu !== null && /^https?:\/\//.test(nu), `ニュース URL: ${String(nu)}`);
        // Google のリダイレクタではなく媒体の実 URL が入る (i0OFE と同じ)
        assert(
          !/^https?:\/\/(www\.)?google\.com\/url\?/.test(nu),
          `ニュース URL がリダイレクタになっている: ${nu}`,
        );
        assert(ns !== null && ns.length > 0, "ニュース媒体名");
        assert(
          n.includes("<ht:news_item_snippet/>") ||
            pick(n, "ht:news_item_snippet") === "",
          "<ht:news_item_snippet> は常に空 (要素自体は必ず存在する)",
        );
        // ★ 実測 (2026-09-09): <ht:news_item_picture> は **要素としては必ず存在する** が、
        //    中身が空文字のことがある (geo=JP の news_item 21 件中 1 件が
        //    `<ht:news_item_picture></ht:news_item_picture>`)。
        //    自己閉じタグ形式でも、要素ごとの欠落でもない点に注意。
        //    → ラッパーは「空文字 = 画像なし」として null に正規化すること。
        const np = pick(n, "ht:news_item_picture");
        if (np !== null && np !== "") {
          assert(/^https?:\/\/\S+$/.test(np), `ニュース画像 URL: ${np}`);
          newsPicCount++;
        }
      }
    }

    // 欠落しうる要素も「スキーマに存在する」ことはフィード全体で確認する
    assertEquals(
      maxNewsPerItem,
      3,
      "<ht:news_item> の上限は 3 件 (0 件の item は存在するが、付く場合は必ず 3 件)",
    );
    assert(picCount >= 1, "フィード全体で <ht:picture> が 1 件も無い。スキーマが変わった可能性");
    assert(picSourceCount >= 1, "フィード全体で <ht:picture_source> が 1 件も無い");
    assert(newsPicCount >= 1, "フィード全体で <ht:news_item_picture> が 1 件も無い");
    console.log(
      `  [info] RSS: ニュース計 ${newsTotal} 件 (最大 ${maxNewsPerItem} 件/item), ` +
        `<ht:picture> あり ${picCount}/${items.length} 件, ` +
        `<ht:picture_source> あり ${picSourceCount}/${items.length} 件, ` +
        `ニュース画像 ${newsPicCount}/${newsTotal} 件`,
    );
  },
});
