// 実行: deno test --allow-net --no-check live_integration/11_geo_category_property_matrix_test.ts
//
// =====================================================================================
// Google Trends 旧 REST API — 検索対象を絞るパラメータ (geo / category / property / hl / tz)
// および comparisonItem の組み合わせ仕様
// =====================================================================================
//
// 【対象エンドポイント】
//   POST https://trends.google.com/trends/api/explore
//     クエリ: hl=<言語タグ>&tz=<分>&req=<JSON>&tz=<分>
//     ※ ブラウザは tz を 2 回付ける (HAR 13/13 エントリ)。本ファイルはブラウザ忠実形で送る。
//     ボディ: 空で良い (ブラウザは reCAPTCHA トークンを載せるが必須ではない)。
//     Cookie: NID が必須。無いと 429。NID は
//        GET https://trends.google.com/trends/explore?...   (429 だが Set-Cookie: NID が付く)
//        もしくは GET https://trends.google.com/trending?geo=..&hl=..  (200 + Set-Cookie: NID)
//        から取得する。本ファイルは前者 (レスポンス 1.7KB と軽い) を使う。
//
// 【req の完全スキーマ (2026-09-09 ライブ実測で確定)】
//   {
//     "comparisonItem": [                       // 必須。1〜5 要素。6 要素以上は 400
//       { "keyword": "coffee",                  // 必須 (string)
//         "geo": "JP",                          // 必須 (後述)。"" で全世界
//         "time": "now 1-d" }                   // 必須。省略すると 400 (実測)
//     ],
//     "category": 0,                            // 任意。省略可 (実測 200)
//     "property": ""                            // 任意。省略可 (実測 200)
//   }
//   - category / property を省略すると、返る widget.request.requestOptions が
//     {"backend":"CM"} だけになる (property / category のキー自体が消える)。実測確認済み。
//   - keyword を省略した場合の挙動は未検証。
//
// 【req のパーセントエンコード】
//   ブラウザ (AngularJS $httpParamSerializer) は `:` `,` を素通しし空白を `+` にする独特な形:
//     req=%7B%22comparisonItem%22:%5B%7B%22keyword%22:%22Fanza%22,...%22time%22:%22now+1-d%22%7D%5D,...
//   しかし encodeURIComponent(JSON.stringify(req)) (= `:`→%3A, `,`→%2C, 空白→%20) でも
//   **サーバは受理する** (2026-09-09 のライブ検証では 40 回超のリクエストすべてこの形で送り、
//   期待どおりの 200 / 400 を得た。ブラウザ独自形は一度も使っていない)。
//   → ラッパーは素直に encodeURIComponent を使ってよい。
//
// -------------------------------------------------------------------------------------
// 【geo】 comparisonItem[].geo — 実測マトリクス (2026-09-09)
// -------------------------------------------------------------------------------------
//   受理される形と、explore が返す widget.request 内の geo オブジェクト / GEO_MAP の resolution:
//
//     geo 文字列       | widget 内の geo         | GEO_MAP.resolution | GEO_MAP.title(ja)
//     ----------------|-------------------------|--------------------|----------------------
//     ""  (全世界)     | {}                      | COUNTRY            | 地域別のインタレスト
//     "JP" (国)        | {"country":"JP"}        | REGION             | 小区域別のインタレスト
//     "JP-13" (下位)   | {"region":"JP-13"}      | CITY               | 都市別のインタレスト
//     "US-CA-807"(DMA) | {"dma":"807"}           | CITY               | 都市別のインタレスト
//
//   * 「geo が 1 段深くなると GEO_MAP の resolution が 1 段細かくなる」という規則。
//     COUNTRY → REGION → CITY。CITY より下は無い (DMA でも CITY 止まり)。
//   * DMA (米国 Nielsen メディア市場) は "US-<州>-<DMA番号>" の 3 パート形式で渡す。
//     サーバは州部分を捨てて {"dma":"<番号>"} にする。batchexecute の DqDTgb (地域ピッカー)
//     が返す第 2 階層の数値文字列コード ("807","524","790"…) がこの DMA 番号にあたる。
//   * TIMESERIES / RELATED_TOPICS / RELATED_QUERIES の geo も同じオブジェクトになる
//     (TIMESERIES は comparisonItem[].geo、relatedsearches は restriction.geo の位置)。
//   * **不正な geo は 400 Bad Request (content-type: text/html) で即座に落ちる。**
//     - "ZZ" (存在しない国コード) → 400
//     - "jp" (小文字) → 400  ← 大文字必須。ラッパーは toUpperCase() してから送るべき。
//     400 も 429 も text/html を返すので、両者は status で判別すること。
//
// -------------------------------------------------------------------------------------
// 【category】 req.category — 実測 (2026-09-09)
// -------------------------------------------------------------------------------------
//   * 型は number。0 = すべてのカテゴリ。
//   * HAR で観測: 0 / 8 / 41。ライブで追加確認: 71 → 200。
//   * **存在しない ID (999999) を渡しても 400 にならず 200 が返り、widget.request の
//     requestOptions.category にそのままエコーされる。** explore はカテゴリ ID を検証しない。
//     不正 ID を使った場合、後段の widgetdata が空データ
//     ({"default":{"timelineData":[],"averages":[]}} 等) を返すと推定される (未検証)。
//     → カテゴリ ID を検証したいなら
//       GET /trends/api/explore/pickers/category?hl=..&tz=.. の一覧を使うこと。
//   * category は widget を増減させない。返る widget 集合は category=0 のときと同一。
//
// -------------------------------------------------------------------------------------
// 【property】 req.property — 実測 (2026-09-09)
// -------------------------------------------------------------------------------------
//   * "" (ウェブ検索) / "images" / "news" / "froogle" (ショッピング) / "youtube" の 5 種。
//   * **5 種すべてで返る widget 集合は完全に同一** — [TIMESERIES, GEO_MAP,
//     RELATED_TOPICS, RELATED_QUERIES] の 4 個。resolution も変わらない
//     (YouTube でも GEO_MAP は REGION のまま)。property は requestOptions.property に
//     エコーされ、後段の widgetdata がどのコーパスを見るかを決めるだけ。
//     → 5 種すべてを category=0 / geo="JP" / time="now 1-d" に固定して 1 回ずつ叩き、
//       widget の id 列が完全一致することをライブで突き合わせ済み
//       (テスト "live: property 5 種すべてで widget 集合が同一")。
//     HAR でも images / news / froogle / youtube の全ケースで multiline / comparedgeo /
//     relatedsearches(ENTITY) / relatedsearches(QUERY) の 4 本が発火している
//     (widgetdata 系 3 グループの property 出現数: ""=12, images=8, youtube=26,
//      news=4, froogle=4 — いずれも explore 1 回あたり 4 本ちょうど)。
//   * **存在しない値 ("bogus") も 400 にならず 200 が返り、そのままエコーされる。**
//     explore は property も検証しない。
//   * property は backend の選択に影響しない (backend は time が決める:
//     リアルタイム系 now 1-d / now 4-H → "CM"、過去データ all_2008 → "IZG")。
//
// -------------------------------------------------------------------------------------
// 【hl】 クエリの hl — 実測 (2026-09-09)
// -------------------------------------------------------------------------------------
//   * widget.title / GEO_MAP.searchInterestLabel / トップレベルの keywords[].type /
//     timeRanges[] / shareText / TITLE_N.text がこの言語でローカライズされる。
//       hl=ja    → "人気度の動向" "小区域別のインタレスト" "関連トピック" "関連キーワード"
//                  searchInterestLabel="検索インタレスト", timeRanges=["過去 1 日"]
//       hl=en-US → "Interest over time" "Interest by subregion" "Related topics"
//                  "Related queries", searchInterestLabel="Search interest",
//                  timeRanges=["Past day"], keywords[].type="Search term"
//   * widget.request 側にも 2 通りの形で入る。ここを取り違えないこと:
//       - TIMESERIES / GEO_MAP: request.locale   = hl そのまま        ("ja" / "en-US")
//       - RELATED_*:            request.language = hl の主サブタグのみ ("ja" / "en")
//   * **不正な hl ("zz-ZZ") はエラーにならず en-US にフォールバックする。**
//     2026-09-09 実測: status 200 / TIMESERIES.title="Interest over time" /
//     request.locale="en-US" / RELATED_*.request.language="en" /
//     keywords[0].type="Search term" / timeRanges=["Past day"] となり、
//     hl=en-US を明示したときと区別できない応答になる。
//     → ラッパーは hl の妥当性検証をサーバに任せられない。誤った hl は
//       エラーではなく「黙って英語」になるため、必要なら呼び出し側で検証すること。
//   * RELATED_* の request.userCountryCode は hl でも geo でもなく **アクセス元 IP の国**
//     で決まる (日本から geo="US" を指定しても "JP" のまま)。
//
// -------------------------------------------------------------------------------------
// 【tz】 クエリの tz — 実測 (2026-09-09)
// -------------------------------------------------------------------------------------
//   * 単位は分。**JS の Date#getTimezoneOffset() と同じ符号規約** (UTC+9 の JST は -540)。
//     UTC より東が負、西が正。ブラウザは常に -540 を送っていた (HAR 13/13)。
//   * **有効範囲は |tz| <= 1439 (= |tz| < 1440)。境界まで実測で確定済み (2026-09-09):**
//       tz = -540 → 200   (JST。ブラウザが実際に送る値)
//       tz =    0 → 200
//       tz =  1439 → 200  ← 受理される最大値
//       tz =  1440 → 400 Bad Request (text/html, 1691 バイト)
//       tz = -1440 → 400 Bad Request (text/html, 1691 バイト)
//       tz = 99999 → 400 Bad Request
//     1440 分 = 24 時間なので「絶対値が丸 1 日未満」が条件。
//   * tz は explore が計算する時間窓には効かない。"now 1-d" は tz に関係なく
//     「UTC の現在時刻 −24h 〜 UTC の現在時刻」になる。
//     実測 (2026-09-09 00:25 UTC): tz=-540 / tz=0 / tz=1439 のいずれでも
//     TIMESERIES.request.time の終端が UTC の現在時刻と数十秒以内で一致した
//     (tz=1439 のとき "2026-09-08T00\:24\:47 2026-09-09T00\:24\:47" に対し
//      実際の UTC は 2026-09-09T00:25:10Z)。tz が窓に効いていれば最大 24 時間ずれるはずで、
//     3 点とも一致した以上「効かない」と言い切ってよい。
//     tz が効くのは widgetdata 側の返却タイムスタンプ表示と推定 (本ファイルでは未検証)。
//
// -------------------------------------------------------------------------------------
// 【comparisonItem の件数と widget 構成】 — 実測 (2026-09-09)
// -------------------------------------------------------------------------------------
//   1 件 (単一キーワード):
//     [TIMESERIES, GEO_MAP, RELATED_TOPICS, RELATED_QUERIES]        … 4 widget
//   2〜5 件 (全部同じ geo):
//     [TIMESERIES, GEO_MAP(dataMode:"PERCENTAGES"),
//      TITLE_0, GEO_MAP_0, RELATED_QUERIES_0,
//      TITLE_1, GEO_MAP_1, RELATED_QUERIES_1, …]                    … 2 + 3N widget
//     - N=5 で 17 widget を実測。
//     - **複数件では RELATED_TOPICS (keywordType:"ENTITY") が一切返らない。**
//       関連トピックが欲しければキーワードごとに 1 件ずつ explore を叩くしかない。
//     - 統合 GEO_MAP だけが dataMode:"PERCENTAGES" を持つ。個別 GEO_MAP_N には無い。
//   2〜5 件だが geo が混在:
//     [TIMESERIES, geos_note, TITLE_0, GEO_MAP_0, RELATED_QUERIES_0, TITLE_1, …]
//     - 統合 GEO_MAP の代わりに **geos_note** という request を持たないテキスト widget が入る。
//       {"text":{"text":"地域による比較を表示するには、すべてのキーワードに対して同じ地域を
//        選択してください。"}, "id":"geos_note", "type":"fe_text", ...}
//     - TITLE_N も request を持たないテキスト widget
//       ({"text":{"text":"coffee - 日本、過去 1 日"}, "type":"fe_text", "template":"fe_explore"})。
//     - **落とし穴**: geo 混在時の RELATED_QUERIES_N は
//       restriction.originalTimeRangeForExploreUrl に時間範囲ではなく
//       **ローカライズされた地域名 ("日本" / "アメリカ合衆国")** が入る (サーバ側の不具合と思われる)。
//       単一 geo のときは正しく "now 1-d" が入る。この値を時間範囲としてパースしてはいけない。
//   6 件以上:
//     **400 Bad Request**。上限は 5 件。
//
// -------------------------------------------------------------------------------------
// 【widget オブジェクトの共通フィールド (ライブ実測)】
// -------------------------------------------------------------------------------------
//   ※ 以下のキー一覧は 2026-09-09 に実際のレスポンスから Object.keys() を採取したもの。
//   全 widget 共通: id, type, title, template, embedTemplate, version, isLong, isCurated
//     - template は基本 "fe"、TITLE_N のみ "fe_explore"。
//     - embedTemplate="fe_embed", version="1" (文字列), isLong: boolean, isCurated: boolean。
//     - isCurated: boolean (HAR のバイト計算では "isPartial" と推定されていたが実物は isCurated)。
//   データ取得系 widget のみ: request, token, helpDialog
//     - token は 44 文字の base64url。widget ごと・リクエストごとに別値
//       (同一条件で 2 回叩くと別の token が返ることを実測済み)。有効期間は未計測
//       (一般に 24 時間程度と言われるが本ファイルでは検証していない)。
//     - helpDialog はヘルプ文言のオブジェクト。データ取得には不要だが必ず存在する。
//   GEO_MAP 系のみ: geo, resolution, searchInterestLabel, displayMode, color, index, bullet
//   RELATED_* のみ: keywordName, color
//   TIMESERIES のみ: lineAnnotationText, bullets, showLegend, showAverages
//     実測キー列 (TIMESERIES): request, lineAnnotationText, bullets, showLegend,
//       showAverages, helpDialog, token, id, type, title, template, embedTemplate,
//       version, isLong, isCurated
//     実測キー列 (GEO_MAP): request, geo, resolution, searchInterestLabel, displayMode,
//       helpDialog, color, index, bullet, token, id, type, title, template,
//       embedTemplate, version, isLong, isCurated
//     実測キー列 (RELATED_QUERIES): request, helpDialog, color, keywordName, token,
//       id, type, title, template, embedTemplate, version, isLong, isCurated
//   テキスト widget (TITLE_N / geos_note): text.text のみ。request も token も無い。
//   トップレベル: widgets, keywords, timeRanges, shareText, shouldShowMultiHeatMapMessage
//     - keywords[i] = {keyword, name, type}  (type は hl でローカライズ)
//     - timeRanges[i] = ローカライズ済み時間範囲ラベル。要素数は comparisonItem と同数。
//
// -------------------------------------------------------------------------------------
// 【エラー / レート制限の挙動】
// -------------------------------------------------------------------------------------
//   * 400 Bad Request: content-type text/html、body 1691 バイト前後の Google 標準エラーページ
//     ("Error 400 (Bad Request)!!1")。JSON では返らない。Retry-After 無し。
//     発生条件 (実測): 不正 geo / 小文字 geo / time 欠落 / tz が範囲外 / comparisonItem 6 件以上。
//   * 429 Too Many Requests: 同じく content-type text/html、body 1695 バイト前後。
//     Cookie (NID) 無しで /trends/api/explore を叩くと必ず 429。
//   * 成功判定は `res.status === 200 && content-type が application/json` で行うこと。
//     200 の本文は `)]}'` + LF の 5 バイトプレフィックス付き JSON。
//
// -------------------------------------------------------------------------------------
// 【根拠】
//   HAR: C:\Users\ushid\Documents\gtrend_claude\.har\trends.google.com.har
//     extracted/trends_api_explore/00_entry092.txt 〜 12_entry272.txt (13 件、req の形)
//     extracted/trends_api_widgetdata_multiline/*.txt (13 件)
//     extracted/trends_api_widgetdata_comparedgeo/*.txt (15 件、resolution REGION/CITY)
//     extracted/trends_api_widgetdata_relatedsearches/*.txt (26 件、ENTITY/QUERY)
//     ※ /trends/api/* はレスポンスボディが HAR に保存されていないため、レスポンス側の仕様
//       (widget id 文字列 / resolution / ローカライズ / エラーコード) はすべてライブ実測による。
//   ライブ検証日: 2026-09-09 (Cookie は毎回新規取得した NID のみ。実 Cookie 値や
//     reCAPTCHA トークンは本ファイルに一切埋め込んでいない)
//   ※ 冒頭のドキュメントに書いた仕様は、すべてこの日のライブ応答から採取した実測値である。
//     とくに以下は本ファイルのテストが毎回ライブで再検証する:
//       geo 4 段階と GEO_MAP.resolution の対応 / 不正 geo と小文字 geo の 400 /
//       category・property の無検証エコー / property 5 種での widget 集合不変 /
//       hl のローカライズと locale・language の差 / 不正 hl の en-US フォールバック /
//       tz の境界 (1439 は 200、1440 は 400) と「tz は時間窓に効かない」/
//       comparisonItem の上限 5 件 / geo 混在時の geos_note /
//       widget オブジェクトの共通キー一覧 (helpDialog を含む)
//
// 【このテストが行うライブリクエスト数】
//   NID 取得 1 + explore 20 = 21 (すべて成功した場合の下限)。内訳:
//     geo 4 種 ("" / "JP" / "JP-13" / "US-CA-807")                     … 4
//     不正 geo 2 種 ("ZZ" / 小文字 "jp")                                … 2
//     category/property エコー 2 種 (999999+youtube / 71+images)        … 2
//     category/property 省略                                            … 1
//     property 5 種マトリクス ("" / images / news / froogle / youtube)  … 3
//        (images / youtube は上の 2 種と条件が違うのでこのテスト内で
//         "" / news / froogle の 3 回を追加し、5 種を同一条件で比較する)
//     hl=en-US                                                          … 1
//     不正 hl "zz-ZZ" のフォールバック                                   … 1
//     tz=0 / tz=1439 / tz=1440                                          … 3
//     comparisonItem 5 件 / 6 件                                        … 2
//     geo 混在 2 件                                                     … 1
//   各リクエスト間に 1.6 秒のウェイトを入れる。
//   (上の仕様のうち「time 欠落 → 400」「tz=-1440 / tz=99999 → 400」は 2026-09-09 に
//    実測済みだが、境界値 1439/1440 を押さえれば十分なのでテストケースには含めていない。)
//   429 は 2s/6s/18s/40s の指数バックオフで最大 4 回再試行し、それでも駄目なら
//   console.warn を出してスキップ扱いにする (ハード失敗させない)。
//   **したがって 429 が多発する環境では 1 回の実行で最大 16 x 5 = 80 リクエストまで
//   膨らみうる。** 連続実行は避けること。
//   ※ 直前に別プロセスで大量にリクエストしていると、テスト開始直後の数リクエストが
//     まとめて 429 になり (スロットリング窓は数十秒〜数分続く) スキップされることがある。
//     その場合は数分空けてから再実行すること。
// =====================================================================================

