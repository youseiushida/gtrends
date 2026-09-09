// 実行: deno test --allow-net --no-check live_integration/05_widgetdata_relatedsearches_test.ts
//
// ============================================================================
// Google Trends 旧 REST API: /trends/api/widgetdata/relatedsearches
//   = 「関連トピック (Related topics)」/「関連キーワード (Related queries)」
// ============================================================================
//
// ライブ検証日: 2026-09-09 (Deno 2.9.6 / Windows / Cookie は NID のみ)
// HAR 根拠: .har/extracted/trends_api_widgetdata_relatedsearches/
//             00_entry102.txt 〜 25_entry279.txt (全 26 件)
//           HAR はレスポンスボディが 26/26 とも未保存で、バイト数 (content.size) だけが残っている。
//           したがってレスポンス仕様は下記のライブ実測で確定させ、HAR のバイト数と突き合わせて検算した。
//
// ----------------------------------------------------------------------------
// 1. エンドポイント
// ----------------------------------------------------------------------------
//   GET https://trends.google.com/trends/api/widgetdata/relatedsearches
//   クエリの並び順 (HAR 26/26 で固定): hl, tz, req, token
//     ※ multiline (/trends/api/widgetdata/multiline) と違い tz は 1 回しか付かない。
//   POST ボディは無い。reCAPTCHA トークンも不要 (このエンドポイントには元々存在しない)。
//
//   パラメータ:
//     hl    (必須 / 文字列)   UI 言語。"ja" / "en-US" など。
//                             レスポンスの formattedValue のローカライズに効く (§5)。
//     tz    (必須 / 整数文字列) JS の Date#getTimezoneOffset() 規約の分オフセット。JST は -540。
//                             本エンドポイントの返り値に日時は含まれないため実質無害。
//                             省略時の挙動は未検証 (ブラウザは必ず送る)。
//     req   (必須 / JSON 文字列) ウィジェット定義。explore が返した widgets[i].request を
//                             JSON.stringify したものを **そのまま** 渡す (§3)。
//     token (必須 / 44 文字)  explore が返した widgets[i].token。§4 参照。
//
// ----------------------------------------------------------------------------
// 2. 認証 / ヘッダ要件
// ----------------------------------------------------------------------------
//   * Cookie: NID が実質必須。Cookie 無しだと 429 (content-type: text/html) が返る。
//     NID の入手経路 (2026-09-09 実測):
//       - GET https://trends.google.com/trending?geo=JP&hl=ja      -> 200 + Set-Cookie: NID
//       - GET https://trends.google.com/trends/explore?q=..&hl=ja  -> 429 だが Set-Cookie: NID は付く
//     OTZ / _ga / __utm* は不要 (サーバは使っていない)。
//   * 認証ヘッダ (authorization, x-goog-*, x-client-data) は一切不要。ログイン不要。
//   * ブラウザは referer: https://trends.google.com/trends/explore?... を送るが、
//     UA と referer を付けた素の Deno fetch で 200 が返ることを実測済み。
//     x-browser-validation / sec-ch-ua-* は送らないこと (Chrome 内部定数であり偽装は逆効果)。
//   * 推奨ヘッダ:
//       accept:          "application/json, text/plain, */*"
//       accept-language: hl に合わせる
//       user-agent:      普通の Chrome UA
//       referer:         "https://trends.google.com/trends/explore"
//       cookie:          "NID=<値>"
//
// ----------------------------------------------------------------------------
// 3. req スキーマ (HAR 26 件 + ライブ 3 件の和集合。これで完全)
// ----------------------------------------------------------------------------
//   {
//     "restriction": {
//       "geo": {"country":"JP"} | {"region":"JP-13"},
//              // explore の geo に対応。国コードなら country、下位地域コードなら region と
//              // キー名そのものが変わる。
//       "time": "2026-09-01T16\:13\:56 2026-09-08T16\:13\:56"   // 1 日未満の窓 (時刻付き)
//             | "2008-01-01 2026-09-08",                        // 1 日以上の窓 (日付のみ)
//              // ★1 日未満の書式ではコロンがバックスラッシュでエスケープされる。
//              //   JS 文字列リテラルとしては "…T16\\:13\\:56…"、実データは \ と : の 2 文字。
//              //   URL 上では %5C%5C: になる。自分で組み立てず explore の値を透過させること。
//              //   2 つの日時は半角スペース区切り (URL 上は +)。
//       "originalTimeRangeForExploreUrl": "now 1-d" | "now 4-H" | "now 7-d" | "all_2008",
//              // ★このエンドポイント固有。レスポンスの link の date= に使われる (§5)。
//       "complexKeywordsRestriction": {
//         "keyword": [ {"type":"BROAD","value":"コーヒー"} ]
//              // 素のキーワードは type:"BROAD"。
//              // explore に mid ("/m/02vqfm" = Coffee) を渡すと type:"ENTITY" になる (実測)。
//              // ★この配列は HAR 26/26 で **常に 1 要素**。複数キーワード比較 (explore の
//              //   comparisonItem が N 要素) でも 1 リクエストにまとまることはなく、
//              //   キーワードごとに別ウィジェット (= 別 req + 別 token) が発行されるため
//              //   relatedsearches を N 回呼ぶことになる。
//              //   根拠: 24_entry277 (value:"Fanza") と 25_entry279 (value:"DLsite") は
//              //   comparisonItem:[{Fanza},{DLsite}] という単一 explore から派生した隣接ペアで、
//              //   どちらも keyword 配列は 1 要素だった。
//       }
//     },
//     "keywordType": "ENTITY" | "QUERY",
//              // ★RELATED_TOPICS と RELATED_QUERIES の差分は **このフィールドだけ**。
//              //   ENTITY = 関連トピック、QUERY = 関連キーワード。HAR: ENTITY 12 件 / QUERY 14 件。
//     "metric": ["TOP","RISING"],
//              // HAR 26/26 でこの 2 要素固定。rankedList[0]=TOP, rankedList[1]=RISING に 1:1 対応。
//     "trendinessSettings": {"compareTime": "<比較対象期間>"},
//              // RISING の増加率の分母となる期間。
//              //   now 1-d / now 4-H / now 7-d -> 直前の同じ長さの窓
//              //   all_2008                    -> "2008-01-01 2009-01-01" (最初の 1 年。直前窓ではない)
//     "requestOptions": {
//       "property": "" | "images" | "news" | "froogle" | "youtube",
//       "backend":  "CM" | "IZG",
//              // 時間範囲で決まる。now 1-d / now 4-H -> "CM"、all_2008 -> "IZG"。
//              // ★property との交絡は排除済み: HAR には
//              //     (now 1-d,  property:"youtube") -> "CM"
//              //     (all_2008, property:"youtube") -> "IZG"
//              //   の両方があるため、backend を決めているのは property ではなく
//              //   時間範囲であると確定できる。
//       "category": 0                // 数値カテゴリ ID (HAR 観測: 0, 8, 41)
//     },
//     "language": "ja",
//              // ★このエンドポイント固有。hl の **主言語サブタグ**。
//              //   hl=en-US -> "en" になる (実測)。TIMESERIES の "locale" は hl そのもの ("en-US")。
//     "userCountryCode": "JP",
//              // ★このエンドポイント固有。アクセス元 IP の国。geo とは独立で、
//              //   日本から geo=US を叩いても "JP" のままだった (実測)。
//     "userConfig": {"userType":"USER_TYPE_SCRAPER"}
//              // 一般ユーザ全員に付く固定値。通常の Chrome でもこの値になる。
//   }
//
//   req のパーセントエンコード:
//     ブラウザは { } [ ] " のみ %エンコードし、: と , は素通し、空白は + にする。
//     素の encodeURIComponent (":"->%3A, ","->%2C, " "->%20) でもサーバは受理し、
//     同一レスポンス (8196 バイト) が返ることを 2026-09-09 に実測。どちらでもよい。
//
// ----------------------------------------------------------------------------
// 4. token
// ----------------------------------------------------------------------------
//   * 44 文字の base64url (charset [A-Za-z0-9_-]、パディング無し)。全て "ANI_2wMAAAAA" 始まり。
//   * base64url デコードで 33 バイト。bytes[0:9] は固定ヘッダ、bytes[9:13] が
//     ビッグエンディアン uint32 の有効期限 Unix 秒 (= 発行時刻 + 24h)、bytes[13:33] が 20 バイト署名。
//     -> token は 24 時間キャッシュして使い回せる。explore を毎回叩く必要はない。
//   * ★token は req に紐付いた署名である (2026-09-09 実測で確定):
//       - token を 1 文字だけ改変            -> 401 (content-type: text/html, 約 1691 バイト)
//       - token はそのままで req のキーワードだけ差し替え -> 401
//     つまり時間範囲・キーワード・カテゴリを自前で書き換えて token を流用することはできない。
//     パラメータを変えたければ explore を叩き直すこと。
//   * 同一 explore レスポンス内でもウィジェットごとに token は別値。
//
// ----------------------------------------------------------------------------
// 5. レスポンス形式
// ----------------------------------------------------------------------------
//   200 / content-type: application/json; charset=UTF-8
//       / content-disposition: attachment; filename="json.txt"   (filename* は付かない)
//       / cache-control: private, max-age=0
//
//   ★プレフィックスは `)]}',\n` の **6 バイト** (末尾にカンマが付く)。末尾に改行は付かない。
//     /trends/api/explore は `)]}'\n` の 5 バイトでカンマ無し。エンドポイントごとに違う。
//     (先行調査の「5 バイト + 末尾改行」は誤り。合計バイト数が同じになるため
//      バイト計算だけでは判別できなかった。実測は「6 バイト + 末尾改行なし」。)
//     実装は body.slice(body.indexOf("\n") + 1) か /^\)\]\}'[,]?\n/ の除去が安全。
//
//   ★本文は純 ASCII。非 ASCII は \uXXXX、さらに "=" -> \u003d、"&" -> \u0026 と
//     HTML セーフエスケープされる (Gson の既定)。したがって
//     body.length (UTF-16) === UTF-8 バイト数 が常に成立する。
//
//   JSON スキーマ:
//     {
//       "default": {
//         "rankedList": [
//           { "rankedKeyword": [ <TOP アイテム>,    ... ] },   // = metric[0] = TOP
//           { "rankedKeyword": [ <RISING アイテム>, ... ] }    // = metric[1] = RISING
//         ]
//       }
//     }
//     rankedList は metric 配列と順序まで 1:1。各リストは最大 25 件。
//
//   TOP アイテム (キーは query, value, formattedValue, hasData, link の 5 つ):
//     {"query":"カフェ","value":100,"formattedValue":"100","hasData":true,
//      "link":"/trends/explore?q=%E3%82%AB%E3%83%95%E3%82%A7&date=now+7-d&geo=JP"}
//     - value は 0〜100 の相対人気度。降順ソート済みで先頭は 100。
//     - formattedValue は value の文字列表現そのまま (0-100 なので桁区切りは出ない)。
//     - hasData は TOP のみに存在し、観測範囲では常に true。
//
//   RISING アイテム (キーは query, value, formattedValue, link の 4 つ。★hasData が無い):
//     {"query":"ハグ コーヒー 炎上","value":9500,"formattedValue":"急激増加",
//      "link":"/trends/explore?q=...&date=now+7-d&geo=JP"}
//     - value は増加率 (%)。降順ソート済み。
//     - 値が大きいものは "急激増加" (ja) / "Breakout" (en) というラベルになる。
//       閾値の実測レンジ: ブレイクアウトになった最小 value は 5200 (en-US "coffee"/US)、
//       ならなかった最大 value は 4650 -> 閾値は **(4650, 5200] の範囲**にある。
//       一般に言われる 5000 と矛盾しないが、**5000 という値自体は推定であり実測していない**。
//       ラッパーは 5000 でハードコードせず「formattedValue に数字が含まれないものが
//       ブレイクアウト」と判定するほうが安全 (value 降順なので必ず先頭側に固まる)。
//     - 2026-09-09 の実測サンプル:
//         ja "コーヒー"/JP : 9300=急激増加 6000=急激増加 2250="2,250% 増加" 700="700% 増加" …
//         en-US "coffee"/US: 16350=Breakout 12800=Breakout 8700=Breakout 5200=Breakout 300="+300%" …
//     - ブレイクアウトでない場合、formattedValue から数字だけ抜き出して連結すると value と一致する
//       (value=2200 -> "2,200% 増加" / value=4650 -> "+4,650%")。実測で全件成立。
//
//   link は相対パス。q= はキーワードを + 区切りで URL エンコードしたもの、
//   date= は req.restriction.originalTimeRangeForExploreUrl (空白は +)、geo= は geo コード。
//
//   ★hl によるローカライズ差 (2026-09-09 実測):
//       hl=ja    : RISING -> "急激増加" / "2,200% 増加"   (先頭に + は付かない)
//       hl=en-US : RISING -> "Breakout" / "+4,650%"       (先頭に + が付く)
//       TOP の formattedValue はどちらも "100" 等の数字のままで差なし。
//     explore 側のウィジェット title も ja "関連キーワード" / en "Related queries" とローカライズされる。
//
//   ★データが無い場合 (エラーではなく 200 の正常応答。ENTITY と QUERY で形が非対称):
//       keywordType=ENTITY : `)]}',\n{"default":{"rankedList":[]}}`                        = 35 バイト
//       keywordType=QUERY  : `)]}',\n{"default":{"rankedList":[{"rankedKeyword":[]},{"rankedKeyword":[]}]}}`
//                                                                                          = 76 バイト
//     HAR の content.size (35 / 76) と完全一致。204 や空ボディにはならない。
//
//   ★★ 最大の落とし穴: RELATED_TOPICS (keywordType=ENTITY) は常に空を返す ★★
//     HAR の実ブラウザセッション 12/12 (ENTITY は全て content.size=35) も、2026-09-09 のライブ 4/4 も
//     rankedList が [] だった。explore のキーワードにエンティティ mid ("/m/02vqfm" = Coffee) を
//     渡して complexKeywordsRestriction.keyword[0].type が "ENTITY" になったケースでも空。
//     -> 関連トピックは事実上取得できない。ラッパーは「ENTITY は空が正常」として扱うこと。
//     参考: 空でない場合の rankedKeyword は query の代わりに topic:{mid,title,type} を持つ、
//           というのが従来ドキュメントの説明だが、本調査では **一度も観測できていない (未検証)**。
//
// ----------------------------------------------------------------------------
// 6. エラー / レート制限
// ----------------------------------------------------------------------------
//   401 : token 不正、または token と req の不一致。content-type: text/html、約 1691 バイト。
//         HTML の title は "Error 401 (Bad Request)!!1"。
//   429 : レート制限。content-type: text/html、約 1697 バイト。Retry-After ヘッダは無い。
//         content-disposition も x-frame-options も付かない。
//   302 : IP 単位でブロックされると Location: https://www.google.com/sorry/index?continue=...
//         (Google の captcha インタースティシャル) が返る。fetch を redirect:"manual" に
//         しないと自動追跡されてしまい気付けない。
//         ★429 と違い 302 は **IP 単位で持続する**。2026-09-09 の実測:
//           - 軽い発生時 : 3s + 20s + 60s のバックオフで復帰 (本ファイルのライブテストで実際に復帰)
//           - 同一 IP から並列に叩き続けた状態 : 2 分待機 -> 不可、さらに 4.5 分待機 -> 不可
//         復帰時間に上限は無いと考えるべきで、短時間のリトライで抜けられる保証は無い。
//         ラッパーは 302 を「一時的失敗」ではなく「長いクールダウンを要する停止条件」として扱い、
//         リトライ回数を絞って呼び出し元にエラーを返すのが安全。
//   成功判定の推奨:
//     res.status === 200 && res.headers.get("content-type")?.startsWith("application/json")
//   ★本エンドポイントは HAR 26/26 がすべて status=200 で、429 は 1 件も出ていない。
//     (「HAR では正規のブラウザでも 429 が 1 件発生している」という記述は誤りだったので訂正した。
//      その 429 は姉妹エンドポイント /trends/api/widgetdata/multiline の har_idx=246 のもので、
//      relatedsearches のものではない。MANIFEST.TXT で確認済み。)
//     とはいえ 429 自体はセッション単位ではなくリクエスト単位の確率的スロットリングであり、
//     同時並列の他リクエストは 200 のまま通る。指数バックオフ (2s / 4s / 8s) で再試行すること。
//
// ----------------------------------------------------------------------------
// 7. 呼び出しフロー
// ----------------------------------------------------------------------------
//   (1) GET /trending?geo=..&hl=..   -> Set-Cookie: NID を得る
//
//   (2) GET /trends/api/explore?hl=<hl>&tz=<tz>&req=<explore 用 req>&tz=<tz>   (要 NID)
//         ★tz が 2 回付く (ブラウザの実装どおり。1 回でも通るが揃えておくのが無難)。
//         explore の req は relatedsearches の req とは **別スキーマ** なので注意:
//           {"comparisonItem":[{"keyword":"コーヒー","geo":"JP","time":"now 7-d"}],
//            "category":0,"property":""}
//             - keyword  : 検索語、または mid ("/m/02vqfm")
//             - geo      : "" (全世界) / "JP" (国) / "JP-13" (下位地域)
//             - time     : "now 1-d" / "now 4-H" / "now 7-d" / "all_2008" など
//             - category : 数値カテゴリ ID (0 = すべてのカテゴリ)
//             - property : "" (ウェブ検索) / "images" / "news" / "froogle" / "youtube"
//         レスポンスは `)]}'\n` (5 バイト・カンマ無し。relatedsearches の 6 バイトとは違う)
//         + {"widgets":[...]}。
//         widgets[i].id は TIMESERIES / GEO_MAP / RELATED_TOPICS / RELATED_QUERIES。
//         RELATED_* の widgets[i].type は "fe_related_searches"。
//         ★複数キーワード比較時の id 連番 (RELATED_QUERIES_0 / _1 のような綴り) は
//           **本調査では未検証**。HAR の explore レスポンスボディは 100% 未保存であり、
//           ライブ確認も 302 captcha に阻まれて到達できなかった。
//           確実に言えるのは「キーワードごとに別ウィジェットが発行され、各 req の
//           complexKeywordsRestriction.keyword は常に 1 要素」という点だけ (§3 参照)。
//           -> 実装は id の綴りを決め打ちせず、request.keywordType と
//              request.restriction.complexKeywordsRestriction.keyword[0].value で
//              目的のウィジェットを選別すること。
//
//   (3) GET /trends/api/widgetdata/relatedsearches?hl&tz&req=<widget.request>&token=<widget.token>
//         req は widgets[i].request を JSON.stringify して透過させるだけでよい
//         (自分で組み立てない。token が req の署名なので改変すると 401 になる)。
//
//   token は 24h 有効なので (2) の結果はキャッシュしてよい。
// ============================================================================

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@^1";

