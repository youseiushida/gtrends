// 実行: deno test --allow-read live_integration/13_har_offline_conformance_test.ts
//
// ネットワーク権限 (--allow-net) は不要。このファイルは HTTP を一切叩かない。
// 必須の権限は --allow-read (HAR ファイルの読み取り) のみ。
// 環境変数 GTREND_HAR で HAR のパスを上書きしたい場合のみ --allow-env を追加する
// (env アクセスは try/catch で握り潰しているので、無くても既定パスで動作する)。

/**
 * =============================================================================
 * 13_har_offline_conformance_test.ts
 *   Google Trends ワイヤ仕様の「HAR オフライン整合性テスト (回帰テスト)」
 * =============================================================================
 *
 * ## このファイルの位置づけ
 *
 * 本ディレクトリの他のテストは実際に trends.google.com を叩く「ライブ検証」である。
 * ライブ検証は Google のレート制限 (429) によって容易に不安定化し、CI では緑にならない。
 * 本ファイルは **キャプチャ済み HAR だけを入力とし、ネットワークを一切使わずに**
 * ワイヤ仕様を検証する。したがって
 *
 *   - オフライン環境でも常に実行できる
 *   - 429 に左右されず、決定的 (deterministic) に緑/赤が決まる
 *   - ラッパーライブラリのパーサ実装を変更したときの回帰検出に使える
 *
 * という性質を持つ。ライブ検証が落ちたとき「仕様が変わったのか」「単に 429 なのか」を
 * 切り分けるための基準線 (baseline) として機能させることを意図している。
 *
 *
 * ## 入力 HAR
 *
 *   既定パス: C:\Users\ushid\Documents\gtrend_claude\.har\trends.google.com.har
 *   環境変数 GTREND_HAR で上書き可能。
 *   加えて cwd 相対の ".har/trends.google.com.har" と
 *   "../.har/trends.google.com.har" も探索する。
 *
 *   **HAR が見つからない場合、全テストは ignore され緑になる。**
 *   (このファイル単体を任意の環境で走らせても落ちないようにするため。
 *    スキップされた場合は理由が 1 行だけ警告として出る。)
 *
 *   キャプチャ日時 : 2026-09-08T14:53:36Z 〜 14:54:57Z (約 81 秒、UI 操作 1 セッション)
 *   HAR サイズ     : 約 29 MB / log.entries は 456 件
 *   うち trends.google.com 宛 : 111 件
 *   キャプチャ内容 : (a) /trends/explore?q=Fanza&date=now 1-d&geo=JP&hl=ja の一連の UI 操作
 *                    (b) /trends/trendingsearches/daily?geo=JP&hl=ja
 *                        → 302 で /trending (新 Trending Now UI, boq RPC) へ遷移
 *
 *
 * ## メモリについて (重要)
 *
 * ### 実測してわかったこと (2026-09-09 / Windows 11 / Deno 2.9.6 / PeakWorkingSet)
 *
 * まず **支配的なコストは JSON.parse ではなく「29MB をどう読むか」だった**。
 *
 *   deno 起動のみ (baseline)                        :  約 10 MB
 *   readTextFileSync で読むだけ (parse すらしない)  : 約 181 MB   ← これが犯人
 *   readTextFileSync + 丸ごと JSON.parse            : 約 179 MB
 *   readTextFileSync + entries を 1 件ずつ parse    : 約 179 MB   ← 削減効果ゼロ
 *   **readFileSync (バイト列) + 1 件ずつ parse**    : 約  88 MB   ← 採用
 *
 * つまり 29MB のファイルを `Deno.readTextFileSync` で **JS 文字列に展開した時点で**
 * 約 180MB を消費してしまい、その後 JSON.parse を工夫しても一切減らない。
 * (V8 の文字列表現と UTF-8 デコードのバッファが効いている。)
 * 逆に `Deno.readFileSync` で **Uint8Array のまま持てば約 88MB で済む**。
 *
 * ### 採用した方針
 *
 *   1. `Deno.readFileSync` で **バイト列のまま** 読む (文字列に展開しない)。
 *   2. `"entries"` 配列の中を括弧の深さで走査し (文字列リテラル / エスケープを考慮)、
 *      **1 エントリぶんの subarray** を切り出して decode → JSON.parse する。
 *      `subarray` はコピーを作らない。射影が終わったエントリは即座に GC 対象。
 *      → 456 エントリぶんのオブジェクトが同時に生存することがない。
 *      JSON の構造文字は全て ASCII なので、UTF-8 バイト列のまま安全に走査できる。
 *   3. レスポンスボディを保持するのは batchexecute の 21 件だけ (合計 約 300KB)。
 *      /trending の HTML (約 1.26MB) など巨大なボディは長さだけ記録して本体を捨てる。
 *   4. Cookie は **名前だけ** 射影し、値は射影の時点で捨てる (秘密情報を持ち回らない)。
 *   5. 射影は 1 回だけ行い、以降のテストで使い回す (Deno.test は同一プロセスで直列実行)。
 *   6. 走査器がエントリを 1 件も取れなかった場合 (HAR の整形が想定と違う等) は
 *      **丸ごと JSON.parse へフォールバック**する。堅牢性のための保険。
 *      (フォールバック経路も実際に動かして 14/14 緑になることを確認済み。)
 *
 * 全 14 テストの実行時間は約 0.4 秒。
 *
 * **バイト走査版と丸ごと parse 版が同一の射影結果を返すことは、実 HAR
 * (456 エントリ / trends 宛 111 件 / batchexecute ボディ 21 件) で
 * 1 件の差異もなく一致することを確認済み** (2026-09-09)。
 *
 * 注: `deno test` は runner のオーバーヘッドで上記より 80MB ほど上に出る。
 *     上の数値はいずれも `deno run` で測ったもの。
 *
 *
 * =============================================================================
 * ## 【最重要】batchexecute レスポンス封筒の「長さ行」の単位
 * =============================================================================
 *
 * /_/TrendsUi/data/batchexecute のレスポンス本文は以下の形をしている。
 *
 *     )]}'\n          ← 4 文字 + LF
 *     \n              ← 空行  (ここまでで固定 6 文字のプレフィックス)
 *     <10進数字>\n<チャンクJSON>\n
 *     <10進数字>\n<チャンクJSON>\n
 *     ...
 *
 * この `<10進数字>` (以下 N) の単位が何かは、パーサ実装の成否を分ける最重要ポイント。
 * 候補は 3 つ:
 *
 *     (a) UTF-8 バイト長
 *     (b) UTF-16 コードユニット長  (= JavaScript の String.length)
 *     (c) Unicode コードポイント長 (= [...str].length)
 *
 * ### 結論 (本ファイルの test 08 が実データで機械的に判定する)
 *
 *   **(a) UTF-8 バイト長は明確に誤りである。** 日本語を含む実データで破綻する。
 *   **(b) と (c) はどちらも本 HAR の全 21 ボディを完走する。**
 *   本 HAR にはサロゲートペア (BMP 外 = astral 文字) が 1 文字も存在しないため、
 *   (b) と (c) はこのデータでは原理的に区別できない。
 *
 * ### (a) を棄却する具体的な反例 (HAR 実データ / test 08 が再計算して検証する)
 *
 *   | HAR entry | rpcid  |     N | JSON の UTF-16 長 (= N-2) | JSON の UTF-8 バイト長 |
 *   |-----------|--------|-------|---------------------------|------------------------|
 *   |       322 | DqDTgb | 50055 |                     50053 |                  86617 |
 *   |       351 | g4kJzf | 50484 |                     50482 |                  50594 |
 *   |       402 | i0OFE  | 20740 |                     20738 |                  24992 |
 *   |       433 | i0OFE  |  8530 |                      8528 |                  10218 |
 *   |       450 | i0OFE  |  3895 |                      3893 |                   4777 |
 *
 *   21 ボディ中 **13 ボディで UTF-8 バイト解釈が破綻する**。
 *   残り 8 ボディは中身が ASCII のみ (Tnt4U の `[[]]` や MHC2q の `[]` など) なので
 *   3 つの単位が偶然一致してしまう。
 *   **小さいレスポンスだけを見て実装すると必ず踏む罠。**
 *
 * ### 厳密な切り出し規則 (21/21 ボディで検証済み)
 *
 *   長さ数字列を終端する LF の位置を `nl`、数字列の値を `N` とすると
 *
 *       body.slice(nl, nl + N)  ===  "\n" + <チャンクJSON> + "\n"
 *
 *   が成立する。したがって
 *
 *       json      = body.slice(nl + 1, nl + N - 1)
 *       json.length === N - 2
 *       次の長さ行の先頭 = nl + N
 *
 *   すなわち **N は「長さ行を終端する LF」＋「JSON 本体」＋「JSON を終端する LF」を
 *   数えている**。素直に「LF を読み飛ばしてから N 文字読む」と 1 文字ずれる。
 *   ここも定番の罠。
 *
 * ### (b) UTF-16 を採用すべき理由 (測定ではなく論拠)
 *
 *   本 HAR とライブ観測 (2026-09-09, JP/TW/IN) のいずれにも astral 文字が出現しなかったため、
 *   (b) と (c) は実測では確定できない。ただし
 *
 *     - この封筒を消費する正規のクライアントは Google 自身の JavaScript (Wiz/boq) である
 *     - JS の String.length / slice は UTF-16 コードユニット単位でしか動かない
 *     - サーバが (c) コードポイントで数えていたら、astral 文字を含む応答で
 *       Google 自身のクライアントが壊れる
 *
 *   ことから、**(b) UTF-16 コードユニットと解釈するのが唯一整合的**である。
 *   実装上も、Deno / Node の `res.text()` が返す JS 文字列に対して
 *   そのまま `slice(nl, nl + N)` すれば (b) の挙動になるので、
 *   **特別なことを何もしないのが正解**という結論になる。
 *   (test 08 はこの「未確定だが UTF-16 を採るべき」という状況自体もアサートする。)
 *
 * ### 単位の混在 (もう 1 つの罠)
 *
 *   最終チャンクは常に `[["e", k, null, null, T]]` の形をしている。
 *
 *     k = 全チャンクを平坦化したときのアイテム総数 (1 始まりの通し番号)
 *     T = **レスポンスボディ全体の UTF-8 バイト長**
 *
 *   つまり **同一レスポンス内で「長さ行 = UTF-16 単位」「e チャンク = UTF-8 バイト」と
 *   単位が食い違っている**。T を `body.length` と比較すると日本語応答で必ず不一致になる。
 *   照合するなら `new TextEncoder().encode(body).length` と比べること。
 *
 *   HAR 実測: entry 322 は文字数 50153 に対し T=86717。
 *   ライブ実測 (2026-09-09, i0OFE): JP 108618 文字 / T=131074、
 *     TW 33513 文字 / T=37330、IN 74811 文字 / T=82881。いずれも T = UTF-8 バイト長と一致。
 *
 *
 * =============================================================================
 * ## batchexecute のリクエスト仕様 (test 09 が検証)
 * =============================================================================
 *
 *   POST https://trends.google.com/_/TrendsUi/data/batchexecute?<query>
 *
 *   クエリ (27/27 エントリで同じ 10 個):
 *     rpcids       … 呼ぶ RPC の id。複数はカンマ結合 (URL 上は %2C)
 *     source-path  … SPA の現在ルート ("/trending" または "/home")
 *     f.sid        … セッション ID。/trending HTML の WIZ_global_data.FdrFJe
 *                    符号付き 64bit の**文字列**。負値もあるので数値化禁止
 *     bl           … FE ビルドラベル。WIZ_global_data.cfb2h
 *     hl           … 表示言語
 *     soc-app / soc-platform / soc-device … 全て 1 固定
 *     _reqid       … キャッシュバスタ。B + 100000*n (B はセッション毎の乱数)
 *     rt           … "c" 固定。この値のとき「長さ行 + チャンク」形式で返る
 *
 *   ヘッダ:
 *     content-type: application/x-www-form-urlencoded;charset=UTF-8
 *     x-same-domain: 1
 *     origin: https://trends.google.com
 *     referer: https://trends.google.com/
 *     ※ at (XSRF) トークンは URL にもボディにも存在しない (27/27)
 *
 *   ボディ: 常に `f.req=<percent-encoded JSON>&` の **1 キーのみ**。末尾に裸の & が付く。
 *     デコード後の構造:
 *         [[ call, call, ... ]]                    // 外側は必ず 2 重配列
 *         call = [ rpcid, argsJSONString|null, null, slotId ]
 *     call[2] は 28/28 全て null。slotId の観測値は "1" / "3" / "generic"。
 *     call[1] は「JSON をさらに JSON 文字列としてエスケープしたもの」(二段 JSON)。
 *
 *
 * =============================================================================
 * ## 旧 REST API のリクエスト仕様 (test 03〜07 が検証)
 * =============================================================================
 *
 *   POST /trends/api/explore?hl=<hl>&tz=<min>&req=<JSON>&tz=<min>
 *     - **tz が 2 回出現する** (13/13)。Angular の interceptor による二重付与。
 *     - req はクエリ側にある。スキーマは
 *         { comparisonItem: [{ keyword, geo, time }], category: int, property: string }
 *       観測値: geo ∈ {"JP","JP-13"}, time ∈ {"now 1-d","now 4-H","all_2008"},
 *               category ∈ {0,8,41}, property ∈ {"","images","news","froogle","youtube"}
 *     - POST ボディは reCAPTCHA 運搬専用:
 *         body = "FE" + base64(JSON.stringify(["setoken", tokenA, tokenB]))
 *       ("FEW" と書かれることがあるが誤り。W は base64 の 1 文字目 = "WyJz" → `["s`)
 *       tokenA は 1764 文字固定の reCAPTCHA v3 トークン。
 *         **13 リクエスト全てで完全に同一値** (test 05 が値の同一性まで検証済み)。
 *         → セッション中は使い回されている。実装者にとっては
 *           「リクエスト毎に reCAPTCHA を解き直す必要は無い」という帰結になる。
 *       tokenB は 13331〜18419 文字でリクエスト毎に異なる BotGuard 系 blob。
 *         **13 件が全て相異なる** (test 05 が検証済み)。長さもばらつく。
 *       base64 はパディング無し。本サンプルでは 62/63 番目の文字が出現しないため
 *       標準 base64 か base64url かは判別不能。
 *
 *   GET /trends/api/widgetdata/multiline?hl&tz&req&token&tz     (tz 二重)
 *   GET /trends/api/widgetdata/comparedgeo?hl&tz&req&token      (tz 一度)
 *   GET /trends/api/widgetdata/relatedsearches?hl&tz&req&token  (tz 一度)
 *     - token と req は 54/54 全てで必須。
 *     - token は常に 44 文字の base64url、全て "ANI_2wMAAAAA" 始まり、54/54 相異なる。
 *       デコードすると 33 バイト固定で
 *         bytes[0..8]   9B  固定ヘッダ 00d23fdb0300000000 (54/54 同一)
 *         bytes[9..12]  4B  ビッグエンディアン uint32 = **失効 UNIX 秒**
 *         bytes[13..32] 20B ウィジェット毎に一意 (HMAC 相当)
 *       失効時刻 − リクエスト時刻 = 86399 or 86400 秒 (54/54) → **token は 24 時間有効**。
 *       ローカルで期限判定できるので explore を毎回叩かずキャッシュ可能。
 *
 *
 * =============================================================================
 * ## HAR にボディが無い理由 — よくある誤説の訂正 (test 12 が記録)
 * =============================================================================
 *
 * 「content-disposition: attachment が付いているから Chrome がボディを保存しない」
 * という説明を見かけるが、**これは本 HAR の実データと矛盾する**。
 *
 *   - /_/TrendsUi/data/batchexecute は content-disposition: attachment が付いているのに
 *     27 件中 21 件でボディが保存されている。
 *   - 逆に /trends/explore (content-disposition なし) は 8 件全てボディが空。
 *   - 429 応答 (content-disposition なし、content.size=1695) もボディが空。
 *
 * 真の原因は **DevTools のページ単位ボディ退避 (eviction)**。
 * trends.google.com 宛 111 件を pageref 別に集計すると
 *
 *     pageref=undefined :  0 件保存 /  7 件空
 *     pageref=page_1    :  0 件保存 / 79 件空   ← /trends/explore セッション (離脱済み)
 *     pageref=page_2    : 24 件保存 /  1 件空   ← /trending セッション (エクスポート時に表示中)
 *
 * となり、**HAR エクスポート時点で表示中だったページのボディだけが残っている**。
 * /trends/api/* は **71 件すべて page_1 所属** なので全滅した
 * (うち 70 件が 200 + content-disposition: attachment、残り 1 件が 429 = entry 246)。
 *
 * 実務上の帰結は同じ (= /trends/api/* の応答仕様はライブで確かめるしかない) が、
 * 原因が違うので **Explore ページを開いたまま HAR を取り直せば /trends/api/* のボディも
 * 取れる**。今後 HAR を再キャプチャする際に効いてくるので test 12 で明示的に記録する。
 *
 * なお test 12 は **この「取り直した HAR」を与えられても落ちない** 作りにしてある。
 * 上のようにボディ付きで再キャプチャするのを推奨しておきながら、
 * その改善された HAR でテストが赤くなるのでは自己矛盾だからである。具体的には
 *
 *   - /trends/api/* のボディが 0 件 (現コーパス) → 「全滅している」事実を記録する
 *   - ボディが 1 件以上ある (再キャプチャ後)   → 記録に切り替えたうえで、
 *     保存されていた 200 応答が `)]}'` プレフィックス付きであることを検証する
 *
 * と分岐する。DevTools 退避仮説 (ページ単位の集計) の検証も前者のときだけ行う。
 * 実 HAR にボディを注入した合成 HAR で両分岐を実際に通し、
 * 正しいボディなら緑・壊れたプレフィックスなら赤になることを確認済み (2026-09-09)。
 *
 * なお /trends/api/* の応答は **ボディが無くても content.size (非圧縮バイト数) は残る**。
 * この数値からスキーマを逆算できる (プレフィックス `)]}'\n` 5 バイト + JSON + LF 1 バイト):
 *     relatedsearches 空 (ENTITY) = 35 バイト
 *         → `{"default":{"rankedList":[]}}` (29) + 5 + 1
 *     relatedsearches 空 (QUERY)  = 76 バイト
 *         → `{"default":{"rankedList":[{"rankedKeyword":[]},{"rankedKeyword":[]}]}}` (70) + 5 + 1
 *     multiline 空                = 51 バイト
 *         → `{"default":{"timelineData":[],"averages":[]}}` (45) + 5 + 1
 * 3 つとも 1 バイトの誤差なく一致する。test 12 がこの会計を検証する。
 *
 *
 * =============================================================================
 * ## エラー応答 (test 13 が検証)
 * =============================================================================
 *
 *   429 : content-type は **text/html; charset=utf-8** (JSON ではない)。
 *         Retry-After ヘッダ無し。content-disposition 無し。x-frame-options 無し。
 *         ボディは約 1.7KB の HTML。
 *         → 成功判定は status だけでなく content-type も見ること。
 *         → HAR 中 429 は 1 件のみ (entry 246)。同時に並列発火した 247/248/249 は全て 200
 *            だったので、429 は**セッション単位のブロックではなくリクエスト単位の
 *            確率的スロットリング**である。1 本落ちても他は生きる。
 *   302 : /trends/trendingsearches/daily → https://trends.google.com/trending?geo=JP&hl=ja
 *         旧デイリートレンド UI は廃止済み。
 *   502 : /_/TrendsUi/browserinfo と /_/TrendsUi/jserror。テレメトリ系なので無視してよい。
 *
 *
 * =============================================================================
 * ## 秘密情報の取り扱い
 * =============================================================================
 *
 *   - HAR には NID / OTZ などの Cookie 値と reCAPTCHA トークン (1764 文字 / 13KB 超) が
 *     実値で入っている。
 *   - 本ファイルは **それらの値をソースに一切埋め込まない**。
 *     実行時に HAR から読むだけで、長さ・プレフィックス・文字集合しか検査しない。
 *   - Cookie は射影の時点で **名前だけ** にし、値は捨てている (Ent.cookieNames)。
 *   - 失敗メッセージやログにトークン本体・Cookie 値を出さない。
 *     長い値を扱う箇所では必ず「長さ」「先頭数文字」だけを使う。
 *   - test 14 が **このファイル自身のソースを読み直して**、40 文字以上の
 *     base64url 風リテラルが混入していないことを確認する
 *     (将来コピペ事故でトークンを埋め込んでしまうのを防ぐガード)。
 *
 *
 * =============================================================================
 * ## ラッパー実装者向けの要点まとめ
 * =============================================================================
 *
 *  1. batchexecute の長さ行は **UTF-16 コードユニット**。TextEncoder で数えると日本語で壊れる。
 *  2. チャンク JSON は N-2 文字。前後の LF が N に含まれる。次の長さ行は nl+N から。
 *  3. e チャンクの T だけ **UTF-8 バイト長**。同一レスポンス内で単位が混在する。
 *  4. チャンク境界に意味は無い。必ず平坦化してから [0]==="wrb.fr" で拾う。
 *  5. wrb.fr の出現順はリクエストの call 順と一致しない。rpcid か slotId で突き合わせる。
 *     (entry 418 は i0OFE → wAgrOe の順で送って wAgrOe が先に返る実例)
 *  6. wrb.fr[2] は二段 JSON (JSON 文字列の中に JSON)。JSON.parse が 2 回必要。
 *  7. batchexecute の POST ボディは `f.req=<percent-encoded JSON>&` の 1 キーのみ。
 *  8. /trends/api/explore は req を **クエリ**に載せる。POST ボディは reCAPTCHA 運搬用。
 *  9. widget token は 44 文字 / 33 バイト。byte[9..12] BE-uint32 が失効 UNIX 秒 (発行 +24h)。
 *     ローカルで失効判定できるので、explore を毎回叩かずキャッシュしてよい。
 * 10. 429 は content-type: text/html で返る。Retry-After は付かない。
 *     並列に投げた他のリクエストは 200 で通るので、1 本の 429 で全体を諦めないこと。
 * 11. explore の reCAPTCHA トークン (setoken の 2 番目) は **セッション中ずっと同一値**。
 *     リクエスト毎に取り直す必要は無い。3 番目の BotGuard blob だけが毎回変わる。
 * 12. token / rpcid / slotId 以外に XSRF (`at`) トークンの類は一切登場しない。
 *     batchexecute も widgetdata も、必要なのは Cookie (NID) と URL 上のパラメータだけ。
 *
 *
 * =============================================================================
 * ## 根拠にした HAR エントリ (log.entries の index)
 * =============================================================================
 *
 *   batchexecute (ボディ有 21 件):
 *     322(DqDTgb) 330(Tnt4U) 351/357/363(g4kJzf) 402/405(i0OFE) 410(g4kJzf)
 *     414(MHC2q) 416(Tnt4U) 418(i0OFE,wAgrOe) 419(i0OFE) 422(g4kJzf) 429(MHC2q)
 *     432(Tnt4U) 433(i0OFE) 438(g4kJzf) 445(MHC2q) 448(Tnt4U) 450(i0OFE) 452(g4kJzf)
 *   batchexecute (ボディ無 6 件): 7 14 15 21 27 33  (すべて source-path=/home)
 *   POST /trends/api/explore (13 件): 92 116 132 148 161 174 189 203 217 229 244 257 272
 *   429: 246 (/trends/api/widgetdata/multiline)
 *   302: 284 (/trends/trendingsearches/daily → /trending)
 *   /trending HTML: 285
 *
 * ライブ検証日: 2026-09-09
 *   (本ファイル自体はネットワークを使わない。ドキュメント中の「ライブ実測」注記は
 *    同日に別途 4 リクエストで確認した値である。)
 * =============================================================================
 */