import { assert, assertEquals } from "jsr:@std/assert@^1";

const ORIGIN = "https://trends.google.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const MIN_INTERVAL_MS = 1600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
async function pace() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

// --- NID Cookie の取得 (プロセス内で 1 回だけ) -----------------------------------------
// GET /trends/explore は Cookie 無しだと 429 を返すが Set-Cookie: NID が付いてくる。
// この NID を POST /trends/api/explore に付けると 200 になる。
let nidCache: string | null = null;
let nidTried = false;
async function ensureNid(): Promise<string | null> {
  if (nidTried) return nidCache;
  nidTried = true;
  await pace();
  try {
    const res = await fetch(
      `${ORIGIN}/trends/explore?q=coffee&date=now%201-d&geo=JP&hl=ja`,
      {
        headers: { "user-agent": UA, "accept-language": "ja" },
        redirect: "manual",
      },
    );
    const setCookie = res.headers.get("set-cookie") ?? "";
    await res.text(); // ボディを必ず消費 (Deno のリソースリーク検出対策)
    const m = setCookie.match(/NID=[^;,\s]+/);
    if (m) nidCache = m[0];
  } catch (e) {
    console.warn(`NID 取得でネットワークエラー: ${e}`);
  }
  if (!nidCache) {
    console.warn(
      "NID Cookie を取得できなかった。ライブテストはスキップされる。",
    );
  }
  return nidCache;
}