const HOST = "https://trends.google.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * RISING の「ブレイクアウト」判定閾値の実測ブラケット (2026-09-09 時点)。
 *   BREAKOUT_MAX_NON = ブレイクアウト表記にならなかった value の実測最大値
 *   BREAKOUT_MIN_OBS = ブレイクアウト表記になった value の実測最小値
 * -> 真の閾値は (4650, 5200] の範囲にある。一般に言われる 5000 とは矛盾しないが未確定。
 * 判定そのものは閾値ではなく「formattedValue に数字が含まれるか」で行うこと。
 */
const BREAKOUT_MAX_NON = 4650;
const BREAKOUT_MIN_OBS = 5200;

/** relatedsearches / explore 共通のプレフィックス剥がし。`)]}',\n` と `)]}'\n` の両方に対応。 */
function stripPrefix(body: string): string {
  const m = body.match(/^\)\]\}'[,]?\n/);
  if (!m) throw new Error("unexpected prefix: " + JSON.stringify(body.slice(0, 12)));
  return body.slice(m[0].length);
}

/** req のブラウザ互換パーセントエンコード ( : と , は素通し / 空白は + )。 */
function encodeReq(json: string): string {
  return encodeURIComponent(json)
    .replace(/%3A/g, ":")
    .replace(/%2C/g, ",")
    .replace(/%20/g, "+");
}