import { assert, assertEquals, assertGreaterOrEqual } from "jsr:@std/assert@^1";

// -----------------------------------------------------------------------------
// HAR の探索
// -----------------------------------------------------------------------------

function envHarPath(): string {
  try {
    return Deno.env.get("GTREND_HAR") ?? "";
  } catch {
    return ""; // --allow-env が無い場合は黙って諦める
  }
}

const HAR_CANDIDATES: string[] = [
  envHarPath(),
  "C:/Users/ushid/Documents/gtrend_claude/.har/trends.google.com.har",
  ".har/trends.google.com.har",
  "../.har/trends.google.com.har",
].filter((p) => p.length > 0);

function findHarPath(): string | null {
  for (const p of HAR_CANDIDATES) {
    try {
      if (Deno.statSync(p).isFile) return p;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

const HAR_PATH: string | null = findHarPath();
const SKIP = HAR_PATH === null;

if (SKIP) {
  console.warn(
    "[13_har_offline_conformance] HAR が見つからないため全テストを skip します。" +
      " 環境変数 GTREND_HAR で HAR のパスを指定してください。",
  );
}

// -----------------------------------------------------------------------------
// 射影 (projection): HAR から必要なフィールドだけを抜き出した軽量表現
// -----------------------------------------------------------------------------

/** 1 エントリの射影。**Cookie の値と巨大ボディは意図的に保持しない。** */
interface Ent {
  /** log.entries における index */
  idx: number;
  method: string;
  /** URL の pathname */
  path: string;
  /** URL 全体 (クエリ解析用。ログには出さない) */
  url: string;
  /** request.queryString に現れた name を順序どおり並べたもの (tz の重複も保持) */
  qsNames: string[];
  startedMs: number;
  status: number;
  mimeType: string;
  /** response.content.size (非圧縮バイト数)。ボディが未保存でも入っている */
  contentSize: number;
  /** response.content.text の長さ。0 なら未保存 */
  bodyLen: number;
  /**
   * ボディ先頭 64 文字だけの控え (全エントリぶん保持しても 111*64 文字で無害)。
   * 巨大ボディを捨てたあとでも `)]}'` プレフィックスの有無を検査できるようにするため。
   */
  bodyHead: string;
  /** batchexecute のみ本体を保持。それ以外は null (メモリ節約) */
  body: string | null;
  /** POST ボディ。batchexecute のみ保持 */
  postBody: string | null;
  /** explore の POST ボディのメタ情報 (プレフィックスと base64 部分) */
  postMeta: { prefix2: string; length: number; b64: string } | null;
  pageref: string;
  headers: Record<string, string | null>;
  /** Cookie は **名前だけ**。値は捨てる */
  cookieNames: string[];
}

interface Projection {
  totalEntries: number;
  pageIds: string[];
  trends: Ent[];
}

const WANTED_HEADERS = [
  "content-type",
  "content-disposition",
  "content-encoding",
  "retry-after",
  "x-frame-options",
  "location",
  "server",
  "vary",
];

let _proj: Projection | null = null;

// --- バイト単位の走査に使う ASCII コード ---
const CH_QUOTE = 0x22; // "
const CH_BSLASH = 0x5c; // \
const CH_COLON = 0x3a; // :
const CH_COMMA = 0x2c; // ,
const CH_LBRACE = 0x7b; // {
const CH_RBRACE = 0x7d; // }
const CH_LBRACK = 0x5b; // [
const CH_RBRACK = 0x5d; // ]

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

const DEC = new TextDecoder();

/**
 * `buf` の中から `"<key>"` `:` `[` という並びを探し、`[` のバイト位置を返す。
 * レスポンスボディ内に同名の文字列が現れても、直後が `:` `[` でなければ読み飛ばす。
 * 見つからなければ -1。
 *
 * JSON の構造文字はすべて ASCII なので、UTF-8 バイト列のまま安全に走査できる
 * (マルチバイト文字の後続バイトは必ず 0x80 以上なので構造文字と衝突しない)。
 */
function findArrayStart(buf: Uint8Array, key: string): number {
  const pat = new TextEncoder().encode(`"${key}"`);
  outer:
  for (let i = 0; i + pat.length < buf.length; i++) {
    for (let j = 0; j < pat.length; j++) {
      if (buf[i + j] !== pat[j]) continue outer;
    }
    let k = i + pat.length;
    while (k < buf.length && isWs(buf[k])) k++;
    if (buf[k] !== CH_COLON) continue;
    k++;
    while (k < buf.length && isWs(buf[k])) k++;
    if (buf[k] === CH_LBRACK) return k;
  }
  return -1;
}

/**
 * `buf` の位置 `start` にある `{` または `[` に対応する閉じ括弧の **次** の位置を返す。
 * JSON 文字列リテラルとエスケープを追跡するので、ボディ中の `{` や `"` に騙されない。
 * (HAR のボディには括弧と引用符が大量に含まれるので、この追跡は必須。)
 */
function matchBracket(buf: Uint8Array, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === CH_BSLASH) esc = true;
      else if (c === CH_QUOTE) inStr = false;
      continue;
    }
    if (c === CH_QUOTE) inStr = true;
    else if (c === CH_LBRACE || c === CH_LBRACK) depth++;
    else if (c === CH_RBRACE || c === CH_RBRACK) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * `"entries"` 配列の要素を 1 つずつ **バイト列のビュー (subarray)** として取り出す。
 *
 * `subarray` はコピーを作らないので、切り出し自体はメモリを消費しない。
 * 呼び出し側が 1 件ずつ decode → JSON.parse → 射影 → 破棄 することで、
 * 456 エントリぶんのオブジェクトを同時に生存させずに済む。
 */
function* iterEntryBytes(buf: Uint8Array): Generator<Uint8Array> {
  const start = findArrayStart(buf, "entries");
  if (start < 0) return;
  let i = start + 1;
  while (i < buf.length) {
    while (i < buf.length && (buf[i] === CH_COMMA || isWs(buf[i]))) i++;
    if (i >= buf.length || buf[i] === CH_RBRACK) return;
    if (buf[i] !== CH_LBRACE) return; // 想定外の並び → 呼び出し側がフォールバックする
    const end = matchBracket(buf, i);
    if (end < 0) return;
    yield buf.subarray(i, end);
    i = end;
  }
}

function loadProjection(): Projection {
  if (_proj) return _proj;
  if (!HAR_PATH) throw new Error("HAR path not resolved");

  // **テキストではなくバイト列として読む。** 29MB を JS 文字列に展開すると
  // それだけでピーク RSS が約 180MB に達する (実測)。Uint8Array のままなら約 88MB。
  const buf = Deno.readFileSync(HAR_PATH);

  // pages は小さいので、その配列部分だけを切り出して parse する。
  let pageIds: string[] = [];
  const pagesAt = findArrayStart(buf, "pages");
  const entriesAt = findArrayStart(buf, "entries");
  if (pagesAt >= 0 && (entriesAt < 0 || pagesAt < entriesAt)) {
    const end = matchBracket(buf, pagesAt);
    if (end > 0) {
      try {
        // deno-lint-ignore no-explicit-any
        pageIds = (JSON.parse(DEC.decode(buf.subarray(pagesAt, end))) as any[])
          .map((p) => String(p.id));
      } catch {
        pageIds = [];
      }
    }
  }

  const trends: Ent[] = [];
  let totalEntries = 0;

  // deno-lint-ignore no-explicit-any
  const project = (e: any, i: number) => {
    let u: URL;
    try {
      u = new URL(e.request.url);
    } catch {
      return;
    }
    if (u.hostname !== "trends.google.com") return;

    const path = u.pathname;
    const isBatch = path === "/_/TrendsUi/data/batchexecute";
    const isExplorePost = path === "/trends/api/explore";

    const bodyText: string = e.response?.content?.text ?? "";
    const postText: string = e.request?.postData?.text ?? "";

    const headers: Record<string, string | null> = {};
    // deno-lint-ignore no-explicit-any
    const hs: any[] = e.response?.headers ?? [];
    for (const want of WANTED_HEADERS) {
      const found = hs.find((h) => String(h.name).toLowerCase() === want);
      headers[want] = found ? String(found.value) : null;
    }

    trends.push({
      idx: i,
      method: String(e.request.method),
      path,
      url: String(e.request.url),
      // deno-lint-ignore no-explicit-any
      qsNames: (e.request.queryString ?? []).map((q: any) => String(q.name)),
      startedMs: Date.parse(e.startedDateTime),
      status: Number(e.response.status),
      mimeType: String(e.response?.content?.mimeType ?? ""),
      contentSize: Number(e.response?.content?.size ?? 0),
      bodyLen: bodyText.length,
      bodyHead: bodyText.slice(0, 64),
      // batchexecute だけ本体を保持 (合計 約 300KB)。/trending の 1.26MB HTML 等は捨てる。
      body: isBatch ? bodyText : null,
      postBody: isBatch ? postText : null,
      postMeta: isExplorePost && postText.length > 0
        ? {
          prefix2: postText.slice(0, 2),
          length: postText.length,
          b64: postText.slice(2),
        }
        : null,
      pageref: String(e.pageref ?? "undefined"),
      headers,
      // Cookie は名前だけ。値は一切保持しない。
      // deno-lint-ignore no-explicit-any
      cookieNames: (e.request.cookies ?? []).map((c: any) => String(c.name)),
    });
  };

  // ---- 主経路: 1 エントリずつ decode → parse → 射影 → 破棄 ----
  for (const slice of iterEntryBytes(buf)) {
    let e: unknown;
    try {
      e = JSON.parse(DEC.decode(slice));
    } catch {
      // 走査がずれた可能性がある。フォールバックに委ねるため打ち切る。
      totalEntries = -1;
      break;
    }
    project(e, totalEntries);
    totalEntries++;
  }

  // ---- フォールバック: 走査に失敗したら丸ごと JSON.parse ----
  // (HAR の整形が想定と違う場合の保険。実 HAR ではここには来ない。)
  if (totalEntries <= 0) {
    trends.length = 0;
    // deno-lint-ignore no-explicit-any
    const har: any = JSON.parse(DEC.decode(buf));
    // deno-lint-ignore no-explicit-any
    const entries: any[] = har.log?.entries ?? [];
    totalEntries = entries.length;
    if (pageIds.length === 0) {
      // deno-lint-ignore no-explicit-any
      pageIds = (har.log?.pages ?? []).map((p: any) => String(p.id));
    }
    for (let i = 0; i < entries.length; i++) project(entries[i], i);
  }

  _proj = { totalEntries, pageIds, trends };
  return _proj;
}

const trendsEntries = () => loadProjection().trends;
const byPath = (p: string) => trendsEntries().filter((e) => e.path === p);
const byPrefix = (p: string) => trendsEntries().filter((e) => e.path.startsWith(p));
const qp = (e: Ent, name: string) => new URL(e.url).searchParams.get(name);

// -----------------------------------------------------------------------------
// batchexecute 封筒パーサ (このファイル内の自前実装。外部依存なし)
// -----------------------------------------------------------------------------

const ENVELOPE_PREFIX = ")]}'\n\n";
const TE = new TextEncoder();

/** 長さ行の単位仮説 */
type Unit = "utf16" | "codepoint" | "utf8";

/**
 * `body` の位置 `nl` から、単位 `unit` で数えて丁度 `target` 個ぶん進んだ
 * 終端インデックス (UTF-16 index) を返す。丁度で止まれない場合は -1。
 *
 * utf16 は body.slice が UTF-16 index なので単純加算でよい。
 * codepoint / utf8 はコードポイント単位で歩いて重みを加算する (O(n))。
 */
function advanceBy(body: string, nl: number, target: number, unit: Unit): number {
  if (unit === "utf16") {
    const end = nl + target;
    return end <= body.length ? end : -1;
  }
  let i = nl;
  let acc = 0;
  while (i < body.length && acc < target) {
    const cp = body.codePointAt(i)!;
    const codeUnits = cp > 0xffff ? 2 : 1;
    const w = unit === "codepoint"
      ? 1
      : cp < 0x80
      ? 1
      : cp < 0x800
      ? 2
      : cp < 0x10000
      ? 3
      : 4;
    acc += w;
    i += codeUnits;
  }
  return acc === target ? i : -1;
}

interface Envelope {
  /** 全チャンクを平坦化したアイテム列 */
  items: unknown[][];
  /** チャンク JSON 文字列 (平坦化前) */
  chunks: string[];
}

/** 指定単位で封筒をパースする。失敗したら null を返す (例外を投げない)。 */
function tryParseEnvelope(body: string, unit: Unit): Envelope | null {
  if (!body.startsWith(ENVELOPE_PREFIX)) return null;
  const items: unknown[][] = [];
  const chunks: string[] = [];
  let pos = ENVELOPE_PREFIX.length;
  let guard = 0;

  while (pos < body.length) {
    if (guard++ > 10000) return null;
    const nl = body.indexOf("\n", pos);
    if (nl < 0) return null;
    const numStr = body.slice(pos, nl);
    if (!/^\d+$/.test(numStr)) return null;
    const n = Number(numStr);
    if (n < 2) return null;

    const end = advanceBy(body, nl, n, unit);
    if (end < 0) return null;

    const seg = body.slice(nl, end);
    // seg は "\n" + JSON + "\n" でなければならない
    if (!seg.startsWith("\n") || !seg.endsWith("\n")) return null;
    const json = seg.slice(1, -1);

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;

    chunks.push(json);
    for (const it of parsed) {
      if (!Array.isArray(it)) return null;
      items.push(it as unknown[]);
    }
    pos = end;
  }
  return { items, chunks };
}

/**
 * ラッパー実装者がそのまま使える最終形のパーサ (UTF-16 固定)。
 * 戻り値は wrb.fr アイテムだけを取り出し、二段 JSON を解いたもの。
 */
function parseBatchExecute(
  body: string,
): Array<{ rpcid: string; slot: string; data: unknown }> {
  const env = tryParseEnvelope(body, "utf16");
  if (!env) throw new Error("batchexecute envelope parse failed");
  return env.items
    .filter((it) => it[0] === "wrb.fr")
    .map((it) => ({
      rpcid: String(it[1]),
      slot: String(it[6]),
      data: typeof it[2] === "string" ? JSON.parse(it[2] as string) : it[2],
    }));
}

/** base64url / 標準 base64 どちらでもデコードする (パディング欠落も許容) */
function b64decode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ボディが保存されている batchexecute エントリだけを返す */
const batchWithBody = () =>
  byPath("/_/TrendsUi/data/batchexecute").filter((e) => (e.body ?? "").length > 0);

/** HAR が無いときは ignore になる Deno.test のラッパ */
const t = (name: string, fn: () => void) => Deno.test({ name, ignore: SKIP, fn });

// =============================================================================
// test 01: HAR の基本構造
// =============================================================================

t("01 HAR の基本構造 / trends.google.com 宛エントリが存在する", () => {
  const p = loadProjection();

  assertGreaterOrEqual(p.totalEntries, 1, "log.entries が空");
  assertGreaterOrEqual(
    p.trends.length,
    50,
    `trends.google.com 宛エントリが少なすぎる: ${p.trends.length}`,
  );

  // 全エントリが最低限のフィールドを持つ
  for (const e of p.trends) {
    assert(e.method.length > 0, `entry ${e.idx}: method 欠落`);
    assert(e.path.startsWith("/"), `entry ${e.idx}: path が不正`);
    assert(Number.isFinite(e.status) && e.status >= 100, `entry ${e.idx}: status が不正`);
    assert(Number.isFinite(e.startedMs), `entry ${e.idx}: startedDateTime が不正`);
  }

  // 参考値 (2026-09-08 キャプチャ): 456 エントリ / trends 宛 111 件 / pages 2 件
  console.log(
    `  [01] log.entries=${p.totalEntries}, trends.google.com=${p.trends.length}, pages=${p.pageIds.length}`,
  );
});

// =============================================================================
// test 02: 期待するエンドポイント群が全て含まれること
// =============================================================================

t("02 期待するエンドポイント群が全て HAR に含まれる", () => {
  const counts = new Map<string, number>();
  for (const e of trendsEntries()) {
    // autocomplete はキーワードがパス末尾に入るので正規化する
    const key = e.path.startsWith("/trends/api/autocomplete/")
      ? "/trends/api/autocomplete/<keyword>"
      : e.path;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // 「この HAR に必ず居るはず」のエンドポイント目録。
  // 件数は再キャプチャで変わりうるので下限だけを課す。
  const REQUIRED: Array<[string, number]> = [
    ["/trends/explore", 1], // 旧 Explore の SPA シェル (HTML)
    ["/trends/api/explore", 1], // ウィジェット定義 + token を返す
    ["/trends/api/explore/pickers/geo", 1], // 地域ピッカー
    ["/trends/api/explore/pickers/category", 1], // カテゴリピッカー
    ["/trends/api/widgetdata/multiline", 1], // TIMESERIES
    ["/trends/api/widgetdata/comparedgeo", 1], // GEO_MAP
    ["/trends/api/widgetdata/relatedsearches", 1], // RELATED_TOPICS / RELATED_QUERIES
    ["/trends/api/autocomplete/<keyword>", 1], // オートコンプリート
    ["/trends/trendingsearches/daily", 1], // 旧デイリートレンド (302)
    ["/trending", 1], // 新 Trending Now UI (boq)
    ["/_/TrendsUi/data/batchexecute", 1], // boq RPC
  ];

  const missing = REQUIRED.filter(([p, min]) => (counts.get(p) ?? 0) < min);
  assertEquals(
    missing.map(([p]) => p),
    [],
    `期待するエンドポイントが HAR に無い: ${missing.map(([p]) => p).join(", ")}`,
  );

  // 参考: 2026-09-08 キャプチャの実件数 (2026-09-09 に実測で照合済み)
  //   batchexecute 27 / relatedsearches 26 / comparedgeo 15 / explore 13 / multiline 13
  //   trends_explore 8 / browserinfo 2 / autocomplete 2
  //   pickers/geo 1 / pickers/category 1 / trendingsearches/daily 1 / trending 1 / jserror 1
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p}=${n}`).join(" ");
  console.log(`  [02] ${summary}`);
});

// =============================================================================
// test 03: POST /trends/api/explore のクエリ形状
// =============================================================================

t("03 /trends/api/explore は POST で、クエリは hl,tz,req,tz (tz が 2 回)", () => {
  const es = byPath("/trends/api/explore");
  assertGreaterOrEqual(es.length, 1, "/trends/api/explore のエントリが無い");

  for (const e of es) {
    assertEquals(e.method, "POST", `entry ${e.idx}: explore は POST のはず`);

    // クエリ名の並びが 13/13 で "hl,tz,req,tz" に固定されている。
    // tz が 2 回出るのは Angular の interceptor による二重付与。
    assertEquals(
      e.qsNames.join(","),
      "hl,tz,req,tz",
      `entry ${e.idx}: explore のクエリ順が想定外`,
    );

    const tzCount = e.qsNames.filter((n) => n === "tz").length;
    assertEquals(tzCount, 2, `entry ${e.idx}: tz は 2 回出現するはず`);

    // hl / tz / req が実際に値を持つ
    assert((qp(e, "hl") ?? "").length > 0, `entry ${e.idx}: hl が空`);
    assert(/^-?\d+$/.test(qp(e, "tz") ?? ""), `entry ${e.idx}: tz が整数でない`);
    assert((qp(e, "req") ?? "").length > 0, `entry ${e.idx}: req が空`);
  }

  console.log(`  [03] explore POST ${es.length} 件すべて hl,tz,req,tz`);
});

// =============================================================================
// test 04: explore の req クエリの JSON スキーマ
// =============================================================================

t("04 explore の req クエリが期待する JSON スキーマである", () => {
  const es = byPath("/trends/api/explore");
  const seenTime = new Set<string>();
  const seenGeo = new Set<string>();
  const seenCat = new Set<number>();
  const seenProp = new Set<string>();
  let maxItems = 0;

  for (const e of es) {
    const raw = qp(e, "req")!;
    let req: Record<string, unknown>;
    try {
      req = JSON.parse(raw);
    } catch (err) {
      throw new Error(`entry ${e.idx}: req が JSON として壊れている: ${String(err)}`);
    }

    // トップレベルは この 3 キーで完全 (13 件の和集合)
    assertEquals(
      Object.keys(req).sort(),
      ["category", "comparisonItem", "property"],
      `entry ${e.idx}: req のトップレベルキーが想定外`,
    );

    assertEquals(typeof req.category, "number", `entry ${e.idx}: category は数値`);
    assertEquals(typeof req.property, "string", `entry ${e.idx}: property は文字列`);
    seenCat.add(req.category as number);
    seenProp.add(req.property as string);

    const items = req.comparisonItem;
    assert(Array.isArray(items), `entry ${e.idx}: comparisonItem は配列`);
    assertGreaterOrEqual(items.length, 1, `entry ${e.idx}: comparisonItem が空`);
    assert(items.length <= 5, `entry ${e.idx}: comparisonItem は最大 5 要素`);
    maxItems = Math.max(maxItems, items.length);

    for (const ci of items as Array<Record<string, unknown>>) {
      // 各要素は keyword / geo / time の 3 キーで完全
      assertEquals(
        Object.keys(ci).sort(),
        ["geo", "keyword", "time"],
        `entry ${e.idx}: comparisonItem 要素のキーが想定外`,
      );
      assertEquals(typeof ci.keyword, "string", `entry ${e.idx}: keyword は文字列`);
      assertEquals(typeof ci.geo, "string", `entry ${e.idx}: geo は文字列`);
      assertEquals(typeof ci.time, "string", `entry ${e.idx}: time は文字列`);

      // geo は "" / ISO-3166-1 (JP) / ISO-3166-2 (JP-13) のいずれか
      assert(
        /^$|^[A-Z]{2}$|^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(ci.geo as string),
        `entry ${e.idx}: geo の形式が想定外`,
      );
      // time は "now N-X" 形式 か "all_YYYY" か "YYYY-MM-DD YYYY-MM-DD"
      assert(
        /^now \d+-[dHmy]$/.test(ci.time as string) ||
          /^all(_\d{4})?$/.test(ci.time as string) ||
          /^\d{4}-\d{2}-\d{2} \d{4}-\d{2}-\d{2}$/.test(ci.time as string),
        `entry ${e.idx}: time の形式が想定外: ${ci.time}`,
      );
      seenTime.add(ci.time as string);
      seenGeo.add(ci.geo as string);
    }
  }

  console.log(
    `  [04] time=${[...seenTime].join("|")} geo=${[...seenGeo].join("|")} ` +
      `category=${[...seenCat].join("|")} property=${[...seenProp].map((p) => p || '""').join("|")} ` +
      `maxComparisonItem=${maxItems}`,
  );
});

// =============================================================================
// test 05: explore の POST ボディ = "FE" + base64(["setoken", tokenA, tokenB])
// =============================================================================

t('05 explore の POST ボディが "FE" + base64(["setoken", tokA, tokB]) である', () => {
  const es = byPath("/trends/api/explore").filter((e) => e.postMeta !== null);
  assertGreaterOrEqual(es.length, 1, "explore の POST ボディが 1 件も無い");

  const lenA = new Set<number>();
  const lenB: number[] = [];
  // トークンの実値は保持も出力もしない。**同一性の判定にだけ** 使い、
  // 集計後は個数 (Set の size) しか外に出さない。
  const distinctA = new Set<string>();
  const distinctB = new Set<string>();

  for (const e of es) {
    const pm = e.postMeta!;

    // プレフィックスは "FEW" ではなく "FE" (2 文字)。
    // "FEW..." に見えるのは base64 部が "WyJz" (= `["s`) で始まるため。
    assertEquals(pm.prefix2, "FE", `entry ${e.idx}: POST ボディのプレフィックスが想定外`);

    // base64 部はパディング無しで、英数字 + base64/base64url の記号のみ
    assert(!pm.b64.includes("="), `entry ${e.idx}: base64 にパディングが付いている`);
    assert(
      /^[A-Za-z0-9+/_-]+$/.test(pm.b64),
      `entry ${e.idx}: base64 に想定外の文字が含まれる`,
    );

    const json = new TextDecoder().decode(b64decode(pm.b64));
    let arr: unknown;
    try {
      arr = JSON.parse(json);
    } catch (err) {
      throw new Error(`entry ${e.idx}: base64 の中身が JSON でない: ${String(err)}`);
    }

    assert(Array.isArray(arr), `entry ${e.idx}: 内側は配列のはず`);
    assertEquals(arr.length, 3, `entry ${e.idx}: 内側は 3 要素のはず`);
    assertEquals(arr[0], "setoken", `entry ${e.idx}: 第 1 要素は "setoken" 固定`);

    const a = arr[1];
    const b = arr[2];
    assertEquals(typeof a, "string", `entry ${e.idx}: tokenA は文字列`);
    assertEquals(typeof b, "string", `entry ${e.idx}: tokenB は文字列`);

    // トークンの **値** は決してログにも失敗メッセージにも出さない。
    // 形式 (文字集合・長さ・先頭) だけを検査する。
    assert(
      /^[A-Za-z0-9_-]+$/.test(a as string),
      `entry ${e.idx}: tokenA が base64url 文字集合でない`,
    );
    assert(
      /^[A-Za-z0-9_-]+$/.test(b as string),
      `entry ${e.idx}: tokenB が base64url 文字集合でない`,
    );
    // tokenA は reCAPTCHA v3 トークン (プレフィックス "03A" 始まり、1764 文字固定)
    assert((a as string).startsWith("03A"), `entry ${e.idx}: tokenA の先頭が想定外`);
    // tokenB は BotGuard 系 blob。必ず "A" で始まり 10000 文字を超える
    assert((b as string).startsWith("A"), `entry ${e.idx}: tokenB の先頭が想定外`);
    assertGreaterOrEqual((b as string).length, 10000, `entry ${e.idx}: tokenB が短すぎる`);

    lenA.add((a as string).length);
    lenB.push((b as string).length);
    distinctA.add(a as string);
    distinctB.add(b as string);

    // ボディ長 = "FE" + base64 の長さ
    assertEquals(pm.length, 2 + pm.b64.length, `entry ${e.idx}: ボディ長が合わない`);
  }

  // tokenA は 13 リクエスト全てで **同一値**。長さだけでなく値の同一性まで検証する。
  // (reCAPTCHA v3 のサイトトークンをセッション中ずっと使い回している = 1 回取れば足りる。
  //  実装者にとっては「毎回 reCAPTCHA を解く必要は無い」という重要な帰結になる。)
  assertEquals(lenA.size, 1, `tokenA の長さが複数ある: ${[...lenA].join(",")}`);
  assertEquals(
    distinctA.size,
    1,
    `tokenA が全リクエストで同一値でない (相異なる値が ${distinctA.size} 種類)`,
  );

  // tokenB はリクエスト毎に異なる BotGuard blob。**全件が相異なる**。
  assertEquals(
    distinctB.size,
    es.length,
    `tokenB が使い回されている (${es.length} 件中 ${distinctB.size} 種類)`,
  );
  assert(new Set(lenB).size > 1, "tokenB の長さが全て同じ (毎回異なるはず)");

  console.log(
    `  [05] ${es.length} 件 / tokenA 長=${[...lenA][0]} (${distinctA.size} 種類 = 全件同一) / ` +
      `tokenB ${distinctB.size} 種類 (全件相異) 長=${Math.min(...lenB)}〜${Math.max(...lenB)}`,
  );
});

// =============================================================================
// test 06: widgetdata に token と req が必ず含まれる
// =============================================================================

t("06 /trends/api/widgetdata/* のリクエストに token と req が必ず含まれる", () => {
  const ws = byPrefix("/trends/api/widgetdata/");
  assertGreaterOrEqual(ws.length, 1, "widgetdata のエントリが無い");

  const perEndpoint = new Map<string, { n: number; orders: Set<string> }>();

  for (const e of ws) {
    assertEquals(e.method, "GET", `entry ${e.idx}: widgetdata は GET`);

    const token = qp(e, "token");
    const req = qp(e, "req");
    assert(token !== null && token.length > 0, `entry ${e.idx}: token が無い`);
    assert(req !== null && req.length > 0, `entry ${e.idx}: req が無い`);
    assert((qp(e, "hl") ?? "").length > 0, `entry ${e.idx}: hl が無い`);
    assert(/^-?\d+$/.test(qp(e, "tz") ?? ""), `entry ${e.idx}: tz が無い/不正`);

    // req は必ず JSON としてパースでき、userConfig を持つ
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(req);
    } catch (err) {
      throw new Error(`entry ${e.idx}: req が JSON でない: ${String(err)}`);
    }
    assert("userConfig" in r, `entry ${e.idx}: req に userConfig が無い`);
    assert("requestOptions" in r, `entry ${e.idx}: req に requestOptions が無い`);
    assertEquals(
      (r.userConfig as Record<string, unknown>).userType,
      "USER_TYPE_SCRAPER",
      `entry ${e.idx}: userConfig.userType が想定外`,
    );

    const name = e.path.split("/").pop()!;
    const slot = perEndpoint.get(name) ?? { n: 0, orders: new Set<string>() };
    slot.n++;
    slot.orders.add(e.qsNames.join(","));
    perEndpoint.set(name, slot);
  }

  // エンドポイント別の必須キー (HAR 全件の和集合 = これで完全)
  const SCHEMA: Record<string, string[]> = {
    multiline: ["time", "resolution", "locale", "comparisonItem", "requestOptions", "userConfig"],
    comparedgeo: ["geo", "comparisonItem", "resolution", "locale", "requestOptions", "userConfig"],
    relatedsearches: [
      "restriction",
      "keywordType",
      "metric",
      "trendinessSettings",
      "requestOptions",
      "language",
      "userCountryCode",
      "userConfig",
    ],
  };

  for (const e of ws) {
    const name = e.path.split("/").pop()!;
    const need = SCHEMA[name];
    if (!need) continue;
    const r = JSON.parse(qp(e, "req")!) as Record<string, unknown>;
    const missing = need.filter((k) => !(k in r));
    assertEquals(missing, [], `entry ${e.idx} (${name}): req に必須キーが無い`);

    if (name === "relatedsearches") {
      // metric は 26/26 で ["TOP","RISING"] 固定。rankedList の順序に対応する。
      assertEquals(r.metric, ["TOP", "RISING"], `entry ${e.idx}: metric が想定外`);
      assert(
        r.keywordType === "ENTITY" || r.keywordType === "QUERY",
        `entry ${e.idx}: keywordType が想定外: ${r.keywordType}`,
      );
    }
    if (name === "multiline") {
      // クエリ順は hl,tz,req,token,tz (tz 二重)
      assertEquals(
        e.qsNames.join(","),
        "hl,tz,req,token,tz",
        `entry ${e.idx}: multiline のクエリ順が想定外`,
      );
    } else {
      // comparedgeo / relatedsearches は tz 一度きり
      assertEquals(
        e.qsNames.join(","),
        "hl,tz,req,token",
        `entry ${e.idx}: ${name} のクエリ順が想定外`,
      );
    }
  }

  const summary = [...perEndpoint.entries()]
    .map(([k, v]) => `${k}=${v.n}[${[...v.orders].join(" / ")}]`).join(" ");
  console.log(`  [06] ${summary}`);
});

// =============================================================================
// test 07: widget token の内部構造と 24 時間有効期限
// =============================================================================

t("07 widget token は 44 文字 base64url / 33 バイト / 有効期限は発行 +24h", () => {
  const ws = byPrefix("/trends/api/widgetdata/");
  const tokens = ws.map((e) => ({ idx: e.idx, tok: qp(e, "token")!, at: e.startedMs }));
  assertGreaterOrEqual(tokens.length, 1, "token が 1 件も無い");

  const lens = new Set<number>();
  const decodedLens = new Set<number>();
  const headHex = new Set<string>();
  const deltas = new Set<number>();
  const uniq = new Set<string>();

  for (const { idx, tok, at } of tokens) {
    uniq.add(tok);
    lens.add(tok.length);

    // 44 文字の base64url (パディング無し)
    assertEquals(tok.length, 44, `entry ${idx}: token の長さが 44 でない`);
    assert(/^[A-Za-z0-9_-]+$/.test(tok), `entry ${idx}: token が base64url でない`);

    const b = b64decode(tok);
    decodedLens.add(b.length);
    assertEquals(b.length, 33, `entry ${idx}: token のデコード長が 33 バイトでない`);

    // bytes[0..8] は 9 バイトの固定ヘッダ
    const hex = [...b.slice(0, 9)].map((x) => x.toString(16).padStart(2, "0")).join("");
    headHex.add(hex);

    // bytes[9..12] = ビッグエンディアン uint32 = 失効 UNIX 秒
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const exp = dv.getUint32(9, false);
    const reqSec = Math.floor(at / 1000);
    const delta = exp - reqSec;
    deltas.add(delta);

    // 発行から 24 時間 (秒の丸めで 86399 or 86400)
    assert(
      delta === 86400 || delta === 86399,
      `entry ${idx}: token の有効期間が 24h でない (${delta} 秒)`,
    );
  }

  // 固定ヘッダは全 token で同一
  assertEquals(headHex.size, 1, `token の固定ヘッダが複数ある: ${[...headHex].join(",")}`);
  assertEquals(
    [...headHex][0],
    "00d23fdb0300000000",
    "token の 9 バイト固定ヘッダが想定外",
  );

  // 同一 explore レスポンス内でもウィジェット毎に別 token なので全件ユニーク
  assertEquals(uniq.size, tokens.length, "token が重複している (全件ユニークのはず)");

  console.log(
    `  [07] ${tokens.length} 件 / 全件ユニーク / 長さ=${[...lens].join(",")} ` +
      `デコード=${[...decodedLens].join(",")}B / 有効期間=${[...deltas].sort().join(",")}秒`,
  );
});

// =============================================================================
// test 08: 【最重要】長さ行の単位判定
// =============================================================================

t("08 batchexecute 長さ行の単位判定: UTF-8 バイト説を棄却し UTF-16 を確定させる", () => {
  const bs = batchWithBody();
  assertGreaterOrEqual(bs.length, 1, "ボディ付き batchexecute が無い");

  let okUtf16 = 0;
  let okCodepoint = 0;
  let okUtf8 = 0;
  let discriminating = 0; // UTF-8 説が破綻する = 日本語等を含むボディ
  let surrogateBodies = 0;
  const counterexamples: string[] = [];

  for (const e of bs) {
    const body = e.body!;

    // 封筒プレフィックスは 6 文字固定
    assert(
      body.startsWith(ENVELOPE_PREFIX),
      `entry ${e.idx}: 封筒プレフィックス ")]}'\\n\\n" が無い`,
    );

    // サロゲートペア (BMP 外 = astral 文字) の有無を数える。
    // これが 0 である限り「UTF-16」と「コードポイント」は区別できない。
    let hasSurrogate = false;
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        hasSurrogate = true;
        break;
      }
    }
    if (hasSurrogate) surrogateBodies++;

    const u16 = tryParseEnvelope(body, "utf16");
    const cp = tryParseEnvelope(body, "codepoint");
    const u8 = tryParseEnvelope(body, "utf8");

    if (u16) okUtf16++;
    if (cp) okCodepoint++;
    if (u8) okUtf8++;

    // ---- UTF-16 は必ず成功しなければならない ----
    assert(u16 !== null, `entry ${e.idx}: UTF-16 単位でパースできない`);

    // ---- 最初のチャンクについて 3 通りの長さを実測して記録 ----
    const nl = body.indexOf("\n", ENVELOPE_PREFIX.length);
    const n = Number(body.slice(ENVELOPE_PREFIX.length, nl));
    const json = body.slice(nl + 1, nl + n - 1);

    // 厳密な切り出し規則: json.length === N - 2
    assertEquals(
      json.length,
      n - 2,
      `entry ${e.idx}: JSON の UTF-16 長が N-2 でない (N=${n})`,
    );
    // body.slice(nl, nl+N) は "\n" + JSON + "\n"
    const seg = body.slice(nl, nl + n);
    assertEquals(seg, "\n" + json + "\n", `entry ${e.idx}: チャンク境界の切り出し規則が破れた`);

    const utf8Len = TE.encode(json).length;
    if (utf8Len !== n - 2) {
      discriminating++;
      // UTF-8 バイト説を棄却できる反例として記録 (値は数値だけ。秘密情報を含まない)
      const rpcids = qp(e, "rpcids") ?? "?";
      counterexamples.push(
        `entry=${e.idx} rpcids=${rpcids} N=${n} utf16=${n - 2} utf8=${utf8Len}`,
      );
      // このボディでは UTF-8 単位でのパースは必ず失敗するはず
      assert(
        u8 === null,
        `entry ${e.idx}: UTF-8 単位でもパースできてしまった (判定が甘い)`,
      );
    }
  }

  // ---- 結論 1: UTF-16 は全ボディで成功 ----
  assertEquals(okUtf16, bs.length, "UTF-16 単位で全ボディをパースできなかった");

  // ---- 結論 2: UTF-8 バイト説は反例が存在する = 棄却 ----
  assertGreaterOrEqual(
    discriminating,
    1,
    "UTF-8 バイト説を棄却できる反例が 1 件も無い (このデータでは判定不能)",
  );
  assert(okUtf8 < bs.length, "UTF-8 単位でも全ボディが通ってしまった (判定不能)");

  // ---- 結論 3: サロゲートペアが無い限り UTF-16 と コードポイント は区別できない ----
  // この条件が崩れた (astral 文字を含むボディが混ざった) 場合は、
  // 初めて UTF-16 か コードポイント かを確定できるようになる。
  if (surrogateBodies === 0) {
    assertEquals(
      okCodepoint,
      okUtf16,
      "サロゲートペアが無いのに UTF-16 と コードポイント の結果が食い違った",
    );
    console.log(
      "  [08] astral 文字を含むボディが無いため UTF-16 と コードポイント は区別不能。" +
        "\n       → 正規クライアントが JS (String.length は UTF-16) である以上、UTF-16 を採用する。",
    );
  } else {
    // astral 文字入りのボディが手に入った場合は、どちらが正しいかを断定できる。
    console.log(
      `  [08] astral 文字を含むボディが ${surrogateBodies} 件ある: ` +
        `utf16=${okUtf16 === bs.length ? "OK" : "NG"} codepoint=${okCodepoint === bs.length ? "OK" : "NG"}`,
    );
    assertEquals(okUtf16, bs.length, "astral 入りでも UTF-16 が正しいはず");
  }

  console.log(
    `  [08] ボディ ${bs.length} 件: utf16=${okUtf16} codepoint=${okCodepoint} utf8=${okUtf8}` +
      ` / UTF-8 説の反例 ${discriminating} 件`,
  );
  for (const c of counterexamples.slice(0, 5)) console.log(`       反例 ${c}`);
});

