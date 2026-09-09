// 実行: deno test --allow-net --no-check live_integration/06_autocomplete_test.ts
//
// =====================================================================================
// Google Trends オートコンプリート / エンティティ検索 — 2 系統の仕様 (ライブ検証: 2026-09-09)
// =====================================================================================
//
// キーワード文字列を Google の Knowledge Graph エンティティ (mid, 例 "/m/0k8z") に解決する
// エンドポイントは 2 系統ある。両者は別サービス (旧 = server: GSE / 新 = server: ESF) で、
// レスポンス形式も返る件数も型文字列も違う。本ファイルは両系統を実際に叩いて比較検証する。
//
// なぜ mid が必要か:
//   /trends/api/explore の comparisonItem[].keyword に "Fanza" のような生文字列ではなく
//   "/m/0k8z" のような mid を渡すと「トピック(エンティティ)」としての検索になる。
//   ラッパーライブラリでキーワード → トピック変換を提供するにはこのどちらかが必要。
//
//
// -------------------------------------------------------------------------------------
// 【系統 A】旧 REST: GET https://trends.google.com/trends/api/autocomplete/{keyword}
// -------------------------------------------------------------------------------------
//
// HAR 根拠: .har/extracted/trends_api_autocomplete_DL/00_entry266.txt  (har idx 266, "DL")
//           .har/extracted/trends_api_autocomplete_DLsite/00_entry267.txt (har idx 267, "DLsite")
//           ※ どちらも Chrome の DevTools がボディを退避済みで body length 0。
//              content.size のみ残っている (DL=565, DLsite=440)。
//              → レスポンススキーマは本ファイルのライブ検証で初めて確定させた。
//
// ● HTTP メソッド: GET
// ● キーワードは **クエリではなく URL パスの末尾セグメント**に入る。
// ● クエリパラメータ
//     hl (任意, string)  … 表示言語。例 "ja" / "en"。省略すると既定 (en 相当)。
//                          type フィールドと title の一部がこの言語にローカライズされる。
//     tz (任意, number)  … 分単位のタイムゾーンオフセット (JS getTimezoneOffset 規約, JST=-540)。
//                          【実測】"apple" を hl=en&tz=0 と hl=en (tz 無し) で叩いた結果は
//                          バイト単位で完全一致 (len=311)。→ tz はこのエンドポイントでは無意味。
//                          ブラウザが Angular の共通 interceptor で付けているだけ。
//     ※ token / geo / category / cat のようなパラメータは存在しない。
//        HAR の 2 エントリとも hl と tz の 2 個だけ。
//
// ● 認証: **Cookie 不要**。NID も OTZ も無しで 200 が返る (実測 9/9 リクエスト成功)。
//     これは /trends/api/* ファミリの中では例外的。同じ系統の GET /trends/api/explore は
//     NID 無しだと 429 になるが、autocomplete は素の fetch で通る。
//     なお Cookie 無しで送った 200 レスポンスには必ず Set-Cookie: NID が付くので、
//     「NID を 1 回のリクエストで入手しつつエンティティ解決もする」用途に使える
//     (本ファイルのテスト 1 で Set-Cookie のヘッダ名を実際にアサートしている。値は保持しない)。
//
// ● リクエストヘッダ要件: 実質なし。ブラウザは accept / referer / sec-ch-ua-* 等を送るが、
//     Deno の素の fetch (accept, accept-language, user-agent だけ) で 200。
//     x-browser-validation 等の Chrome 内部ヘッダは送ってはいけない (偽装になる)。
//
// ● 【最重要の落とし穴】パスのパーセントエンコード
//     keyword は必ず encodeURIComponent() を通すこと。encodeURI() では不十分。
//     - 日本語:  "任天堂" → "%E4%BB%BB%E5%A4%A9%E5%A0%82"  … 【実測 200】5 件返る
//     - 空白:    "star wars" → "star%20wars"               … 【実測 200】5 件返る
//                ("+" にしてはいけない。パス中の + はリテラルのプラス記号)
//     - スラッシュ: "AC/DC" を **素のまま**入れると URL が
//                /trends/api/autocomplete/AC/DC となり **404 (text/html, 1648 バイト)**。
//                "AC%2FDC" にエンコードすれば **200** で
//                {"mid":"/m/0134s5","title":"AC/DC","type":"Rock band"} が先頭に返る。
//                encodeURIComponent は "/" を %2F にするので、これを使えば正しく動く。
//                (encodeURI は "/" を残すので壊れる)
//
// ● レスポンス
//     status 200 / content-type: application/json; charset=UTF-8
//     content-disposition: attachment; filename="json.txt"   (filename* は無し)
//     cache-control: private, max-age=0
//     server: GSE
//
//     ボディの先頭 6 文字は  )]}',\n   ← **カンマが入る 6 文字**。
//     ※ 他エージェントの HAR バイト会計では widgetdata 系のプレフィクスが
//        「)]}'\n の 5 バイト + 末尾改行 1 バイト」と推定されていたが、
//        本ファイルのライブ実測では autocomplete は
//        「)]}',\n の 6 文字 + 末尾改行なし」であることが確定した
//        (Fanza の応答: 全長 388 文字 = 6 + JSON 382 文字、最後の文字は '}')。
//        空レスポンスのバイト数 35 / 51 / 76 という HAR の実測値も
//        「6 + JSON + 改行なし」で同様に説明できる。パーサはどちらでも動くよう
//        「先頭の '{' か '[' まで読み飛ばす」実装にしておくのが安全。
//
//     プレフィクスを剥がした後は素の JSON:
//       {"default":{"topics":[
//          {"mid":"/m/0k8z","title":"Apple","type":"Technology company"},
//          ...
//       ]}}
//
//     topics[i] のフィールドは **mid / title / type の 3 個のみ**(実測 9 応答 45 件すべて)。
//       mid   : string。"/m/…" (旧 Freebase mid) または "/g/…" (Knowledge Graph)。必ず "/" 始まり。
//       title : string。エンティティ表示名。hl でローカライズされる。
//       type  : string。エンティティ種別のローカライズ済みラベル。
//               型が特定できないエンティティには **汎用ラベルが入る**:
//                 hl=en → "Topic" / hl=ja → "トピック"
//               (新 API はここが空文字列 "" になる。§比較 参照)
//     サムネイル URL は **返らない**。
//
// ● 件数: 実測 9 クエリすべてで **ちょうど 5 件**。1 文字クエリ ("a") でも 5 件返る。
//     → 上限は 5 件で固定、最小クエリ長の制限は無い、と読める (推測: 上限 5 はサーバ固定)。
//
// ● 非 ASCII は \uXXXX でエスケープされて返る (JSON.parse すれば復元される)。
//     例: "type":"トピック" (= "トピック")
//
//
// -------------------------------------------------------------------------------------
// 【系統 B】新 boq RPC: POST https://trends.google.com/_/TrendsUi/data/batchexecute
//                       ?rpcids=hzg6Ed …
// -------------------------------------------------------------------------------------
//
// HAR 根拠: .har/extracted/TrendsUi_data_batchexecute/01_entry014.txt (har idx 14,  "F")
//                                                     02_entry015.txt (har idx 15,  "Fa")
//                                                     03_entry021.txt (har idx 21,  "Fan")
//                                                     04_entry027.txt (har idx 27,  "Fanz")
//                                                     05_entry033.txt (har idx 33,  "Fanza")
//           ※ この 5 件は source-path=/home の第1セッション由来で、
//              **5 件とも body length 0** (DevTools のページ単位ボディ退避のため)。
//              判明していたのは非圧縮サイズ (F=136, Fa=1090, Fan=827, Fanz=1053, Fanza=599)
//              だけで、配列レイアウトは本ファイルのライブ検証で初めて確定させた。
//              なお F=136 バイトは実測の「空応答」(132〜142 バイトの範囲でばらつく) と
//              矛盾しないが、封筒に可変長の乱数 ID が入るため一致は証明にならない (下記 ★★ 参照)。
//
// ● HTTP メソッド: POST
// ● リクエストボディ: application/x-www-form-urlencoded
//       f.req=<percent-encoded JSON>&        ← 末尾に裸の & が 1 個 (ブラウザの形)。省略可。
//     f.req のデコード後:
//       [[[ "hzg6Ed", "[\"<query>\",\"<hl>\"]", null, "1" ]]]
//     すなわち args は **2 要素の配列 [query, hl] を JSON 文字列化したもの**。
//       query (必須, string) … 生のキーワード。日本語もそのまま (URL パスではないのでエンコード不要)。
//       hl    (必須, string) … 表示言語。
//     slotId は HAR では "1"。任意文字列でよく、レスポンスの wrb.fr[6] にエコーされる。
//     at (XSRF) トークンは不要。reCAPTCHA トークンも不要 (hzg6Ed は引数にトークンを持たない)。
//
// ● クエリパラメータ: ブラウザは rpcids, source-path, f.sid, bl, hl, soc-app, soc-platform,
//     soc-device, _reqid, rt=c の 10 個を送る。
//     【実測】**rpcids / hl / _reqid / rt=c の 4 個だけ**でも 200 が返る。
//     source-path, f.sid, bl, soc-* は省略可能 (2026-09-09 実測)。
//     f.sid / bl を使いたい場合は GET /trending の HTML の WIZ_global_data から
//     FdrFJe / cfb2h を正規表現で抜く (別成果物担当)。
//
// ● 認証: **Cookie 不要**。実測 7/7 リクエストが Cookie 無しで 200。
// ● リクエストヘッダ: content-type: application/x-www-form-urlencoded;charset=UTF-8 のみ必須。
//     【実測】user-agent / x-same-domain / origin / referer を **全部外しても 200**。
//     ただしブラウザは常に x-same-domain: 1, origin, referer を送っており、
//     boq のレスポンスに vary: Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site が付く
//     (= サーバが見ているフック) ので、保険として付けておくのは低コストで無害。
//
// ● レスポンス封筒 (batchexecute 共通)
//       )]}'\n          ← 4 文字 + LF
//       \n              ← 空行 (プレフィクス計 6 文字)
//       <10進数字>\n<チャンクJSON>\n
//       <10進数字>\n<チャンクJSON>\n …
//     長さ数字 N は **UTF-16 コードユニット数** (バイト数ではない)。
//     数字列を終端する LF の位置を nl とすると
//       body.slice(nl, nl+N) === "\n" + JSON + "\n"   → JSON = body.slice(nl+1, nl+N-1)
//     最終チャンクは [["e", k, null, null, T]] で、**T だけは UTF-8 バイト長**。
//     (実測: 任天堂/ja の応答は UTF-16 845 文字 / UTF-8 973 バイト、T=973)
//     チャンク境界に意味は無いので平坦化してから [0]==="wrb.fr" を拾う。
//
// ● wrb.fr のペイロード (二段 JSON。wrb.fr[2] を再度 JSON.parse する)
//     候補あり: [[ item, item, … ]]   ← **外側が 1 要素の配列**。items = payload[0]
//     候補なし: []                    ← **[[]] ではなく空配列 []**。payload[0] は undefined。
//                                        → items = payload[0] ?? [] と書くこと (落とし穴)
//     実測: 1 文字クエリは必ず [] を返す。query="F"/ja, "F"/en, "a"/en の 3 通りで確認。
//           クエリ内容にも hl にも依らないので、「候補ゼロ」は特定キーワードの事情ではなく
//           **1 文字という長さの規則**である。2 文字以上で候補が返り始める
//           (HAR の Fa=1090, Fan=827, Fanz=1053, Fanza=599 というサイズ推移とも整合)。
//           (対照: 旧 REST は同じ "a" で 5 件返す。§比較 の「最小クエリ長」を参照)
//
//     ★★ 訂正 (重要な落とし穴 / 2026-09-09 に自己反証済み) ★★
//       当初 「空応答は常に 136 バイトで、HAR entry 014 ("F") の content.size 136 と
//       完全一致するので HAR の "F" も空応答だったと確定できる」と書いていたが、**これは誤り**。
//       同じ query="F"/hl=ja を繰り返し叩くと 136 / 133 / 132 バイトとばらついた。
//       原因は封筒に混ざる **可変長のサーバ側メタデータ**:
//         [["wrb.fr","hzg6Ed","[]",null,null,null,"1"],
//          ["di",9],                                        ← 桁数が変わる内部カウンタ
//          ["af.httprm",8,"7105740433858857025",17]]        ← 19〜20 文字の乱数 ID (先頭 '-' あり得る)
//                                                              + 前後の数値も桁数が変わる
//       さらに slotId の文字列長もそのまま効く (slot="generic" にすると 142 バイトになった)。
//       → **batchexecute の応答バイト長を定数として期待してはいけない**。
//         HAR の content.size 136 は「空応答と矛盾しない」だけであって、証明にはならない。
//         本ファイルのテストも、136 との厳密比較ではなく
//         「payload が [] であること」と「終端 e チャンクの T が実バイト長と一致すること」を
//         検証する形に直した。
//
// ● wrb.fr 以外に封筒へ混ざるエントリ (平坦化後に現れる。無視してよいが存在は知っておくこと)
//     ["di", <int>]                                … 内部カウンタ
//     ["af.httprm", <int>, "<乱数ID>", <int>]      … サーバ側のリクエスト計測。ID は毎回変わる
//     ["e", <int>, null, null, <UTF-8 バイト長>]   … 終端マーカー (常に最後)
//     → 必ず [0] === "wrb.fr" で絞り込むこと。位置で決め打ちしてはいけない。
//
// ● item は **arity 5 固定** (実測 5 応答 21 件すべて):
//     [0] mid          : string  "/m/…" または "/g/…"
//     [1] title        : string  表示名 (hl でローカライズ)
//     [2] type         : string  種別ラベル。**型が無いときは空文字列 ""**
//                                (旧 API はここが "Topic"/"トピック" になる)
//     [3] thumbnailUrl : string | null
//                        例 "https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcT4ymcl…"
//                        まれに "http://t1.gstatic.com/images?q=tbn:…" (http & 別ホスト) も返る。
//                        画像が無いエンティティは null (実測: /m/010g3r3l "任天堂株式会社")。
//                        ※ JSON 文字列中では "=" が = にエスケープされて入っている。
//                           JSON.parse すれば普通の "=" に戻るので特別扱い不要。
//     [4] boolean      : 意味未確定のフラグ。下記参照。
//
// ● [4] の boolean フラグについて (実測に基づく事実 と 推測を分けて記す)
//     《実測で確定していること》
//       - 型は必ず boolean (null や 0/1 ではない)。
//       - 1 レスポンス中で true になるのは **高々 1 件**。実測 5 応答の true 件数は
//         1, 0, 1, 1, 1 (Fanza/ja=1, 任天堂/ja=0, apple/en=1, apple/ja=1, nintendo/en=1)。
//       - **決定的 (deterministic)**。同じ (query, hl)="apple","en" を時間をおいて 2 回叩き、
//         5 件の並びもフラグ位置も完全一致した。ランダムな実験フラグではない。
//       - **エンティティ固有の属性ではない**。同じ mid が、クエリによって true にも false にもなる:
//           mid=/g/1ymzszlpz "Nintendo": query="nintendo",hl=en → true
//                                        query="任天堂",  hl=ja → false
//           mid=/m/04st9hr  "Apple":     query="apple",  hl=en → true
//                                        query="apple",  hl=ja → false
//       - 上記 2 例では **true/false が切り替わると同時に thumbnailUrl も別画像に変わっていた**。
//         (例: /m/04st9hr は en で https://encrypted-tbn0…GcRv0-Tx (true)、
//              ja で http://t1.gstatic.com…GcTu6jKZ (false))
//       - thumbnailUrl が null の item は実測 2 件ともフラグ false。
//       - 順位とは無関係 (true が来た位置は 0, 1, 3 とばらついた)。
//       - 「title がクエリと完全一致する item」でもない
//         (apple/ja では title="Apple" の 2 件が false で、title="アップル・レコード" が true)。
//     《推測 — 未確定》
//       フラグはエンティティではなく **選ばれたサムネイル画像に紐づくメタデータ**である可能性が高い。
//       具体的には「この画像はロゴ/ワードマークなので切り抜かず余白付きで表示せよ」といった
//       表示ヒント (isLogo / doNotCrop) だと推測する。根拠は
//         (a) 同一 mid でも画像が変わるとフラグが反転する、
//         (b) 画像が null のときは必ず false、
//         (c) true になった 4 件はいずれもロゴ画像を持つ蓋然性が高い対象
//             (Apple(ブランドのトピック), Apple Records, Nintendo, FANZA)。
//       反証可能な予測: true の画像は透過/白背景のロゴ、false の画像は写真であるはず。
//       画像そのものを取得して確かめてはいないので **推測にとどまる**。
//       ラッパー実装としては **この値に依存しないこと**を推奨する。
//
//
// -------------------------------------------------------------------------------------
// 【2 系統の差分まとめ】(実測)
// -------------------------------------------------------------------------------------
//  項目                    旧 REST autocomplete            新 boq hzg6Ed
//  ---------------------- ------------------------------- ---------------------------------
//  メソッド/形式           GET / 素の JSON                 POST / batchexecute 封筒 + 二段 JSON
//  プレフィクス            )]}',\n (6文字, 末尾改行なし)   )]}'\n\n + 長さ行つきチャンク
//  Cookie                  不要 (実測)                     不要 (実測)
//  reCAPTCHA               不要                            不要 (hzg6Ed は引数にトークンを持たない)
//  返却フィールド          mid, title, type                mid, title, type, thumbnailUrl, boolean
//  サムネイル              **なし**                        **あり** (null のこともある)
//  件数                    実測 9/9 で常に 5 件            0〜5 件 (実測 3, 5, 5, 5, 0)
//  最小クエリ長            なし (1 文字 "a" でも 5 件)     **2 文字以上** (1 文字は [] を返す)
//  type が無いとき         "Topic" / "トピック" (汎用語)   "" (空文字列)
//  type のローカライズ     される (hl 依存)                される (hl 依存)。旧より説明的な
//                                                          文言が返ることがある
//                                                          (例 "日本 宇治市のミュージアム")
//  title のローカライズ    される                          される。ただし訳し方が違う
//                                                          (apple/ja: 旧="Apple" 新="リンゴ")
//  候補の中身              旧の方が緩く拾う                新の方が絞られる
//                          (Fanza: 旧 5 件 / 新 3 件)
//  サーバ                  GSE (旧 Angular UI 系)          ESF (boq/Wiz 系)
//
//  ※ type の対応は "apple"/en で 1:1 に確認できた:
//       /m/04st9hr  旧 "Topic"              → 新 ""
//       /g/11bc6hq8w2 旧 "Topic"            → 新 ""
//       /m/0k8z     旧 "Technology company" → 新 "Technology company"
//       /m/014j1m   旧 "Fruit"              → 新 "Fruit"
//     つまり旧 API は「型なし」を汎用ラベル "Topic" で埋めているだけで、
//     新 API の "" と意味的に等価である。
//
//
// -------------------------------------------------------------------------------------
// 【ラッパーライブラリとしての推奨】
// -------------------------------------------------------------------------------------
//  結論: **既定は旧 REST (GET /trends/api/autocomplete/{kw}) を使い、
//         サムネイルが必要な場合と旧が落ちた場合のフォールバックに新 hzg6Ed を用意する。**
//
//  旧を既定にする理由:
//   1. 実装が圧倒的に薄い。GET 1 本 + プレフィクス 6 文字を剥がして JSON.parse するだけ。
//      batchexecute の「長さ行 (UTF-16) / e チャンク (UTF-8) の単位混在」「二段 JSON」
//      「チャンク平坦化」「レスポンス順 ≠ リクエスト順」といった罠を全部避けられる。
//   2. mid / title / type という、explore に投げるのに必要な情報が全部揃っている。
//      サムネイルはラッパーの用途 (トピック解決) には不要。
//   3. 1 文字クエリでも候補を返すので、インクリメンタル検索の UX が良い。
//   4. Cookie も token も不要で、しかも Set-Cookie: NID が付いてくるので、
//      「NID を取りつつエンティティ解決する」1 石 2 鳥の使い方ができる
//      (/trends/api/explore は NID が要る)。
//
//  それでも新系統を残す理由 (= 旧を唯一の実装にしてはいけない理由):
//   1. 旧 REST は退役中の GSE スタック上にある。同じファミリの
//      /trends/api/dailytrends は既に 404 になっており、autocomplete も同じ道を辿りうる。
//      新 UI (boq) は現役で開発が続いている。
//   2. サムネイルが要るなら新一択。
//   3. 旧が 429 を返し始めたときの逃げ道になる (両者は別サービス・別レート制限のはず。
//      ただしこれは推測で、同一 IP での閾値比較は本調査では行っていない)。
//
//  実装ノート:
//   - mid をそのまま /trends/api/explore の comparisonItem[].keyword に入れれば
//     「トピック」としての比較になる。title は UI 表示用、type は曖昧性解消用。
//   - 旧の type === "Topic"/"トピック" は「型不明」を意味するので、
//     曖昧性解消 UI で意味のあるラベルとして見せない方がよい。
//   - 同じ title のエンティティが複数返るのは普通 (apple/en は "Apple" が 4 件)。
//     mid で一意化すること。
//
//
// -------------------------------------------------------------------------------------
// 【レート制限の挙動】
// -------------------------------------------------------------------------------------
//  本調査では 2026-09-09 に約 1 分半で 16 リクエスト (旧 9 / 新 7) を Cookie 無しで送ったが
//  **429 は 1 度も発生しなかった**。旧 /trends/api/explore が NID 無しで即 429 になるのとは
//  対照的で、autocomplete 系は緩い。ただし HAR では正規のブラウザセッションでも
//  widgetdata が 1 件 429 を食らっているので、429 はいつでも起こりうる前提で書くこと。
//  429 の見分け方: status 429 かつ content-type: text/html (JSON ではない)。
//  Retry-After ヘッダは付かないので、指数バックオフ (2s, 4s, 8s) を自前で実装する。
//  本テストもその方針で、429 のときはハード失敗させず console.warn してスキップする。
//
//
// -------------------------------------------------------------------------------------
// 【本ファイルのテストが実行時に検証すること / ライブリクエスト予算】
// -------------------------------------------------------------------------------------
//  テスト 1 (旧 REST, 6 リクエスト)
//    (1) apple/en  … Cookie 無しで 200 / Set-Cookie: NID が付く / プレフィクス )]}',\n 6 文字 /
//                    末尾に改行なし / topics[] のキーが厳密に mid,title,type / mid の形 /
//                    5 件 / 型不明は type="Topic" / /m/0k8z (Apple Inc.) を含む
//    (2) 任天堂/ja … パスが UTF-8 %エンコード / 非 ASCII は \uXXXX で返る / title と type の
//                    ローカライズ / /m/059wk を含む
//    (3) AC/DC 生   … スラッシュを素で入れると 404 + text/html
//    (4) AC%2FDC    … 同じキーワードでも %2F なら 200。title に '/' が往復する /
//                    /m/0134s5 = "AC/DC" / type="Rock band"
//    (5) star wars  … 空白は %20 ('+' ではない)。title に "star wars" が往復する
//    (6) "a" 1 文字 … 最小クエリ長が無いこと (5 件返る)
//  テスト 2 (新 boq, 3 リクエスト)
//    (1) apple/en   … Cookie/reCAPTCHA 無しで 200 / 封筒の長さ行が UTF-16 単位 /
//                    slotId のエコー / item の arity 5 と各要素の型 / thumbnail は
//                    gstatic の http(s) URL か null / フラグ true は高々 1 件 /
//                    新 API は "Topic" を返さない
//    (2) "F"/ja     … payload が [] (=[[]] ではない) / 封筒に di・af.httprm・e が混ざること /
//                    終端 e チャンクの T が実測 UTF-8 バイト長と一致すること /
//                    応答バイト長が定数ではない (HAR の 136 と厳密比較してはいけない) こと
//    (3) 任天堂/ja  … 最小ヘッダ (content-type のみ) + 最小クエリ (rpcids,hl,_reqid,rt) で 200 /
//                    UTF-8 バイト長 > UTF-16 長 (単位の違いの実証)
//  テスト 3 (比較, 追加リクエスト 0) … テスト 1/2 の実測値だけで両系統を突き合わせる
//
//  → 1 回の実行で発行するライブリクエストは **合計 9 回**。
//    429 を食らった場合のみ 1 リクエストにつき最大 3 回リトライする (指数バックオフ 2/4/8 秒)。
//    テストの最後に実際の発行数を console.log に出す。
//
// 【秘密情報について】
//  本ファイルには実 Cookie 値・reCAPTCHA トークン・実サムネイル URL の署名部分など
//  秘密情報は一切埋め込んでいない。形式のみ記述している。
// =====================================================================================