type LiveResult = { status: number; contentType: string; body: string };

let liveCount = 0;
/**
 * このファイル 1 回の実行で許容するライブリクエスト上限 (暴走・レート制限対策)。
 * 成功パスは 6 リクエスト (NID + explore ja + rs QUERY + rs ENTITY + explore en + rs en) なので
 * 残り 4 回が再試行の余裕になる。
 */
const MAX_LIVE = 10;

/**
 * 一時的に弾かれたときだけ指数バックオフで最大 3 回再試行する GET。
 * 再試行対象は 2 種類:
 *   429 = リクエスト単位の確率的スロットリング
 *   302 = Location: https://www.google.com/sorry/index?continue=... (IP 単位の captcha インタースティシャル)
 * 302 は redirect:"manual" にしないと自動追跡されて気付けない。2026-09-09 の実測では
 * 同一 IP から並列に叩き続けた状態で 302 が出はじめ、60〜90 秒の待機で 200 に復帰した。
 */
async function liveGet(url: string, cookie?: string): Promise<LiveResult> {
  const delays = [0, 3000, 20000, 60000];
  let last: LiveResult = { status: 0, contentType: "", body: "" };
  for (const d of delays) {
    if (d) await sleep(d);
    if (liveCount >= MAX_LIVE) {
      console.warn(`[skip] ライブリクエスト上限 ${MAX_LIVE} に到達したため中止`);
      return { status: 0, contentType: "", body: "" };
    }
    liveCount++;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "ja",
          "user-agent": UA,
          referer: `${HOST}/trends/explore`,
          ...(cookie ? { cookie } : {}),
        },
        redirect: "manual",
      });
    } catch (e) {
      console.warn("[skip] ネットワークエラー:", String(e));
      return { status: 0, contentType: "", body: "" };
    }
    // Deno のテストは未消費のレスポンスボディでリソースリークになるため必ず消費する
    const body = await res.text();
    last = { status: res.status, contentType: res.headers.get("content-type") ?? "", body };
    if (res.status !== 429 && res.status !== 302) return last;
    const why = res.status === 429
      ? "429 (レート制限)"
      : `302 (${res.headers.get("location")?.slice(0, 40) ?? ""}… captcha インタースティシャル)`;
    console.warn(`[retry] ${why} を受信。バックオフして再試行: ${url.slice(0, 70)}...`);
  }
  return last;
}