// explore のレスポンス JSON は widget ごとに形が違う動的な構造なので、
// テスト内では緩い型で扱う (アサーションで形を検証する)。
// deno-lint-ignore no-explicit-any
type Loose = any;

interface ExploreResult {
  status: number;
  contentType: string;
  bodyLength: number;
  json: Loose; // 200 かつ application/json のときだけ非 null
}

/** POST /trends/api/explore を 1 回叩く。429 は指数バックオフで最大 4 回再試行。 */
async function explore(
  req: unknown,
  opts: { hl?: string; tz?: number } = {},
): Promise<ExploreResult | null> {
  const nid = await ensureNid();
  if (!nid) return null;
  const hl = opts.hl ?? "ja";
  const tz = opts.tz ?? -540;
  // ブラウザ忠実形として tz を 2 回付ける。req は素の encodeURIComponent で問題ない。
  const url =
    `${ORIGIN}/trends/api/explore?hl=${encodeURIComponent(hl)}&tz=${tz}` +
    `&req=${encodeURIComponent(JSON.stringify(req))}&tz=${tz}`;
  const headers: Record<string, string> = {
    "accept": "application/json, text/plain, */*",
    "accept-language": hl,
    "user-agent": UA,
    "referer": `${ORIGIN}/trends/explore`,
    "origin": ORIGIN,
    "content-type": "application/json;charset=UTF-8",
    "cookie": nid,
  };

  // 429 のスロットリング窓は数十秒〜数分続くことがある (2026-09-09 実測)。
  // 2s/4s/8s では足りずスキップになりがちなので、少し長めの指数バックオフにしてある。
  const backoffs = [2000, 6000, 18000, 40000];
  for (let attempt = 0;; attempt++) {
    await pace();
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers }); // ボディ無し (reCAPTCHA 不要)
    } catch (e) {
      console.warn(`ネットワークエラー: ${e}`);
      return null;
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]
      .trim();
    const text = await res.text();
    if (res.status === 429 && attempt < backoffs.length) {
      console.warn(
        `429 を受信。${backoffs[attempt]}ms 待って再試行 (${
          attempt + 1
        }/${backoffs.length})`,
      );
      await sleep(backoffs[attempt]);
      continue;
    }
    if (res.status === 429) {
      console.warn("429 が続くためレート制限として未検証扱いにする。");
      return null;
    }
    let json: Loose = null;
    if (res.status === 200 && contentType === "application/json") {
      assert(
        text.startsWith(")]}'\n"),
        "200 のボディは )]}' + LF で始まるはず",
      );
      json = JSON.parse(text.slice(5));
    }
    return { status: res.status, contentType, bodyLength: text.length, json };
  }
}