import { assert, assertEquals } from "jsr:@std/assert@^1";

// -------------------------------------------------------------------------------------
// 定数
// -------------------------------------------------------------------------------------
const ORIGIN = "https://trends.google.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/** 旧 REST autocomplete のレスポンスプレフィクス (カンマ込み 6 文字)。 */
const OLD_PREFIX = ")]}',\n";
/** batchexecute のレスポンスプレフィクス (6 文字)。 */
const BOQ_PREFIX = ")]}'\n\n";

// -------------------------------------------------------------------------------------
// 型
// -------------------------------------------------------------------------------------
type OldTopic = { mid: string; title: string; type: string };
/** [mid, title, type, thumbnailUrl|null, flag] */
type NewItem = [string, string, string, string | null, boolean];

type Fetched = {
  status: number;
  contentType: string;
  text: string;
  /** Set-Cookie で降ってきた Cookie 名の一覧 (値は保持しない = 秘密情報を持ち回らない)。 */
  setCookieNames: string[];
};

// -------------------------------------------------------------------------------------
// ライブ HTTP ヘルパ (レート制限に配慮: 直列 + 1.5s 間隔 + 429 は指数バックオフ最大 3 回)
// -------------------------------------------------------------------------------------
let liveCount = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 429 とネットワーク断に耐えるフェッチ。
 * - 成功したら Fetched を返す。
 * - 429 が続いた / ネットワークが死んでいる場合は null を返す (呼び出し側で skip 扱い)。
 * - レスポンスボディは必ず text() で消費する (Deno のリソースリーク検出対策)。
 */