// =============================================================================
// test 09: batchexecute の f.req 形式
// =============================================================================

t("09 batchexecute の f.req が [[[rpcid, argsJSON, null, slot]]] 形式である", () => {
  const bs = byPath("/_/TrendsUi/data/batchexecute");
  assertGreaterOrEqual(bs.length, 1, "batchexecute のエントリが無い");

  const slots = new Set<string>();
  const rpcids = new Set<string>();
  let calls = 0;

  for (const e of bs) {
    assertEquals(e.method, "POST", `entry ${e.idx}: batchexecute は POST`);

    const raw = e.postBody ?? "";
    // ボディは常に `f.req=<percent-encoded JSON>&` の 1 キーのみ。末尾に裸の & が付く。
    const m = /^f\.req=([^&]*)&?$/.exec(raw);
    assert(m !== null, `entry ${e.idx}: POST ボディが f.req 単独の形式でない`);
    // at (XSRF) トークンは存在しない
    assert(!raw.includes("at="), `entry ${e.idx}: at (XSRF) トークンが混ざっている`);

    let outer: unknown;
    try {
      outer = JSON.parse(decodeURIComponent(m![1]));
    } catch (err) {
      throw new Error(`entry ${e.idx}: f.req が JSON でない: ${String(err)}`);
    }

    // 外側は必ず 2 重配列 [[ call, call, ... ]]
    assert(Array.isArray(outer), `entry ${e.idx}: f.req のトップは配列`);
    assertEquals((outer as unknown[]).length, 1, `entry ${e.idx}: f.req の外側は 1 要素`);
    const callList = (outer as unknown[])[0];
    assert(Array.isArray(callList), `entry ${e.idx}: f.req[0] は配列`);
    assertGreaterOrEqual((callList as unknown[]).length, 1, `entry ${e.idx}: call が空`);

    const ids: string[] = [];
    for (const call of callList as unknown[][]) {
      calls++;
      assert(Array.isArray(call), `entry ${e.idx}: call は配列`);
      assertEquals(call.length, 4, `entry ${e.idx}: call は 4 要素 [rpcid, args, null, slot]`);

      const [rpcid, args, third, slot] = call;
      assertEquals(typeof rpcid, "string", `entry ${e.idx}: call[0] (rpcid) は文字列`);
      assert(/^[A-Za-z0-9]+$/.test(rpcid as string), `entry ${e.idx}: rpcid の形式が想定外`);
      ids.push(rpcid as string);
      rpcids.add(rpcid as string);

      // call[1] は「JSON をさらに JSON 文字列としてエスケープしたもの」または null
      if (args !== null) {
        assertEquals(typeof args, "string", `entry ${e.idx}: call[1] は JSON 文字列か null`);
        let inner: unknown;
        try {
          inner = JSON.parse(args as string);
        } catch (err) {
          throw new Error(`entry ${e.idx}: call[1] が二段 JSON になっていない: ${String(err)}`);
        }
        assert(Array.isArray(inner), `entry ${e.idx}: call[1] の中身は配列`);
      }

      // call[2] は 28/28 全て null
      assertEquals(third, null, `entry ${e.idx}: call[2] は null 固定`);

      // call[3] は slotId。観測値は "1" / "3" / "generic"
      assertEquals(typeof slot, "string", `entry ${e.idx}: call[3] (slot) は文字列`);
      slots.add(slot as string);
    }

    // rpcids クエリと f.req 内の rpcid 並びが一致する (順序込み)
    const q = (qp(e, "rpcids") ?? "").split(",");
    assertEquals(ids, q, `entry ${e.idx}: rpcids クエリと f.req の rpcid が食い違う`);

    // rt=c 固定 (この値のとき「長さ行 + チャンク」形式で返る)
    assertEquals(qp(e, "rt"), "c", `entry ${e.idx}: rt が c でない`);
  }

  console.log(
    `  [09] ${bs.length} リクエスト / ${calls} コール / rpcids=${[...rpcids].sort().join(",")} ` +
      `/ slots=${[...slots].sort().join(",")}`,
  );
});

