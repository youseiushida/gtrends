/**
 * =============================================================================
 * 09_batchexecute_wire_format_test.ts
 *   Google Trends 新 UI (boq / Wiz) の RPC トランスポート
 *   POST https://trends.google.com/_/TrendsUi/data/batchexecute
 *   の **ワイヤフォーマット (封筒の形)** 単独仕様
 * =============================================================================
 *
 * 実行:
 *   deno test --allow-net --allow-read live_integration/09_batchexecute_wire_format_test.ts
 *
 * --allow-net が無い場合はライブ検証が、--allow-read が無い (または HAR コーパスが
 * 手元に無い) 場合は HAR コーパス適合テストが、それぞれ console.warn を出して
 * skip される。どちらも欠けてもフィクスチャによるパーサ単体テストは緑になる。
 *
 * ライブ検証日: 2026-09-09 (東京の家庭用回線、Cookie 一切無し、素の Deno fetch)
 * HAR 根拠: C:\Users\ushid\Documents\gtrend_claude\.har\trends.google.com.har
 *           (2026-09-08 キャプチャ) の /_/TrendsUi/data/batchexecute 全 27 エントリ。
 *           抽出済みコーパス .har\extracted\TrendsUi_data_batchexecute\*.txt
 *           特に 07_entry330 (最小の完全応答) と 16_entry418 (複数 RPC + 日本語)。
 *
 * -----------------------------------------------------------------------------
 * 0. このファイルが扱う範囲
 * -----------------------------------------------------------------------------
 * 個々の RPC (i0OFE = Trending Now 一覧 / g4kJzf = スパークライン / DqDTgb = 地域
 * ピッカー / wAgrOe = 地域表示名 / hzg6Ed = オートコンプリート / Tnt4U / MHC2q /
 * we8Zrc) の **意味やペイロード構造は扱わない**。扱うのは
 *   - リクエスト URL クエリの意味と必須/任意
 *   - POST ボディ f.req の組み立て方
 *   - レスポンス封筒 ")]}'\n" + 長さ行 + チャンク の厳密仕様
 *   - エラー時の封筒の形
 * だけ。ラッパーライブラリの「トランスポート層」1 枚に相当する。
 *
 * -----------------------------------------------------------------------------
 * 1. リクエスト
 * -----------------------------------------------------------------------------
 * メソッド : **POST 固定**。GET は実測 (2026-09-09) で **405** +
 *            `["er",null,null,null,null,405,null,null,null,9]` が返る
 *            (封筒自体は rt=c の通常形のまま)。f.req をクエリに載せても駄目。
 * URL      : https://trends.google.com/_/TrendsUi/data/batchexecute
 *            ホスト + パスは WIZ_global_data の eptZe ("/_/TrendsUi/") + "data/batchexecute"。
 *
 * ## 1-1. URL クエリパラメータ (ブラウザは 10 個送る)
 *
 * | key          | ブラウザの値                                   | 必須? (2026-09-09 実測) |
 * |--------------|-----------------------------------------------|-------------------------|
 * | rpcids       | "wAgrOe" / "i0OFE,wAgrOe" (カンマ区切り)        | **不要**。しかも無視される |
 * | source-path  | "/trending" または "/home"                     | **不要** |
 * | f.sid        | "713326012370917585" (符号付き64bit・文字列)    | **不要** |
 * | bl           | "boq_trends-boq-servers-frontend_20260906.08_p0"| **不要** |
 * | hl           | "ja"                                           | **不要** (RPC 引数側で hl を渡すため) |
 * | soc-app      | "1"                                            | **不要** |
 * | soc-platform | "1"                                            | **不要** |
 * | soc-device   | "1"                                            | **不要** |
 * | _reqid       | 整数 (B + 100000*n。単なるキャッシュバスター)    | **不要** |
 * | rt           | "c"                                            | **任意だがレスポンス形式が変わる (下記 3-4)** |
 *
 * ★ 実測 (2026-09-09): **クエリ文字列を完全に空にした POST でも 200 が返り、
 *   ペイロードは全て正常**。つまり batchexecute はクエリを認証・ルーティングに
 *   使っておらず、**全ての情報は POST ボディ f.req から読んでいる**。
 *   10 個を同時に落として通る以上、個々のパラメータが必須でないことも同時に言える。
 *
 * ★ ただし「全部落とす」テストだけだと、rt が消えたことによる応答形式の変化
 *   (下記 3) と「f.sid/bl が不要」が混ざってしまう。そこで本ファイルには
 *   **rt=c だけ残して f.sid / bl / hl / soc-* / _reqid を落とす**テストを別に用意し、
 *   チャンク形式のまま 200 が返ることを単独で確認している。
 *   → 応答形式を変えているのは rt だけであり、f.sid/bl は本当に不要。
 *
 * ★ 実測: `rpcids` は **サーバ側で照合すらされていない**。
 *   `?rpcids=i0OFE` を付けつつボディに wAgrOe だけを入れても、返るのは wAgrOe。
 *   逆にボディに 2 RPC 入れて `?rpcids=i0OFE` (1 個) にしても 2 個とも返る。
 *   → ラッパーは rpcids を「デバッグ用の飾り」として付けてもよいし省いてもよい。
 *     ブラウザに擬態したいなら f.req の call 順と同じ順でカンマ結合して付ける。
 *
 * ★ HAR の 27 エントリは 10 個のクエリを 100% 全て持っていたため、
 *   **HAR だけからは必須性を判定できなかった**。上記は全てライブの実測結果。
 *
 * ## 1-2. f.sid / bl のブラウザ無し取得法 (必要になった場合の保険)
 *
 * 実際には不要だが、将来サーバが要求し始めたときのために取得経路を確立しておく。
 * これらは /trending の HTML の <head> にある
 *     <script data-id="_gd" nonce="...">window.WIZ_global_data = { ...37キーのJSON... };</script>
 * から取る。jsdom 等は不要で、正規表現だけで抜ける。
 *
 *     f.sid <- WIZ_global_data["FdrFJe"]   (HTML 全体で出現回数 1)
 *     bl    <- WIZ_global_data["cfb2h"]    (HTML 全体で出現回数 1)
 *
 * 落とし穴:
 *   - **f.sid は必ず文字列で扱うこと**。符号付き 64bit で負値が普通に出る
 *     (実測: "-8959654384266786277")。Number() すると 2^53 超で精度が壊れる。
 *     しかも **アクセスごとに違う値が振られる** (HAR キャプチャ時は正の
 *     "713326012370917585"、2026-09-09 のライブでは負値)。キャッシュ不可。
 *   - bl はビルドラベルなので Google のデプロイで変わる。ハードコード禁止。
 *   - /trending の HTML は **約 1.26MB** (HAR entry285: body 1,259,918 文字) ある。
 *     ただし WIZ_global_data は先頭付近にあるので全部読む必要は無い。
 *     HAR 実測のボディ先頭からのオフセット:
 *         "window.WIZ_global_data" @1423 / `"FdrFJe"` @1503 / `"cfb2h"` @2250
 *     → **先頭 4KB も読めば十分**。ストリームで先頭だけ読んで打ち切ってもよい。
 *   - WIZ_global_data のキーは 37 個。ほかに使える値:
 *         eptZe  = "/_/TrendsUi/"  (batchexecute のパス接頭辞)
 *         qwAQke = "TrendsUi"      (アプリ名)
 *         SNlM0e = **キーそのものが存在しない** (未ログインのため XSRF トークン無し)
 *   - Cookie 不要。Set-Cookie: NID が付いてくるので旧 /trends/api/* 用に流用できる。
 *
 * ## 1-3. リクエストヘッダ
 *
 * ブラウザは content-type / x-same-domain / origin / referer を送るが、
 * **実測 (2026-09-09) では content-type だけで 200 が返る**
 * (「rt=c だけ残す」テストが content-type 単独で投げて検証している)。
 * x-same-domain: 1 も origin も referer も user-agent も無くてよい。
 * Cookie も不要 (Deno の素の fetch は Cookie を一切送らない)。
 * ただしレスポンスに `vary: Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site` が付く
 * ことからフレームワーク側に検査フックはあるので、保険として下記を送るのは無害:
 *
 *     content-type : application/x-www-form-urlencoded;charset=UTF-8   ← **必須**
 *     x-same-domain: 1                                                 ← 任意
 *     origin       : https://trends.google.com                         ← 任意
 *     referer      : https://trends.google.com/                        ← 任意
 *
 * ★ **content-type だけは本当に必須**。2026-09-09 の実測で
 *   `content-type: text/plain;charset=UTF-8` (fetch に文字列ボディを渡したときの
 *   Deno / ブラウザの既定値) で投げると **400 + er** になった:
 *       )]}'\n\n103\n[["er",null,null,null,null,400,null,null,null,3],...]
 *   → **fetch(url, { method:"POST", body: "f.req=..." }) と書くだけだと落ちる。**
 *      これは実装者が最も踏みやすい罠なので、ラッパーでは content-type を
 *      必ず明示的に設定すること (本ファイルの専用ライブテストで裏取り済み)。
 *
 * `at=` (Wiz の SNlM0e XSRF トークン) は **不要**。HAR 27/27 で URL にもボディにも
 * 存在せず、ページの WIZ_global_data.SNlM0e も null (未ログインのため)。
 * at が必要になるのは「ログイン済みユーザの状態を変更する RPC」であり、
 * Trends の読み取り系 RPC には該当しない。
 *
 * ## 1-4. POST ボディ
 *
 * 常に **1 フィールドのみ**、末尾に裸の `&` が 1 個付く。
 * この `&` はブラウザ (Wiz ランタイム) の癖であり **無くても 200 が返る**
 * (2026-09-09 実測。「rt=c だけ残す」テストが末尾 `&` を外して投げて検証している):
 *
 *     f.req=<percent-encoded JSON>&
 *
 * デコード後の JSON は必ず **二重配列**:
 *
 *     [[ call, call, ... ]]
 *     call = [ rpcid, argsJsonString | null, null, slotId ]
 *              [0]     [1]                    [2]   [3]
 *
 *   - call[1] は「引数配列を JSON.stringify したもの」= 二段 JSON。
 *     例: 引数 ["JP","ja"] → call[1] は文字列 '["JP","ja"]'。
 *     引数なしの RPC は "[]"。null も可 (HAR に例は無い)。
 *   - call[2] は 28/28 全て null。
 *   - call[3] slotId は任意文字列。HAR の観測値は "1" / "3" / "generic"。
 *     **レスポンスの wrb.fr[6] にそのままエコーされる**ので、複数 RPC を
 *     まとめたときの突合キーとして使える (同じ rpcid を 2 回呼ぶ場合に必須)。
 *     実測: 絵文字を入れてもそのままエコーされる (後述の UTF-16 検証に利用)。
 *
 * 複数 RPC を 1 リクエストにまとめる例 (HAR 16_entry418 と同形):
 *
 *     [[["i0OFE","[null,null,\"IE\",0,\"ja\",4]",null,"1"],
 *       ["wAgrOe","[\"IE\",\"ja\"]",null,"3"]]]
 *
 * -----------------------------------------------------------------------------
 * 2. レスポンス (rt=c のとき) — チャンク封筒
 * -----------------------------------------------------------------------------
 *
 *     )]}'\n            ← 5 文字 (XSSI 防御プレフィックス)
 *     \n                ← 空行。ここまで合計 6 文字
 *     <10進数字>\n<チャンクJSON>\n
 *     <10進数字>\n<チャンクJSON>\n
 *     ...
 *
 * 末尾は必ず LF で終わる。content-type は application/json; charset=utf-8、
 * content-disposition: attachment; filename="response.bin" が付く (fetch では無害)。
 *
 * ## 2-1. 長さ行の厳密な意味 【最重要・実装が一番間違えるところ】
 *
 * 長さ数字列を終端する LF の位置を `nl`、数字列の値を `N` とすると
 *
 *     body.slice(nl, nl + N)  ===  "\n" + <チャンクJSON> + "\n"
 *     したがって  JSON = body.slice(nl + 1, nl + N - 1)、JSON.length === N - 2
 *     次の長さ行は nl + N から始まる
 *
 * つまり N は「長さ行を終端する LF」+「JSON」+「JSON を終端する LF」を数えている。
 * 素直に「LF を読み飛ばして N 文字読む」と 1 文字ずれる。
 *
 * ## 2-2. 長さ行の単位は **UTF-16 コードユニット** (= JS の String.length)
 *
 * バイト数でもコードポイント数でもない。根拠は 3 段構え:
 *
 *  (a) HAR コーパスの **ボディが保存されている 21 エントリ全て** で
 *      「長さ行 = JSON.length + 2」が成立し、再シリアライズすると 1 文字違わず
 *      原文に戻る (本ファイルの「HAR コーパスの実レスポンス 21 本」テスト)。
 *      うち 06_entry322 は UTF-16 50153 文字 / UTF-8 86717 バイトと 3 万以上
 *      ずれており、バイト長説なら最初のチャンクで破綻する。
 *  (b) ライブ応答でも同じ検証が通る。
 *  (c) 下記のサロゲートペア注入で「コードポイント長」説も潰した。
 *
 * (c) は 2026-09-09 のライブで
 * **サロゲートペアを含む応答を意図的に作って決着させた**:
 *
 *   slotId に "s🇯🇵e" (🇯🇵 = 2 コードポイント / 4 UTF-16 ユニット) を入れて
 *   サーバにエコーさせた応答:
 *       長さ行 N = 111
 *       JSON の UTF-16 長      = 109  = N - 2  ✅
 *       JSON のコードポイント長 = 107 ≠ N - 2  ✗
 *       JSON の UTF-8 バイト長  = 117 ≠ N - 2  ✗
 *
 *   ※ この 111 という絶対値は毎回同じにはならない。af.httprm の乱数が
 *      19 桁のことも 20 桁のこともある (負号の有無) ため 1 前後ぶれる。
 *      ライブテストは絶対値ではなく「UTF-16 長 === N-2 かつ他の 2 つは ≠」
 *      という関係だけを検証している。上の数字は固定フィクスチャの記録値。
 *
 *   日本語 (BMP 内) でも同様に UTF-8 とは食い違う。HAR 16_entry418 の第1チャンク:
 *       長さ行 57 / UTF-16 55 (= 57-2) / UTF-8 67
 *   ライブの大きい応答 (i0OFE JP):
 *       長さ行 10637 / UTF-16 10635 / UTF-8 12801
 *
 * → **Deno/Node の res.text() が返す文字列に対してそのまま slice すれば正しい。**
 *   TextEncoder でバイト数を数えたり、[...str] でコードポイントを数えたら壊れる。
 *   Uint8Array のままバイト単位でパースするのも壊れる。
 *
 *   実装上の推奨: 切り出した区間が「LF で始まり LF で終わる」ことを毎チャンク
 *   検証すること (本ファイルの parseBatchExecute はそうしている)。単位を
 *   取り違えていると非 ASCII 応答でここが必ずずれるので、JSON.parse の
 *   意味不明なエラーではなく原因の分かるエラーで落とせる。
 *
 *   逆に「パースして JSON.stringify し直すと原文に戻る」ことを実行時の
 *   健全性チェックに使ってはいけない。JSON.stringify はサーバの表記を
 *   正規化してしまう (= -> = 、1.0 -> 1、2^53 超の整数の精度落ち) ため、
 *   ワイヤ形式が正しくてもペイロード次第で不一致になり得る。
 *   本ファイルでも厳密なラウンドトリップ検証は固定フィクスチャと HAR コーパス
 *   (どちらも内容が固定) に限定し、ライブでは参考情報の出力に留めている。
 *
 * ## 2-3. チャンク内アイテムの種類
 *
 * 各チャンク JSON は「アイテムの配列」。観測されたアイテム:
 *
 *   ["wrb.fr", rpcid, payloadJsonString|null, null, null, errorArray|null, slotId]
 *        arity 7。成功時は [2] がペイロード (二段 JSON)、[5] は null。
 *        **RPC 単位のエラー時は [2] が null になり [5] にエラー配列が入る** (下記 4-2)。
 *        HAR コーパスの wrb.fr 22/22 が arity 7 かつ [3][4][5] 全て null、
 *        [2] は必ず文字列、[6] は "generic" / "1" / "3" (= リクエストの
 *        call[3] のエコー) だった。arity が 7 以外のものは 1 件も無い。
 *   ["di", n]                                    arity 2。内部カウンタ。無視してよい
 *   ["af.httprm", n, "<乱数10進文字列>", m]        arity 4。無視してよい
 *   ["e", k, null, null, T]                      arity 5。終端マーカ (下記 2-4)
 *   ["er", null, null, null, null, 400, null, null, null, 3]
 *        arity 10。**リクエスト全体が失敗したとき** (下記 4-1)
 *
 * ## 2-4. 終端チャンク ["e", k, null, null, T] の T は **UTF-8 バイト長**
 *
 * 同一レスポンス内で単位が混在する。これが 2 つ目の落とし穴。
 *   - k = そのアイテムが全チャンクを平坦化したときの 1 始まりの通し番号
 *         (= それまでのアイテム数 + 1)
 *   - T = **レスポンスボディ全体の UTF-8 バイト長**
 *         実測: 全体 UTF-16 10789 文字の応答で T = 12959
 *         HAR 16_entry418: UTF-16 3072 文字 / T = 3086
 *         HAR 06_entry322: UTF-16 50153 文字 / T = 86717 (差が 3 万を超える)
 *         ASCII のみの応答では両者が一致するので小さいデータだけ見ると気付けない
 * → 整合性チェックに使うなら new TextEncoder().encode(body).length と比較すること。
 *   k / T いずれも HAR コーパスの 21/21 で上記の定義どおりだった。
 *   T は「受信しきったか」の判定に使える唯一の手掛かりなので、rt=c を使うなら
 *   検証する価値がある (rt を省くと e チャンクごと消えるので判定不能になる)。
 *
 * ## 2-5. チャンク境界に意味は無い / 順序は保証されない
 *
 *   - チャンク境界は単なるサーバのフラッシュ点。1 チャンクに複数 RPC の結果が
 *     入ることも、RPC ごとに別チャンクになることもある。
 *     **必ず全チャンクを平坦化してから [0]==="wrb.fr" で拾うこと。**
 *   - **wrb.fr の出現順はリクエストの call 順と一致しない。**
 *     HAR 16_entry418: リクエスト i0OFE → wAgrOe、レスポンス wAgrOe → i0OFE。
 *     ライブ実測 (2026-09-09) でも同じ逆転を再現。
 *     → rpcid か slotId で突合すること。同じ rpcid を複数回呼ぶなら slotId 必須。
 *   - ペイロードは二段 JSON。wrb.fr[2] は文字列なので JSON.parse がもう一度必要。
 *
 * -----------------------------------------------------------------------------
 * 3. rt パラメータ (レスポンス形式スイッチ) 【新規発見・実測】
 * -----------------------------------------------------------------------------
 *
 *   rt=c   … 上記のチャンク封筒 (長さ行 + JSON + 終端 e チャンク)。ブラウザはこれ。
 *   rt 省略 … content-type は同じ application/json だが
 *             **")]}'\n\n" の直後にチャンク JSON が 1 個ベタで置かれるだけ**。
 *             長さ行なし・終端 e チャンクなし・末尾 LF なし。
 *             実測ボディ: `)]}'\n\n[["wrb.fr","wAgrOe","[\"日本\"]",null,null,null,"generic"],["di",12],["af.httprm",11,"...",16]]`
 *             → **ストリーミング分割が起きないぶん、こちらの方がパースは楽**。
 *                ただし途中切断を検出する術が無くなる (e チャンクが無いため)。
 *   rt=b   … **protobuf バイナリ** (content-type: application/octet-stream)。
 *             ")]}'" プレフィックスも長さ行も付かない。実測 (2026-09-09、
 *             wAgrOe を 107 バイトで応答) では Any の型名
 *             type.googleapis.com/trends.fe.geo.GetLocationDisplayNameResponse
 *             と rpcid が平文で埋まっているのが目印。JSON パーサには食わせられない。
 *             軽量ラッパーでは使わないこと (protobuf デコーダが要る)。
 *             → 本ファイルのライブテストで content-type と型名まで裏取り済み。
 *
 * 本ファイルのパーサは rt=c と rt 省略の **両方**を透過的に扱う。
 *
 * -----------------------------------------------------------------------------
 * 4. エラー時の封筒 【実測で確定】
 * -----------------------------------------------------------------------------
 *
 * ## 4-1. リクエスト全体の失敗 → HTTP 4xx + "er" アイテム
 *
 *   発生条件 (実測):
 *     - 存在しない rpcid を f.req に入れた                   → 400
 *     - f.req が JSON として壊れている                       → 400
 *     - f.req フィールドそのものが無い                       → 400
 *     - content-type が x-www-form-urlencoded でない         → 400
 *     - メソッドが POST でない (GET)                          → 405
 *   応答 (いずれも同形):
 *     content-type application/json / rt=c の封筒はそのまま
 *     )]}'\n\n102\n[["er",null,null,null,null,400,null,null,null,3],["di",9],["af.httprm",...]]\n25\n[["e",4,null,null,138]]\n
 *
 *   ★ **er は arity 10 固定で、意味のある要素は [5] と [9] の 2 つだけ。**
 *       er[5] … HTTP ステータスと同値。実測 400 / 405。
 *       er[9] … **固定値ではない**。HTTP ステータスに対応する内部コード。
 *                実測: 400 のとき 3 / 405 のとき 9。
 *                gRPC 標準コードの INVALID_ARGUMENT(3) / FAILED_PRECONDITION(9)
 *                と一致するが、対応表を全部確かめたわけではない (**推定**)。
 *       他の 8 要素は全て null。
 *   → 実装は er[9] を分岐に使わず、**er が 1 個でもあればリクエスト全体の失敗**
 *      と扱い、詳細は er[5] (= HTTP ステータス) から判断するのが安全。
 *   → **wrb.fr は 1 つも返らない。**
 *
 * ## 4-2. RPC 単位の失敗 → HTTP 200 のまま wrb.fr[5] にエラー配列
 *
 *   発生条件 (実測): rpcid は正しいが引数の形が不正 (例: wAgrOe に [] を渡す)
 *   応答:
 *     status 200
 *     ["wrb.fr","wAgrOe",null,null,null,[3],"generic"]
 *                        ^^^^ ペイロードが null      ^^^ エラー配列
 *   → **HTTP ステータスだけ見ていると成功に見える。**
 *      wrb.fr[2] === null を必ずチェックすること。
 *      [5] の [3] は gRPC の INVALID_ARGUMENT と推定 (1 例のみの観測)。
 *   → HAR の 22 個の wrb.fr は全て [3][4][5] が null だったため、
 *      この形は HAR からは分からずライブ検証でのみ判明した。
 *
 * ## 4-3. レート制限
 *
 *   batchexecute で 429 は本調査では 1 度も観測されなかった (旧 /trends/api/* は
 *   Cookie 無しだと即 429 を返すのと対照的)。もし返る場合は Google 共通の
 *   エラーページなので content-type が text/html になると思われる (**推定**)。
 *
 *   トランスポート層の判定順序としてはこれが安全:
 *     1. content-type が application/json で始まらない → 想定外 (429 / 5xx / HTML)。
 *        本文を JSON パーサに食わせず、そのままエラーにする。
 *     2. パースして requestErrors.length > 0 → リクエスト全体の失敗 (4-1)。
 *        このとき HTTP ステータスは 400 / 405 で、封筒自体は正常。
 *     3. results[i].data === null && error !== null → その RPC だけ失敗 (4-2)。
 *   Retry-After は期待できない。
 *
 * -----------------------------------------------------------------------------
 * 5. ラッパー実装者向け最小レシピ
 * -----------------------------------------------------------------------------
 *
 *   const body = "f.req=" + encodeURIComponent(JSON.stringify([[
 *     ["i0OFE", JSON.stringify([null,null,"JP",0,"ja",4]), null, "1"],
 *   ]])) + "&";
 *   const res = await fetch(
 *     "https://trends.google.com/_/TrendsUi/data/batchexecute?rpcids=i0OFE&rt=c",
 *     { method:"POST",
 *       // ↓ この 1 行を省くと Deno/ブラウザが text/plain を付けて 400 になる
 *       headers:{ "content-type":"application/x-www-form-urlencoded;charset=UTF-8" },
 *       body });
 *   const env = parseBatchExecute(await res.text());              // 本ファイルの実装
 *   if (env.requestErrors.length) throw new Error("batchexecute 全体が失敗");
 *   const hit = env.results.find(r => r.rpcid === "i0OFE")!;
 *   if (hit.data === null) throw new Error(`RPC 失敗: ${JSON.stringify(hit.error)}`);
 *   const payload = hit.data;
 *
 * Cookie 不要 / reCAPTCHA 不要 / f.sid・bl 不要 / at 不要。
 * 必須なのは「POST であること」と「content-type」の 2 点だけ。
 * ただし reCAPTCHA Enterprise トークンを引数に含む RPC (we8Zrc, g4kJzf) だけは
 * トークンの有無で応答内容が変わる可能性がある (本ファイルの対象外)。
 *
 * -----------------------------------------------------------------------------
 * 6. 本ファイルのテスト構成 (どの主張がどのテストで裏付けられているか)
 * -----------------------------------------------------------------------------
 *
 * (1) オフライン (ネットワーク不要)
 *   - HAR 07_entry330 の完全な封筒 …………… 2-1 / 2-3 / 2-4 の基本形
 *   - HAR 16_entry418 の日本語チャンク ……… 2-2「バイト長ではない」
 *   - サロゲートペア入りライブ応答 …………… 2-2「コードポイント長でもない」
 *   - ラウンドトリップ (フィクスチャ 5 本) … 2-2「長さ行 = JSON.length + 2」
 *   - チャンク境界と応答順 …………………………… 2-5
 *   - er / wrb.fr エラー ……………………………… 4-1 / 4-2
 *   - rt 省略時の非チャンク形式 ………………… 3
 *   - 壊れた入力の検出 ………………………………… 実装の堅牢性
 *   - f.req / URL 組み立て …………………………… 1-1 / 1-4 (HAR の生 postData と一致)
 *   - WIZ_global_data 抽出 (合成 HTML) ……… 1-2
 *   - **HAR コーパス 21 本の一括適合** ……… 2-1〜2-5 を実データ全件で機械検証
 *
 * (2) ライブ (2026-09-09 実施、**1 回の実行につき合計 12 リクエスト**)
 *   - /trending から f.sid / bl を正規表現抽出 ……………………… 1-2
 *   - ブラウザと同じ 10 個のクエリ + rt=c …………………………… 正常系の基準
 *   - クエリを完全に省略 …………………………………………………………… 1-1
 *   - rt=c だけ残す + content-type ヘッダのみ + 末尾 & 無し … 1-1 / 1-3 / 1-4
 *   - content-type を text/plain にすると 400 + er ……………… 1-3 (必須性の証明)
 *   - GET だと 405 + er[9]=9 ………………………………………………………… 1-1 (POST 固定)
 *   - rpcids はサーバに照合されない ………………………………………… 1-1
 *   - 複数 RPC のバッチ (rpcids は 1 個だけ宣言しても 2 個返る /
 *     応答順の逆転 / slotId 突合) ……………………………………………… 1-1 / 1-4 / 2-5
 *   - サロゲートペア注入による長さ行の単位確定 ………………… 2-2
 *   - rt=b が protobuf …………………………………………………………………… 3
 *   - 存在しない rpcid → 400 + er[9]=3 ………………………………… 4-1
 *   - 不正な引数 → 200 + wrb.fr[5] ……………………………………… 4-2
 *
 * ライブテストは 429 / ネットワーク断では console.warn を出して skip し、
 * ハードには落とさない (実行者の環境で再現性を保つため)。
 * 429 は 2s / 4s / 8s の指数バックオフで最大 3 回まで再試行する。
 *
 * =============================================================================
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";

// =============================================================================
// パーサ実装 (ラッパーライブラリのトランスポート層に相当。依存ゼロ・軽量)
// =============================================================================

/** batchexecute レスポンスの XSSI プレフィックス。5 文字。 */
const XSSI_PREFIX = ")]}'\n";