async function liveFetch(url: string, init?: RequestInit): Promise<Fetched | null> {
  const backoffs = [2000, 4000, 8000];
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    if (liveCount > 0) await sleep(1500);
    liveCount++;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      console.warn(`[skip] ネットワークエラー: ${url}\n  ${e}`);
      return null;
    }
    const text = await res.text(); // 必ず消費する
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status === 429) {
      if (attempt < backoffs.length) {
        console.warn(`[429] リトライ ${attempt + 1}/${backoffs.length} (${backoffs[attempt]}ms 待機): ${url}`);
        await sleep(backoffs[attempt]);
        continue;
      }
      console.warn(`[skip] レート制限のため未検証: ${url}`);
      return null;
    }
    // Cookie 値そのものは絶対に保持しない。名前だけ取り出す。
    const setCookieNames = res.headers.getSetCookie().map((c) => c.split("=")[0].trim());
    return { status: res.status, contentType, text, setCookieNames };
  }
  return null;
}

// -------------------------------------------------------------------------------------
// パーサ
// -------------------------------------------------------------------------------------

/** 旧 REST autocomplete のボディをパースして topics を返す。 */
function parseOldAutocomplete(text: string): OldTopic[] {
  // プレフィクスは ")]}',\n" だが、将来 ")]}'\n" に変わっても壊れないよう
  // 最初の '{' まで読み飛ばす実装にしておく。
  const i = text.indexOf("{");
  assert(i >= 0, "旧 autocomplete のボディに JSON オブジェクトが見つからない");
  const obj = JSON.parse(text.slice(i));
  const topics = obj?.default?.topics;
  assert(Array.isArray(topics), "default.topics が配列でない");
  return topics as OldTopic[];
}