// =============================================================================
// test 10: 自前パーサで解析し rpcid が一致すること
// =============================================================================

t("10 自前パーサで batchexecute を解析し wrb.fr の rpcid が rpcids クエリと一致する", () => {
  const bs = batchWithBody();
  assertGreaterOrEqual(bs.length, 1, "ボディ付き batchexecute が無い");

  let totalWrb = 0;
  let outOfOrder = 0;

  for (const e of bs) {
    const parsed = parseBatchExecute(e.body!);
    totalWrb += parsed.length;

    const requested = (qp(e, "rpcids") ?? "").split(",");
    const returned = parsed.map((p) => p.rpcid);

    // 集合として一致すること (順序は一致しない場合がある)
    assertEquals(
      [...returned].sort(),
      [...requested].sort(),
      `entry ${e.idx}: 返ってきた rpcid が要求と一致しない`,
    );

    // レスポンス順 != リクエスト順 の実例を数える (entry 418 が該当)
    if (returned.join(",") !== requested.join(",")) outOfOrder++;

    // f.req の slotId が wrb.fr[6] にエコーされること
    const m = /^f\.req=([^&]*)&?$/.exec(e.postBody ?? "");
    if (m) {
      const callList = JSON.parse(decodeURIComponent(m[1]))[0] as unknown[][];
      for (const call of callList) {
        const rpcid = String(call[0]);
        const slot = String(call[3]);
        const hit = parsed.find((p) => p.rpcid === rpcid);
        assert(hit !== undefined, `entry ${e.idx}: ${rpcid} の応答が無い`);
        assertEquals(hit!.slot, slot, `entry ${e.idx}: ${rpcid} の slotId がエコーされていない`);
      }
    }

    // data は二段 JSON を解いた結果。null でないこと (配列 or オブジェクト)
    for (const p of parsed) {
      assert(
        p.data !== undefined,
        `entry ${e.idx}: ${p.rpcid} の payload をデコードできない`,
      );
    }
  }

  // レスポンス順がリクエスト順と食い違う実例が最低 1 件ある
  // (= 順序に依存した実装をしてはいけないことの証拠)
  assertGreaterOrEqual(
    outOfOrder,
    1,
    "レスポンス順 != リクエスト順 の実例が無い (順序依存の危険を検出できていない)",
  );

  console.log(
    `  [10] ${bs.length} ボディ / wrb.fr ${totalWrb} 件 / ` +
      `レスポンス順がリクエスト順と異なる例 ${outOfOrder} 件`,
  );
});