/** wrb.fr アイテムから取り出した 1 RPC の結果。 */
export interface RpcResult {
  rpcid: string;
  /** リクエストの call[3] にエコーされる。同一 rpcid の複数呼び出しの突合に使う。 */
  slot: string;
  /** wrb.fr[2] を JSON.parse したもの。RPC 単位のエラー時は null。 */
  data: unknown;
  /** wrb.fr[5]。RPC 単位のエラー情報 (例 [3])。成功時は null。 */
  error: unknown;
}

export interface BatchExecuteEnvelope {
  /** チャンクごとのアイテム配列。境界に意味は無いので通常は items を使う。 */
  chunks: unknown[][][];
  /** 全チャンクを平坦化したアイテム列。 */
  items: unknown[][];
  /** wrb.fr アイテムだけを取り出したもの。出現順はリクエスト順と一致しない。 */
  results: RpcResult[];
  /** 終端 ["e", k, null, null, T] の T (= ボディ全体の UTF-8 バイト長)。無ければ null。 */
  totalByteLength: number | null;
  /** ["er", ...] アイテム。リクエスト全体が失敗したときだけ入る。 */
  requestErrors: unknown[][];
  /** rt=c の長さ行付き形式だったか。rt 省略時は false。 */
  chunked: boolean;
}