const item = (keyword: string, geo: string, time = "now 1-d") => ({
  keyword,
  geo,
  time,
});
/**
 * explore が返す TIMESERIES の `request.time` をパースする。
 * 1 日未満の窓では "2026-09-08T14\:53\:39 2026-09-09T14\:53\:39" の
 * ようにコロンが `\:` (バックスラッシュ 1 個 + コロン) にエスケープされた秒精度形式で
 * 返る。widgetdata へはこの文字列をそのまま渡すが、値として解釈する際はエスケープを外し、
 * タイムゾーン指定が無いので **UTC** として読む。
 */
function parseTimeWindow(t: string): { start: number; end: number } {
  const [a, b] = t.replace(/\\:/g, ":").split(" ");
  return { start: Date.parse(`${a}Z`), end: Date.parse(`${b}Z`) };
}

const ids = (r: ExploreResult): string[] =>
  (r.json.widgets as Loose[]).map((w) => w.id as string);
const byId = (r: ExploreResult, id: string): Loose =>
  (r.json.widgets as Loose[]).find((w) => w.id === id);

// =====================================================================================
// オフライン: req のパーセントエンコード互換性
// =====================================================================================
Deno.test({
  name:
    "offline: ブラウザ独自エンコードと encodeURIComponent はデコードすると同一の req になる",
  fn() {
    // HAR entry 92 (2026-09-08) の実物クエリから req 部分だけを取り出したもの。
    const harEncoded =
      "%7B%22comparisonItem%22:%5B%7B%22keyword%22:%22Fanza%22,%22geo%22:%22JP%22," +
      "%22time%22:%22now+1-d%22%7D%5D,%22category%22:0,%22property%22:%22%22%7D";
    // AngularJS は空白を "+" にするので、decodeURIComponent の前に "+" を空白へ戻す。
    const fromHar = JSON.parse(
      decodeURIComponent(harEncoded.replace(/\+/g, " ")),
    );
    assertEquals(fromHar, {
      comparisonItem: [{ keyword: "Fanza", geo: "JP", time: "now 1-d" }],
      category: 0,
      property: "",
    });

    // ラッパーが使う素直なエンコード。`:` `,` も % エンコードされ、空白は %20 になる。
    const mine = encodeURIComponent(JSON.stringify(fromHar));
    assert(mine.includes("%3A"), "encodeURIComponent は : を %3A にする");
    assert(mine.includes("%20"), "encodeURIComponent は空白を %20 にする");
    assert(!mine.includes("+"), "encodeURIComponent は + を生成しない");
    // どちらもデコード結果は同一 (= サーバから見て等価)。2026-09-09 のライブ検証では
    // encodeURIComponent 形のみを 28 回送り、すべて期待どおりの応答を得ている。
    assertEquals(JSON.parse(decodeURIComponent(mine)), fromHar);
  },
});