// =============================================================================
// test 11: チャンク内アイテムの種類と e チャンクの k / T
// =============================================================================

t("11 チャンク内アイテムの種類と arity / e チャンクの k と T (単位の混在)", () => {
  const bs = batchWithBody();
  const arity = new Map<string, Set<number>>();
  let multiChunk = 0;
  let tMatches = 0;
  let kMatches = 0;

  for (const e of bs) {
    const body = e.body!;
    const env = tryParseEnvelope(body, "utf16")!;
    assert(env !== null, `entry ${e.idx}: パース失敗`);

    if (env.chunks.length > 1) multiChunk++;

    for (const it of env.items) {
      const kind = String(it[0]);
      if (!arity.has(kind)) arity.set(kind, new Set());
      arity.get(kind)!.add(it.length);
    }

    // 既知の 4 種以外が出てきたら気付けるようにする
    for (const it of env.items) {
      const kind = String(it[0]);
      assert(
        ["wrb.fr", "di", "af.httprm", "e"].includes(kind),
        `entry ${e.idx}: 未知のアイテム種別 "${kind}"`,
      );
    }

    // wrb.fr[3],[4],[5] は全て null
    for (const it of env.items.filter((x) => x[0] === "wrb.fr")) {
      assertEquals(it.length, 7, `entry ${e.idx}: wrb.fr の arity が 7 でない`);
      assertEquals(it[3], null, `entry ${e.idx}: wrb.fr[3] は null`);
      assertEquals(it[4], null, `entry ${e.idx}: wrb.fr[4] は null`);
      assertEquals(it[5], null, `entry ${e.idx}: wrb.fr[5] は null`);
    }

    // 最終アイテムは必ず e チャンク
    const last = env.items[env.items.length - 1];
    assertEquals(last[0], "e", `entry ${e.idx}: 最終アイテムが e チャンクでない`);
    assertEquals(last.length, 5, `entry ${e.idx}: e チャンクの arity が 5 でない`);

    // k = 平坦化後のアイテム総数 (1 始まりの通し番号)
    assertEquals(last[1], env.items.length, `entry ${e.idx}: e チャンクの k が不一致`);
    kMatches++;

    // T = レスポンスボディ全体の **UTF-8 バイト長**
    // ここが長さ行 (UTF-16) と単位が違う。body.length と比べると日本語で必ず外れる。
    const utf8Total = TE.encode(body).length;
    assertEquals(last[4], utf8Total, `entry ${e.idx}: e チャンクの T が UTF-8 バイト長と不一致`);
    tMatches++;
  }

  // 期待する arity
  assertEquals([...(arity.get("wrb.fr") ?? [])], [7], "wrb.fr の arity");
  assertEquals([...(arity.get("di") ?? [])], [2], "di の arity");
  assertEquals([...(arity.get("af.httprm") ?? [])], [4], "af.httprm の arity");
  assertEquals([...(arity.get("e") ?? [])], [5], "e の arity");

  // チャンク境界に意味が無いことの証拠: 複数チャンクに分かれる例が存在する
  assertGreaterOrEqual(multiChunk, 1, "複数チャンクに分割された例が無い");

  console.log(
    `  [11] アイテム種別/arity=${
      [...arity.entries()].map(([k, v]) => `${k}:${[...v].join("|")}`).join(" ")
    } / 複数チャンク ${multiChunk} 件 / k 一致 ${kMatches} / T(UTF-8) 一致 ${tMatches}`,
  );
});