// ---- ライブ用ブートストラップ (テスト間で 1 回だけ実行し結果を使い回す) ------------

let nidPromise: Promise<string | null> | null = null;

/** /trending から NID Cookie ("NID=<値>") を得る。取得できなければ null。 */
function getNid(): Promise<string | null> {
  if (!nidPromise) {
    nidPromise = (async () => {
      if (liveCount >= MAX_LIVE) return null;
      liveCount++;
      let res: Response;
      try {
        res = await fetch(`${HOST}/trending?geo=JP&hl=ja`, {
          headers: { "user-agent": UA, "accept-language": "ja" },
          redirect: "manual",
        });
      } catch (e) {
        console.warn("[skip] NID 取得でネットワークエラー:", String(e));
        return null;
      }
      // 1.2MB の HTML は不要なので破棄する (リソースリーク対策も兼ねる)
      await res.body?.cancel();
      const nid = (res.headers.getSetCookie?.() ?? [])
        .map((s) => s.split(";")[0])
        .find((s) => s.startsWith("NID="));
      if (!nid) console.warn(`[skip] Set-Cookie: NID が得られなかった (status=${res.status})`);
      return nid ?? null;
    })();
  }
  return nidPromise;
}

interface Widget {
  id: string;
  type?: string;
  title?: string;
  token: string;
  // deno-lint-ignore no-explicit-any
  request: any;
}

const exploreCache = new Map<string, Promise<Widget[] | null>>();

/** explore を叩いて widgets[] を得る。失敗時は null (テストは skip 扱いにする)。 */
function getWidgets(
  hl: string,
  keyword: string,
  geo: string,
  time: string,
): Promise<Widget[] | null> {
  const key = [hl, keyword, geo, time].join("|");
  if (!exploreCache.has(key)) {
    exploreCache.set(
      key,
      (async () => {
        const nid = await getNid();
        if (!nid) return null;
        await sleep(1500);
        const req = JSON.stringify({
          comparisonItem: [{ keyword, geo, time }],
          category: 0,
          property: "",
        });
        const url = `${HOST}/trends/api/explore?hl=${encodeURIComponent(hl)}&tz=-540` +
          `&req=${encodeReq(req)}&tz=-540`;
        const r = await liveGet(url, nid);
        if (r.status !== 200 || !r.contentType.startsWith("application/json")) {
          console.warn(`[skip] explore が使えない (status=${r.status}, content-type=${r.contentType})`);
          return null;
        }
        return JSON.parse(stripPrefix(r.body)).widgets as Widget[];
      })(),
    );
  }
  return exploreCache.get(key)!;
}