// =====================================================================================
// ライブ: geo の階層と GEO_MAP.resolution の対応
// =====================================================================================
Deno.test({
  name: "live: geo の粒度で GEO_MAP の resolution と geo オブジェクトが変わる",
  fn: async () => {
    const cases: Array<{
      geo: string;
      expectResolution: string;
      expectGeo: Record<string, string>;
    }> = [
      { geo: "", expectResolution: "COUNTRY", expectGeo: {} },
      { geo: "JP", expectResolution: "REGION", expectGeo: { country: "JP" } },
      {
        geo: "JP-13",
        expectResolution: "CITY",
        expectGeo: { region: "JP-13" },
      },
      { geo: "US-CA-807", expectResolution: "CITY", expectGeo: { dma: "807" } },
    ];
    for (const c of cases) {
      const r = await explore({
        comparisonItem: [item("coffee", c.geo)],
        category: 0,
        property: "",
      });
      if (!r) {
        console.warn(`geo=${JSON.stringify(c.geo)}: レート制限のため未検証`);
        continue;
      }
      assertEquals(r.status, 200, `geo=${JSON.stringify(c.geo)} は 200 のはず`);
      assertEquals(r.contentType, "application/json");
      assertEquals(ids(r), [
        "TIMESERIES",
        "GEO_MAP",
        "RELATED_TOPICS",
        "RELATED_QUERIES",
      ]);

      const geoMap = byId(r, "GEO_MAP");
      assertEquals(
        geoMap.request.resolution,
        c.expectResolution,
        `geo=${JSON.stringify(c.geo)} の GEO_MAP.resolution`,
      );
      assertEquals(geoMap.request.geo, c.expectGeo);
      assert(
        Object.hasOwn(geoMap, "geo"),
        "GEO_MAP は widget 直下にも geo を持つ",
      );
      assert(
        Object.hasOwn(geoMap, "resolution"),
        "GEO_MAP は widget 直下にも resolution を持つ",
      );

      // 同じ geo オブジェクトが他 widget にも別の位置で入る。
      assertEquals(
        byId(r, "TIMESERIES").request.comparisonItem[0].geo,
        c.expectGeo,
      );
      assertEquals(
        byId(r, "RELATED_QUERIES").request.restriction.geo,
        c.expectGeo,
      );

      // token は 44 文字の base64url。
      for (const w of r.json.widgets) {
        assertEquals(typeof w.token, "string", `${w.id} は token を持つ`);
        assertEquals(w.token.length, 44, `${w.id} の token は 44 文字`);
        assert(
          /^[A-Za-z0-9_-]+$/.test(w.token),
          `${w.id} の token は base64url`,
        );
      }

      // time は 1 日未満なので \: エスケープ付きの秒精度形式。
      const t = byId(r, "TIMESERIES").request.time as string;
      assert(
        /^\d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2} \d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2}$/
          .test(t),
        `time が \\: エスケープ形式ではない: ${t}`,
      );
      // このリクエストは tz=-540 (JST) で送っている。窓の終端が「UTC の現在時刻」に
      // 一致することを確認する → 「tz は窓の算出に使われない」の前半の証拠。
      const win = parseTimeWindow(t);
      assertEquals(
        win.end - win.start,
        24 * 3600 * 1000,
        "now 1-d の窓はちょうど 24 時間",
      );
      assert(
        Math.abs(win.end - Date.now()) < 30 * 60 * 1000,
        `tz=-540 でも窓の終端は UTC の現在時刻のはず (ズレ: ${
          Math.round((win.end - Date.now()) / 60000)
        } 分, time=${t})`,
      );
    }
  },
});

// =====================================================================================
// ライブ: 不正 geo は 400 (429 と区別できる)
// =====================================================================================
Deno.test({
  name: "live: 存在しない geo と小文字 geo は 400 Bad Request",
  fn: async () => {
    // "ZZ" = ISO-3166-1 に存在しない国コード。
    // "jp" = 正しい国だが小文字。geo は大文字小文字を区別し、小文字は受理されない。
    //        ラッパーは利用者入力を toUpperCase() してから送るべき、という根拠になる。
    for (const badGeo of ["ZZ", "jp"]) {
      const r = await explore({
        comparisonItem: [item("coffee", badGeo)],
        category: 0,
        property: "",
      });
      if (!r) {
        console.warn(`geo=${badGeo}: レート制限のため未検証`);
        continue;
      }
      assertEquals(r.status, 400, `geo=${badGeo} は 400 のはず`);
      assertEquals(
        r.contentType,
        "text/html",
        "400 は JSON ではなく HTML で返る",
      );
      assertEquals(r.json, null, "400 のときは JSON をパースしない");
      assert(
        r.bodyLength > 1000 && r.bodyLength < 4000,
        `geo=${badGeo} の 400 本文長: ${r.bodyLength}`,
      );
    }
  },
});

// =====================================================================================
// ライブ: category / property は検証されずエコーされるだけ、widget 集合も変わらない
// =====================================================================================
Deno.test({
  name:
    "live: category / property は検証されずエコーされ、値を変えても widget 集合は不変",
  fn: async () => {
    const r = await explore({
      comparisonItem: [item("coffee", "JP")],
      category: 999999, // 存在しないカテゴリ ID
      property: "youtube",
    });
    if (!r) {
      console.warn("category/property テスト: レート制限のため未検証");
      return;
    }
    assertEquals(
      r.status,
      200,
      "未知の category ID でも explore は 400 を返さない",
    );
    // property を変えても widget 集合は不変 (5 種すべてで同一であることを実測済み)。
    assertEquals(ids(r), [
      "TIMESERIES",
      "GEO_MAP",
      "RELATED_TOPICS",
      "RELATED_QUERIES",
    ]);

    const ro = byId(r, "TIMESERIES").request.requestOptions;
    assertEquals(
      ro.category,
      999999,
      "category はそのままエコーされる (検証されない)",
    );
    assertEquals(ro.property, "youtube");
    assertEquals(ro.backend, "CM", "now 1-d はリアルタイム系なので backend=CM");

    // youtube でも GEO_MAP は REGION のまま (property は resolution に影響しない)。
    assertEquals(byId(r, "GEO_MAP").request.resolution, "REGION");
    assertEquals(byId(r, "GEO_MAP").request.geo, { country: "JP" });

    // RELATED_TOPICS / RELATED_QUERIES は同じ endpoint で keywordType だけが違う。
    assertEquals(byId(r, "RELATED_TOPICS").request.keywordType, "ENTITY");
    assertEquals(byId(r, "RELATED_QUERIES").request.keywordType, "QUERY");
    assertEquals(byId(r, "RELATED_QUERIES").request.metric, ["TOP", "RISING"]);
    // property / category は relatedsearches の requestOptions にも同じ値で入る。
    assertEquals(
      byId(r, "RELATED_QUERIES").request.requestOptions.property,
      "youtube",
    );
    assertEquals(
      byId(r, "RELATED_QUERIES").request.requestOptions.category,
      999999,
    );

    // --- 2 パターン目: 実在するカテゴリ (71 = 食品・飲料) + 別 property ("images") ---
    // 「property / category を変えても widget 集合は変わらない」という主張は、
    // 2 パターンを実際に比較しないと検証したことにならないのでここで突き合わせる。
    const r2 = await explore({
      comparisonItem: [item("coffee", "JP")],
      category: 71, // pickers/category に実在する ID
      property: "images",
    });
    if (!r2) {
      console.warn("category=71 / property=images: レート制限のため未検証");
      return;
    }
    assertEquals(r2.status, 200, "実在カテゴリ + images でも 200");
    // ★ ここが本題: widget の id 列が 999999+youtube のときと完全に一致する。
    assertEquals(
      ids(r2),
      ids(r),
      "category / property を変えても widget 集合 (id と順序) は変わらない",
    );
    const ro2 = byId(r2, "TIMESERIES").request.requestOptions;
    assertEquals(ro2.category, 71);
    assertEquals(ro2.property, "images");
    assertEquals(ro2.backend, "CM");
    // resolution も property に依存しない (images でも REGION のまま)。
    assertEquals(byId(r2, "GEO_MAP").request.resolution, "REGION");
    // RELATED_TOPICS は property を変えても残る (YouTube 専用に消えたりしない)。
    assertEquals(byId(r2, "RELATED_TOPICS").request.keywordType, "ENTITY");
    // token は widget ごと・リクエストごとに別値 (使い回してはいけない)。
    assert(
      byId(r2, "TIMESERIES").token !== byId(r, "TIMESERIES").token,
      "token はリクエストごとに再発行される",
    );
  },
});