// =============================================================================
// test 12: /trends/api/* のレスポンスボディが HAR に保存されていない事実の記録
// =============================================================================

t("12 /trends/api/* のレスポンスボディが HAR に保存されていない事実を記録する", () => {
  const api = byPrefix("/trends/api/");
  assertGreaterOrEqual(api.length, 1, "/trends/api/* のエントリが無い");

  let emptyBody = 0;
  let nonZeroSize = 0;
  let withAttachment = 0;
  const savedApi: Ent[] = [];

  for (const e of api) {
    // このコーパスでは 71/71 すべてボディ未保存。
    // ただし **ボディ付きで取り直した HAR を与えられても落ちてはならない**。
    // (本ファイル自身が「Explore を開いたまま取り直せばボディも取れる」と書いている以上、
    //  その改善された HAR でテストが赤くなるのは自己矛盾である。)
    if (e.bodyLen > 0) savedApi.push(e);
    else emptyBody++;

    // ただし content.size (非圧縮バイト数) は残っている → ここからスキーマを逆算できる
    if (e.contentSize > 0) nonZeroSize++;

    // 200 応答には必ず content-disposition: attachment が付く
    if (e.status === 200) {
      const cd = e.headers["content-disposition"] ?? "";
      assert(
        cd.startsWith("attachment;"),
        `entry ${e.idx}: 200 なのに content-disposition が attachment でない`,
      );
      withAttachment++;
    }
  }

  // ---- 記録: このコーパスでは全件ボディ未保存 ----
  // ボディ付きの HAR を与えられた場合は「事実が変わった」ことを記録し、
  // 代わりに **保存されていたボディが仕様どおりか** を検証する側に切り替える。
  if (savedApi.length === 0) {
    assertEquals(
      emptyBody,
      api.length,
      "/trends/api/* のボディが一部保存されている (集計が矛盾)",
    );
  } else {
    console.log(
      `  [12] このHARでは /trends/api/* のうち ${savedApi.length} 件にボディが保存されている` +
        " (Explore を表示したまま取り直した HAR と思われる)。",
    );
    for (const e of savedApi) {
      // /trends/api/* の 200 応答は `)]}'\n` プレフィックス付き JSON である。
      // 射影は巨大ボディ本体を捨てているので、先頭 64 文字の控えで検査する。
      if (e.status !== 200) continue;
      assert(
        e.bodyHead.startsWith(")]}'"),
        `entry ${e.idx}: /trends/api/* の 200 応答が )]}' プレフィックスで始まらない`,
      );
      assert(
        e.bodyHead.includes("\n"),
        `entry ${e.idx}: プレフィックスの後に LF が無い`,
      );
    }
  }

  // ---- 「content-disposition が原因」という説の反証 ----
  // batchexecute は content-disposition: attachment なのにボディが保存されている。
  const batch = byPath("/_/TrendsUi/data/batchexecute");
  const batchSaved = batch.filter((e) => e.bodyLen > 0);
  assertGreaterOrEqual(
    batchSaved.length,
    1,
    "batchexecute のボディが 1 件も保存されていない (反証が成立しない)",
  );
  for (const e of batchSaved) {
    const cd = e.headers["content-disposition"] ?? "";
    assert(
      cd.startsWith("attachment;"),
      `entry ${e.idx}: batchexecute に attachment が付いていない`,
    );
  }
  // → content-disposition: attachment でもボディは保存されうる。よって原因は別。

  // ---- 真の原因: DevTools のページ単位ボディ退避 ----
  const perPage = new Map<string, { saved: number; empty: number }>();
  for (const e of trendsEntries()) {
    const s = perPage.get(e.pageref) ?? { saved: 0, empty: 0 };
    if (e.bodyLen > 0) s.saved++;
    else s.empty++;
    perPage.set(e.pageref, s);
  }
  // 保存されているボディが存在するページは 1 つだけ (= エクスポート時に表示中だったページ)。
  // この「退避仮説」の検証は、/trends/api/* が全滅している元のコーパスでのみ意味を持つ。
  // ボディ付きで取り直した HAR では前提が変わるので検証をスキップする。
  const pagesWithSaved = [...perPage.entries()].filter(([, v]) => v.saved > 0);
  if (savedApi.length === 0) {
    assertEquals(
      pagesWithSaved.length,
      1,
      "ボディが保存されているページが 1 つでない (退避仮説と食い違う)",
    );
    // /trends/api/* は全て「保存されていない側」のページに属する
    const savedPage = pagesWithSaved[0][0];
    for (const e of api) {
      assert(
        e.pageref !== savedPage,
        `entry ${e.idx}: /trends/api/* が保存済みページに属しているのに空`,
      );
    }
  }

  // ---- content.size からのスキーマ逆算 (バイト会計) ----
  // プレフィックス ")]}'\n" 5 バイト + JSON + 末尾 LF 1 バイト
  const PFX = 5;
  const LF = 1;
  const EMPTY_MULTILINE = '{"default":{"timelineData":[],"averages":[]}}';
  const EMPTY_REL_ENTITY = '{"default":{"rankedList":[]}}';
  const EMPTY_REL_QUERY =
    '{"default":{"rankedList":[{"rankedKeyword":[]},{"rankedKeyword":[]}]}}';

  assertEquals(PFX + EMPTY_MULTILINE.length + LF, 51, "multiline 空レスポンスのバイト会計");
  assertEquals(PFX + EMPTY_REL_ENTITY.length + LF, 35, "relatedsearches(ENTITY) 空のバイト会計");
  assertEquals(PFX + EMPTY_REL_QUERY.length + LF, 76, "relatedsearches(QUERY) 空のバイト会計");

  // 実際にその size を持つエントリが HAR に存在する
  const sizes = (p: string) => new Set(byPath(p).map((e) => e.contentSize));
  const mlSizes = sizes("/trends/api/widgetdata/multiline");
  const relSizes = sizes("/trends/api/widgetdata/relatedsearches");
  assert(mlSizes.has(51), "multiline の 51 バイト応答 (空) が HAR に無い");
  assert(relSizes.has(35), "relatedsearches の 35 バイト応答 (ENTITY 空) が HAR に無い");
  assert(relSizes.has(76), "relatedsearches の 76 バイト応答 (QUERY 空) が HAR に無い");

  console.log(
    `  [12] /trends/api/* ${api.length} 件中 ボディ未保存 ${emptyBody} 件 / 保存済み ${savedApi.length} 件` +
      ` (size は ${nonZeroSize} 件で有効, 200 のうち ${withAttachment} 件が attachment)`,
  );
  console.log(
    `       pageref 別: ${
      [...perPage.entries()].map(([k, v]) => `${k}=saved:${v.saved}/empty:${v.empty}`).join(" ")
    }`,
  );
  console.log(
    "       → 原因は content-disposition ではなく DevTools のページ単位ボディ退避。" +
      "\n         Explore ページを開いたまま HAR を取り直せば /trends/api/* のボディも取れる。",
  );
});