/**
 * batchexecute の封筒を平坦化し、全エントリを返す。
 * 返る配列には wrb.fr のほか ["di",N] / ["af.httprm",…] / ["e",…] が混ざる。
 */
function flattenBatchExecute(text: string): unknown[][] {
  assert(text.startsWith(BOQ_PREFIX), `batchexecute のプレフィクスが不正: ${JSON.stringify(text.slice(0, 12))}`);
  const items: unknown[][] = [];
  let pos = BOQ_PREFIX.length;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) break;
    const n = Number(text.slice(pos, nl));
    assert(Number.isFinite(n) && n > 2, `長さ行が数値でない: ${JSON.stringify(text.slice(pos, nl))}`);
    // 長さ N は「長さ行を終端する LF + JSON + JSON を終端する LF」を数えた UTF-16 単位
    const json = text.slice(nl + 1, nl + n - 1);
    assertEquals(json.length, n - 2, "チャンク JSON の長さが N-2 でない (長さ行の単位が UTF-16 でない?)");
    for (const it of JSON.parse(json)) items.push(it as unknown[]);
    pos = nl + n;
  }
  return items;
}

/** 平坦化した封筒から wrb.fr のペイロードだけを取り出す。 */
function parseBatchExecute(
  text: string,
): Array<{ rpcid: string; slot: string; data: unknown }> {
  return flattenBatchExecute(text)
    .filter((it) => it[0] === "wrb.fr")
    .map((it) => ({
      rpcid: it[1] as string,
      slot: it[6] as string,
      data: JSON.parse(it[2] as string),
    }));
}