/** relatedsearches を叩いて生ボディを返す。失敗時は null。 */
async function fetchRelatedSearches(hl: string, w: Widget): Promise<string | null> {
  const nid = await getNid();
  if (!nid) return null;
  await sleep(1500);
  const url = `${HOST}/trends/api/widgetdata/relatedsearches?hl=${encodeURIComponent(hl)}&tz=-540` +
    `&req=${encodeReq(JSON.stringify(w.request))}&token=${w.token}`;
  const r = await liveGet(url, nid);
  if (r.status !== 200 || !r.contentType.startsWith("application/json")) {
    console.warn(`[skip] relatedsearches が使えない (status=${r.status}, content-type=${r.contentType})`);
    return null;
  }
  return r.body;
}

// deno-lint-ignore no-explicit-any
function assertRankedListShape(payload: any, keywordType: "ENTITY" | "QUERY") {
  assertEquals(Object.keys(payload), ["default"], "トップレベルのキーは default のみ");
  assertEquals(Object.keys(payload.default), ["rankedList"], "default 直下は rankedList のみ");
  const rl = payload.default.rankedList;
  assert(Array.isArray(rl), "rankedList は配列");
  if (keywordType === "ENTITY") {
    // 空のときは [] (0 要素)、データがあれば metric と同じ 2 要素
    assert(rl.length === 0 || rl.length === 2, `ENTITY の rankedList 長は 0 か 2 (実際 ${rl.length})`);
  } else {
    // QUERY は無データでも 2 要素の空 rankedKeyword が返る (非対称)
    assertEquals(rl.length, 2, "QUERY の rankedList は metric ['TOP','RISING'] に対応する 2 要素");
  }
  for (const entry of rl) {
    assertEquals(Object.keys(entry), ["rankedKeyword"], "rankedList 要素のキーは rankedKeyword のみ");
    assert(Array.isArray(entry.rankedKeyword));
    assert(entry.rankedKeyword.length <= 25, "1 リストあたり最大 25 件");
  }
}

// ============================================================================
// オフラインテスト (ネットワーク不要)
// ============================================================================

Deno.test({
  name: "オフライン: 空レスポンスのリテラルとバイト数が HAR の content.size と一致する",
  fn: () => {
    // HAR 26 エントリの内訳は ENTITY 12 件 / QUERY 14 件。
    // ENTITY は 12/12 が content.size=35 (= 空)、QUERY は無データの 8 件が content.size=76、
    // データ有りの 6 件が 471 / 471 / 471 / 749 / 766 / 4303 バイトだった。
    const emptyEntity = `)]}',\n{"default":{"rankedList":[]}}`;
    const emptyQuery =
      `)]}',\n{"default":{"rankedList":[{"rankedKeyword":[]},{"rankedKeyword":[]}]}}`;
    assertEquals(new TextEncoder().encode(emptyEntity).length, 35);
    assertEquals(new TextEncoder().encode(emptyQuery).length, 76);
    // 本文は ASCII のみなので UTF-16 長 == UTF-8 バイト長
    assertEquals(emptyEntity.length, 35);
    assertEquals(emptyQuery.length, 76);
    // 末尾に改行は付かない
    assert(!emptyEntity.endsWith("\n"));
    assert(!emptyQuery.endsWith("\n"));

    assertRankedListShape(JSON.parse(stripPrefix(emptyEntity)), "ENTITY");
    assertRankedListShape(JSON.parse(stripPrefix(emptyQuery)), "QUERY");
  },
});

Deno.test({
  name: "オフライン: プレフィックス剥がしが )]}',\\n と )]}'\\n の両方を扱える",
  fn: () => {
    assertEquals(stripPrefix(`)]}',\n{"a":1}`), `{"a":1}`); // relatedsearches (6 バイト)
    assertEquals(stripPrefix(`)]}'\n{"a":1}`), `{"a":1}`); // explore         (5 バイト)
    let threw = false;
    try {
      stripPrefix(`{"a":1}`);
    } catch {
      threw = true;
    }
    assert(threw, "プレフィックスが無ければ例外にする");
  },
});

Deno.test({
  name: "オフライン: HAR 00_entry102 の req を再現し ENTITY/QUERY の差分が keywordType だけであることを確認",
  fn: () => {
    // 00_entry102.txt (RELATED_TOPICS) と 01_entry103.txt (RELATED_QUERIES) は
    // 同一 explore から派生したペアで、req の差は keywordType のみだった。
    const base = {
      restriction: {
        geo: { country: "JP" },
        time: "2026-09-07T14\\:53\\:39 2026-09-08T14\\:53\\:39",
        originalTimeRangeForExploreUrl: "now 1-d",
        complexKeywordsRestriction: { keyword: [{ type: "BROAD", value: "Fanza" }] },
      },
      keywordType: "ENTITY",
      metric: ["TOP", "RISING"],
      trendinessSettings: { compareTime: "2026-09-06T14\\:53\\:39 2026-09-07T14\\:53\\:39" },
      requestOptions: { property: "", backend: "CM", category: 0 },
      language: "ja",
      userCountryCode: "JP",
      userConfig: { userType: "USER_TYPE_SCRAPER" },
    };
    // HAR の "query params (decoded)" に出ている req 文字列そのもの
    const harEntity =
      '{"restriction":{"geo":{"country":"JP"},"time":"2026-09-07T14\\\\:53\\\\:39 ' +
      '2026-09-08T14\\\\:53\\\\:39","originalTimeRangeForExploreUrl":"now 1-d",' +
      '"complexKeywordsRestriction":{"keyword":[{"type":"BROAD","value":"Fanza"}]}},' +
      '"keywordType":"ENTITY","metric":["TOP","RISING"],"trendinessSettings":' +
      '{"compareTime":"2026-09-06T14\\\\:53\\\\:39 2026-09-07T14\\\\:53\\\\:39"},' +
      '"requestOptions":{"property":"","backend":"CM","category":0},"language":"ja",' +
      '"userCountryCode":"JP","userConfig":{"userType":"USER_TYPE_SCRAPER"}}';
    // キー順まで含めて HAR の req 文字列と完全一致する
    assertEquals(JSON.stringify(base), harEntity);

    // time のエスケープは「バックスラッシュ + コロン」の 2 文字
    assert(base.restriction.time.includes("\\:"), "time のコロンは \\: にエスケープされている");
    assertEquals(base.restriction.time.split(" ").length, 2, "time は半角スペース区切りの 2 値");

    const asQuery = { ...base, keywordType: "QUERY" };
    const diff = Object.keys(base).filter(
      (k) =>
        JSON.stringify((base as Record<string, unknown>)[k]) !==
          JSON.stringify((asQuery as Record<string, unknown>)[k]),
    );
    assertEquals(diff, ["keywordType"], "ENTITY と QUERY の差分は keywordType の 1 フィールドだけ");

    // ブラウザ互換エンコードでは : と , は素通しし、空白は + になる
    const enc = encodeReq(JSON.stringify(base));
    assert(enc.includes("%22keywordType%22:%22ENTITY%22"), ": が素通しされている");
    assert(enc.includes("now+1-d"), "空白が + になっている");
    assert(enc.includes("%5C%5C:"), "\\: は %5C%5C: にエンコードされる");
    assert(!enc.includes("%20"), "空白の %20 は残らない");
    // 素の encodeURIComponent でもサーバは受理する (2026-09-09 実測) ため
    // ここでは復号の往復が壊れないことだけ確認する
    assertEquals(decodeURIComponent(enc.replace(/\+/g, "%20")), JSON.stringify(base));
  },
});