// =============================================================================
// test 13: エラー応答の形
// =============================================================================

t("13 エラー応答の形 (429 / 302 / 502)", () => {
  const all = trendsEntries();

  // ---- 429: レート制限 ----
  const r429 = all.filter((e) => e.status === 429);
  if (r429.length === 0) {
    console.warn("  [13] この HAR に 429 が無いため 429 の検証をスキップ");
  } else {
    for (const e of r429) {
      // JSON ではなく HTML で返る
      assert(
        (e.headers["content-type"] ?? "").startsWith("text/html"),
        `entry ${e.idx}: 429 の content-type が text/html でない`,
      );
      // Retry-After は付かない
      assertEquals(e.headers["retry-after"], null, `entry ${e.idx}: 429 に Retry-After がある`);
      // content-disposition も x-frame-options も付かない (200 応答には付く)
      assertEquals(
        e.headers["content-disposition"],
        null,
        `entry ${e.idx}: 429 に content-disposition がある`,
      );
      assertEquals(
        e.headers["x-frame-options"],
        null,
        `entry ${e.idx}: 429 に x-frame-options がある`,
      );
      assertGreaterOrEqual(e.contentSize, 1, `entry ${e.idx}: 429 のボディサイズが 0`);
    }

    // 429 はセッション単位のブロックではなくリクエスト単位の確率的スロットリング。
    // 429 と同じ 2 秒窓に 200 が並存することを確認する。
    const t0 = r429[0].startedMs;
    const neighbors = all.filter(
      (e) => Math.abs(e.startedMs - t0) < 2000 && e.status === 200,
    );
    assertGreaterOrEqual(
      neighbors.length,
      1,
      "429 と同時刻帯に 200 が 1 件も無い (確率的スロットリング説と食い違う)",
    );
    console.log(
      `  [13] 429 ${r429.length} 件 / 同時刻帯 (±2s) の 200 が ${neighbors.length} 件` +
        " → リクエスト単位の確率的スロットリング",
    );
  }

  // ---- 302: 旧デイリートレンドの廃止 ----
  const daily = byPath("/trends/trendingsearches/daily");
  if (daily.length > 0) {
    for (const e of daily) {
      assertEquals(e.status, 302, `entry ${e.idx}: daily は 302 のはず`);
      const loc = e.headers["location"] ?? "";
      assert(
        loc.startsWith("https://trends.google.com/trending"),
        `entry ${e.idx}: daily のリダイレクト先が /trending でない: ${loc}`,
      );
    }
    console.log(`  [13] 302 ${daily.length} 件: daily → /trending (旧 UI は廃止)`);
  }

  // ---- 502: テレメトリ系 ----
  const r502 = all.filter((e) => e.status === 502);
  for (const e of r502) {
    assert(
      e.path.startsWith("/_/TrendsUi/"),
      `entry ${e.idx}: 502 がテレメトリ系以外で発生している`,
    );
  }
  if (r502.length > 0) {
    console.log(
      `  [13] 502 ${r502.length} 件: ${
        [...new Set(r502.map((e) => e.path))].join(",")
      } (テレメトリ系なので無視してよい)`,
    );
  }

  // ---- ステータスの全体像 ----
  const st = new Map<number, number>();
  for (const e of all) st.set(e.status, (st.get(e.status) ?? 0) + 1);
  console.log(
    `  [13] status 分布: ${
      [...st.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" ")
    }`,
  );
});