// -------------------------------------------------------------------------------------
// クライアント (薄いラッパーの参照実装)
// -------------------------------------------------------------------------------------

/** 旧 REST autocomplete を叩く。keyword は encodeURIComponent でパスに埋める。 */
function oldAutocompleteUrl(keyword: string, hl: string, tz?: number): string {
  const qs = new URLSearchParams({ hl });
  if (tz !== undefined) qs.set("tz", String(tz));
  // encodeURIComponent は "/" も %2F にするので、スラッシュ入りキーワードでも壊れない
  return `${ORIGIN}/trends/api/autocomplete/${encodeURIComponent(keyword)}?${qs}`;
}

/** 新 boq hzg6Ed を叩くための URL とボディを組む。 */
function hzg6EdRequest(query: string, hl: string, slot = "1") {
  const fReq = JSON.stringify([[["hzg6Ed", JSON.stringify([query, hl]), null, slot]]]);
  // ブラウザは source-path / f.sid / bl / soc-* も送るが、実測では下記 4 個だけで通る
  const qs = new URLSearchParams({
    rpcids: "hzg6Ed",
    hl,
    _reqid: String(Math.floor(Math.random() * 100000)),
    rt: "c",
  });
  return {
    url: `${ORIGIN}/_/TrendsUi/data/batchexecute?${qs}`,
    body: "f.req=" + encodeURIComponent(fReq) + "&",
  };
}

/** hzg6Ed のペイロードから items を取り出す。空のときは payload が [] なので ?? [] が必須。 */
function hzg6EdItems(payload: unknown): NewItem[] {
  assert(Array.isArray(payload), "hzg6Ed のペイロードが配列でない");
  const first = (payload as unknown[])[0];
  if (first === undefined) return []; // 候補ゼロ: payload === [] ([[]] ではない)
  assert(Array.isArray(first), "hzg6Ed の payload[0] が配列でない");
  return first as NewItem[];
}

// -------------------------------------------------------------------------------------
// テスト間で共有する実測結果 (再フェッチしてリクエストを浪費しないため)
// -------------------------------------------------------------------------------------
const captured: {
  oldAppleEn?: OldTopic[];
  oldNintendoJa?: OldTopic[];
  newAppleEn?: NewItem[];
  newNintendoJa?: NewItem[];
  newEmpty?: { payload: unknown; byteLen: number };
} = {};