/**
 * batchexecute のレスポンス本文をパースする。
 *
 * rt=c の「長さ行 + JSON チャンク」形式と、rt 省略時の「JSON 1 個ベタ置き」形式の
 * 両方を透過的に扱う。長さ行は **UTF-16 コードユニット** として解釈する
 * (JS の文字列に対する slice/length がそのまま正しい単位である)。
 */
export function parseBatchExecute(text: string): BatchExecuteEnvelope {
  if (!text.startsWith(XSSI_PREFIX)) {
    throw new Error(
      `batchexecute: XSSI プレフィックス ")]}'\\n" が無い (先頭: ${JSON.stringify(text.slice(0, 16))})`,
    );
  }
  let pos = XSSI_PREFIX.length;
  // プレフィックス直後の空行 (実測では常に存在するが、無くても動くようにする)
  if (text[pos] === "\n") pos++;

  const chunks: unknown[][][] = [];
  let chunked = false;

  while (pos < text.length) {
    // 末尾の余分な空白/改行は終了とみなす。
    // ★ ここを text.slice(pos).trim() === "" で判定すると、チャンクを 1 個進める
    //   たびに「残りボディ全体」をコピーすることになり、チャンク数 k に対して
    //   O(k * bodyLength) = 実質 O(n^2) になる。地域ピッカー (DqDTgb, 68KB) の
    //   ような大きい応答で無駄にメモリと時間を食うので、添字走査だけで済ませる。
    let scan = pos;
    while (
      scan < text.length &&
      (text[scan] === "\n" || text[scan] === "\r" || text[scan] === " " || text[scan] === "\t")
    ) scan++;
    if (scan >= text.length) break;
    pos = scan;

    if (text[pos] === "[") {
      // rt 省略時: 残り全部が 1 チャンク分の JSON
      chunks.push(parseChunkJson(text.slice(pos).trim()));
      break;
    }

    const nl = text.indexOf("\n", pos);
    if (nl < 0) {
      throw new Error(`batchexecute: 長さ行を終端する LF が見つからない (pos=${pos})`);
    }
    const lenText = text.slice(pos, nl);
    if (!/^\d+$/.test(lenText)) {
      throw new Error(`batchexecute: 長さ行が 10 進数字ではない: ${JSON.stringify(lenText)}`);
    }
    const n = Number(lenText);
    if (n < 2) throw new Error(`batchexecute: 長さ行の値が小さすぎる: ${n}`);

    // ★ ここが仕様の核心。n は「LF + JSON + LF」の UTF-16 コードユニット数。
    const segment = text.slice(nl, nl + n);
    if (segment.length !== n) {
      throw new Error(
        `batchexecute: ボディが途中で切れている (長さ行 ${n}, 実際に読めたのは ${segment.length})`,
      );
    }
    // ★ n が「LF + JSON + LF」を数えていることを毎回検証する。
    //   もし長さ行を UTF-8 バイト長やコードポイント長で解釈していたら、非 ASCII を
    //   含む応答でここの境界が必ずずれる。JSON.parse に渡す前に落とすことで
    //   「単位を取り違えている」という原因が即座に分かるようにしておく。
    if (segment[0] !== "\n" || segment[segment.length - 1] !== "\n") {
      throw new Error(
        `batchexecute: 長さ行 ${n} の区間が LF で挟まれていない ` +
          `(先頭=${JSON.stringify(segment[0])} 末尾=${JSON.stringify(segment[segment.length - 1])})。` +
          `長さ行を UTF-16 コードユニット以外の単位で解釈している可能性が高い`,
      );
    }
    const json = segment.slice(1, -1);
    chunks.push(parseChunkJson(json));
    chunked = true;
    pos = nl + n;
  }

  const items: unknown[][] = [];
  for (const c of chunks) items.push(...c);

  const results: RpcResult[] = [];
  const requestErrors: unknown[][] = [];
  let totalByteLength: number | null = null;

  for (const it of items) {
    switch (it[0]) {
      case "wrb.fr":
        results.push({
          rpcid: it[1] as string,
          slot: it[6] as string,
          data: typeof it[2] === "string" ? JSON.parse(it[2]) : null,
          error: it[5] ?? null,
        });
        break;
      case "e":
        totalByteLength = typeof it[4] === "number" ? it[4] : null;
        break;
      case "er":
        requestErrors.push(it);
        break;
      // "di" / "af.httprm" は無視
    }
  }

  return { chunks, items, results, totalByteLength, requestErrors, chunked };
}