// =============================================================================
// test 14: 秘密情報がこのファイルに埋め込まれていないことの自己検査
// =============================================================================

t("14 Cookie 値・reCAPTCHA トークン等の秘密情報を埋め込んでいない", () => {
  // ---- 射影が Cookie の値を保持していないこと ----
  const withCookies = trendsEntries().filter((e) => e.cookieNames.length > 0);
  assertGreaterOrEqual(withCookies.length, 1, "Cookie 付きリクエストが無い");

  const names = new Set<string>();
  for (const e of withCookies) {
    for (const n of e.cookieNames) {
      names.add(n);
      // 名前だけを保持しているので、値らしき長い文字列が混ざっていないこと
      assert(n.length < 40, `Cookie 名が長すぎる (値が混入している疑い): ${n.length} 文字`);
    }
  }
  // Ent 型に cookie の値を持つフィールドが存在しないことの実質的な確認
  const sample = withCookies[0] as unknown as Record<string, unknown>;
  assert(!("cookieValues" in sample), "射影に Cookie の値が含まれている");
  assert(!("cookies" in sample), "射影に生 Cookie が含まれている");

  // NID は Trends API の実質的な認証キー。名前が観測できていることだけ確認する。
  assert(names.has("NID"), "Cookie 名に NID が無い");
  console.log(`  [14] Cookie 名 (値は保持しない): ${[...names].sort().join(", ")}`);

  // ---- このファイル自身のソースを読み直して秘密情報の混入を検査 ----
  // 将来コピペ事故でトークンや Cookie 値を埋め込んでしまうのを防ぐガード。
  let self: string;
  try {
    self = Deno.readTextFileSync(new URL(import.meta.url));
  } catch (err) {
    console.warn(`  [14] 自己ソースを読めないため自己検査をスキップ: ${String(err)}`);
    return;
  }

  // 40 文字以上連続する base64url 風のリテラルを探す。
  // reCAPTCHA トークン (1764 文字 / 13KB 超)、widget token (44 文字)、
  // NID の値 (200 文字前後) はいずれもこれに引っかかる。
  //
  // ただし罫線 ("-----" や "=====") も base64url の文字集合に入ってしまうので、
  // 「エントロピーが高いもの」だけを秘密情報候補として残す:
  //   - 英字と数字の両方を含む
  //   - 相異なる文字が 8 種類以上
  // 実トークンは必ずこれを満たし、罫線や識別子は満たさない。
  const suspicious = (self.match(/[A-Za-z0-9_-]{40,}/g) ?? []).filter(
    (s) => /[A-Za-z]/.test(s) && /\d/.test(s) && new Set(s).size >= 8,
  );
  assertEquals(
    suspicious.map((s) => `${s.slice(0, 8)}...(${s.length}文字)`),
    [],
    "40 文字以上の base64url 風リテラルが混入している (秘密情報の可能性)",
  );

  // reCAPTCHA トークンの既知プレフィックスが実値付きで書かれていないこと
  for (const pfx of ["03AFcWeA", "0cAFcWeA"]) {
    const hits = self.match(new RegExp(pfx + "[A-Za-z0-9_-]{8,}", "g")) ?? [];
    assertEquals(hits.length, 0, `reCAPTCHA トークンらしき実値が埋め込まれている (${pfx})`);
  }

  console.log(
    `  [14] 自己ソース ${self.length} 文字を検査: 秘密情報らしきリテラルは検出されず`,
  );
});