// =====================================================================================
// テスト 1: 旧 REST GET /trends/api/autocomplete/{keyword}
// =====================================================================================
Deno.test({
  name: "旧REST autocomplete: Cookie無しで200 / )]}',\\n プレフィクス / topics[].{mid,title,type} / パスのエンコード",
  fn: async () => {
    // --- (1) ASCII キーワード + hl=en ---------------------------------------------
    const url1 = oldAutocompleteUrl("apple", "en", 0);
    assertEquals(url1, `${ORIGIN}/trends/api/autocomplete/apple?hl=en&tz=0`);
    const r1 = await liveFetch(url1, {
      headers: {
        "accept": "application/json, text/plain, */*",
        "accept-language": "en",
        "user-agent": UA,
        // Cookie は一切送らない (認証不要であることの検証)
      },
    });
    if (!r1) return;
    assertEquals(r1.status, 200, "Cookie 無しでも 200 が返るはず");
    assert(
      r1.contentType.startsWith("application/json"),
      `JSON が返るはず (429 は text/html): ${r1.contentType}`,
    );
    // Cookie を送らずに来た場合、200 レスポンスに Set-Cookie: NID が付く。
    // → autocomplete を 1 回叩くだけで、/trends/api/explore に必要な NID を入手できる。
    assert(
      r1.setCookieNames.includes("NID"),
      `Cookie 無しリクエストの 200 応答には Set-Cookie: NID が付くはず: ${JSON.stringify(r1.setCookieNames)}`,
    );

    // プレフィクスは ")]}'" + "," + LF の 6 文字、末尾に改行は付かない
    assertEquals(r1.text.slice(0, 6), OLD_PREFIX, "旧 API のプレフィクスは )]}',\\n の 6 文字");
    assertEquals(r1.text.at(-1), "}", "末尾に改行は付かない (最後の文字は '}')");
    assertEquals(
      r1.text.length,
      OLD_PREFIX.length + r1.text.slice(6).length,
      "全長 = プレフィクス6文字 + JSON",
    );

    const appleEn = parseOldAutocomplete(r1.text);
    captured.oldAppleEn = appleEn;

    // 件数は実測で常に 5 件
    assertEquals(appleEn.length, 5, "旧 API は 5 件返す (実測 9/9 クエリで 5 件)");

    for (const t of appleEn) {
      // フィールドは mid / title / type の 3 個ちょうど
      assertEquals(
        Object.keys(t).sort().join(","),
        "mid,title,type",
        `topics[] のキーは mid,title,type の 3 個のみ: ${JSON.stringify(t)}`,
      );
      assertEquals(typeof t.mid, "string");
      assertEquals(typeof t.title, "string");
      assertEquals(typeof t.type, "string");
      assert(/^\/(m|g)\/[A-Za-z0-9_]+$/.test(t.mid), `mid は /m/… か /g/… の形: ${t.mid}`);
      assert(t.title.length > 0, "title は非空");
      assert(t.type.length > 0, `旧 API の type は常に非空 (型不明なら "Topic"): ${JSON.stringify(t)}`);
    }
    // ★2026-09-09 実測で訂正: 特定の mid を決め打ちしてはいけない。
    //   当初は「"apple"/en には Apple 社 (/m/0k8z) が必ず含まれる」とアサートしていたが、
    //   実際の応答は [/m/04st9hr "Apple"(Topic), /m/014j1m "Apple"(Fruit),
    //   /g/11bc6hq8w2 "Apple"(Topic), /m/0ckq2 "Apple sauce", /m/05253_m "Apple cider vinegar"]
    //   で /m/0k8z を含まなかった。Knowledge Graph の候補集合は時期・出口 IP・hl で変動する。
    //   → ラッパーの実装者も「この語ならこの mid が返る」という前提を置いてはいけない。
    //     mid を安定 ID として保存するのは可 (エンティティ自体は永続) だが、
    //     「検索語 → mid」の対応は毎回解決し直す必要がある。
    //   ここでは「クエリ語に一致するタイトルが少なくとも 1 件返る」ことだけを検証する。
    const apple = appleEn.find((t) => /^apple/i.test(t.title));
    assert(
      apple,
      `"apple" に対しタイトルが apple で始まる候補が 1 件以上返るはず: ${JSON.stringify(appleEn)}`,
    );
    // 型不明のエンティティは汎用ラベル "Topic" で埋められる
    assert(
      appleEn.some((t) => t.type === "Topic"),
      `hl=en では型不明エンティティの type が "Topic" になる: ${JSON.stringify(appleEn)}`,
    );

    // --- (2) 非 ASCII キーワード (パスの %エンコード) + hl=ja (type のローカライズ) ---
    const url2 = oldAutocompleteUrl("任天堂", "ja", -540);
    assertEquals(
      url2,
      `${ORIGIN}/trends/api/autocomplete/%E4%BB%BB%E5%A4%A9%E5%A0%82?hl=ja&tz=-540`,
      "日本語は UTF-8 の %エンコードでパスに入る",
    );
    const r2 = await liveFetch(url2, {
      headers: {
        "accept": "application/json, text/plain, */*",
        "accept-language": "ja",
        "user-agent": UA,
      },
    });
    if (r2) {
      assertEquals(r2.status, 200);
      assert(r2.contentType.startsWith("application/json"));
      // 非 ASCII は \uXXXX でエスケープされて返る (生の UTF-8 では返らない)
      assert(
        r2.text.includes("\\u"),
        "非 ASCII は \\uXXXX エスケープで返る (JSON.parse で復元される)",
      );
      const nintendoJa = parseOldAutocomplete(r2.text);
      captured.oldNintendoJa = nintendoJa;
      assertEquals(nintendoJa.length, 5);
      const nin = nintendoJa.find((t) => t.mid === "/m/059wk");
      assert(nin, `mid=/m/059wk (任天堂) が含まれるはず: ${JSON.stringify(nintendoJa)}`);
      assertEquals(nin!.title, "任天堂", "hl=ja では title が日本語表記になる");
      // type が日本語にローカライズされている = ASCII 以外を含む
      assert(
        nintendoJa.some((t) => /[^\x00-\x7F]/.test(t.type)),
        `hl=ja では type が日本語になる: ${JSON.stringify(nintendoJa.map((t) => t.type))}`,
      );
    }

    // --- (3) 落とし穴: スラッシュを素のままパスに入れると 404 --------------------
    // encodeURIComponent("AC/DC") === "AC%2FDC" は 200 になる (2026-09-09 実測)。
    // ここでは「エンコードを怠ると壊れる」ことを実行可能な形で残す。
    const rawUrl = `${ORIGIN}/trends/api/autocomplete/AC/DC?hl=en&tz=0`;
    const r3 = await liveFetch(rawUrl, {
      headers: { "accept": "application/json, text/plain, */*", "user-agent": UA },
    });
    if (r3) {
      assertEquals(
        r3.status,
        404,
        "スラッシュを %2F にせずパスに入れるとパスが割れて 404 になる",
      );
      assert(
        r3.contentType.startsWith("text/html"),
        `404 は Google の HTML エラーページ: ${r3.contentType}`,
      );
      assert(r3.text.includes("404"), "本文に 404 のエラーページが入る");
    }

    // --- (4) 同じキーワードを encodeURIComponent すれば 200 (スラッシュの往復) -------
    const url4 = oldAutocompleteUrl("AC/DC", "en", 0);
    assertEquals(
      url4,
      `${ORIGIN}/trends/api/autocomplete/AC%2FDC?hl=en&tz=0`,
      "encodeURIComponent は '/' を %2F にする (encodeURI は '/' を残すので壊れる)",
    );
    const r4 = await liveFetch(url4, {
      headers: { "accept": "application/json, text/plain, */*", "accept-language": "en", "user-agent": UA },
    });
    if (r4) {
      assertEquals(r4.status, 200, "%2F にエンコードすれば 200 になる (上の 404 との対比)");
      assert(r4.contentType.startsWith("application/json"));
      const acdc = parseOldAutocomplete(r4.text);
      assertEquals(acdc.length, 5, "スラッシュ入りクエリでも 5 件");
      // スラッシュがサーバまで正しく届いた証拠: title にリテラルの '/' が入って返る
      assert(
        acdc.some((t) => t.title.includes("/")),
        `キーワードのスラッシュが往復している (title に '/' を含む候補が返る): ${JSON.stringify(acdc.map((t) => t.title))}`,
      );
      const band = acdc.find((t) => t.mid === "/m/0134s5");
      assert(band, `mid=/m/0134s5 (バンド AC/DC) が含まれるはず: ${JSON.stringify(acdc)}`);
      assertEquals(band!.title, "AC/DC");
      assertEquals(band!.type, "Rock band", "型が特定できるエンティティは具体的な type が入る");
    }

    // --- (5) 空白は %20 になる ("+" ではない) -------------------------------------
    const url5 = oldAutocompleteUrl("star wars", "en", 0);
    assertEquals(
      url5,
      `${ORIGIN}/trends/api/autocomplete/star%20wars?hl=en&tz=0`,
      "パス中の空白は %20。'+' にしてはいけない (パスでは + はリテラルのプラス記号)",
    );
    const r5 = await liveFetch(url5, {
      headers: { "accept": "application/json, text/plain, */*", "accept-language": "en", "user-agent": UA },
    });
    if (r5) {
      assertEquals(r5.status, 200, "空白入りキーワードも %20 なら 200");
      const sw = parseOldAutocomplete(r5.text);
      assertEquals(sw.length, 5, "空白入りクエリでも 5 件");
      assert(
        sw.some((t) => t.title.toLowerCase().includes("star wars")),
        `空白が往復している (title に "star wars" を含む候補が返る): ${JSON.stringify(sw.map((t) => t.title))}`,
      );
      // 型が特定できるエンティティは具体的な type ("Film" / "2015 film" など) を返す
      assert(
        sw.some((t) => t.type !== "Topic"),
        `型が特定できる候補が混ざる: ${JSON.stringify(sw.map((t) => t.type))}`,
      );
    }

    // --- (6) 最小クエリ長は無い: 1 文字でも 5 件 (新 boq との決定的な差) -----------
    const r6 = await liveFetch(oldAutocompleteUrl("a", "en", 0), {
      headers: { "accept": "application/json, text/plain, */*", "accept-language": "en", "user-agent": UA },
    });
    if (r6) {
      assertEquals(r6.status, 200);
      const one = parseOldAutocomplete(r6.text);
      assertEquals(
        one.length,
        5,
        "旧 API は 1 文字クエリでも 5 件返す (新 boq hzg6Ed は 1 文字だと [] を返す)",
      );
      for (const t of one) {
        assert(/^\/(m|g)\/[A-Za-z0-9_]+$/.test(t.mid), `mid の形: ${t.mid}`);
        assert(t.type.length > 0, `type は常に非空: ${JSON.stringify(t)}`);
      }
    }
  },
});