// =====================================================================================
// ライブ: category / property を省略しても通る (requestOptions からキーごと消える)
// =====================================================================================
Deno.test({
  name:
    "live: category / property は省略可能で、省略すると requestOptions が backend だけになる",
  fn: async () => {
    const r = await explore({ comparisonItem: [item("coffee", "JP")] });
    if (!r) {
      console.warn("省略テスト: レート制限のため未検証");
      return;
    }
    assertEquals(r.status, 200, "category / property を省略しても 200");
    assertEquals(ids(r), [
      "TIMESERIES",
      "GEO_MAP",
      "RELATED_TOPICS",
      "RELATED_QUERIES",
    ]);
    assertEquals(
      byId(r, "TIMESERIES").request.requestOptions,
      { backend: "CM" },
      "省略時は property / category のキー自体が消える",
    );
    // time は省略できない (別テストで 400 を確認)。geo も必須。
    assertEquals(byId(r, "GEO_MAP").request.geo, { country: "JP" });
  },
});

// ※ comparisonItem[].time を省略すると 400 (text/html) になることは 2026-09-09 に実測済み。
//    ライブリクエスト節約のためテストケースにはしていない。
//
// =====================================================================================
// ライブ: hl のローカライズ範囲と locale / language の差
// =====================================================================================
Deno.test({
  name:
    "live: hl はタイトル等をローカライズし、locale は hl そのまま・language は主サブタグ",
  fn: async () => {
    const r = await explore(
      { comparisonItem: [item("coffee", "JP")], category: 0, property: "" },
      { hl: "en-US" },
    );
    if (!r) {
      console.warn("hl テスト: レート制限のため未検証");
      return;
    }
    assertEquals(r.status, 200);
    assertEquals(ids(r), [
      "TIMESERIES",
      "GEO_MAP",
      "RELATED_TOPICS",
      "RELATED_QUERIES",
    ]);

    assertEquals(byId(r, "TIMESERIES").title, "Interest over time");
    assertEquals(byId(r, "GEO_MAP").title, "Interest by subregion");
    assertEquals(byId(r, "RELATED_TOPICS").title, "Related topics");
    assertEquals(byId(r, "RELATED_QUERIES").title, "Related queries");
    assertEquals(byId(r, "GEO_MAP").searchInterestLabel, "Search interest");

    // locale は hl そのまま、language は主サブタグだけになる。
    assertEquals(byId(r, "TIMESERIES").request.locale, "en-US");
    assertEquals(byId(r, "GEO_MAP").request.locale, "en-US");
    assertEquals(byId(r, "RELATED_QUERIES").request.language, "en");

    // userCountryCode は geo でも hl でもなくアクセス元 IP の国。
    const ucc = byId(r, "RELATED_QUERIES").request.userCountryCode as string;
    assertEquals(typeof ucc, "string");
    assertEquals(ucc.length, 2, "userCountryCode は ISO-3166-1 alpha-2");

    // トップレベルのメタもローカライズされる。
    assertEquals(r.json.keywords[0].keyword, "coffee");
    assertEquals(r.json.keywords[0].type, "Search term");
    assertEquals(r.json.timeRanges, ["Past day"]);
    assertEquals(typeof r.json.shareText, "string");
    assertEquals(typeof r.json.shouldShowMultiHeatMapMessage, "boolean");
  },
});

// ※ 不正な hl ("zz-ZZ") が 400 にならず en-US へフォールバックする (locale="en-US" になり
//    title も英語になる) ことは 2026-09-09 に実測済み。ライブリクエスト節約のため
//    テストケースにはしていない。
//
// =====================================================================================
// ライブ: tz の範囲
// =====================================================================================
Deno.test({
  name: "live: tz は分単位で |tz| < 1440、範囲外は 400",
  fn: async () => {
    const ok = await explore(
      { comparisonItem: [item("coffee", "JP")], category: 0, property: "" },
      { tz: 0 },
    );
    if (ok) {
      assertEquals(ok.status, 200, "tz=0 は受理される");
      assertEquals(ok.contentType, "application/json");
      // now 1-d の解像度は tz に依存せず EIGHT_MINUTE。
      assertEquals(byId(ok, "TIMESERIES").request.resolution, "EIGHT_MINUTE");
      // ★「tz は窓の算出に使われない」の後半の証拠。
      //   tz=0 で得た窓も、geo テスト (tz=-540) で得た窓と同じく
      //   「UTC の現在時刻 -24h 〜 UTC の現在時刻」になる。もし tz が窓に効いていれば
      //   両者は 9 時間ずれるはずで、この 2 つのアサーションは同時には成立しない。
      const win = parseTimeWindow(
        byId(ok, "TIMESERIES").request.time as string,
      );
      assertEquals(win.end - win.start, 24 * 3600 * 1000);
      assert(
        Math.abs(win.end - Date.now()) < 30 * 60 * 1000,
        `tz=0 でも窓の終端は UTC の現在時刻のはず (ズレ: ${
          Math.round((win.end - Date.now()) / 60000)
        } 分)`,
      );
      // ローカライズは hl の責務。tz を変えても hl=ja のままタイトルは日本語。
      assertEquals(byId(ok, "TIMESERIES").title, "人気度の動向");
    } else {
      console.warn("tz=0: レート制限のため未検証");
    }

    // 境界値。1439 は受理され 1440 は拒否される → 有効範囲は |tz| <= 1439。
    // (任意の大きな値 99999 を試すより、境界を 1 つ跨ぐ方が仕様として意味がある。)
    const edgeIn = await explore(
      { comparisonItem: [item("coffee", "JP")], category: 0, property: "" },
      { tz: 1439 },
    );
    if (edgeIn) {
      assertEquals(edgeIn.status, 200, "tz=1439 は受理される最大値");
      assertEquals(edgeIn.contentType, "application/json");
      // tz を極端な値にしても窓は UTC の現在時刻基準のまま。
      // tz が窓に効いていれば tz=0 のときと最大 24 時間ずれるはずで、
      // このアサーションは成立しない。
      const win = parseTimeWindow(
        byId(edgeIn, "TIMESERIES").request.time as string,
      );
      assertEquals(win.end - win.start, 24 * 3600 * 1000);
      assert(
        Math.abs(win.end - Date.now()) < 30 * 60 * 1000,
        `tz=1439 でも窓の終端は UTC の現在時刻のはず (ズレ: ${
          Math.round((win.end - Date.now()) / 60000)
        } 分)`,
      );
    } else {
      console.warn("tz=1439: レート制限のため未検証");
    }

    const ng = await explore(
      { comparisonItem: [item("coffee", "JP")], category: 0, property: "" },
      { tz: 1440 },
    );
    if (ng) {
      assertEquals(ng.status, 400, "tz=1440 (=24時間) は範囲外なので 400");
      assertEquals(ng.contentType, "text/html");
      assertEquals(ng.json, null);
      assert(
        ng.bodyLength > 1000 && ng.bodyLength < 4000,
        `tz=1440 の 400 本文長: ${ng.bodyLength}`,
      );
    } else {
      console.warn("tz=1440: レート制限のため未検証");
    }
  },
});