Deno.test({
  name: "オフライン: 複数キーワード比較でも keyword 配列は 1 要素で、キーワードごとに別 req/token になる",
  fn: () => {
    // 24_entry277 と 25_entry279 は comparisonItem:[{Fanza},{DLsite}] という
    // 単一の explore から派生した隣接ペア (startedDateTime が 2ms 差:
    // 2026-09-08T14:54:48.256Z / .258Z)。
    // これが「N キーワード比較 -> relatedsearches を N 回呼ぶ」ことの直接の根拠。
    const mk = (kw: string) =>
      `{"restriction":{"geo":{"country":"JP"},"time":"2008-01-01 2026-09-08",` +
      `"originalTimeRangeForExploreUrl":"all_2008","complexKeywordsRestriction":` +
      `{"keyword":[{"type":"BROAD","value":"${kw}"}]}},"keywordType":"QUERY",` +
      `"metric":["TOP","RISING"],"trendinessSettings":{"compareTime":"2008-01-01 2009-01-01"},` +
      `"requestOptions":{"property":"youtube","backend":"IZG","category":41},"language":"ja",` +
      `"userCountryCode":"JP","userConfig":{"userType":"USER_TYPE_SCRAPER"}}`;
    const reqFanza = mk("Fanza"); // 24_entry277
    const reqDLsite = mk("DLsite"); // 25_entry279

    for (const raw of [reqFanza, reqDLsite]) {
      const r = JSON.parse(raw);
      // ★片方の req に両方のキーワードが入ることはない
      assertEquals(
        r.restriction.complexKeywordsRestriction.keyword.length,
        1,
        "比較中でも keyword 配列は 1 要素",
      );
      assertEquals(r.keywordType, "QUERY");
      // all_2008 の compareTime は「直前の同じ長さの窓」ではなく最初の 1 年
      assertEquals(r.trendinessSettings.compareTime, "2008-01-01 2009-01-01");
      // 時間範囲が backend を決める (property は youtube のまま IZG)
      assertEquals(r.requestOptions.backend, "IZG");
      assertEquals(r.requestOptions.property, "youtube");
      // 1 日以上の窓なので time はコロンエスケープ無しの日付のみ
      assert(!r.restriction.time.includes("\\:"), "all_2008 の time はエスケープを含まない");
    }

    // 2 つの req の差分はキーワード値だけ
    const a = JSON.parse(reqFanza);
    const b = JSON.parse(reqDLsite);
    assertEquals(a.restriction.complexKeywordsRestriction.keyword[0].value, "Fanza");
    assertEquals(b.restriction.complexKeywordsRestriction.keyword[0].value, "DLsite");
    a.restriction.complexKeywordsRestriction.keyword[0].value = "DLsite";
    assertEquals(
      JSON.stringify(a),
      JSON.stringify(b),
      "キーワード値以外は完全に同一 (geo/time/category/property/backend まで共通)",
    );

    // token はウィジェットごとに別値 (どちらも 44 文字 base64url)
    const tokFanza = "ANI_2wMAAAAAaqFzONU9Kc4sB-xMZ8IR2sFM4c8BXSH1";
    const tokDLsite = "ANI_2wMAAAAAaqFzONN7bd2JCYkxB-KMHGACH55-LtYc";
    assert(tokFanza !== tokDLsite, "キーワードごとに token は異なる");
    for (const t of [tokFanza, tokDLsite]) assertMatch(t, /^ANI_[A-Za-z0-9_-]{40}$/);
    // 同じ explore 由来なので有効期限も同じ 12 バイト目までが一致する
    assertEquals(tokFanza.slice(0, 16), tokDLsite.slice(0, 16), "同一 explore なので前半は共通");
  },
});