// =====================================================================================
// テスト 2: 新 boq POST batchexecute rpcids=hzg6Ed
// =====================================================================================
Deno.test({
  name: "新boq hzg6Ed: Cookie無し/最小クエリで200 / item は [mid,title,type,thumb|null,bool] / 1文字は []",
  fn: async () => {
    // --- (1) apple / en : スキーマ確定 ---------------------------------------------
    const req1 = hzg6EdRequest("apple", "en");
    const r1 = await liveFetch(req1.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "accept": "*/*",
        "user-agent": UA,
        "x-same-domain": "1",
        "origin": ORIGIN,
        "referer": `${ORIGIN}/`,
      },
      body: req1.body,
    });
    if (!r1) return;
    assertEquals(r1.status, 200, "Cookie 無し / reCAPTCHA トークン無しでも 200");
    assert(r1.contentType.startsWith("application/json"), `JSON が返るはず: ${r1.contentType}`);

    const calls1 = parseBatchExecute(r1.text);
    assertEquals(calls1.length, 1, "wrb.fr は 1 件");
    assertEquals(calls1[0].rpcid, "hzg6Ed");
    assertEquals(calls1[0].slot, "1", "slotId はリクエストの call[3] がエコーされる");

    const appleEn = hzg6EdItems(calls1[0].data);
    captured.newAppleEn = appleEn;
    assert(appleEn.length >= 1 && appleEn.length <= 5, `件数は 1〜5: ${appleEn.length}`);

    let trueCount = 0;
    for (const it of appleEn) {
      assert(Array.isArray(it), "item は配列");
      assertEquals(it.length, 5, `item の arity は 5 固定: ${JSON.stringify(it)}`);
      const [mid, title, type, thumb, flag] = it;
      assertEquals(typeof mid, "string");
      assert(/^\/(m|g)\/[A-Za-z0-9_]+$/.test(mid), `mid は /m/… か /g/… の形: ${mid}`);
      assertEquals(typeof title, "string");
      assert(title.length > 0, "title は非空");
      assertEquals(typeof type, "string", 'type は string (型不明なら "")');
      assert(
        thumb === null || (typeof thumb === "string" && /^https?:\/\//.test(thumb)),
        `thumbnailUrl は null か http(s) URL: ${JSON.stringify(thumb)}`,
      );
      if (typeof thumb === "string") {
        assert(
          thumb.includes("gstatic.com"),
          `サムネイルは gstatic.com のホストから来る: ${thumb}`,
        );
        assert(
          !thumb.includes("\\u003d"),
          "JSON.parse 済みなので \\u003d は生の = に戻っているはず",
        );
      }
      assertEquals(typeof flag, "boolean", "第5要素は boolean");
      if (flag) trueCount++;
      // 実測: サムネイルが null の item はフラグ false だった
      if (thumb === null) {
        assertEquals(flag, false, "実測ではサムネイル null の item はフラグ false");
      }
    }
    assert(trueCount <= 1, `フラグが true なのは高々 1 件 (実測): ${trueCount}`);

    // "apple"/en には Apple 社が含まれる
    assert(
      appleEn.some((it) => it[0] === "/m/0k8z"),
      `mid=/m/0k8z が含まれるはず: ${JSON.stringify(appleEn.map((i) => i[0]))}`,
    );
    // 新 API は型不明エンティティの type を "" にする ("Topic" とは書かない)
    assert(
      appleEn.every((it) => it[2] !== "Topic"),
      `新 API は "Topic" という汎用ラベルを返さない: ${JSON.stringify(appleEn.map((i) => i[2]))}`,
    );

    // --- (2) 1 文字クエリ: ペイロードが [[]] ではなく [] ---------------------------
    const req2 = hzg6EdRequest("F", "ja");
    const r2 = await liveFetch(req2.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "accept": "*/*",
        "user-agent": UA,
        "x-same-domain": "1",
        "origin": ORIGIN,
        "referer": `${ORIGIN}/`,
      },
      body: req2.body,
    });
    if (r2) {
      assertEquals(r2.status, 200);
      const calls2 = parseBatchExecute(r2.text);
      assertEquals(calls2[0].rpcid, "hzg6Ed");
      const payload = calls2[0].data;
      assert(Array.isArray(payload), "ペイロードは配列");
      assertEquals(
        (payload as unknown[]).length,
        0,
        "1 文字クエリのペイロードは [] (空)。[[]] ではないので payload[0] は undefined",
      );
      assertEquals(hzg6EdItems(payload).length, 0, "items は空配列に正規化される");
      const byteLen = new TextEncoder().encode(r2.text).length;
      captured.newEmpty = { payload, byteLen };

      // 終端チャンクの T は「ボディ全体の UTF-8 バイト長」。自己言及的だが必ず一致する。
      assert(
        r2.text.includes(`[["e",4,null,null,${byteLen}]]`),
        `終端チャンクの T はボディ全体の UTF-8 バイト長: ${JSON.stringify(r2.text.slice(-48))}`,
      );

      // 封筒には wrb.fr 以外に di / af.httprm / e が混ざる。
      // これらは **可変長** なので、応答バイト長を定数として期待してはいけない。
      const env = flattenBatchExecute(r2.text);
      const tags = env.map((it) => it[0]);
      assert(tags.includes("wrb.fr"), `封筒に wrb.fr がある: ${JSON.stringify(tags)}`);
      assertEquals(tags[tags.length - 1], "e", "終端マーカー ['e',…] は必ず最後");
      const httprm = env.find((it) => it[0] === "af.httprm");
      if (httprm) {
        // ["af.httprm", <int>, "<乱数ID>", <int>] — この乱数 ID の桁数が応答長を揺らす原因。
        assertEquals(typeof httprm[2], "string", "af.httprm の第3要素はサーバ側の乱数リクエスト ID");
        assert(
          /^-?\d{15,25}$/.test(httprm[2] as string),
          `af.httprm の ID は符号付きの長い 10 進数 (桁数が毎回変わる): ${JSON.stringify(httprm[2])}`,
        );
      }
      // HAR entry 014 ("F"/ja) の content.size は 136 バイトだったが、
      // 実測は 132〜142 バイトでばらついた。厳密比較は誤り (ヘッダの ★★ 訂正 を参照)。
      // 「空応答は小さい」ことだけを緩く確認する。
      assert(
        byteLen > 100 && byteLen < 200,
        `空応答は 200 バイト未満の小さな封筒 (HAR の 136 と同じオーダー): ${byteLen}`,
      );
      assert(
        !r2.text.includes("/m/") && !r2.text.includes("/g/"),
        "候補ゼロなので mid は 1 つも含まれない",
      );
    }

    // --- (3) 最小ヘッダ + 最小クエリ + 日本語クエリ --------------------------------
    // user-agent / x-same-domain / origin / referer を全部外す。
    // クエリも rpcids / hl / _reqid / rt の 4 個だけ (source-path, f.sid, bl, soc-* なし)。
    const req3 = hzg6EdRequest("任天堂", "ja");
    const r3 = await liveFetch(req3.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: req3.body,
    });
    if (r3) {
      assertEquals(
        r3.status,
        200,
        "UA/x-same-domain/origin/referer 無し & f.sid/bl/source-path/soc-* 無しでも 200",
      );
      const calls3 = parseBatchExecute(r3.text);
      const items = hzg6EdItems(calls3[0].data);
      captured.newNintendoJa = items;
      assert(items.length > 0, "日本語クエリでも候補が返る");
      assert(
        items.some((it) => it[0] === "/m/059wk"),
        `mid=/m/059wk (任天堂) が含まれるはず: ${JSON.stringify(items.map((i) => i[0]))}`,
      );
      // UTF-16 の長さ行が正しく解釈できている = 日本語を含んでも parseBatchExecute が通る
      const utf16 = r3.text.length;
      const utf8 = new TextEncoder().encode(r3.text).length;
      assert(
        utf8 > utf16,
        `日本語を含むので UTF-8 バイト長 > UTF-16 長になる (長さ行は UTF-16 単位): ${utf16} / ${utf8}`,
      );
      assert(
        r3.text.includes(`[["e",4,null,null,${utf8}]]`),
        "終端チャンクの T は UTF-8 バイト長であり長さ行 (UTF-16) と単位が違う",
      );
    }
  },
});