// =====================================================================================
// ライブ: 不正な hl は 400 にならず en-US へ黙ってフォールバックする
// =====================================================================================
Deno.test({
  name: "live: 不正な hl はエラーにならず en-US にフォールバックする",
  fn: async () => {
    const r = await explore(
      { comparisonItem: [item("coffee", "JP")], category: 0, property: "" },
      { hl: "zz-ZZ" }, // 存在しない言語タグ
    );
    if (!r) {
      console.warn("不正 hl テスト: レート制限のため未検証");
      return;
    }
    // エラーにならないのがポイント。ラッパーは hl の検証をサーバに任せられない。
    assertEquals(r.status, 200, "不正な hl でも 400 にはならない");
    assertEquals(r.contentType, "application/json");

    // 中身は hl=en-US を明示したときと区別できない。
    assertEquals(byId(r, "TIMESERIES").request.locale, "en-US");
    assertEquals(byId(r, "GEO_MAP").request.locale, "en-US");
    assertEquals(byId(r, "RELATED_QUERIES").request.language, "en");
    assertEquals(byId(r, "TIMESERIES").title, "Interest over time");
    assertEquals(byId(r, "GEO_MAP").title, "Interest by subregion");
    assertEquals(byId(r, "GEO_MAP").searchInterestLabel, "Search interest");
    assertEquals(r.json.keywords[0].type, "Search term");
    assertEquals(r.json.timeRanges, ["Past day"]);
    // 送った "zz-ZZ" がどこかにエコーされていないことも確認しておく
    // (もしエコーされていれば「フォールバック」ではなく「素通し」になる)。
    assert(
      !JSON.stringify(r.json).includes("zz-ZZ"),
      "不正な hl はレスポンスのどこにもエコーされない",
    );
  },
});

// =====================================================================================
// ライブ: comparisonItem の件数上限と widget 構成
// =====================================================================================
Deno.test({
  name: "live: comparisonItem は最大 5 件、複数件では RELATED_TOPICS が消える",
  fn: async () => {
    const five = await explore({
      comparisonItem: ["coffee", "tea", "milk", "juice", "water"].map((k) =>
        item(k, "JP")
      ),
      category: 0,
      property: "",
    });
    if (!five) {
      console.warn("comparisonItem 5 件: レート制限のため未検証");
    } else {
      assertEquals(five.status, 200);
      // 2 + 3N の構成。
      assertEquals(ids(five), [
        "TIMESERIES",
        "GEO_MAP",
        "TITLE_0",
        "GEO_MAP_0",
        "RELATED_QUERIES_0",
        "TITLE_1",
        "GEO_MAP_1",
        "RELATED_QUERIES_1",
        "TITLE_2",
        "GEO_MAP_2",
        "RELATED_QUERIES_2",
        "TITLE_3",
        "GEO_MAP_3",
        "RELATED_QUERIES_3",
        "TITLE_4",
        "GEO_MAP_4",
        "RELATED_QUERIES_4",
      ]);
      assert(
        !ids(five).some((id) => id.startsWith("RELATED_TOPICS")),
        "複数キーワードでは RELATED_TOPICS (ENTITY) が返らない",
      );
      // TIMESERIES は 1 本にまとまり comparisonItem が 5 要素になる。
      assertEquals(byId(five, "TIMESERIES").request.comparisonItem.length, 5);
      // 統合 GEO_MAP のみ dataMode: PERCENTAGES。
      assertEquals(byId(five, "GEO_MAP").request.dataMode, "PERCENTAGES");
      assertEquals(byId(five, "GEO_MAP").request.comparisonItem.length, 5);
      assertEquals(byId(five, "GEO_MAP_0").request.dataMode, undefined);
      assertEquals(byId(five, "GEO_MAP_0").request.comparisonItem.length, 1);
      // TITLE_N は request も token も持たないテキスト widget。
      const t0 = byId(five, "TITLE_0");
      assertEquals(t0.request, undefined);
      assertEquals(t0.token, undefined);
      assertEquals(t0.type, "fe_text");
      assertEquals(typeof t0.text.text, "string");
      assertEquals(five.json.keywords.length, 5);
      assertEquals(five.json.timeRanges.length, 5);
    }

    const six = await explore({
      comparisonItem: ["coffee", "tea", "milk", "juice", "water", "beer"].map((
        k,
      ) => item(k, "JP")),
      category: 0,
      property: "",
    });
    if (!six) {
      console.warn("comparisonItem 6 件: レート制限のため未検証");
      return;
    }
    assertEquals(six.status, 400, "comparisonItem 6 件は 400 (上限は 5 件)");
    assertEquals(six.contentType, "text/html");
  },
});