Deno.test({
  name: "オフライン: token の 44 文字 base64url 構造と 24 時間有効期限をデコードで確認",
  fn: () => {
    // HAR 00_entry102 の token (発行 2026-09-08T14:53:39Z)。署名付き公開値であり秘密情報ではない。
    const token = "ANI_2wMAAAAAaqFy89-uYRMnFMPreQbR0axR7-KowoFz";
    assertEquals(token.length, 44);
    assertMatch(token, /^[A-Za-z0-9_-]{44}$/);
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (token.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    assertEquals(bytes.length, 33, "デコードすると 33 バイト固定");
    assertEquals(
      Array.from(bytes.slice(0, 9)).map((b) => b.toString(16).padStart(2, "0")).join(""),
      "00d23fdb0300000000",
      "先頭 9 バイトは固定ヘッダ",
    );
    const exp = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(9, false);
    // 発行 2026-09-08T14:53:39Z + 24h = 2026-09-09T14:53:39Z
    assertEquals(exp, Math.floor(Date.parse("2026-09-09T14:53:39Z") / 1000));
  },
});

// ============================================================================
// ライブテスト (429 / ネットワーク断では console.warn して skip 扱いにする)
// ============================================================================

Deno.test({
  name: "ライブ: explore が RELATED_TOPICS / RELATED_QUERIES ウィジェットを返す",
  fn: async () => {
    const widgets = await getWidgets("ja", "コーヒー", "JP", "now 7-d");
    if (!widgets) return;

    const ids = widgets.map((w) => w.id);
    assert(ids.includes("RELATED_TOPICS"), `RELATED_TOPICS が無い: ${ids.join(",")}`);
    assert(ids.includes("RELATED_QUERIES"), `RELATED_QUERIES が無い: ${ids.join(",")}`);

    for (const id of ["RELATED_TOPICS", "RELATED_QUERIES"] as const) {
      const w = widgets.find((x) => x.id === id)!;
      assertEquals(w.type, "fe_related_searches", `${id}.type`);
      assertMatch(w.token, /^ANI_[A-Za-z0-9_-]{40}$/, `${id}.token は 44 文字の base64url`);
      const r = w.request;
      assertEquals(r.keywordType, id === "RELATED_TOPICS" ? "ENTITY" : "QUERY");
      assertEquals(r.metric, ["TOP", "RISING"]);
      assertEquals(r.userConfig, { userType: "USER_TYPE_SCRAPER" });
      assertEquals(r.language, "ja", "language は hl の主言語サブタグ");
      assertEquals(r.restriction.geo, { country: "JP" });
      assertEquals(r.restriction.originalTimeRangeForExploreUrl, "now 7-d");
      assertEquals(r.restriction.complexKeywordsRestriction.keyword, [
        { type: "BROAD", value: "コーヒー" },
      ]);
      assertEquals(r.requestOptions, { property: "", backend: "CM", category: 0 });
      assert(
        typeof r.userCountryCode === "string" && r.userCountryCode.length === 2,
        "userCountryCode は 2 文字の国コード",
      );
      assert(typeof r.trendinessSettings.compareTime === "string");
      assertMatch(r.restriction.time, /^\S+ \S+$/, "time は半角スペース区切りの 2 値");
      assert(r.restriction.time.includes("\\:"), "1 日未満の窓なのでコロンがエスケープされている");
    }

    // ENTITY と QUERY の req の差分は keywordType のみ
    const a = widgets.find((w) => w.id === "RELATED_TOPICS")!;
    const b = widgets.find((w) => w.id === "RELATED_QUERIES")!;
    const diff = Object.keys(a.request).filter(
      (k) => JSON.stringify(a.request[k]) !== JSON.stringify(b.request[k]),
    );
    assertEquals(diff, ["keywordType"]);
    assert(a.token !== b.token, "同一 explore でもウィジェットごとに token は異なる");
  },
});

Deno.test({
  name: "ライブ: RELATED_QUERIES (keywordType=QUERY) の rankedList スキーマ",
  fn: async () => {
    const widgets = await getWidgets("ja", "コーヒー", "JP", "now 7-d");
    if (!widgets) return;
    const w = widgets.find((x) => x.id === "RELATED_QUERIES")!;
    const body = await fetchRelatedSearches("ja", w);
    if (body === null) return;

    // --- 封筒 ---
    assert(
      body.startsWith(")]}',\n"),
      `プレフィックスは )]}',\\n : ${JSON.stringify(body.slice(0, 8))}`,
    );
    assert(!body.endsWith("\n"), "末尾に改行は付かない");
    assertEquals(
      body.length,
      new TextEncoder().encode(body).length,
      "本文は ASCII のみ (非 ASCII は \\uXXXX) なので文字数 == バイト数",
    );
    // deno-lint-ignore no-control-regex
    assert(!/[^\u0000-\u007F]/.test(body), "生ボディに非 ASCII 文字は現れない");
    assert(body.includes("\\u003d"), '"=" は \\u003d にエスケープされる (Gson の HTML セーフ既定)');

    const payload = JSON.parse(stripPrefix(body));
    assertRankedListShape(payload, "QUERY");
    const [top, rising] = payload.default.rankedList;

    // --- TOP (rankedList[0] = metric[0]) ---
    assert(top.rankedKeyword.length > 0, "「コーヒー」の TOP 関連キーワードが 0 件なのは想定外");
    for (const k of top.rankedKeyword) {
      assertEquals(
        Object.keys(k).sort(),
        ["formattedValue", "hasData", "link", "query", "value"],
        "TOP アイテムのキー集合",
      );
      assert(typeof k.query === "string" && k.query.length > 0);
      assert(
        Number.isInteger(k.value) && k.value >= 0 && k.value <= 100,
        `TOP の value は 0-100 の整数 (${k.value})`,
      );
      assertEquals(k.formattedValue, String(k.value), "TOP の formattedValue は value の文字列表現");
      assertEquals(k.hasData, true, "TOP には hasData:true が付く");
      assertMatch(k.link, /^\/trends\/explore\?q=/);
      assert(
        k.link.includes("&date=now+7-d"),
        `link の date は originalTimeRangeForExploreUrl 由来: ${k.link}`,
      );
      assert(k.link.includes("&geo=JP"), `link の geo: ${k.link}`);
    }
    for (let i = 1; i < top.rankedKeyword.length; i++) {
      assert(
        top.rankedKeyword[i - 1].value >= top.rankedKeyword[i].value,
        "TOP は value 降順にソート済み",
      );
    }
    assertEquals(top.rankedKeyword[0].value, 100, "TOP の先頭は 100 に正規化される");

    // --- RISING (rankedList[1] = metric[1]) ---
    assert(rising.rankedKeyword.length > 0, "「コーヒー」の RISING 関連キーワードが 0 件なのは想定外");
    let sawBreakout = false;
    let sawPercent = false;
    let lastWasPercent = false;
    for (const k of rising.rankedKeyword) {
      assertEquals(
        Object.keys(k).sort(),
        ["formattedValue", "link", "query", "value"],
        "RISING アイテムのキー集合 (hasData は無い)",
      );
      assert(!("hasData" in k), "RISING に hasData は存在しない");
      assert(Number.isInteger(k.value) && k.value > 0, `RISING の value は正の整数 (${k.value})`);
      assert(typeof k.formattedValue === "string" && k.formattedValue.length > 0);
      assertMatch(k.link, /^\/trends\/explore\?q=/);

      const digits = k.formattedValue.replace(/[^0-9]/g, "");
      if (digits === String(k.value)) {
        // パーセント表記。例: "2,250% 増加" (ja) / "+300%" (en)
        assert(k.formattedValue.includes("%"), `パーセント表記には % が含まれる: ${k.formattedValue}`);
        sawPercent = true;
        lastWasPercent = true;
        // 閾値そのものは未確定 (実測レンジ (4650, 5200])。ハード failure にはせず観測だけ残す。
        if (k.value > BREAKOUT_MAX_NON) {
          console.warn(`[NOTE] 非ブレイクアウトの value 上限が更新された: ${k.value} > ${BREAKOUT_MAX_NON}`);
        }
      } else {
        // ブレイクアウト表記 (ja: 急激増加 / en: Breakout)。数字を含まない
        assertEquals(digits, "", `ブレイクアウト表記に数字は含まれない: ${k.formattedValue}`);
        assert(
          !lastWasPercent,
          "value 降順なのでブレイクアウト項目はパーセント項目より必ず前に来る",
        );
        sawBreakout = true;
        if (k.value < BREAKOUT_MIN_OBS) {
          console.warn(`[NOTE] ブレイクアウトの value 下限が更新された: ${k.value} < ${BREAKOUT_MIN_OBS}`);
        }
      }
    }
    for (let i = 1; i < rising.rankedKeyword.length; i++) {
      assert(
        rising.rankedKeyword[i - 1].value >= rising.rankedKeyword[i].value,
        "RISING は value 降順にソート済み",
      );
    }
    console.log(
      `[info] ja RISING ${rising.rankedKeyword.length} 件 / breakout=${sawBreakout} percent=${sawPercent} / ` +
        rising.rankedKeyword
          .slice(0, 3)
          .map((k: { formattedValue: string; value: number }) => `${k.formattedValue}(${k.value})`)
          .join(" "),
    );
    if (sawPercent) {
      const pct = rising.rankedKeyword.find(
        (k: { formattedValue: string; value: number }) =>
          k.formattedValue.replace(/[^0-9]/g, "") === String(k.value),
      )!;
      assert(
        !pct.formattedValue.startsWith("+"),
        `hl=ja のパーセント表記は + で始まらない: ${pct.formattedValue}`,
      );
    }
  },
});

Deno.test({
  name: "ライブ: RELATED_TOPICS (keywordType=ENTITY) は 200 で空の rankedList を返す",
  fn: async () => {
    const widgets = await getWidgets("ja", "コーヒー", "JP", "now 7-d");
    if (!widgets) return;
    const w = widgets.find((x) => x.id === "RELATED_TOPICS")!;
    const body = await fetchRelatedSearches("ja", w);
    if (body === null) return;

    assert(body.startsWith(")]}',\n"));
    const payload = JSON.parse(stripPrefix(body));
    assertRankedListShape(payload, "ENTITY");

    // 実測 (HAR の ENTITY 12/12 + 2026-09-09 のライブ 4/4) では常に空。
    if (payload.default.rankedList.length === 0) {
      assertEquals(
        body,
        `)]}',\n{"default":{"rankedList":[]}}`,
        "空 ENTITY レスポンスのリテラル",
      );
      assertEquals(body.length, 35, "空 ENTITY レスポンスは 35 バイト (HAR の content.size と一致)");
      console.log("[info] RELATED_TOPICS は既知のとおり空を返した (rankedList: [])");
    } else {
      // 将来データが返るようになった場合の想定スキーマ (本調査では未観測 = 未検証)
      console.warn("[NOTE] RELATED_TOPICS がデータを返した。仕様が変わった可能性がある");
      for (const rl of payload.default.rankedList) {
        for (const k of rl.rankedKeyword) {
          assert("topic" in k || "query" in k, "ENTITY アイテムは topic か query を持つ");
          if (k.topic) {
            assert(
              typeof k.topic.mid === "string" && k.topic.mid.startsWith("/"),
              "topic.mid は /m/xxxx 形式",
            );
            assert(typeof k.topic.title === "string");
            assert(typeof k.topic.type === "string");
          }
        }
      }
    }
  },
});

Deno.test({
  name: "ライブ: hl による formattedValue のローカライズ差 (ja vs en-US)",
  fn: async () => {
    const jaWidgets = await getWidgets("ja", "コーヒー", "JP", "now 7-d");
    const enWidgets = await getWidgets("en-US", "coffee", "US", "now 7-d");
    if (!jaWidgets || !enWidgets) return;

    // explore 側: language は hl の主言語サブタグに落ちる (TIMESERIES の locale は hl そのもの)
    const enRq = enWidgets.find((w) => w.id === "RELATED_QUERIES")!;
    assertEquals(enRq.request.language, "en", "hl=en-US なら language は 'en'");
    assertEquals(enRq.request.userCountryCode.length, 2);
    const enTs = enWidgets.find((w) => w.id === "TIMESERIES");
    if (enTs) assertEquals(enTs.request.locale, "en-US", "TIMESERIES の locale は hl そのもの");

    // ウィジェットのタイトルもローカライズされる
    const jaRq = jaWidgets.find((w) => w.id === "RELATED_QUERIES")!;
    assert(jaRq.title !== enRq.title, `title がローカライズされる (ja=${jaRq.title} / en=${enRq.title})`);
    assertEquals(enRq.title, "Related queries");

    const body = await fetchRelatedSearches("en-US", enRq);
    if (body === null) return;
    const payload = JSON.parse(stripPrefix(body));
    assertRankedListShape(payload, "QUERY");
    const [top, rising] = payload.default.rankedList;

    // TOP の formattedValue はロケール非依存 (0-100 の数字のまま)
    for (const k of top.rankedKeyword) assertEquals(k.formattedValue, String(k.value));

    let checkedPercent = false;
    let checkedBreakout = false;
    for (const k of rising.rankedKeyword) {
      const digits = k.formattedValue.replace(/[^0-9]/g, "");
      if (digits === String(k.value)) {
        // en-US のパーセント表記は "+4,650%" のように + で始まる (ja は "4,650% 増加")
        assertMatch(k.formattedValue, /^\+[\d,]+%$/, `en-US のパーセント表記: ${k.formattedValue}`);
        checkedPercent = true;
      } else {
        assertEquals(k.formattedValue, "Breakout", "en-US のブレイクアウト表記");
        assert(k.value > BREAKOUT_MAX_NON, `ブレイクアウトの value は ${BREAKOUT_MAX_NON} 超 (${k.value})`);
        checkedBreakout = true;
      }
      assert(k.link.includes("&geo=US"));
    }
    console.log(
      `[info] en-US RISING ${rising.rankedKeyword.length} 件 / percent=${checkedPercent} breakout=${checkedBreakout} / ` +
        rising.rankedKeyword
          .slice(0, 3)
          .map((k: { formattedValue: string }) => k.formattedValue)
          .join(" "),
    );
    assert(checkedPercent || checkedBreakout, "RISING が 1 件も無いのは想定外");
  },
});