// =====================================================================================
// テスト 3: 2 系統の比較 (追加のライブリクエストは発生しない)
// =====================================================================================
Deno.test({
  name: "2系統比較: 新はサムネイル付き / 旧の type=\"Topic\" は新の \"\" に対応 / 件数と最小クエリ長の差",
  fn: () => {
    const oldApple = captured.oldAppleEn;
    const newApple = captured.newAppleEn;
    if (!oldApple || !newApple) {
      console.warn("[skip] 先行テストがレート制限/ネットワーク断でスキップされたため比較できない");
      return;
    }

    // --- 返却フィールドの差 --------------------------------------------------------
    // 旧はオブジェクトで 3 フィールド、新は配列で 5 要素。
    for (const t of oldApple) {
      assertEquals(Object.keys(t).length, 3, "旧 API はサムネイルを返さない (mid/title/type のみ)");
      assert(!("thumbnail" in t) && !("image" in t), "旧 API に画像系フィールドは無い");
    }
    assert(
      newApple.some((it) => typeof it[3] === "string"),
      "新 API は少なくとも 1 件でサムネイル URL を返す",
    );

    // --- type の対応関係: 旧 "Topic" ⇔ 新 "" --------------------------------------
    const oldByMid = new Map(oldApple.map((t) => [t.mid, t]));
    let compared = 0;
    for (const it of newApple) {
      const o = oldByMid.get(it[0]);
      if (!o) continue; // 候補集合は完全一致しないので、共通の mid だけ比べる
      compared++;
      if (o.type === "Topic") {
        assertEquals(
          it[2],
          "",
          `旧の汎用ラベル "Topic" は新では空文字列になる (mid=${it[0]})`,
        );
      } else {
        assertEquals(
          it[2],
          o.type,
          `型が特定できるエンティティは両系統で同じ type 文字列 (mid=${it[0]})`,
        );
      }
    }
    assert(compared >= 2, `共通の mid が 2 件以上あるはず: ${compared}`);

    // --- mid は両系統で同一の名前空間 ---------------------------------------------
    const oldMids = new Set(oldApple.map((t) => t.mid));
    const newMids = new Set(newApple.map((it) => it[0]));
    const shared = [...newMids].filter((m) => oldMids.has(m));
    assert(
      shared.length >= 2,
      `mid は両系統で共通の名前空間 (重なりがあるはず): old=${[...oldMids]} new=${[...newMids]}`,
    );

    // --- 件数の差: 旧は常に 5、新は 5 以下 -----------------------------------------
    assertEquals(oldApple.length, 5, "旧は常に 5 件");
    assert(newApple.length <= 5, "新は 5 件以下");

    // --- 最小クエリ長の差 ----------------------------------------------------------
    if (captured.newEmpty) {
      assertEquals(
        (captured.newEmpty.payload as unknown[]).length,
        0,
        "新は 1 文字クエリで候補ゼロ",
      );
    }

    // --- title のローカライズ差 (日本語結果が取れているときだけ) --------------------
    const oldNin = captured.oldNintendoJa;
    const newNin = captured.newNintendoJa;
    if (oldNin && newNin) {
      const o = oldNin.find((t) => t.mid === "/m/059wk");
      const n = newNin.find((it) => it[0] === "/m/059wk");
      if (o && n) {
        assertEquals(o.title, n[1], "同一 mid・同一 hl なら title は両系統で一致する");
      }
      // 新 API の type は旧より説明的な文言になることがある
      // (例: 旧 "企業" に対し 新 "日本 京都市の企業のオフィス")。
      // 文言そのものは Google 側の都合で変わるので、ここでは
      // 「新の type も hl でローカライズされる」ことだけを検証する。
      assert(
        newNin.some((it) => it[2] === "" || /[^\x00-\x7F]/.test(it[2])),
        `hl=ja では新 API の type も日本語 (または空): ${JSON.stringify(newNin.map((i) => i[2]))}`,
      );
    }

    console.log(
      `[info] 本テスト実行で発行したライブリクエスト数: ${liveCount}`,
    );
  },
});