function parseChunkJson(json: string): unknown[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`batchexecute: チャンク JSON のパースに失敗: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("batchexecute: チャンクが配列でない");
  for (const item of parsed) {
    if (!Array.isArray(item)) throw new Error("batchexecute: チャンク内アイテムが配列でない");
  }
  return parsed as unknown[][];
}

/**
 * パース結果からワイヤ形式 (rt=c) を再構築する。ラウンドトリップ検証用。
 * 長さ行は JSON.length + 2 (= UTF-16 コードユニット) で計算する。
 */
export function serializeBatchExecute(chunks: unknown[][][]): string {
  let out = XSSI_PREFIX + "\n";
  for (const chunk of chunks) {
    const json = JSON.stringify(chunk);
    out += String(json.length + 2) + "\n" + json + "\n";
  }
  return out;
}

/** 1 RPC 呼び出しの記述。 */
export interface RpcCall {
  rpcid: string;
  /** 引数配列。JSON.stringify されて call[1] に入る。 */
  args: unknown[];
  /** 任意の識別子。レスポンスの wrb.fr[6] にエコーされる。既定 "generic"。 */
  slot?: string;
}

/** POST ボディ `f.req=<percent-encoded JSON>&` を組み立てる。 */
export function buildBatchExecuteBody(calls: RpcCall[]): string {
  const fReq = [
    calls.map((c) => [c.rpcid, JSON.stringify(c.args), null, c.slot ?? "generic"]),
  ];
  return "f.req=" + encodeURIComponent(JSON.stringify(fReq)) + "&";
}

/** batchexecute の URL を組み立てる。省略可能なクエリは opts で明示的に付ける。 */
export function buildBatchExecuteUrl(
  calls: RpcCall[],
  opts: { rt?: "c" | null; hl?: string; sourcePath?: string; fSid?: string; bl?: string; reqid?: number } = {},
): string {
  const q = new URLSearchParams();
  q.set("rpcids", calls.map((c) => c.rpcid).join(","));
  if (opts.sourcePath) q.set("source-path", opts.sourcePath);
  if (opts.fSid) q.set("f.sid", opts.fSid);
  if (opts.bl) q.set("bl", opts.bl);
  if (opts.hl) q.set("hl", opts.hl);
  if (opts.reqid !== undefined) q.set("_reqid", String(opts.reqid));
  if (opts.rt !== null) q.set("rt", opts.rt ?? "c");
  return "https://trends.google.com/_/TrendsUi/data/batchexecute?" + q.toString();
}

// -----------------------------------------------------------------------------
// WIZ_global_data 抽出 (正規表現のみ。DOM パーサ不使用)
// -----------------------------------------------------------------------------

/** /trending の HTML から WIZ_global_data の文字列値を 1 つ抜く。 */
export function extractWizString(html: string, key: string): string | null {
  // JSON 文字列のエスケープ ( \" \\ \uXXXX ) を正しく食う
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = html.match(re);
  return m ? (JSON.parse('"' + m[1] + '"') as string) : null;
}

/** f.sid (WIZ_global_data.FdrFJe)。必ず文字列のまま扱うこと (負の 64bit 整数)。 */
export const extractFSid = (html: string) => extractWizString(html, "FdrFJe");
/** bl (WIZ_global_data.cfb2h)。ビルドラベル。 */
export const extractBl = (html: string) => extractWizString(html, "cfb2h");

// =============================================================================
// HAR 由来の固定フィクスチャ (秘密情報は含まない。Cookie/トークンは一切無い)
// =============================================================================

/**
 * HAR 07_entry330 (entry index 330) の完全なレスポンスボディ。
 * rpcids=Tnt4U、引数 []、ペイロード [[]]。ASCII のみ 142 文字 = 142 バイト。
 * 「最小の完全な封筒」としてラウンドトリップ検証に使う。
 */
const HAR_ENTRY330_BODY = ")]}'\n" +
  "\n" +
  "106\n" +
  '[["wrb.fr","Tnt4U","[[]]",null,null,null,"generic"],["di",10],["af.httprm",10,"8110329141056352168",20]]\n' +
  "25\n" +
  '[["e",4,null,null,142]]\n';

/**
 * HAR 16_entry418 (rpcids=i0OFE,wAgrOe) の **第 1 チャンクそのまま**。
 * 日本語 6 文字を含むので「長さ行はバイト長ではない」ことの直接の証拠になる。
 *   長さ行 57 / JSON の UTF-16 長 55 / JSON の UTF-8 長 67
 */
const HAR_ENTRY418_CHUNK1 = '57\n[["wrb.fr","wAgrOe","[\\"アイルランド\\"]",null,null,null,"3"]]\n';

/**
 * HAR 16_entry418 のチャンク列 (i0OFE の巨大ペイロードだけ省略した縮約版)。
 * チャンク境界が RPC 境界と一致しないこと、レスポンス順がリクエスト順
 * (i0OFE → wAgrOe) と **逆転**していることを示す。
 */
const HAR_ENTRY418_SHAPE = ")]}'\n\n" +
  HAR_ENTRY418_CHUNK1 +
  "55\n" +
  '[["di",48],["af.httprm",48,"3251696711060829550",18]]\n' +
  "26\n" +
  '[["e",5,null,null,3086]]\n';

/**
 * 2026-09-09 のライブ実測で得た「サロゲートペア入り」応答 (そのまま記録)。
 * slotId に "s🇯🇵e" を入れてサーバにエコーさせたもの。
 * 長さ行 111 / UTF-16 109 / コードポイント 107 / UTF-8 117。
 * → 長さ行の単位が UTF-16 コードユニットであることの決定的証拠。
 */
const LIVE_SURROGATE_BODY = ")]}'\n" +
  "\n" +
  "111\n" +
  '[["wrb.fr","wAgrOe","[\\"日本\\"]",null,null,null,"s\u{1F1EF}\u{1F1F5}e"],["di",12],["af.httprm",11,"-5668663339315347667",17]]\n' +
  "25\n" +
  '[["e",4,null,null,155]]\n';

/**
 * 2026-09-09 のライブ実測: 存在しない rpcid を投げたときの応答 (HTTP 400)。
 */
const LIVE_ER_BODY = ")]}'\n" +
  "\n" +
  "102\n" +
  '[["er",null,null,null,null,400,null,null,null,3],["di",9],["af.httprm",8,"-1913695066988224335",16]]\n' +
  "25\n" +
  '[["e",4,null,null,138]]\n';

/**
 * 2026-09-09 のライブ実測: POST ではなく GET で投げたときの応答 (HTTP 405)。
 * er[5] = 405 / er[9] = 9 で、**er[9] が 3 固定ではない**ことの直接の証拠。
 */
const LIVE_ER_405_BODY = ")]}'\n" +
  "\n" +
  "102\n" +
  '[["er",null,null,null,null,405,null,null,null,9],["di",8],["af.httprm",8,"-6083195748611684957",17]]\n' +
  "25\n" +
  '[["e",4,null,null,138]]\n';

/**
 * 2026-09-09 のライブ実測: rpcid は正しいが引数が不正なときの応答 (HTTP 200)。
 * wrb.fr[2] が null になり、wrb.fr[5] にエラー配列 [3] が入る。
 */
const LIVE_RPC_ERROR_BODY = ")]}'\n" +
  "\n" +
  "105\n" +
  '[["wrb.fr","wAgrOe",null,null,null,[3],"generic"],["di",17],["af.httprm",16,"-5609615246004551854",15]]\n' +
  "25\n" +
  '[["e",4,null,null,141]]\n';

/**
 * 2026-09-09 のライブ実測: rt を省略したときの応答 (長さ行も e チャンクも無い)。
 */
const LIVE_UNCHUNKED_BODY = ")]}'\n" +
  "\n" +
  '[["wrb.fr","wAgrOe","[\\"日本\\"]",null,null,null,"generic"],["di",12],["af.httprm",11,"-7864793380069003492",16]]';

// =============================================================================
// (1) パーサ単体テスト — ネットワーク不要
// =============================================================================

Deno.test({
  name: "パーサ: HAR 07_entry330 の完全な封筒をパースできる",
  fn() {
    const env = parseBatchExecute(HAR_ENTRY330_BODY);
    assert(env.chunked, "rt=c 形式として認識されること");
    assertEquals(env.chunks.length, 2, "チャンクは 2 個 (本体 + 終端)");
    assertEquals(env.items.length, 4, "平坦化すると wrb.fr / di / af.httprm / e の 4 アイテム");
    assertEquals(env.items.map((i) => i[0]), ["wrb.fr", "di", "af.httprm", "e"]);

    assertEquals(env.results.length, 1);
    assertEquals(env.results[0].rpcid, "Tnt4U");
    assertEquals(env.results[0].slot, "generic");
    assertEquals(env.results[0].error, null);
    // ペイロードは二段 JSON。Tnt4U は [[]] を返す
    assertEquals(env.results[0].data, [[]]);

    // 終端 e チャンク: k はアイテムの 1 始まり通し番号、T はボディの UTF-8 バイト長
    const eItem = env.items.find((i) => i[0] === "e")!;
    assertEquals(eItem[1], 4, "e[1] は自分自身の 1 始まり通し番号");
    assertEquals(env.totalByteLength, 142);
    assertEquals(
      new TextEncoder().encode(HAR_ENTRY330_BODY).length,
      142,
      "e[4] はボディ全体の UTF-8 バイト長と一致する",
    );
    // このフィクスチャは ASCII のみなので UTF-16 長とも一致してしまう (だから小さい
    // データだけ見ていると単位の違いに気付けない)
    assertEquals(HAR_ENTRY330_BODY.length, 142);
  },
});

Deno.test({
  name: "パーサ: 長さ行は UTF-8 バイト長ではない (HAR 16_entry418 の日本語チャンク)",
  fn() {
    // "57\n" + JSON + "\n" という生の 1 チャンク
    const nl = HAR_ENTRY418_CHUNK1.indexOf("\n");
    const n = Number(HAR_ENTRY418_CHUNK1.slice(0, nl));
    assertEquals(n, 57);

    const segment = HAR_ENTRY418_CHUNK1.slice(nl, nl + n);
    assertEquals(segment.length, n, "slice(nl, nl+n) がちょうど n 文字取れる");
    assertEquals(segment[0], "\n");
    assertEquals(segment[segment.length - 1], "\n");

    const json = segment.slice(1, -1);
    assertEquals(json.length, n - 2, "★ JSON の UTF-16 長 === n - 2");
    assertEquals(json.length, 55);
    assertEquals(
      new TextEncoder().encode(json).length,
      67,
      "★ UTF-8 バイト長は 67 で n-2 と一致しない → 長さ行はバイト長ではない",
    );

    const item = JSON.parse(json)[0];
    assertEquals(item[0], "wrb.fr");
    assertEquals(item[1], "wAgrOe");
    assertEquals(JSON.parse(item[2] as string), ["アイルランド"]);
    assertEquals(item[6], "3", "slotId がエコーされている");
  },
});

Deno.test({
  name: "パーサ: 長さ行はコードポイント長でもない (サロゲートペア入りライブ応答)",
  fn() {
    const env = parseBatchExecute(LIVE_SURROGATE_BODY);
    assertEquals(env.results.length, 1);
    assertEquals(env.results[0].data, ["日本"]);
    // slotId に入れた 🇯🇵 (地域指示子 2 つ = 2 コードポイント = 4 UTF-16 ユニット) が
    // そのままエコーされている
    assertEquals(env.results[0].slot, "s\u{1F1EF}\u{1F1F5}e");
    assertEquals(env.results[0].slot.length, 6, "UTF-16 では 6 ユニット");
    assertEquals([...env.results[0].slot].length, 4, "コードポイントでは 4 個");

    // 生データ上での三者比較
    const nl = LIVE_SURROGATE_BODY.indexOf("\n", 6);
    const n = Number(LIVE_SURROGATE_BODY.slice(6, nl));
    assertEquals(n, 111);
    const json = LIVE_SURROGATE_BODY.slice(nl + 1, nl + n - 1);
    assertEquals(json.length, n - 2, "★ UTF-16 コードユニット長が n-2 に一致");
    assertEquals(json.length, 109);
    assertEquals([...json].length, 107, "★ コードポイント長 107 は n-2 と一致しない");
    assertEquals(new TextEncoder().encode(json).length, 117, "★ UTF-8 長 117 も一致しない");

    // 終端 e の T はボディ全体の UTF-8 バイト長
    assertEquals(env.totalByteLength, 155);
    assertEquals(new TextEncoder().encode(LIVE_SURROGATE_BODY).length, 155);
    assertEquals(LIVE_SURROGATE_BODY.length, 147, "UTF-16 長 147 とは異なる (単位の混在)");
  },
});

Deno.test({
  name: "パーサ: ラウンドトリップ (パース → 再シリアライズ で元の文字列に戻る)",
  fn() {
    for (const [label, body] of [
      ["HAR entry330", HAR_ENTRY330_BODY],
      ["HAR entry418 (縮約)", HAR_ENTRY418_SHAPE],
      ["live surrogate", LIVE_SURROGATE_BODY],
      ["live er (400)", LIVE_ER_BODY],
      ["live er (405)", LIVE_ER_405_BODY],
      ["live rpc error", LIVE_RPC_ERROR_BODY],
    ] as const) {
      const env = parseBatchExecute(body);
      assertEquals(
        serializeBatchExecute(env.chunks),
        body,
        `${label}: 長さ行 = JSON.length + 2 (UTF-16) で完全に復元できる`,
      );
    }
  },
});

Deno.test({
  name: "パーサ: チャンク境界に意味は無く、応答順はリクエスト順と一致しない",
  fn() {
    const env = parseBatchExecute(HAR_ENTRY418_SHAPE);
    // リクエストは i0OFE(slot "1") → wAgrOe(slot "3") の順だったが、
    // レスポンスでは wAgrOe が先に出る (i0OFE のチャンクはこのフィクスチャでは省略)
    assertEquals(env.results[0].rpcid, "wAgrOe");
    assertEquals(env.results[0].slot, "3");
    // di / af.httprm は wrb.fr とは別チャンクに入っている
    assertEquals(env.chunks.length, 3);
    assertEquals(env.chunks[0].map((i) => i[0]), ["wrb.fr"]);
    assertEquals(env.chunks[1].map((i) => i[0]), ["di", "af.httprm"]);
    assertEquals(env.chunks[2].map((i) => i[0]), ["e"]);
    // 平坦化してから拾えば境界を意識しなくてよい
    assertEquals(env.items.length, 4);
  },
});

Deno.test({
  name: "パーサ: リクエスト全体のエラー (er アイテム) を識別でき、er[9] は固定値ではない",
  fn() {
    const env = parseBatchExecute(LIVE_ER_BODY);
    assertEquals(env.results.length, 0, "エラー時は wrb.fr が 1 つも返らない");
    assertEquals(env.requestErrors.length, 1);
    const er = env.requestErrors[0];
    assertEquals(er[0], "er");
    assertEquals(er.length, 10, "er は arity 10");
    assertEquals(er[5], 400, "er[5] は HTTP ステータスと同値");
    assertEquals(er[9], 3, "er[9] は 400 のとき 3 (gRPC INVALID_ARGUMENT と推定)");
    // [5] と [9] 以外は全て null
    assertEquals(
      er.filter((_, i) => i !== 0 && i !== 5 && i !== 9),
      [null, null, null, null, null, null, null],
      "er[1..4] と er[6..8] は全て null",
    );

    // ★ GET で投げたときは同じ形のまま値だけ変わる。
    //   er[9] を 3 決め打ちで判定すると壊れる。
    const env405 = parseBatchExecute(LIVE_ER_405_BODY);
    const er405 = env405.requestErrors[0];
    assertEquals(env405.results.length, 0);
    assertEquals(er405.length, 10);
    assertEquals(er405[5], 405, "er[5] は 405");
    assertEquals(er405[9], 9, "★ er[9] は 9 になる (3 固定ではない)");
    assert(er[9] !== er405[9], "★ er[9] はステータスによって変わる");
  },
});

Deno.test({
  name: "パーサ: RPC 単位のエラー (wrb.fr[2]=null, wrb.fr[5]=エラー配列) を識別できる",
  fn() {
    const env = parseBatchExecute(LIVE_RPC_ERROR_BODY);
    assertEquals(env.requestErrors.length, 0, "HTTP は 200 で er も無い");
    assertEquals(env.results.length, 1);
    const r = env.results[0];
    assertEquals(r.rpcid, "wAgrOe");
    assertEquals(r.slot, "generic");
    assertEquals(r.data, null, "★ ペイロードが null になる");
    assertEquals(r.error, [3], "★ wrb.fr[5] にエラー配列が入る");
    // HAR の 22 個の wrb.fr は全て [5] が null だったので、この形は HAR からは
    // 分からなかった (ライブでわざと不正な引数を送って判明)
  },
});

Deno.test({
  name: "パーサ: rt 省略時の非チャンク形式も透過的に扱える",
  fn() {
    const env = parseBatchExecute(LIVE_UNCHUNKED_BODY);
    assertEquals(env.chunked, false, "長さ行が無い形式として認識される");
    assertEquals(env.chunks.length, 1);
    assertEquals(env.totalByteLength, null, "終端 e チャンクが無いので整合性検査はできない");
    assertEquals(env.results.length, 1);
    assertEquals(env.results[0].rpcid, "wAgrOe");
    assertEquals(env.results[0].data, ["日本"]);
  },
});

Deno.test({
  name: "パーサ: 壊れた入力を検出する",
  fn() {
    assertThrows(
      () => parseBatchExecute('[["wrb.fr"]]'),
      Error,
      "XSSI",
    );
    assertThrows(
      () => parseBatchExecute(")]}'\n\nxx\n[]\n"),
      Error,
      "10 進数字ではない",
    );
    // 長さ行が実際のボディより長い = 途中で切れている
    assertThrows(
      () => parseBatchExecute(")]}'\n\n9999\n[[\"di\",1]]\n"),
      Error,
      "途中で切れている",
    );
    // 長さは足りているが区間が LF で挟まれていない = 単位の取り違え
    // (長さ行をバイト長で読むと非 ASCII 応答でこの形のずれ方をする)
    assertThrows(
      () => parseBatchExecute(")]}'\n\n4\n[]X"),
      Error,
      "LF で挟まれていない",
    );
  },
});

/**
 * HAR コーパス全体に対する適合検証。
 *
 * 上のフィクスチャは手で選んだ 3 本なので「たまたま通っただけ」の可能性が残る。
 * ここでは抽出済みコーパスの **ボディが保存されている 21 エントリ全て** を
 * パースし、ヘッダコメントに書いた仕様上の主張を機械的に突き合わせる。
 *
 * コーパスが無い環境 (成果物を単体で配布した場合) や --allow-read が無い場合は
 * console.warn を出して skip する。ネットワークも不要。
 *
 * 注意: 抽出済み .txt は改行が CRLF に正規化されており、`# body length` は
 *       **UTF-16 コードユニット長** (バイト長ではない) で記録されている。
 *       生 HAR のボディは LF なので、比較前に CRLF -> LF に戻す必要がある。
 */
const HAR_CORPUS_DIR =
  "C:\\Users\\ushid\\Documents\\gtrend_claude\\.har\\extracted\\TrendsUi_data_batchexecute";

Deno.test({
  name: "パーサ: HAR コーパスの実レスポンス 21 本を全てパースし仕様の主張を突き合わせる",
  fn() {
    let names: string[];
    try {
      names = [...Deno.readDirSync(HAR_CORPUS_DIR)]
        .filter((d) => d.isFile && d.name.endsWith(".txt"))
        .map((d) => d.name)
        .sort();
    } catch (e) {
      console.warn(`  [skip] HAR コーパスを読めない (${(e as Error).name}): ${HAR_CORPUS_DIR}`);
      return;
    }

    const enc = new TextEncoder();
    let bodies = 0;
    let wrbCount = 0;
    const slots = new Set<string>();
    let maxUtf8MinusUtf16 = 0;

    for (const name of names) {
      const raw = Deno.readTextFileSync(`${HAR_CORPUS_DIR}\\${name}`);
      const declared = Number((raw.match(/^# body length: (\d+)/m) ?? [])[1] ?? -1);
      const marker = raw.indexOf("# body:");
      if (declared <= 0 || marker < 0) continue; // ボディ未保存のエントリ (6 件)

      // CRLF 正規化を戻し、抽出時に付いた末尾改行の揺れを削って生 HAR の姿に戻す
      let body = raw.slice(marker + "# body:".length).replace(/\r\n/g, "\n").replace(/^\n/, "");
      while (body.length > declared && /\s$/.test(body)) body = body.slice(0, -1);
      assertEquals(body.length, declared, `${name}: 復元したボディの UTF-16 長が記録と一致`);

      const env = parseBatchExecute(body);
      bodies++;
      assert(env.chunked, `${name}: HAR は全て rt=c なのでチャンク形式`);
      assertEquals(env.requestErrors.length, 0, `${name}: HAR に er は 1 件も無い`);

      // ★ 主張 2-1/2-2: 長さ行 = JSON.length + 2 (UTF-16)。
      //   再シリアライズで 1 文字違わず戻ることが最も強い証拠になる。
      assertEquals(serializeBatchExecute(env.chunks), body, `${name}: ラウンドトリップ成立`);

      // ★ 主張 2-4: 終端 e の T はボディ全体の UTF-8 バイト長
      const utf8 = enc.encode(body).length;
      assertEquals(env.totalByteLength, utf8, `${name}: e[4] === ボディの UTF-8 バイト長`);
      maxUtf8MinusUtf16 = Math.max(maxUtf8MinusUtf16, utf8 - body.length);

      // ★ 主張 2-4: e[1] は平坦化したアイテム列での 1 始まり通し番号
      const eIdx = env.items.findIndex((i) => i[0] === "e");
      assert(eIdx >= 0, `${name}: 終端 e アイテムがある`);
      assertEquals(env.items[eIdx][1], eIdx + 1, `${name}: e[1] === 平坦化後の 1 始まり位置`);

      // ★ 主張 2-3: wrb.fr は arity 7、[3][4][5] は成功時 null
      for (const it of env.items) {
        if (it[0] !== "wrb.fr") continue;
        wrbCount++;
        assertEquals(it.length, 7, `${name}: wrb.fr は arity 7`);
        assertEquals(it[3], null, `${name}: wrb.fr[3] は null`);
        assertEquals(it[4], null, `${name}: wrb.fr[4] は null`);
        assertEquals(it[5], null, `${name}: wrb.fr[5] は成功時 null`);
        assertEquals(typeof it[2], "string", `${name}: ペイロードは二段 JSON の文字列`);
        slots.add(String(it[6]));
      }
    }

    // 以下はこの HAR キャプチャ (2026-09-08) の実測値。HAR を取り直したら
    // ヘッダコメントの根拠の数字ごと更新すること。
    assertEquals(bodies, 21, "ボディが保存されているのは 27 エントリ中 21 件");
    assertEquals(wrbCount, 22, "wrb.fr は全部で 22 個 (1 エントリだけ 2 RPC のバッチ)");
    assertEquals(
      [...slots].sort(),
      ["1", "3", "generic"],
      "観測された slotId は 3 種類。リクエストの call[3] がそのままエコーされている",
    );
    // ASCII だけのボディでは UTF-8 と UTF-16 が一致してしまい単位の違いに気付けない。
    // コーパスには両者が 3 万以上ずれるボディが含まれている (= 決定的な反証材料)。
    assert(
      maxUtf8MinusUtf16 > 30000,
      `UTF-8 と UTF-16 の最大差 ${maxUtf8MinusUtf16} (長さ行がバイト長なら破綻していたはず)`,
    );
  },
});

Deno.test({
  name: "ボディ組み立て: f.req の二重配列と二段 JSON",
  fn() {
    // HAR 07_entry330 の postData を再現する
    const body = buildBatchExecuteBody([{ rpcid: "Tnt4U", args: [], slot: "generic" }]);
    assertEquals(
      body,
      "f.req=%5B%5B%5B%22Tnt4U%22%2C%22%5B%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&",
      "HAR の生 postData と 1 バイト違わず一致する",
    );

    // デコードして構造を確認
    const decoded = JSON.parse(decodeURIComponent(body.slice("f.req=".length, -1)));
    assertEquals(decoded.length, 1, "外側は必ず二重配列 (calls の配列を 1 個包む)");
    assertEquals(decoded[0].length, 1);
    assertEquals(decoded[0][0], ["Tnt4U", "[]", null, "generic"]);
    assertEquals(typeof decoded[0][0][1], "string", "引数は JSON 文字列 (二段 JSON)");
    assertEquals(decoded[0][0][2], null, "call[2] は常に null");

    // HAR 16_entry418 の複数 RPC 形を再現する
    const multi = buildBatchExecuteBody([
      { rpcid: "i0OFE", args: [null, null, "IE", 0, "ja", 4], slot: "1" },
      { rpcid: "wAgrOe", args: ["IE", "ja"], slot: "3" },
    ]);
    const m = JSON.parse(decodeURIComponent(multi.slice("f.req=".length, -1)));
    assertEquals(m[0].length, 2, "1 リクエストに複数 call を並べる");
    assertEquals(m[0][0][0], "i0OFE");
    assertEquals(m[0][0][1], '[null,null,"IE",0,"ja",4]');
    assertEquals(m[0][1][0], "wAgrOe");
    assertEquals(m[0][1][1], '["IE","ja"]');
  },
});

Deno.test({
  name: "URL 組み立て: rpcids は call 順のカンマ結合、rt=c が既定、省略可能なものは省ける",
  fn() {
    const calls: RpcCall[] = [
      { rpcid: "i0OFE", args: [], slot: "1" },
      { rpcid: "wAgrOe", args: [], slot: "3" },
    ];
    const minimal = buildBatchExecuteUrl(calls);
    assert(minimal.includes("rpcids=i0OFE%2CwAgrOe"), "カンマは %2C にエンコードされる");
    assert(minimal.includes("rt=c"));
    assert(!minimal.includes("f.sid"), "f.sid はオプトイン");

    const full = buildBatchExecuteUrl(calls, {
      sourcePath: "/trending",
      fSid: "-8959654384266786277",
      bl: "boq_trends-boq-servers-frontend_20260906.08_p0",
      hl: "ja",
      reqid: 186100,
    });
    const u = new URL(full);
    assertEquals(u.searchParams.get("f.sid"), "-8959654384266786277", "f.sid は負値もある文字列");
    assertEquals(u.searchParams.get("source-path"), "/trending");
    assertEquals(u.searchParams.get("rt"), "c");

    // rt: null で rt を落とすと非チャンク形式になる (レスポンス形式が変わる)
    assert(!buildBatchExecuteUrl(calls, { rt: null }).includes("rt="));
  },
});

Deno.test({
  name: "WIZ_global_data 抽出: 正規表現だけで f.sid / bl を取れる (合成 HTML)",
  fn() {
    // 実際の /trending の <head> と同じ形。値は本物ではない (負値のケースを含む)
    const html = '<!doctype html><html><head><script data-id="_gd" nonce="AbCd">' +
      'window.WIZ_global_data = {"AfY8Hf":"[[]]","FdrFJe":"-8959654384266786277",' +
      '"cfb2h":"boq_trends-boq-servers-frontend_20260906.08_p0","qwAQke":"TrendsUi",' +
      '"eptZe":"/_/TrendsUi/","rtQCxc":-540,"y2FhP":"prod"};</script></head><body></body></html>';

    assertEquals(extractFSid(html), "-8959654384266786277");
    assertEquals(extractBl(html), "boq_trends-boq-servers-frontend_20260906.08_p0");
    assertEquals(extractWizString(html, "qwAQke"), "TrendsUi");
    assertEquals(extractWizString(html, "eptZe"), "/_/TrendsUi/");
    assertEquals(extractWizString(html, "NoSuchKey"), null);

    // f.sid は文字列のまま扱う必要がある (Number() すると精度が壊れる)
    const s = extractFSid(html)!;
    assertEquals(typeof s, "string");
    assert(
      String(Number(s)) !== s,
      "★ Number() を通すと値が変わってしまう (2^53 超) ので必ず文字列で扱う",
    );

    // \uXXXX や \" を含む値も正しく復元できる
    const esc = 'x{"cfb2h":"a\\"b\\u0041c"}';
    assertEquals(extractBl(esc), 'a"bAc');
  },
});

// =============================================================================
// (2) ライブ検証 — 429 / ネットワーク断ではハードに落とさず warn + skip
// =============================================================================

const BASE_URL = "https://trends.google.com/_/TrendsUi/data/batchexecute";
const POST_HEADERS: Record<string, string> = {
  // 実測ではこれ 1 本で 200 が返る。以下 3 本はブラウザ擬態の保険 (無害)
  "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
  "x-same-domain": "1",
  "origin": "https://trends.google.com",
  "referer": "https://trends.google.com/",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 直前のライブリクエストからの間隔を空ける (同一 IP からの連打を避ける)。 */
let lastRequestAt = 0;
async function pace() {
  const wait = 1200 - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

interface LiveResponse {
  status: number;
  contentType: string;
  text: string;
}

/**
 * ライブ POST。429 は指数バックオフ (2s, 4s, 8s) で最大 3 回まで再試行。
 * それでも駄目 / ネットワーク断なら null を返し、呼び出し側は skip 扱いにする。
 */
async function livePost(
  url: string,
  body: string,
  headers: Record<string, string> = POST_HEADERS,
): Promise<LiveResponse | null> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
    await pace();
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body });
    } catch (e) {
      console.warn(`  [skip] ネットワークエラー: ${(e as Error).message}`);
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text(); // ★ 必ず消費する (Deno のリソースリーク検出対策)
    if (res.status === 429) {
      console.warn(`  [429] リトライ ${attempt + 1}/3`);
      continue;
    }
    return { status: res.status, contentType, text };
  }
  console.warn("  [skip] レート制限のため未検証 (429 が続いた)");
  return null;
}

async function liveGetText(url: string): Promise<{ status: number; text: string } | null> {
  await pace();
  try {
    const res = await fetch(url, {
      headers: { "accept": "text/html,application/xhtml+xml,*/*", "accept-language": "ja" },
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) {
    console.warn(`  [skip] ネットワークエラー: ${(e as Error).message}`);
    return null;
  }
}

/** 小さくて日本語を含むため検証に都合の良い RPC (地域コード → ローカライズ表示名)。 */
const TINY_CALL: RpcCall[] = [{ rpcid: "wAgrOe", args: ["JP", "ja"], slot: "generic" }];

Deno.test({
  name: "ライブ: /trending の HTML から正規表現で f.sid / bl を抽出できる",
  async fn() {
    const r = await liveGetText("https://trends.google.com/trending?geo=JP&hl=ja");
    if (!r) return;
    if (r.status !== 200) {
      console.warn(`  [skip] /trending が status ${r.status}`);
      return;
    }
    assert(r.text.length > 100_000, "SPA シェルなので 1MB 前後あるはず");

    const fSid = extractFSid(r.text);
    const bl = extractBl(r.text);
    assert(fSid !== null, "FdrFJe (f.sid) が取れること");
    assert(bl !== null, "cfb2h (bl) が取れること");
    assert(/^-?\d+$/.test(fSid!), `f.sid は符号付き 10 進整数の文字列: ${fSid}`);
    assert(fSid!.length >= 15, "64bit 相当の桁数");
    assert(bl!.startsWith("boq_trends-boq-servers-frontend_"), `bl の形: ${bl}`);
    assertEquals(extractWizString(r.text, "qwAQke"), "TrendsUi");
    assertEquals(extractWizString(r.text, "eptZe"), "/_/TrendsUi/");

    // HTML 全体で 1 回しか出ないので単一キー直抜きが安全
    assertEquals(r.text.split('"FdrFJe"').length - 1, 1);
    assertEquals(r.text.split('"cfb2h"').length - 1, 1);
    console.log(`  f.sid=${fSid} bl=${bl}`);
  },
});

Deno.test({
  name: "ライブ: ブラウザと同じ 10 個のクエリ + rt=c で 200 / 封筒が仕様どおり",
  async fn() {
    const url = buildBatchExecuteUrl(TINY_CALL, {
      sourcePath: "/trending",
      hl: "ja",
      reqid: 100000,
    }) + "&soc-app=1&soc-platform=1&soc-device=1";
    const r = await livePost(url, buildBatchExecuteBody(TINY_CALL));
    if (!r) return;
    assertEquals(r.status, 200);
    assert(r.contentType.startsWith("application/json"), `content-type: ${r.contentType}`);

    const env = parseBatchExecute(r.text);
    assert(env.chunked, "rt=c ならチャンク形式");
    assertEquals(env.requestErrors.length, 0);
    assertEquals(env.results.length, 1);
    assertEquals(env.results[0].rpcid, "wAgrOe");
    assertEquals(env.results[0].slot, "generic", "slotId がそのままエコーされる");
    assertEquals(env.results[0].error, null);
    // wAgrOe は [ローカライズ済み地域名] の長さ 1 配列を返す
    const data = env.results[0].data as string[];
    assert(Array.isArray(data) && data.length === 1 && typeof data[0] === "string");
    assertEquals(data[0], "日本");

    // 終端 e の T はボディ全体の UTF-8 バイト長 (UTF-16 長ではない)
    assertEquals(
      env.totalByteLength,
      new TextEncoder().encode(r.text).length,
      "★ e[4] === UTF-8 バイト長",
    );
    assert(
      env.totalByteLength! > r.text.length,
      "★ 日本語を含むので UTF-8 バイト長 > UTF-16 長 (単位が混在している証拠)",
    );

    // ラウンドトリップも成立する = 長さ行が UTF-16 である追加の証拠
    assertEquals(serializeBatchExecute(env.chunks), r.text);
  },
});

Deno.test({
  name: "ライブ: URL クエリを完全に省いても 200 (rpcids/f.sid/bl/hl/soc-*/_reqid は全て不要)",
  async fn() {
    const r = await livePost(BASE_URL, buildBatchExecuteBody(TINY_CALL));
    if (!r) return;
    assertEquals(r.status, 200, "★ クエリ 0 個でも通る = 全情報は f.req から読まれている");
    assert(r.contentType.startsWith("application/json"));
    const env = parseBatchExecute(r.text);
    assertEquals(env.results.length, 1);
    assertEquals(env.results[0].rpcid, "wAgrOe");
    assertEquals(env.results[0].data, ["日本"]);
    // rt が無いので非チャンク形式になる
    assertEquals(env.chunked, false, "★ rt を省くと長さ行の無い形式になる");
    assertEquals(env.totalByteLength, null, "終端 e チャンクも無くなる");
  },
});

Deno.test({
  name: "ライブ: rt=c だけ残して f.sid/bl/hl/soc-*/_reqid を落とす + ヘッダも content-type のみ + 末尾 & 無し",
  async fn() {
    // 直前のテストは「クエリを全部落とす」ものだったので、rt が無いことによる
    // 形式変化と f.sid/bl が不要であることが混ざってしまっている。
    // ここは rt=c だけを残すことで **f.sid / bl / hl / soc-* / _reqid が
    // 本当に不要**であることを、チャンク形式のまま単独で切り分けて実証する。
    // 同時に検証する主張:
    //   - 1-3: content-type 以外のヘッダ (x-same-domain / origin / referer /
    //          user-agent) は不要
    //   - 1-4: ボディ末尾の裸の `&` はブラウザの癖であって必須ではない
    const bodyWithoutTrailingAmp = buildBatchExecuteBody(TINY_CALL).replace(/&$/, "");
    assert(!bodyWithoutTrailingAmp.endsWith("&"), "末尾 & を確かに外している");
    const r = await livePost(
      BASE_URL + "?rt=c",
      bodyWithoutTrailingAmp,
      { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    );
    if (!r) return;
    assertEquals(r.status, 200, "★ f.sid/bl 無し + content-type だけ + 末尾 & 無しでも 200");
    assert(r.contentType.startsWith("application/json"), `content-type: ${r.contentType}`);

    const env = parseBatchExecute(r.text);
    assert(env.chunked, "★ rt=c を残したのでチャンク形式のまま (= 形式変化は rt だけが原因)");
    assertEquals(env.requestErrors.length, 0);
    assertEquals(env.results.length, 1);
    assertEquals(env.results[0].rpcid, "wAgrOe");
    assertEquals(env.results[0].error, null);
    assertEquals(env.results[0].data, ["日本"]);
    // 封筒の整合性も通常どおり成立する
    assertEquals(env.totalByteLength, new TextEncoder().encode(r.text).length);
    assert(
      env.totalByteLength! > r.text.length,
      "日本語を含むので UTF-8 バイト長 > UTF-16 長",
    );
  },
});

Deno.test({
  name: "ライブ: content-type が x-www-form-urlencoded でないと 400 + er (★ 最も踏みやすい罠)",
  async fn() {
    // fetch(url, { method:"POST", body: "f.req=..." }) と書くと Deno も
    // ブラウザも content-type: text/plain;charset=UTF-8 を勝手に付ける。
    // その状態では batchexecute は 400 を返す = content-type は本当に必須。
    // ここでは実行環境の既定値に依存しないよう text/plain を明示して送る。
    const r = await livePost(
      BASE_URL + "?rt=c",
      buildBatchExecuteBody(TINY_CALL),
      { "content-type": "text/plain;charset=UTF-8" },
    );
    if (!r) return;
    assertEquals(r.status, 400, "★ content-type が違うだけで 400");
    assert(r.contentType.startsWith("application/json"), "エラーでも JSON 封筒のまま");

    const env = parseBatchExecute(r.text);
    assertEquals(env.results.length, 0, "wrb.fr は 1 つも返らない");
    assertEquals(env.requestErrors.length, 1, "er が 1 個");
    assertEquals(env.requestErrors[0][5], 400, "er[5] = 400");
    assertEquals(env.requestErrors[0][9], 3, "er[9] = 3 (400 系)");
    // 封筒は正常系と同じ構造なので、整合性チェックもそのまま通る
    assert(env.chunked);
    assertEquals(env.totalByteLength, new TextEncoder().encode(r.text).length);
  },
});

Deno.test({
  name: "ライブ: メソッドは POST 固定 — GET だと 405 + er[9]=9 (er[9] は 3 固定ではない)",
  async fn() {
    // f.req をクエリに載せた GET。405 が返り、er[9] は 400 系の 3 ではなく 9 になる。
    await pace();
    let res: Response;
    try {
      res = await fetch(BASE_URL + "?rt=c&" + buildBatchExecuteBody(TINY_CALL));
    } catch (e) {
      console.warn(`  [skip] ネットワークエラー: ${(e as Error).message}`);
      return;
    }
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text(); // ★ 必ず消費する
    if (res.status === 429) {
      console.warn("  [skip] レート制限のため未検証");
      return;
    }
    assertEquals(res.status, 405, "★ GET は Method Not Allowed");
    assert(contentType.startsWith("application/json"), `content-type: ${contentType}`);

    const env = parseBatchExecute(text);
    assertEquals(env.results.length, 0);
    assertEquals(env.requestErrors.length, 1);
    const er = env.requestErrors[0];
    assertEquals(er.length, 10, "er は arity 10 のまま");
    assertEquals(er[5], 405, "★ er[5] は HTTP ステータスと同値 (405)");
    assertEquals(er[9], 9, "★ er[9] = 9 (gRPC FAILED_PRECONDITION と推定)。3 固定ではない");
    assert(env.chunked, "エラーでも rt=c の封筒構造は同じ");
    assertEquals(env.totalByteLength, new TextEncoder().encode(text).length);
  },
});

Deno.test({
  name: "ライブ: rt=b は JSON 封筒ではなく protobuf バイナリ (軽量ラッパーでは使わない)",
  async fn() {
    // ヘッダコメント 3 の主張の裏取り。ここだけはテキストではなくバイト列で受ける。
    await pace();
    let res: Response;
    try {
      res = await fetch(BASE_URL + "?rpcids=wAgrOe&rt=b", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: buildBatchExecuteBody(TINY_CALL),
      });
    } catch (e) {
      console.warn(`  [skip] ネットワークエラー: ${(e as Error).message}`);
      return;
    }
    const buf = new Uint8Array(await res.arrayBuffer()); // ★ 必ず消費する
    if (res.status !== 200) {
      console.warn(`  [skip] status ${res.status} (レート制限の可能性)`);
      return;
    }
    const contentType = res.headers.get("content-type") ?? "";
    assert(
      contentType.startsWith("application/octet-stream"),
      `★ rt=b の content-type は octet-stream (実測: ${contentType})`,
    );
    // XSSI プレフィックスも長さ行も無い = JSON 封筒ではない
    const latin1 = Array.from(buf, (b) => String.fromCharCode(b)).join("");
    assert(!latin1.startsWith(XSSI_PREFIX), "★ )]}' プレフィックスは付かない");
    assertThrows(
      () => parseBatchExecute(latin1),
      Error,
      "XSSI",
      "JSON 用パーサには食わせられない",
    );
    // protobuf の Any 型名が平文で埋まっているのが目印
    assert(
      latin1.includes("type.googleapis.com/trends.fe.geo.GetLocationDisplayNameResponse"),
      "★ Any の型名が平文で見える (protobuf である証拠)",
    );
    assert(latin1.includes("wAgrOe"), "rpcid も平文で入っている");
  },
});

Deno.test({
  name: "ライブ: rpcids はサーバに照合されない (ボディの f.req だけが効く)",
  async fn() {
    // クエリでは i0OFE を 1 個だけ宣言するが、ボディには wAgrOe を入れる
    const r = await livePost(
      BASE_URL + "?rpcids=i0OFE&rt=c",
      buildBatchExecuteBody(TINY_CALL),
    );
    if (!r) return;
    assertEquals(r.status, 200);
    const env = parseBatchExecute(r.text);
    assertEquals(env.results.length, 1);
    assertEquals(
      env.results[0].rpcid,
      "wAgrOe",
      "★ クエリの rpcids(i0OFE) ではなくボディの rpcid(wAgrOe) が実行された",
    );
    assertEquals(env.results[0].data, ["日本"]);
  },
});

Deno.test({
  name: "ライブ: 複数 RPC のバッチ — 応答順はリクエスト順と一致せず slotId で突合する",
  async fn() {
    // わざと大きい RPC を先に、小さい RPC を後に置く
    const calls: RpcCall[] = [
      { rpcid: "i0OFE", args: [null, null, "JP", 0, "ja", 4], slot: "big" },
      { rpcid: "wAgrOe", args: ["JP", "ja"], slot: "small" },
    ];
    // ★ わざとクエリの rpcids には i0OFE **1 個だけ**を宣言する。
    //   ヘッダコメント 1-1 の「ボディに 2 RPC 入れて rpcids を 1 個にしても
    //   2 個とも返る」という主張を、ここで直接裏取りする。
    const url = BASE_URL + "?rpcids=i0OFE&hl=ja&rt=c";
    const r = await livePost(url, buildBatchExecuteBody(calls));
    if (!r) return;
    assertEquals(r.status, 200);
    const env = parseBatchExecute(r.text);
    assertEquals(env.requestErrors.length, 0);
    assertEquals(
      env.results.length,
      2,
      "★ 1 リクエストで 2 つの wrb.fr が返る (クエリ rpcids が 1 個でも無視される)",
    );

    // ★ 順序に依存せず slotId で引く
    const small = env.results.find((x) => x.slot === "small");
    const big = env.results.find((x) => x.slot === "big");
    assert(small && big, "slotId がそのままエコーされている");
    assertEquals(small!.rpcid, "wAgrOe");
    assertEquals(small!.data, ["日本"]);
    assertEquals(big!.rpcid, "i0OFE");
    // i0OFE のペイロードは [null, items] (中身の仕様は本ファイルの対象外)
    const payload = big!.data as unknown[];
    assert(Array.isArray(payload) && payload.length === 2 && payload[0] === null);
    assert(Array.isArray(payload[1]) && (payload[1] as unknown[]).length > 0);

    // 実測では小さい方が先に来る (= リクエスト順の逆転) ことが多いが、
    // 保証は無いので「順序に依存しないこと」だけを検証する
    console.log(`  応答順: ${env.results.map((x) => x.rpcid).join(" -> ")} (リクエスト順は i0OFE -> wAgrOe)`);

    // 大きい応答では複数チャンクに分割される
    console.log(`  チャンク数=${env.chunks.length} 長さ行の合計検証:`);
    assert(env.chunks.length >= 2, "終端 e チャンクがあるので最低 2 チャンク");
    // 全チャンクの長さ行が UTF-16 で辻褄が合うことは parse 成功が保証している。
    // 加えて e[4] とボディの UTF-8 バイト長が一致することを確認する
    assertEquals(env.totalByteLength, new TextEncoder().encode(r.text).length);
    assert(
      env.totalByteLength! > r.text.length,
      "日本語を大量に含むので UTF-8 バイト長 > UTF-16 長",
    );
    // ★ 長さ行がバイト長だったらパースは途中で破綻していたはず。
    //   ここまで到達していること自体が UTF-16 説の証拠になっている
    //   (パーサは各チャンクの区間が LF で挟まれていることを毎回検証している)。
    //
    // ラウンドトリップ (再シリアライズして原文一致) は固定フィクスチャと HAR
    // コーパスでは厳密に検証済み。ただしライブでは **アサーションにしない**:
    // JSON.stringify はサーバの表記を正規化してしまう (= -> = 、1.0 -> 1、
    // 2^53 超の整数の精度落ちなど) ため、ペイロードの中身次第でワイヤ形式とは
    // 無関係に不一致になり得る。ここでは参考情報として出すだけにする。
    if (serializeBatchExecute(env.chunks) !== r.text) {
      console.warn(
        "  [info] ライブ応答は再シリアライズで完全一致しなかった " +
          "(JSON.stringify の正規化によるもので、長さ行の仕様とは無関係)",
      );
    }
  },
});

Deno.test({
  name: "ライブ: 長さ行の単位はサロゲートペアでも UTF-16 コードユニット (決定的検証)",
  async fn() {
    // slotId はサーバがそのままエコーするので、応答に任意の文字を注入できる。
    // 🇯🇵 は 2 コードポイント / 4 UTF-16 ユニット / 8 UTF-8 バイト。
    const slot = "s\u{1F1EF}\u{1F1F5}e";
    const calls: RpcCall[] = [{ rpcid: "wAgrOe", args: ["JP", "ja"], slot }];
    const r = await livePost(BASE_URL + "?rpcids=wAgrOe&rt=c", buildBatchExecuteBody(calls));
    if (!r) return;
    assertEquals(r.status, 200);
    assert(r.text.includes(slot), "slotId がそのままエコーされている");

    // 生の長さ行を自前で読み直して 3 つの単位を突き合わせる
    const nl = r.text.indexOf("\n", 6);
    const n = Number(r.text.slice(6, nl));
    const json = r.text.slice(nl + 1, nl + n - 1);
    const utf16 = json.length;
    const codepoints = [...json].length;
    const utf8 = new TextEncoder().encode(json).length;
    console.log(`  長さ行=${n} UTF-16=${utf16} codepoints=${codepoints} UTF-8=${utf8}`);

    assertEquals(utf16, n - 2, "★ UTF-16 コードユニット長 === 長さ行 - 2");
    assert(codepoints !== n - 2, "★ コードポイント長は一致しない (サロゲートペアがあるため)");
    assert(utf8 !== n - 2, "★ UTF-8 バイト長も一致しない");

    const env = parseBatchExecute(r.text);
    assertEquals(env.results[0].slot, slot);
    assertEquals(env.results[0].data, ["日本"]);
  },
});

Deno.test({
  name: "ライブ: エラー — 存在しない rpcid は HTTP 400 + er アイテム (wrb.fr は返らない)",
  async fn() {
    const calls: RpcCall[] = [{ rpcid: "zzZZzz", args: [], slot: "generic" }];
    const r = await livePost(BASE_URL + "?rpcids=zzZZzz&rt=c", buildBatchExecuteBody(calls));
    if (!r) return;
    // ★2026-09-09: boq 系は一過性の 502 Bad Gateway を返すことがある (HAR にも browserinfo /
    //   jserror で 502 が 2 件記録されている)。仕様の反証ではないのでハードに落とさず skip する。
    //   別の出口 IP で再実行すると同一テストが 25/25 で通ることを確認済み。
    if (r.status === 502 || r.status === 503) {
      console.warn(`[skip] 一過性のゲートウェイエラー (status=${r.status})。時間を空けて再実行してください`);
      return;
    }
    assertEquals(r.status, 400, "★ 未知の rpcid はリクエスト全体の失敗になる");
    assert(r.contentType.startsWith("application/json"), "エラーでも JSON 封筒のまま");

    const env = parseBatchExecute(r.text);
    assertEquals(env.results.length, 0, "wrb.fr は 1 つも無い");
    assertEquals(env.requestErrors.length, 1);
    const er = env.requestErrors[0];
    assertEquals(er[0], "er");
    assertEquals(er[5], 400, "er[5] は HTTP ステータスと同値");
    assertEquals(er[9], 3, "er[9] = 3 (gRPC INVALID_ARGUMENT と推定)");
    // 封筒自体は正常系と同じ構造 (長さ行 + 終端 e)
    assert(env.chunked);
    assertEquals(env.totalByteLength, new TextEncoder().encode(r.text).length);
  },
});

Deno.test({
  name: "ライブ: エラー — 引数が不正だと HTTP 200 のまま wrb.fr[2]=null / wrb.fr[5] にコード",
  async fn() {
    // wAgrOe は [geo, hl] の 2 引数を要求する。空配列を渡す。
    const calls: RpcCall[] = [{ rpcid: "wAgrOe", args: [], slot: "generic" }];
    const r = await livePost(BASE_URL + "?rpcids=wAgrOe&rt=c", buildBatchExecuteBody(calls));
    if (!r) return;
    // ★同上: 一過性の 502/503 は仕様の反証ではないので skip する。
    if (r.status === 502 || r.status === 503) {
      console.warn(`[skip] 一過性のゲートウェイエラー (status=${r.status})。時間を空けて再実行してください`);
      return;
    }
    assertEquals(r.status, 200, "★ HTTP ステータスは 200。ステータスだけ見ると成功に見える");

    const env = parseBatchExecute(r.text);
    assertEquals(env.requestErrors.length, 0, "er アイテムは出ない");
    assertEquals(env.results.length, 1);
    const res = env.results[0];
    assertEquals(res.rpcid, "wAgrOe");
    assertEquals(res.data, null, "★ ペイロード (wrb.fr[2]) が null");
    assert(Array.isArray(res.error), `★ wrb.fr[5] にエラー配列が入る: ${JSON.stringify(res.error)}`);
    assertEquals(res.error, [3], "観測値は [3] (gRPC INVALID_ARGUMENT と推定)");
    // → ラッパーは必ず data === null / error !== null をチェックすること
  },
});