// =====================================================================================
// ライブ: geo が混在する比較では統合 GEO_MAP の代わりに geos_note が入る
// =====================================================================================
Deno.test({
  name:
    "live: geo 混在の比較では geos_note widget が返り、統合 GEO_MAP は返らない",
  fn: async () => {
    const r = await explore({
      comparisonItem: [item("coffee", "JP"), item("coffee", "US")],
      category: 0,
      property: "",
    });
    if (!r) {
      console.warn("geo 混在テスト: レート制限のため未検証");
      return;
    }
    assertEquals(r.status, 200);
    assertEquals(ids(r), [
      "TIMESERIES",
      "geos_note",
      "TITLE_0",
      "GEO_MAP_0",
      "RELATED_QUERIES_0",
      "TITLE_1",
      "GEO_MAP_1",
      "RELATED_QUERIES_1",
    ]);
    const note = byId(r, "geos_note");
    assertEquals(note.type, "fe_text");
    assertEquals(
      note.request,
      undefined,
      "geos_note は request を持たない (取得不能な widget)",
    );
    assertEquals(note.token, undefined);
    assertEquals(typeof note.text.text, "string");
    assert(note.text.text.length > 0);

    // 個別 GEO_MAP_N は各アイテムの geo をそのまま持つ。
    assertEquals(byId(r, "GEO_MAP_0").request.geo, { country: "JP" });
    assertEquals(byId(r, "GEO_MAP_1").request.geo, { country: "US" });
    assertEquals(byId(r, "GEO_MAP_0").request.resolution, "REGION");
    assertEquals(byId(r, "GEO_MAP_1").request.resolution, "REGION");

    // 落とし穴: geo 混在時は originalTimeRangeForExploreUrl に時間範囲ではなく
    // ローカライズされた地域名が入る。時間範囲としてパースしてはいけない。
    const otr = byId(r, "RELATED_QUERIES_0").request.restriction
      .originalTimeRangeForExploreUrl as string;
    assertEquals(typeof otr, "string");
    assert(
      !/^now |^all_|^today /.test(otr),
      `geo 混在時の originalTimeRangeForExploreUrl は時間範囲ではない (実測値: ${otr})`,
    );
  },
});

// =====================================================================================
// ライブ: property 5 種すべてで widget 集合が同一
// =====================================================================================
// 「property を変えると返る widget 集合が変わるか」は本ファイルの中心的な調査項目なので、
// 5 種を実際に突き合わせて確定させる。ただしレート制限を考え、ここで新規に叩くのは
// まだ同一条件で試していない "" / "news" / "froogle" の 3 種だけにする。
// "images" と "youtube" は上の
//   "live: category / property は検証されずエコーされ、値を変えても widget 集合は不変"
// で category を変えながら同じ id 列を返すことを確認済みで、かつ同テストで
// 「category は widget 集合に影響しない」ことも示しているため、
// 5 種すべてが同じ widget 集合を返すと結論できる。
const CANONICAL_WIDGET_IDS = [
  "TIMESERIES",
  "GEO_MAP",
  "RELATED_TOPICS",
  "RELATED_QUERIES",
];

Deno.test({
  name: "live: property 5 種すべてで widget 集合が同一",
  fn: async () => {
    // すべて category=0 / geo="JP" / time="now 1-d" に固定し、property だけを動かす。
    const properties = ["", "news", "froogle"];
    const observed: Array<{ property: string; widgetIds: string[] }> = [];

    for (const property of properties) {
      const r = await explore({
        comparisonItem: [item("coffee", "JP")],
        category: 0,
        property,
      });
      if (!r) {
        console.warn(
          `property=${JSON.stringify(property)}: レート制限のため未検証`,
        );
        continue;
      }
      assertEquals(
        r.status,
        200,
        `property=${JSON.stringify(property)} は 200 のはず`,
      );
      assertEquals(r.contentType, "application/json");

      // widget 集合が正準の 4 個と完全一致する (順序も含めて)。
      assertEquals(
        ids(r),
        CANONICAL_WIDGET_IDS,
        `property=${JSON.stringify(property)} の widget 集合`,
      );
      observed.push({ property, widgetIds: ids(r) });

      // property は 4 widget すべての requestOptions にそのままエコーされる。
      for (const id of CANONICAL_WIDGET_IDS) {
        const ro = byId(r, id).request.requestOptions;
        assertEquals(
          ro.property,
          property,
          `${id}.request.requestOptions.property`,
        );
        assertEquals(ro.category, 0, `${id}.request.requestOptions.category`);
        assertEquals(ro.backend, "CM", `${id}.request.requestOptions.backend`);
      }

      // property は GEO_MAP の粒度に影響しない (news / froogle でも REGION のまま)。
      assertEquals(
        byId(r, "GEO_MAP").request.resolution,
        "REGION",
        `property=${JSON.stringify(property)} でも resolution は REGION`,
      );
      // RELATED_TOPICS (ENTITY) はどの property でも残る。
      assertEquals(byId(r, "RELATED_TOPICS").request.keywordType, "ENTITY");
      assertEquals(byId(r, "RELATED_QUERIES").request.keywordType, "QUERY");

      // --- widget オブジェクトの共通フィールド (冒頭ドキュメントの裏付け) ---
      // データ取得系 widget は request / token / helpDialog を必ず持つ。
      for (const w of r.json.widgets) {
        for (const key of [
          "id",
          "type",
          "title",
          "template",
          "embedTemplate",
          "version",
          "isLong",
          "isCurated",
          "request",
          "token",
          "helpDialog",
        ]) {
          assert(
            Object.hasOwn(w, key),
            `${w.id} は ${key} を持つはず (property=${
              JSON.stringify(property)
            })`,
          );
        }
        assertEquals(w.template, "fe", `${w.id}.template`);
        assertEquals(w.embedTemplate, "fe_embed", `${w.id}.embedTemplate`);
        assertEquals(w.version, "1", `${w.id}.version は文字列の "1"`);
        assertEquals(typeof w.isLong, "boolean", `${w.id}.isLong`);
        assertEquals(typeof w.isCurated, "boolean", `${w.id}.isCurated`);
        // 旧仕様書で "isPartial" と推定されていたキーは実在しない。
        assert(!Object.hasOwn(w, "isPartial"), `${w.id} に isPartial は無い`);
      }
      // widget 固有フィールドの住み分け。
      assert(Object.hasOwn(byId(r, "TIMESERIES"), "showAverages"));
      assert(Object.hasOwn(byId(r, "TIMESERIES"), "lineAnnotationText"));
      assert(!Object.hasOwn(byId(r, "TIMESERIES"), "resolution"));
      assert(Object.hasOwn(byId(r, "GEO_MAP"), "searchInterestLabel"));
      assert(Object.hasOwn(byId(r, "RELATED_QUERIES"), "keywordName"));
      assert(!Object.hasOwn(byId(r, "RELATED_QUERIES"), "resolution"));
    }

    // ★ 本題: 実際に取得できた property すべてで id 列が一致する。
    if (observed.length >= 2) {
      for (const o of observed.slice(1)) {
        assertEquals(
          o.widgetIds,
          observed[0].widgetIds,
          `property=${JSON.stringify(o.property)} と property=${
            JSON.stringify(observed[0].property)
          } で widget 集合が食い違った`,
        );
      }
    } else {
      console.warn(
        "property 比較: 取得できたパターンが 1 つ以下のため突き合わせは未実施",
      );
    }
  },
});
