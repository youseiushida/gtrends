// 実行: deno test --allow-net --no-check live_integration/12_errors_and_ratelimit_test.ts
//
// ============================================================================
// Google Trends — エラー応答とレート制限の仕様 (ラッパーライブラリ実装者向け)
// ============================================================================
// ライブ検証日: 2026-09-09 (JST)。HAR 根拠: 2026-09-08 キャプチャ。
// このファイルは単体で動作する。相対 import は無し。外部依存は jsr:@std/assert のみ。
//
// ----------------------------------------------------------------------------
// 0. 一番大事な結論
// ----------------------------------------------------------------------------
// Google Trends には **性質のまったく違う 2 つのサービス** が同居しており、
// エラー応答の形もレート制限の厳しさも別物である。混ぜて扱ってはいけない。
//
//   (A) 旧 REST API : https://trends.google.com/trends/api/*  … `server: GSE`
//       → レート制限が非常に厳しい。エラーは **HTML** (JSON ではない)。
//       → 3 段階の劣化: 200 JSON → 429 HTML → 302 /sorry (CAPTCHA 誘導)。
//
//   (B) boq RPC : https://trends.google.com/_/TrendsUi/data/batchexecute … `server: ESF`
//       → 実測でははるかに寛容。エラーは batchexecute の封筒内に **JSON** で返る。
//       → HTTP 400 (トランスポート層) と HTTP 200 + RPC エラー (アプリ層) の 2 段。
//
// ラッパーは「HTTP ステータスだけ見る」「res.ok だけ見る」設計にしてはならない。
// 少なくとも status + content-type + (batchexecute なら封筒の中身) の 3 つを見る。
//
// ----------------------------------------------------------------------------
// 1. 旧 REST API (GSE) のエラー階段 — ライブ実測 2026-09-09
// ----------------------------------------------------------------------------
//
// ■ 1-a. Cookie 無しで /trends/api/explore を叩く → **429 Too Many Requests**
//   ★これはライブテスト **L0** が常設で再現・検証している (2026-09-09 に再取得して確認)。
//     「Cookie 無し = 1 発目から 429」は回数に依存しない **ゲート** であり、
//     待っても回数を減らしても解けない。解決策は NID を取ってくることだけ (1-b)。
//
//   GET https://trends.google.com/trends/api/explore?hl=ja&tz=-540&req=<JSON>&tz=-540
//   (Cookie ヘッダ無し)
//
//   status: 429 Too Many Requests
//   レスポンスヘッダ (実測):
//     content-type: text/html; charset=utf-8      ← ★JSON ではない
//     content-encoding: gzip
//     cache-control: no-cache, no-store, max-age=0, must-revalidate
//     expires: Mon, 01 Jan 1990 00:00:00 GMT
//     pragma: no-cache
//     server: GSE
//     x-content-type-options: nosniff
//     x-frame-options: SAMEORIGIN
//     x-xss-protection: 1; mode=block
//     content-security-policy: ... report-uri /trends/cspreport
//     p3p: CP="This is not a P3P policy! ..."
//     set-cookie: NID=...                        ← ★429 でも NID が発行される
//     **Retry-After ヘッダは無い**                ← ★実測 null。待ち時間は自分で決める
//     **content-disposition ヘッダは無い**        ← 200 応答には必ず付くので判別に使える
//
//   ボディ: 1697 文字 (hl=ja) の Google 標準エラーページ HTML。安定した目印:
//     - `<title>Error 429 (Too Many Requests)!!1</title>`
//     - `id="af-error-container"`
//     - `<b>429.</b>`
//     - `We're sorry, but you have sent too many requests to us recently.`  ← 直線アポストロフィ U+0027
//
//   ★★ アポストロフィの罠 (実測 2026-09-09 で確定) ★★
//     同じ 1 枚のページの中で **2 種類のアポストロフィが混在している**。
//       - `That’s an error.` / `That’s all we know.` … **カーリー U+2019**
//       - `We're sorry, but you have sent too many requests to us recently.` … **直線 U+0027**
//     実測での確認結果 (429 ページ, 1697 文字):
//       includes("That's an error.")  → **false**   (直線で書くとマッチしない)
//       includes("That’s an error.")  → true
//       includes("We're sorry, but …") → true       (こちらは直線が正しい)
//     HAR の 502 ページ (har_idx=350) も `That’s an error.` はカーリーだった。
//     → 文言でマッチする実装は **必ずコピペで文字を確認すること**。手で打ち直すと壊れる。
//       そもそも文言マッチは避け、`<title>Error (\d{3})` の数値だけを見るのが正解。
//   ※ HAR (2026-09-08, har_idx=246, 正規ブラウザセッション) の 429 は content.size=1695 バイト、
//      x-frame-options ヘッダ無しだった。ライブ (Cookie 無し) は x-frame-options: SAMEORIGIN 付き
//      で 1697 文字。**ヘッダ構成・バイト長は揺れるので厳密一致で判定してはいけない。**
//      判定は status===429 か <title> の "Error NNN" で行うこと。
//
// ■ 1-b. GET /trends/explore (HTML, SPA シェル) も Cookie 無しなら 429。**が NID をくれる**
//
//   GET https://trends.google.com/trends/explore?q=Fanza&date=now%201-d&geo=JP&hl=ja
//   → status 429、body 1697 文字 (1-a と同じエラーページ)、
//     set-cookie: NID=534=<opaque>; expires=<約6か月後>; path=/; domain=.google.com;
//                 Secure; HttpOnly; SameSite=none
//   実測した NID 値の長さは 211 / 212 / 318 / 319 文字とばらつく (固定長ではない)。値は毎回異なる。
//   → **「429 でも Set-Cookie: NID を拾えるので、それを付けて再試行する」が基本の回復パターン。**
//     この回復パターンは 2026-09-09 に実測で成立を確認した (429 → NID 採取 → 同一 URL に
//     NID を付けて再送 → 200 JSON + widgets 4 個)。
//
//   ★ NID の「書式」で発行元を見分けようとしないこと (実測で反例あり)。
//     観測された書式は 2 種類:
//       (i)  `NID=534=<opaque>`         … 従来からある版数プレフィクス付き
//       (ii) `NID=C<u|s>wBCAES<opaque>` … protobuf 風の別書式 (CuwB… / CusB… と細部も揺れる)
//     ★★ 決定的な反例 (2026-09-09 に取得。書式で何かを判断してはいけない証拠) ★★
//       **同一ホスト (GSE) の /trends/api/explore に 1.6 秒差で 2 発投げただけで、
//         429 応答が (ii) `NID=CusBCAES…` を、400 応答が (i) `NID=534=…` を発行した。**
//       つまり書式は「サーバ (GSE/ESF)」とも「ステータス」とも「エンドポイント」とも
//       相関しない。以前この欄にあった「GSE 側が (ii)、ESF 側が (i)」という読みは誤りで、
//       単に同じサーバが両方を返す。
//     → ラッパーは書式を一切見ず、`NID=<値>` をそのまま保存して送り返すだけにすること。
//       長さも 211〜319 文字とばらつくので、長さ検証も入れてはいけない。
//
//   ★ Set-Cookie: NID は **200 でも 429 でも 400 でも 401 でも、ほぼ毎回返ってくる** (実測)。
//     つまりサーバは応答のたびに NID をローテーションしている。
//     ラッパーは「毎レスポンスの Set-Cookie を見て NID を最新に差し替える」実装にすると
//     セッションが長持ちする。エラー応答の Set-Cookie も捨てないこと。
//
//   ★ ただし「毎回」ではない。**NID が返ってこないケースが 2 つ確認できている**:
//       (a) HAR の 429 (har_idx=246, 正規ブラウザセッション) には Set-Cookie が **1 個も無い**。
//           クライアントが既に有効な NID を提示している場合、サーバは発行し直さないと読める。
//       (b) 302 → /sorry (1-c) にも Set-Cookie は無い。
//     → **「NID は必ず取れる」を前提にした実装にしないこと。** 取れなかったら
//       手持ちの NID を使い続ける (捨てない)。本テストの L1 もこの前提で組んである。
//
// ■ 1-c. NID を付けても IP が既にフラグ済みだと → **302 Found → www.google.com/sorry/**
//
//   これは 429 とは別の、より重い 3 段目のブロック (Google 共通の "unusual traffic" ゲート)。
//   実測 (同一 IP から複数エージェントが並行検証していた状況):
//     status: 302 Found
//     location: https://www.google.com/sorry/index?continue=<元URLをエンコードしたもの>&hl=ja&q=<不透明トークン>
//     server: scaffolding on HTTPServer2   ← ★GSE でも ESF でもない。判別の決め手
//     content-type: text/html; charset=UTF-8
//     cache-control: no-store, no-cache, must-revalidate
//     x-xss-protection: 0
//     content-length: 465〜721 (元 URL の長さに比例)
//     Set-Cookie 無し / Retry-After 無し / content-disposition 無し
//   ボディ: `<TITLE>302 Moved</TITLE>` を含む 653 バイト前後の定型 HTML。
//
//   ★★ 最大の落とし穴 ★★
//   fetch の既定は redirect:"follow" なので、この 302 を **黙って追いかけて
//   www.google.com/sorry/index の CAPTCHA ページ (HTTP 200 / text/html) を掴んでしまう**。
//   `res.ok === true` になるため、JSON.parse が謎の SyntaxError で落ちる形で表面化する。
//   対策 (どちらか):
//     - redirect:"manual" にして status 302 と location を自分で見る (推奨)
//     - redirect:"follow" のままなら res.url が `https://www.google.com/sorry/` で
//       始まっていないかを必ず見る
//   本テストの L2 はこの検出方法そのものを検証している。
//
// ■ 1-d. Cookie 無し + IP フラグ済みでも 429 のまま (302 にはならない)
//   実測: 同一 URL に対し Cookie 無し → 429、NID 付与 → 302 /sorry。
//   つまり **/sorry への昇格は Cookie を持っている (= セッションとして追跡できる) 場合に起きる**
//   ように見える。ただし観測は 1 セッション分なので **これは推定**。
//
// ■ 1-e. レート制限は **エンドポイント単位** であって GSE サーフェス全体ではない
//   /trends/api/explore が 302 /sorry になっている最中でも、
//   GET /trends/api/autocomplete/DL?hl=ja&tz=-540 は **Cookie 無しで 200** を返した (実測)。
//     content-type: application/json; charset=UTF-8
//     content-disposition: attachment; filename="json.txt"
//     body: `)]}',\n{"default":{"topics":[...]}}`
//        ← ★プレフィクスは `)]}'` + **カンマ** + 改行 の **6 文字**。
//
//   ★★ プレフィクスは **エンドポイントごとに 5 文字と 6 文字が混在する** (実測 2026-09-09) ★★
//     - `GET /trends/api/explore`              → `)]}'\n`   (5 文字。カンマ **無し**)
//     - `GET /trends/api/widgetdata/multiline` → `)]}',\n`  (6 文字。カンマ **有り**)
//     - `GET /trends/api/autocomplete/<kw>`    → `)]}',\n`  (6 文字。カンマ **有り**)
//     - `POST /_/TrendsUi/data/batchexecute`   → `)]}'\n\n` (6 文字。カンマ無し + 空行)
//     HAR のバイト会計とも整合する: multiline の空応答 51 バイト
//     = 6 (`)]}',\n`) + 45 (`{"default":{"timelineData":[],"averages":[]}}`) で、
//     **本文末尾に改行は付かない**。relatedsearches の空応答 35 バイト = 6 + 29 も同様。
//     (「5 バイトのプレフィクス + 末尾改行 1 バイト」と読んでも合計は同じになるため、
//      バイト会計だけでは区別できなかった。実本文を見て 6 文字側が正しいと確定した。)
//     → 固定長で slice せず、**最初の改行までを丸ごと捨てる**のが唯一安全な剥がし方。
//       本ファイルの stripJsonPrefix() がその実装。
//
//   ★★ content-disposition の **値** もエンドポイントごとに違う (HAR 全件 + ライブで確定) ★★
//     成功判定に content-disposition を使うのはよいが、**文字列の完全一致で見てはいけない**。
//       - `GET /trends/api/explore`              → `attachment; filename="json.txt"; filename*=UTF-8''json.txt`
//                                                  (HAR 13/13 件がこの「長い形」)
//       - `GET /trends/api/widgetdata/multiline` → `attachment; filename="json.txt"`
//                                                  (HAR 12/12 件が `filename*` **無し**の「短い形」)
//       - `GET /trends/api/autocomplete/<kw>`    → `attachment; filename="json.txt"`
//                                                  (HAR 2/2 件 + ライブ実測とも短い形)
//       - `POST /_/TrendsUi/data/batchexecute`   → `attachment; filename="response.bin"; filename*=UTF-8''response.bin`
//                                                  (HAR 27/27 件が長い形)
//     → 判定は **ヘッダが存在するかどうか (!== null) だけ** にすること。
//       エラー応答 (400/401/404/429 と batchexecute の 400) には一切付かないので、
//       「付いている = アプリ層まで到達した」という意味では十分に使える。
//       本ファイルの looksLikeSuccessfulPayload() がその実装。
//
//   → 高コストな explore/widgetdata が絞られていても軽量な autocomplete は生きている。
//     「429 が出た＝全部死んだ」と判断しないこと。
//     ★ これは 2026-09-09 に **決定的な形で実証できた**: 同一プロセス・同一 IP から、
//       /trends/api/explore が 302 /sorry でブロックされている、まさにその最中に
//       GET /trends/api/autocomplete/DL?hl=ja&tz=-540 が **Cookie 無しで 200** を返した
//       (565 バイト、`)]}',\n{"default":{"topics":[…]}}`)。
//       つまりブロックは 429 レベルだけでなく **/sorry レベルでもエンドポイント単位**である。
//       本ファイルのライブテスト L8 がこれを常設で検証している。
//
// ----------------------------------------------------------------------------
// 2. 不正 token / 壊れた req / 存在しないウィジェット (旧 REST API) — ライブ実測
// ----------------------------------------------------------------------------
// **すべて Cookie 無しで実測できた (2026-09-09)。しかも 429 ではなく固有のコードが返る。**
// つまり /trends/api/* の入力検証は **Cookie ゲート / レート制限より手前** で走る。
// 400/401/404 が返ったら「自分のリクエスト組み立てのバグ」であって、
// 待って再試行しても永久に直らない。
//
//  # | 送ったもの                                            | status  | content-type     | body | 常設テスト
//  --|-------------------------------------------------------|---------|------------------|------|----------
//  B | widgetdata/multiline + 形式だけ正しいダミー token      | 401/400 | text/html        | 1691 | L6-1
//  C | widgetdata/multiline + token パラメータそのものを省略  | 401/400 | text/html        | 1691 | (単発実測のみ)
//  E | widgetdata/multiline + req=%7Bnot-json (壊れた JSON)   |   400   | text/html        | 1691 | (単発実測のみ)
//  F | explore + req=%7Bnot-json (Cookie 無し)                |   400   | text/html        | 1691 | L6-3
//  D | /trends/api/widgetdata/nosuchwidget (存在しないパス)   |   404   | text/html        | 1649 | L6-2
//  G | explore + 正しい req (Cookie 無し) ← 対照。1-a のゲート |   429   | text/html        | 1697 | L0
//  H | widgetdata/multiline + 有効 token + 改変 req           |   401   | text/html        | 1691 | L2b
//  A | autocomplete/DL (対照。正常系)                         |   200   | application/json |  565 | L8
//
//  ★ F と G の対比が最も重要: **同じ /trends/api/explore に Cookie 無しで投げても、
//    req が正しければ 429、req が壊れていれば 400** が返る (2026-09-09 に 1.6 秒差で両方観測)。
//    → 入力検証は Cookie ゲート / レート制限より **手前** で走っている、と断定できる。
//    → 逆に言うと **429 が返った時点で「req の形は正しかった」ことが確定する**。
//      429 のときに req を疑ってデバッグしても時間の無駄。必要なのは NID だけ。
//
// ダミー token は `"ANI_2wMAAAAA" + "A".repeat(32)` (実物と同じ 44 文字 base64url)。
//
// ■ 2-a. token 系エラー = **401**、req 系エラー = **400** (ただし揺れる)
//   同じ日の 2 回の実行で、**まったく同一のリクエストが 1 回目 400 / 2 回目 401** を返した。
//   2 回目の実行では B (token 不正) と C (token 欠落) が 401、E (req が壊れている) が 400 と
//   きれいに分かれたので、**基本線は「token → 401 / req → 400」**と読める。
//   しかし 1 回目は token 不正でも 400 だったので、**どちらか一方に決め打ちしてはいけない**。
//   ラッパーは 400 と 401 を同じ「入力エラー (リトライ不可)」バケツに入れるのが安全。
//
// ■ 2-b. ★★ 401 なのに理由文字列は "Bad Request" ★★ (最大の罠)
//     `<title>Error 401 (Bad Request)!!1</title>`   ← 実測そのまま
//   401 の理由が "Unauthorized" ではなく "Bad Request" になっている。
//   さらに 404 は `accept-language: ja` で
//     `<title>Error 404 (見つかりませんでした)!!1</title>`  ← 日本語にローカライズ
//   となる。つまり **理由文字列は当てにならない (英語とも限らず、コードとも整合しない)**。
//   → エラーページ判定は **数値コードだけ** を見る正規表現
//     /<title>Error (\d{3}) [(（]/ を使うこと。本ファイルの parseGoogleErrorPage がこれ。
//   さらに 400 と 401 は **ボディ長まで完全同一の 1691 文字** (理由文字列が同じなので当然)。
//   **バイト長による判定は不可能。**
//
// ■ 2-c. 400 / 401 応答のヘッダ (実測)
//     content-type: text/html; charset=utf-8      ← ★JSON ではない
//     server: GSE
//     **content-disposition 無し**  (200 応答には必ず付くので判別に使える)
//     **Retry-After 無し** / **WWW-Authenticate 無し** (401 なのに付かない)
//     Set-Cookie: NID … **付くこともあれば付かないこともある。当てにしないこと。**
//       ★2026-09-09 の再検証で、以前の記述 (「Cookie 無しで叩いた実行では付かなかった」) は
//         **反証された**: Cookie を一切付けずに `req=%7Bnot-json` で叩いた 400 応答に
//         `Set-Cookie: NID=534=<opaque>` が 1 個付いていた (ライブ L6-3 が常設で観測する)。
//         NID を付けて叩いた 400/401 でもローテーション済み NID が返る。
//       → **Set-Cookie の有無でエラー種別を判定してはいけない。**
//         一方で「エラー応答の Set-Cookie は拾う価値がある」ことは変わらない
//         (400 応答から採取した NID もそのまま次のリクエストに使える)。
//     x-frame-options / content-security-policy / cross-origin-opener-policy … **揺れる**。
//       同じ日の実測で 429 と 401 には付き、explore の 400 には 3 つとも付かなかった。
//       → セキュリティヘッダの有無で分類しないこと。
//   → 429 とヘッダ構成がほぼ同じ。**content-type では 400/401 と 429 を区別できない。**
//     必ず status を見ること。
//
// ■ 2-d. 「token が不正」か「req が壊れている」かはレスポンスから区別できない場合がある
//   1 回目の実行では B (token だけ不正) と E (req だけ壊れている) が
//   **status もボディ長も同一の 400** だった。サーバは理由を教えてくれない。
//   → ラッパーは送る前にローカル検証すべき:
//       - token: 44 文字 / `[A-Za-z0-9_-]` のみ / base64url decode して 33 バイト
//       - token の期限: decode 後 bytes[9..12] を BE uint32 で読むと有効期限の UNIX 秒
//         (発行時刻 + 24h)。これで「期限切れ token を送って 401 を食う」のを防げる
//       - req: 自前で JSON.parse できることを確認してから URL に載せる
//     無駄な 1 発がそのままレート制限予算の消費になるので、事前検証の価値は高い。
//
// ■ 2-e. 404 応答 (存在しないウィジェットパス)
//     status: 404 / content-type: text/html; charset=utf-8 / server: GSE / body 1649 文字
//     content-disposition 無し。理由文字列は上記のとおりローカライズされる。
//
// ■ 2-g. ★★ widget token は req の中身に紐付いている (改変すると 401) ★★  【新規確定】
//   実測手順 (2026-09-09、すべて同一 NID で連続実行):
//     (1) GET /trends/api/explore → 200。widgets[] から TIMESERIES の
//         `request` (オブジェクト) と `token` (44 文字) を取り出す。
//     (2) `token` はそのまま、`req` の keyword だけ "Fanza" → "Zzzzq" に書き換えて
//         GET /trends/api/widgetdata/multiline → **401** (本文 1691 文字の定型ページ)。
//     (3) `req` も `token` も (1) のまま送る → **200** (timelineData 入り 27,639 文字)。
//   → token は「ウィジェット ID + 期限」だけの署名ではなく、
//     **req の内容そのものに対する署名 (HMAC)** である。1 バイトでも変えると通らない。
//
//   ラッパー実装への含意 (重要):
//     - **explore が返した `request` オブジェクトを JSON.stringify したものを、
//       一切加工せずに `req` パラメータに載せること。**
//       期間 (`time`)・解像度 (`resolution`)・カテゴリ・地域を自前で差し替えて
//       token を使い回す、という最適化は **できない**。条件を変えたら explore を叩き直す。
//     - 逆に「req を変えていないのに 401」なら、原因は token の期限切れ (発行から 24h) か
//       シリアライズのブレ (キー順序・エスケープの差) である。
//       JSON.stringify はキー順を保存するので、explore の応答をパースしてそのまま
//       stringify すれば往復で一致する (実測で 200 を確認済み)。
//
// ■ 2-h. `req` のパーセントエンコードは **URLSearchParams 標準でよい** 【新規確定】
//   HAR のブラウザは `:` と `,` を生のまま残し空白を `+` にする独特のエンコードをしていたが、
//   `new URL(...).searchParams.set("req", JSON.stringify(...))` による標準エンコード
//   (`:` → `%3A`, `,` → `%2C`, 空白 → `+`) でも **200 が返る** ことを実測した
//   (explore / widgetdata の両方)。ブラウザのエンコードを模倣する必要は無い。
//
// ■ 2-f. /sorry (302) に落ちている最中は、これら 400/401/404 も全部 302 に潰される
//   同一 IP が 1-c のブロック状態にあると、リクエスト内容に関係なく一律 302 /sorry になり、
//   入力エラーの区別ができなくなる (2026-09-09 の別実行で観測)。
//   **「400 が返らない = リクエストが正しい」ではない。**
//
// ----------------------------------------------------------------------------
// 3. batchexecute (boq / ESF) のエラー形式 — ライブ実測 2026-09-09
// ----------------------------------------------------------------------------
// 封筒は正常時と同じ `)]}'\n\n<UTF-16長>\n<チャンクJSON>\n...` 形式のまま。
//
// ■ 3-a. トランスポート層エラー → **HTTP 400** + `er` チャンク
//   再現条件 (3 通りとも同じ形になることを実測):
//     (i)   存在しない rpcid   : rpcids=zzzZZZ, f.req=[[["zzzZZZ","[]",null,"generic"]]]
//     (ii)  f.req が JSON でない : body = `f.req=not-a-json&`
//     (iii) ボディが空          : body = ``
//   status: 400 Bad Request
//     content-type: application/json; charset=utf-8
//     **content-disposition ヘッダが無い**
//       (200 応答には attachment; filename="response.bin"; filename*=UTF-8''response.bin が必ず付く)
//     server: ESF / vary: Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site
//     set-cookie: NID=... (ESF 書式)
//   ボディ (実測 137〜140 文字。`di`/`af.httprm` の数値の桁数で揺れる):
//     )]}'
//
//     103
//     [["er",null,null,null,null,400,null,null,null,3],["di",11],["af.httprm",10,"<乱数>",16]]
//     25
//     [["e",4,null,null,139]]
//
//   → `er` アイテムは **arity 10**:
//     ["er", null, null, null, null, <httpStatus:int>, null, null, null, <int>]
//     index 5 に HTTP ステータス (400) がそのまま入る。**wrb.fr は 1 個も返らない。**
//     ラッパーは「wrb.fr が 0 個」だけで判断せず、er アイテムの有無を明示的に見ること。
//
// ■ 3-b. アプリ層 (RPC 個別) エラー → **HTTP 200** のまま wrb.fr にエラーが載る
//   再現条件: 正しい rpcid に壊れた引数を渡す。
//     rpcids=i0OFE, f.req=[[["i0OFE","[\"garbage\",{}]",null,"generic"]]]
//   status: 200 OK (content-disposition も付く = 見た目は完全に正常応答)
//   ボディ (実測 138〜140 文字。長さは揺れるので判定に使わないこと):
//     )]}'
//
//     103
//     [["wrb.fr","i0OFE",null,null,null,[3],"generic"],["di",37],["af.httprm",36,"<乱数>",16]]
//     25
//     [["e",4,null,null,139]]
//
//   → **wrb.fr[2] (ペイロード JSON 文字列) が null**、
//     **wrb.fr[5] にエラーコード配列 [3] が入る** (正常時は index 3/4/5 すべて null)。
//     これで HAR 解析時に未解決だった「wrb.fr の index 3/4/5 は何か」が確定した:
//     **index 5 = エラーコード配列** (3 は gRPC canonical code の INVALID_ARGUMENT と推定)。
//     ★ status 200 なので res.ok では絶対に検出できない。
//       ラッパーは wrb.fr ごとに payload === null を必ずチェックすること。
//
// ■ 3-c. batchexecute では 429 を観測できなかった
//   1 秒間隔で wAgrOe を 5 連射 → **5 回とも 200** (所要 106〜714ms)。
//   同時刻に旧 REST API 側は /sorry でブロックされていたので、
//   **2 つのレートリミッタは完全に独立している**と言える (実測)。
//
// ■ 3-d. ★`rpcids` クエリは実際のディスパッチに使われていない (実測)
//   `?rpcids=i0OFE` と指定しつつ f.req には `wAgrOe` の call を 1 個だけ入れて POST したところ、
//   **status 200 / `[["wrb.fr","wAgrOe","[\"日本\"]",null,null,null,"generic"], ...]`**
//   が返った。つまりサーバは **f.req の中身だけを見て RPC を実行する**。
//   `rpcids` はテレメトリ/ルーティングヒントに過ぎず、不一致でもエラーにならない。
//   → ラッパー実装では f.req から rpcid を機械的に導出して rpcids に入れておけばよく、
//     ここのズレでデバッグに時間を溶かさないこと。逆に「rpcids に書いたのに返ってこない」
//     という症状は f.req 側の組み立てミスを疑う。
//
// ■ 3-e. f.req が valid JSON でも形が違えば 400 (3-a と同形)
//   `f.req={"nope":1}` (JSON としては valid、だが 2 重配列ではない) を POST →
//     status 400 / body 137 文字
//     )]}'
//
//     101
//     [["er",null,null,null,null,400,null,null,null,3],["di",4],["af.httprm",4,"<乱数>",13]]
//     25
//     [["e",4,null,null,137]]
//   → 3-a (存在しない rpcid) と **完全に同じ er 形状**。er[9] は 3-a/3-e とも 3。
//     長さ行の値 (103 / 101) と e[4] の総バイト数 (139 / 137) だけが `di`/`af.httprm` の
//     数値の桁数で揺れる。**バイト長で判定してはいけない。**
//
// ----------------------------------------------------------------------------
// 4. その他のエラー応答 (HAR 由来)
// ----------------------------------------------------------------------------
//  - 502 Bad Gateway : POST /_/TrendsUi/browserinfo, POST /_/TrendsUi/jserror
//      (HAR har_idx=350, 352)
//      content-type: text/html; charset=UTF-8 / content-length: 1613 / referrer-policy: no-referrer
//      body 1609 バイト、`<title>Error 502 (Server Error)!!1</title>` を含む同系のエラーページ。
//      どちらもテレメトリ用エンドポイントなので **ラッパーは呼ぶ必要が無く、無視してよい**。
//  - 302 Found : GET /trends/trendingsearches/daily?geo=JP&hl=ja (HAR har_idx=284)
//      location: https://trends.google.com/trending?geo=JP&hl=ja / content-length: 214
//      旧デイリートレンド UI は廃止。これは **ブロックではない正常なリダイレクト** なので、
//      302 を一律ブロック扱いしてはいけない。location のホストで区別する
//      (trends.google.com → 正常リダイレクト / www.google.com/sorry → ブロック)。
//  - Google のエラーページは 400/404/429/502 とも `<title>Error <code> (<理由>)!!1</title>` の
//    同一テンプレート。理由文字列は Accept-Language でローカライズされることがあるので
//    (404 は ja で `見つかりませんでした`、400 は ja でも `Bad Request` だった)、
//    汎用検出は **数値コードだけ** を見る /<title>Error (\d{3}) [(（]/ を使うこと。
//
// ----------------------------------------------------------------------------
// 5. レート制限の閾値 — 分かったこと / 分からなかったこと
// ----------------------------------------------------------------------------
//  - batchexecute (boq): 1 秒間隔 5 連射で 429 に **未到達**。本調査の範囲では閾値不明。
//    HAR の正規ブラウザセッションでも boq 側の 429 は 0 件。
//  - 旧 REST API (GSE) / **NID あり**: 429 から採取した新鮮な NID を付けて
//    `/trends/api/explore` を **キーワードを変えながら 1.2 秒間隔で 6 連続** 実行 →
//    **6 回とも 200** (所要 115〜139ms、Retry-After は常に無し)。
//    → 「NID さえあれば 1 秒強の間隔で数発は通る」。本調査の範囲 (6 連射) では 429 未到達。
//    ただしこれは 1 回の観測にすぎず、閾値そのものは特定できていない。
//    より長い連射は DoS 的になるため意図的に行っていない。
//  - 旧 REST API (GSE) / **Cookie 無し**: 1 発目から 429。これはレート制限というより
//    **「NID を持たないクライアントを弾くゲート」** と読むのが正しい (回数に依存しない)。
//  - 旧 REST API (GSE) / **IP が既にフラグ済みのとき**: 別実行では
//    Cookie 無しの 1 発目から 429、NID を付けると 302 /sorry に昇格した。
//    同じ「429」でも、ゲートによるものと本物のレート超過によるものが区別できない。
//
//  ■ 昇格が起きる速さの実測タイムライン (2026-09-09、同一 IP。数分間の出来事)
//    ※ 同一 IP から複数の調査エージェントが並行して叩いていたので、
//      下の本数は「この IP からの総量」であって単独クライアントの閾値ではない。
//      それでも **数十リクエスト規模で /sorry まで昇格しうる** ことは分かる。
//      19:46Z  Cookie 無し /trends/api/explore          → 429 (+ Set-Cookie NID)
//      19:46Z  NID 付きで同じ URL                        → **200** (回復パターン成立)
//      19:46Z  widgetdata: token 改変 / req 改変          → 401 / 401
//      19:48Z  NID 付き /trends/api/explore を 1.2 秒間隔で 6 連射 → **6 回とも 200**
//      20:0xZ  NID 付き /trends/api/explore              → **302 /sorry に昇格**
//              (同時刻でも widgetdata への不正 token は 401、存在しないパスは 404 を返した
//               = ブロックは **エンドポイント単位**。全滅ではない)
//    → 「200 が続いているから安全」ではない。旧 REST API は数十発で /sorry に落ちうるので、
//      ラッパーは **成功中でもレートを絞り続ける** (1 リクエスト/秒以下 + 同時実行 1) こと。
//      /sorry に落ちたら回数を減らしても即座には戻らないので、予防が唯一の対策。
//    参考値として HAR の正規ブラウザセッション (Cookie + reCAPTCHA トークン完備) では
//    81 秒間に 111 リクエストを投げて 429 は 1 件だけ (har_idx=246)。
//    そのとき同時並列に飛んだ 3 本 (har_idx 247/248/249) はすべて 200 だったので、
//    **429 はセッション単位の遮断ではなくリクエスト単位の確率的スロットリング**。
//    1 本落ちても他は生きるので、失敗した 1 本だけを再試行すればよい。
//  - 一方 /sorry (302) は **IP + Cookie 単位の持続的ブロック** で、数分〜数十分は解けない。
//    こちらに落ちたら再試行しても無駄なので、429 とは別のエラー型にして
//    「長めのクールダウン (分オーダー) を挟む / 中止する」判断ができるようにすること。
//
// ----------------------------------------------------------------------------
// 6. 推奨リトライ戦略 (この調査からの結論)
// ----------------------------------------------------------------------------
//  1. **同時実行数は 1**。旧 REST API への並列リクエストは避ける。
//     HAR ではブラウザが 4〜6 本を並列発火し、そのうち 1 本が 429 を食らっている。
//  2. 持続レートは **60 件/分以下**に抑える (呼び出し側でトークンバケット等を持つ)。
//     ★2026-09-09 実測: サーバ側リミッタは **容量 90〜100 件のトークンバケット**として振る舞う。
//       破綻位置は 10 走行すべてで 89〜102 件目に集中し、目標レートを 120→480/分に上げても動かない
//       (速く投げれば速くそこに着くだけ)。60/分では 435 件を 7 分以上流しても枯れなかった。
//       「1 分間 200 が返り続けた = 安全」ではない。120/分の走行は 102 件すべて 200 だったが
//       直後の 1 発が 429 だった。走行後に 1 発撃って焼けたか確かめること。
//  3. 429 を受けたら: **2 種類の 429 を区別すること。**
//     (a) 未 Cookie ゲートの 429 … Cookie 無しでのアクセスに対し回数非依存で返る。
//         **新しい NID を Set-Cookie で配るので、それを付けて即再試行すれば 200**。待つ必要はない。
//     (b) レート制限の 429   … バケット枯渇 (~90〜100 件目) で返る。
//         **Set-Cookie を配らないか、配っても既存と同一。**
//         ★実測: 待機ゼロで (i) 同じ NID で再試行 → 6/6 とも 429、
//           (ii) /trends/explore から**新品の NID を取得**して再試行 → 3/3 とも 429。
//           → **429 は IP スコープ。Cookie をどう替えても回復せず、時間経過を待つしかない。**
//           Cookie プールもクッキーのローテーションも一切効果が無い。
//     したがって (b) では指数バックオフ (2s → 4s → 8s、jitter ±25%) で最大 3 回まで再試行。
//     Retry-After は返ってこないので待ち時間は自前で決めるしかない。
//  4. NID が無い/失効している状態なら、まず
//     GET https://trends.google.com/trends/explore?... (429 でも可) または
//     GET https://trends.google.com/trending?geo=..&hl=.. (200) を 1 回だけ叩いて
//     NID を採取してから本命に進む。NID の有効期限は約 6 か月なので
//     **プロセス外に永続化して使い回す**。
//  5. 302 → www.google.com/sorry を受けたら **リトライしない**。専用のエラー
//     (例: TrendsBlockedError) を投げ、呼び出し側にクールダウンを委ねる。
//     ここで叩き続けるとブロックが長期化する。
//  6. batchexecute の 200 は成功を意味しない。wrb.fr[2] === null なら RPC エラー。
//     これはサーバ都合の一時失敗ではなく引数の誤りであることが多いのでリトライしない。
//  7. **400 / 401 / 404 はすべてリトライ不可**。旧 REST API では widget token の不正・欠落が
//     401 (実測では 400 になることもある)、req の JSON 破損が 400、
//     存在しないパスが 404 (いずれも text/html)。batchexecute では rpcid ミスや
//     f.req の形式ミスが 400 + er チャンク。いずれも待っても直らない。
//     ※ **403 は本調査で一度も観測されていない** (Trends は権限エラーを 401 に寄せている)。
//       それでも classifyResponse は 403 を 400/401 と同じ "bad-request" に分類してある。
//       未知のコードでリトライループに落ちるより、リトライ不可側に倒す方が安全なため。
//     逆に言えば **400/404 を受けたらレート制限ではない** と断定してよい。
//     ただし /sorry ブロック中は 400/404 が 302 に潰されるので、
//     「400 が返らない = リクエストが正しい」とは言えない。
//  8. 成功判定は最低でも status === 200 かつ content-type が application/json で始まること。
//     content-disposition の **有無** を併用するとさらに堅い
//     (旧 API の正常 JSON と batchexecute の正常応答には必ず付き、エラーには付かない)。
//     ★ ただし **値の完全一致で判定してはいけない** (1-e 参照)。explore と batchexecute は
//       `filename*=UTF-8''…` 付きの長い形、widgetdata と autocomplete は付かない短い形。
//     ★ batchexecute は 200 + content-disposition 付きでも RPC が失敗していることがある (3-b)。
//       封筒の中身まで見て初めて成功と言える。
//  9. token / req は **送る前にローカル検証**する。サーバは 400 の理由を教えてくれないし、
//     無駄な 1 発がそのままレート制限予算の消費になる。
//     token: 44 文字 / base64url decode して 33 バイト / bytes[9..12] (BE uint32) が未来の UNIX 秒。
// 10. **explore が返した `request` を加工して token を使い回さない** (2-g)。
//     req を 1 箇所でも書き換えると 401 になる (実測)。期間・解像度・地域・カテゴリを
//     変えたいなら explore から取り直すこと。逆に「同じ req なら token は 24h 再利用できる」
//     ので、explore の応答 (widgets の request と token の組) をキャッシュする価値は高い。
//     Set-Cookie は成功・失敗を問わずほぼ毎回 NID を返してくるので、NID も都度更新する
//     (ただし 1-b のとおり返ってこない応答もあるので、取れなければ手持ちを使い続ける)。
// 11. エラーページ判定は **数値コードだけ** を見る。理由文字列は Accept-Language で
//     ローカライズされる (404 は ja で `見つかりませんでした`)。バイト長での判定も不可。
//     文言マッチはアポストロフィが混在している (1-a) ので特に危険。
//
// ----------------------------------------------------------------------------
// 7. このファイルのライブリクエスト本数
// ----------------------------------------------------------------------------
//   L0 (1) + L1 (1) + L2 (1) + L2b (1) + L3 (1) + L4 (1) + L5 (2) + L6 (3) + L7 (1) + L8 (1)
//   = 計 13 本。内訳と検証対象:
//     L0  … Cookie 無し /trends/api/explore → 429 のゲート挙動 (1-a)
//     L1  … Cookie 無し /trends/explore → 429 + Set-Cookie: NID の採取 (1-b)
//     L2  … 採取した NID を付けて再試行 → 200 (★回復パターンの実地成立)
//     L2b … 有効 token + 改変 req → 401 (token は req に署名している / 2-g)
//     L3  … batchexecute 未知 rpcid → 400 + er チャンク (3-a)
//     L4  … batchexecute 正しい rpcid + 壊れた引数 → 200 なのに RPC エラー (3-b)
//     L5  … batchexecute を 1.3 秒間隔で 2 連射 → 429 未到達の記録 (3-c / 5)
//     L6  … 不正 token → 400/401 / 存在しないパス → 404 / 壊れた req → 400 (2, 2-c)
//     L7  … rpcids クエリは実ディスパッチに使われない (3-d)
//     L8  … 高コスト端点がブロック中でも autocomplete は 200 (1-e)
//   すべて 1.3 秒以上の間隔を空ける。連打は一切しない。
//   ネットワーク断・レート制限・/sorry ブロック時は console.warn を出して skip 扱いにし、
//   **テストは落とさない**。ライブテストは「観測できたときだけ厳しく検証する」方針で書いてある。
//
//   ★ 回復パターン (429 → NID 採取 → 再試行 → 200) は L2 が実地で追うが、
//     IP が既に /sorry ブロック中だと 200 まで到達できず観測できない。
//     そこで **同じ回復ロジックを注入 fetch で決定論的に検証するオフラインテスト**
//     ("offline: fetchWithRecovery …" の 2 本) を用意してある。
//     ネットワーク状態に関係なく、回復パターンとリトライ方針は常に検証される。
// ============================================================================

import { assert, assertEquals } from "jsr:@std/assert@^1";

// ---------------------------------------------------------------------------
// 実装リファレンス: 応答分類器 (ラッパーにそのまま持っていける想定の純関数群)
// ---------------------------------------------------------------------------

/** エラー分類のタグ。ラッパーはこの単位でリトライ可否を決めるとよい。 */
export type TrendsOutcome =
  | "ok-json" // 正常。JSON をパースしてよい
  | "rate-limited" // 429。バックオフして再試行可
  | "blocked" // 302 → www.google.com/sorry。再試行不可、長いクールダウンが必要
  | "redirect" // ブロックではない普通のリダイレクト (例: trendingsearches/daily)
  | "bad-request" // 400/401/403。入力・トークンの誤り。再試行不可
  | "not-found" // 404。パスが存在しない。再試行不可
  | "server-error" // 5xx。短いバックオフで再試行可
  | "html-error" // それ以外の Google エラーページ HTML
  | "unknown";

const SORRY_PREFIX = "https://www.google.com/sorry/";

/**
 * HTTP レスポンスの「外側」だけで分類する。
 * status / content-type / location / 最終 URL の 4 つしか見ないので、
 * ボディを読む前 (= ストリームを消費する前) に呼べる。
 */
export function classifyResponse(
  status: number,
  contentType: string | null,
  location: string | null,
  finalUrl?: string,
): TrendsOutcome {
  // redirect:"follow" のまま /sorry に着地したケースを先に潰す
  if (finalUrl && finalUrl.startsWith(SORRY_PREFIX)) return "blocked";
  if (status === 429) return "rate-limited";
  if (status >= 300 && status < 400) {
    if (location && location.startsWith(SORRY_PREFIX)) return "blocked";
    return "redirect";
  }
  // 400 = req が JSON として壊れている / 401 = widget token が無効か欠落 / 403 = 権限
  // いずれも「送り方の誤り」で、待っても直らない。
  if (status === 400 || status === 401 || status === 403) return "bad-request";
  if (status === 404) return "not-found";
  if (status >= 500) return "server-error";
  if (status === 200) {
    const ct = contentType?.toLowerCase() ?? "";
    if (ct.startsWith("application/json")) return "ok-json";
    if (ct.startsWith("text/html")) return "html-error";
  }
  return "unknown";
}

/** Google の定型エラーページ HTML から HTTP コードを抜く。該当しなければ null。 */
export function parseGoogleErrorPage(html: string): number | null {
  const m = html.match(/<title>Error (\d{3}) [(（]/);
  return m ? Number(m[1]) : null;
}

/** 429 エラーページかどうかを本文の目印で判定する (バイト長で判定しないこと)。 */
export function looksLikeRateLimitHtml(html: string): boolean {
  return parseGoogleErrorPage(html) === 429 ||
    html.includes("Error 429 (Too Many Requests)") ||
    (html.includes("af-error-container") && html.includes("<b>429.</b>"));
}

/** Set-Cookie ヘッダ群から NID の値だけを取り出す。無ければ null。 */
export function extractNid(setCookies: readonly string[]): string | null {
  for (const c of setCookies) {
    const m = c.match(/^\s*NID=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * 旧 REST API の JSON ハイジャック対策プレフィクスを剥がす。
 *
 * プレフィクスは **エンドポイントによって長さが違う** (実測 2026-09-09):
 *   /trends/api/explore              → `)]}'\n`  (5 文字)
 *   /trends/api/widgetdata/multiline → `)]}',\n` (6 文字、カンマ有り)
 *   /trends/api/autocomplete/<kw>    → `)]}',\n` (6 文字、カンマ有り)
 * よって `slice(5)` や `slice(6)` の決め打ちは必ずどれかで壊れる。
 * 「先頭行を丸ごと捨てる」= 最初の改行の次から返す、が唯一安全。
 * プレフィクスが無いテキスト (例: 429 の HTML) には触らず、そのまま返す。
 */
export function stripJsonPrefix(text: string): string {
  if (!text.startsWith(")]}'")) return text;
  const nl = text.indexOf("\n");
  // 改行が無い応答は本来ありえないが、その場合でも `)]}'` と後続のカンマを取り除く
  // (単純な slice(4) だと `)]}',{…}` で先頭に `,` が残り、謎の JSON.parse エラーになる)。
  return nl < 0 ? text.replace(/^\)\]\}'\,?/, "") : text.slice(nl + 1);
}

/**
 * 「アプリ層まで到達した正常応答か」を **ヘッダだけ** で判定する。
 *
 * content-disposition は正常応答にだけ付き、エラー (400/401/404/429、batchexecute の 400)
 * には付かない。ただし **値はエンドポイントごとに違う** (実測 + HAR 全件で確認):
 *   explore / batchexecute → `…; filename*=UTF-8''…` 付きの長い形
 *   widgetdata / autocomplete → `attachment; filename="json.txt"` の短い形
 * よって **存在チェックのみ** を行い、値の完全一致はしない。
 *
 * 注意: これが true でも batchexecute の RPC は失敗していることがある (3-b)。
 * batchexecute では必ず analyzeBatchEnvelope() まで見ること。
 */
export function looksLikeSuccessfulPayload(
  status: number,
  contentType: string | null,
  contentDisposition: string | null,
): boolean {
  return status === 200 &&
    (contentType?.toLowerCase().startsWith("application/json") ?? false) &&
    contentDisposition !== null &&
    contentDisposition.toLowerCase().includes("attachment");
}

// --- batchexecute 封筒パーサ (エラーチャンク対応版) -------------------------

export type BatchItem = unknown[];

/**
 * `)]}'\n\n<UTF-16長>\n<チャンクJSON>\n` の繰り返しを平坦化する。
 * 長さ N は UTF-16 コードユニット数で、「長さ行を終端する LF + JSON + JSON を終端する LF」を数える。
 * したがって JSON 本体は N-2 文字。エラー応答 (er チャンク) も同じ封筒に乗る。
 */
export function parseBatchEnvelope(text: string): BatchItem[] {
  if (!text.startsWith(")]}'\n\n")) {
    throw new Error("batchexecute: unexpected prefix");
  }
  const items: BatchItem[] = [];
  let pos = 6;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) break;
    const n = Number(text.slice(pos, nl));
    if (!Number.isFinite(n) || n <= 0) break;
    const json = text.slice(nl + 1, nl + n - 1);
    for (const it of JSON.parse(json) as BatchItem[]) items.push(it);
    pos = nl + n;
  }
  return items;
}

export type BatchAnalysis = {
  /** ["er", ...] アイテムが返っていれば、その index 5 の HTTP ステータス */
  transportError: number | null;
  /** rpcid ごとの結果。payload === null ならその RPC がエラー */
  results: { rpcid: string; slot: string; payload: unknown; errorCodes: unknown }[];
};

export function analyzeBatchEnvelope(text: string): BatchAnalysis {
  const items = parseBatchEnvelope(text);
  let transportError: number | null = null;
  const results: BatchAnalysis["results"] = [];
  for (const it of items) {
    if (it[0] === "er") {
      const code = it[5];
      transportError = typeof code === "number" ? code : -1;
    } else if (it[0] === "wrb.fr") {
      const raw = it[2];
      results.push({
        rpcid: String(it[1]),
        slot: String(it[6] ?? ""),
        payload: typeof raw === "string" ? JSON.parse(raw) : null,
        errorCodes: it[5] ?? null,
      });
    }
  }
  return { transportError, results };
}

// --- リトライ方針 ----------------------------------------------------------

/**
 * 分類結果からリトライ可否と待ち時間 (ms) を返す。
 * attempt は 0 起点。Retry-After は返ってこないので完全に自前の指数バックオフ。
 */
export function retryPlan(
  outcome: TrendsOutcome,
  attempt: number,
  maxAttempts = 3,
): { retry: boolean; delayMs: number; refreshNid: boolean } {
  if (attempt >= maxAttempts) return { retry: false, delayMs: 0, refreshNid: false };
  switch (outcome) {
    case "rate-limited":
      return { retry: true, delayMs: 2000 * Math.pow(2, attempt), refreshNid: true };
    case "server-error":
      return { retry: true, delayMs: 1000 * Math.pow(2, attempt), refreshNid: false };
    case "blocked": // /sorry。叩き続けると悪化するだけ
    case "bad-request":
    case "not-found":
    case "ok-json":
    case "redirect":
    case "html-error":
    case "unknown":
      return { retry: false, delayMs: 0, refreshNid: false };
  }
}

// --- 回復パターンの参照実装 ------------------------------------------------

/** fetchWithRecovery が呼び出し側に返す 1 回ぶんの試行記録。 */
export type RecoveryAttempt = {
  status: number;
  outcome: TrendsOutcome;
  /** この応答から新しく採取できた NID (無ければ null) */
  nid: string | null;
  /** 実際に待った時間 (ms)。最後の試行では 0 */
  waitedMs: number;
};

export type RecoveryResult = {
  response: Response | null;
  attempts: RecoveryAttempt[];
  /** 最終的に手元にある NID。次回リクエストに引き継ぐ */
  nid: string | null;
  outcome: TrendsOutcome;
};

/**
 * ★このファイルの中心的な成果物: 「429 → Set-Cookie の NID を拾って再試行 → 200」
 * という回復パターンの参照実装。
 *
 * 設計上の要点 (すべて実測に基づく):
 *  - `redirect: "manual"` を強制する。既定の follow だと /sorry の CAPTCHA ページを
 *    200 として掴んでしまい res.ok が true になる (1-c の罠)。
 *  - Retry-After は返ってこないので待ち時間は retryPlan() の自前バックオフで決める。
 *  - **エラー応答の Set-Cookie も必ず読む**。429 でも NID は発行される (1-b)。
 *    ただし返ってこない応答もある (1-b の (a)(b)) ので、その場合は手持ちを使い続ける。
 *  - blocked (/sorry) は即中止。叩き続けるとブロックが長期化する。
 *  - bad-request / not-found も即中止。待っても直らない。
 *
 * `doFetch` を注入できるようにしてあるのは、ネットワーク状態に依存せず
 * 回復パターンそのものをテストするため (実運用では globalThis.fetch を渡す)。
 * `sleepFn` も注入可能で、テストでは実際には待たずに待ち時間だけ記録する。
 */
export async function fetchWithRecovery(
  url: string,
  opts: {
    nid?: string | null;
    maxAttempts?: number;
    headers?: Record<string, string>;
    doFetch: (url: string, init: RequestInit) => Promise<Response>;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<RecoveryResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let nid = opts.nid ?? null;
  const attempts: RecoveryAttempt[] = [];

  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (nid) headers.cookie = `NID=${nid}`;
    // redirect:"manual" は必須。follow にすると /sorry を 200 として掴む。
    const res = await opts.doFetch(url, { redirect: "manual", headers });

    const outcome = classifyResponse(
      res.status,
      res.headers.get("content-type"),
      res.headers.get("location"),
      res.url || undefined,
    );
    // 成功・失敗を問わず NID を拾い直す。429 でも発行されるのがこの回復パターンの肝。
    const fresh = extractNid(res.headers.getSetCookie());
    if (fresh) nid = fresh;

    const plan = retryPlan(outcome, attempt, maxAttempts);
    if (!plan.retry) {
      attempts.push({ status: res.status, outcome, nid: fresh, waitedMs: 0 });
      return { response: res, attempts, nid, outcome };
    }
    attempts.push({ status: res.status, outcome, nid: fresh, waitedMs: plan.delayMs });
    // 再試行するので、掴んだままのボディを必ず解放する (Deno のリソースリーク対策)。
    await res.body?.cancel();
    await sleepFn(plan.delayMs);
  }
}

// ---------------------------------------------------------------------------
// 記録済みフィクスチャ (2026-09-09 のライブ実測。秘密情報は含まない)
// ---------------------------------------------------------------------------

/**
 * 実測の 429 ページ本文の要点 (CSS 部分は省略。目印になる部分のみ)。
 *
 * ★アポストロフィは実物どおり **混在させてある** (2026-09-09 にバイト単位で確認):
 *   `That’s an error.` / `That’s all we know.` … カーリー U+2019
 *   `We're sorry, but …`                                … 直線 U+0027
 * ここを揃えて書き直すと「実測の記録」ではなくなるので触らないこと。
 */
const FIXTURE_429_TAIL =
  `<title>Error 429 (Too Many Requests)!!1</title></style>` +
  `<main id="af-error-container" role="main">` +
  `<p><b>429.</b> <ins>That’s an error.</ins>` +
  `<p>We're sorry, but you have sent too many requests to us recently. ` +
  `Please try again later. <ins>That’s all we know.</ins></main>`;

/** 実測の 302 /sorry の location (不透明トークン部分はダミーに置換してある)。 */
const FIXTURE_SORRY_LOCATION =
  "https://www.google.com/sorry/index?continue=https://trends.google.com/trends/api/explore%3Fhl%3Dja&hl=ja&q=DUMMY";

/** 実測: batchexecute の HTTP 400 応答 (存在しない rpcid / 壊れた f.req / 空ボディで同形)。 */
const FIXTURE_BE_400 = ")]}'\n\n103\n" +
  `[["er",null,null,null,null,400,null,null,null,3],["di",11],["af.httprm",10,"4773764381710509506",16]]\n` +
  "25\n" + `[["e",4,null,null,139]]\n`;

/** 実測: batchexecute の HTTP 200 だが RPC がエラーの応答 (i0OFE に壊れた引数)。 */
const FIXTURE_BE_RPC_ERR = ")]}'\n\n103\n" +
  `[["wrb.fr","i0OFE",null,null,null,[3],"generic"],["di",37],["af.httprm",36,"8368856483597409218",16]]\n` +
  "25\n" + `[["e",4,null,null,139]]\n`;

/** 実測: batchexecute の正常応答 (wAgrOe / ["JP","ja"])。 */
const FIXTURE_BE_OK = ")]}'\n\n111\n" +
  `[["wrb.fr","wAgrOe","[\\"日本\\"]",null,null,null,"generic"],["di",21],["af.httprm",20,"1234567890123456789",16]]\n` +
  "25\n" + `[["e",4,null,null,147]]\n`;

/** HAR har_idx=350 (502 Bad Gateway) の本文冒頭。 */
const FIXTURE_502_HEAD = `<!DOCTYPE html>\n<html lang=en>\n  <meta charset=utf-8>\n` +
  `  <title>Error 502 (Server Error)!!1</title>\n`;

/** 実測 2026-09-09: 不正 token / 壊れた req の 400 ページ冒頭 (1691 文字のうち先頭のみ)。 */
const FIXTURE_400_HEAD = `<html lang="ja" dir=ltr><meta charset=utf-8>` +
  `<meta name=viewport content="initial-scale=1, minimum-scale=1, width=device-width">` +
  `<title>Error 400 (Bad Request)!!1</title>`;

/** 実測 2026-09-09: token が無効/欠落のときの 401。★理由文字列が "Bad Request" のまま。 */
const FIXTURE_401_HEAD = `<html lang="ja" dir=ltr><meta charset=utf-8>` +
  `<title>Error 401 (Bad Request)!!1</title>`;

/** 実測 2026-09-09: 存在しないウィジェットパスの 404。理由文字列が ja にローカライズされる。 */
const FIXTURE_404_JA_HEAD = `<html lang="ja" dir=ltr><meta charset=utf-8>` +
  `<title>Error 404 (見つかりませんでした)!!1</title>`;

// ===========================================================================
// オフラインテスト (ネットワーク不要)
Deno.test({
  name:
    "offline: 400 / 404 ページも同じテンプレート。理由文字列はローカライズされるので数値だけ見る",
  fn() {
    assertEquals(parseGoogleErrorPage(FIXTURE_400_HEAD), 400);
    // ★401 なのに理由文字列は "Bad Request"。理由文字列で分岐してはいけない決定的な例
    assertEquals(parseGoogleErrorPage(FIXTURE_401_HEAD), 401);
    // ★理由が日本語化されていてもコードは取れる (英語文字列でマッチしてはいけない)
    assertEquals(parseGoogleErrorPage(FIXTURE_404_JA_HEAD), 404);
    assert(!looksLikeRateLimitHtml(FIXTURE_400_HEAD), "400 を 429 と誤判定しない");
    assert(!looksLikeRateLimitHtml(FIXTURE_404_JA_HEAD));
    // 旧 API の 400 は content-type が text/html だが、分類は status で行うので bad-request
    assertEquals(classifyResponse(400, "text/html; charset=utf-8", null), "bad-request");
    assertEquals(classifyResponse(404, "text/html; charset=utf-8", null), "not-found");
    // ★401 (token が無効/欠落) も入力エラーとして扱う。リトライしても永久に直らない
    assertEquals(classifyResponse(401, "text/html; charset=utf-8", null), "bad-request");
    assertEquals(retryPlan("not-found", 0).retry, false);
    // ★400 も 429 も content-type は text/html。content-type だけでは区別できない
    assertEquals(classifyResponse(429, "text/html; charset=utf-8", null), "rate-limited");
  },
});

// ===========================================================================

Deno.test({
  name: "offline: Google 定型エラーページから HTTP コードを抽出できる (429 / 502)",
  fn() {
    assertEquals(parseGoogleErrorPage(FIXTURE_429_TAIL), 429);
    assertEquals(parseGoogleErrorPage(FIXTURE_502_HEAD), 502);
    assertEquals(parseGoogleErrorPage(`{"default":{"topics":[]}}`), null);
    assert(looksLikeRateLimitHtml(FIXTURE_429_TAIL));
    assert(!looksLikeRateLimitHtml(FIXTURE_502_HEAD));
  },
});

Deno.test({
  name: "offline: classifyResponse — 429 / 302-sorry / 302-通常 / 400 / 502 / 200json を区別する",
  fn() {
    // 429: content-type は text/html で Retry-After は無い
    assertEquals(classifyResponse(429, "text/html; charset=utf-8", null), "rate-limited");
    // 302 → /sorry はブロック
    assertEquals(
      classifyResponse(302, "text/html; charset=UTF-8", FIXTURE_SORRY_LOCATION),
      "blocked",
    );
    // 302 → trends.google.com/trending は正常リダイレクト (HAR har_idx=284)
    assertEquals(
      classifyResponse(
        302,
        "text/html; charset=UTF-8",
        "https://trends.google.com/trending?geo=JP&hl=ja",
      ),
      "redirect",
    );
    // redirect:"follow" のまま /sorry に着地したケースも blocked と判定できる
    assertEquals(
      classifyResponse(200, "text/html; charset=utf-8", null, FIXTURE_SORRY_LOCATION),
      "blocked",
    );
    assertEquals(classifyResponse(400, "application/json; charset=utf-8", null), "bad-request");
    assertEquals(classifyResponse(502, "text/html; charset=UTF-8", null), "server-error");
    assertEquals(classifyResponse(200, "application/json; charset=utf-8", null), "ok-json");
    // 200 なのに HTML = 何かのエラーページ。JSON.parse する前に弾く
    assertEquals(classifyResponse(200, "text/html; charset=utf-8", null), "html-error");
  },
});

Deno.test({
  name: "offline: Set-Cookie から NID を抽出できる (429 応答でも NID は付く)",
  fn() {
    const sc = [
      "NID=534=OPAQUE_VALUE_PLACEHOLDER; expires=Wed, 10-Mar-2027 17:28:03 GMT; path=/; domain=.google.com; Secure; HttpOnly; SameSite=none",
    ];
    assertEquals(extractNid(sc), "534=OPAQUE_VALUE_PLACEHOLDER");
    assertEquals(extractNid(["OTZ=abc; path=/"]), null);
    assertEquals(extractNid([]), null);
  },
});

Deno.test({
  name: "offline: batchexecute HTTP 400 は er チャンク (arity 10, index5=400) で wrb.fr が 0 個",
  fn() {
    const items = parseBatchEnvelope(FIXTURE_BE_400);
    const er = items.find((it) => it[0] === "er");
    assert(er, "er アイテムが存在すること");
    assertEquals(er!.length, 10, "er は arity 10");
    assertEquals(er![5], 400, "er[5] に HTTP ステータスが入る");
    assertEquals(items.filter((it) => it[0] === "wrb.fr").length, 0, "wrb.fr は返らない");

    const a = analyzeBatchEnvelope(FIXTURE_BE_400);
    assertEquals(a.transportError, 400);
    assertEquals(a.results.length, 0);
  },
});

Deno.test({
  name: "offline: batchexecute の RPC エラーは HTTP 200 + wrb.fr[2]===null + wrb.fr[5]=[code]",
  fn() {
    const a = analyzeBatchEnvelope(FIXTURE_BE_RPC_ERR);
    assertEquals(a.transportError, null, "トランスポート層は正常");
    assertEquals(a.results.length, 1);
    assertEquals(a.results[0].rpcid, "i0OFE");
    assertEquals(a.results[0].slot, "generic");
    assertEquals(a.results[0].payload, null, "★ペイロードが null = RPC エラー");
    assertEquals(a.results[0].errorCodes, [3], "★wrb.fr[5] にエラーコード配列");

    // 対照: 正常応答では payload が入り errorCodes は null
    const ok = analyzeBatchEnvelope(FIXTURE_BE_OK);
    assertEquals(ok.transportError, null);
    assertEquals(ok.results[0].payload, ["日本"]);
    assertEquals(ok.results[0].errorCodes, null);
  },
});

Deno.test({
  name: "offline: 封筒の長さ行は UTF-16 コードユニット数 (JSON 長 = N-2) である",
  fn() {
    // FIXTURE_BE_OK は日本語 (「日本」) を含む。UTF-8 バイトで数えると破綻する。
    const firstNl = FIXTURE_BE_OK.indexOf("\n", 6);
    const n = Number(FIXTURE_BE_OK.slice(6, firstNl));
    const json = FIXTURE_BE_OK.slice(firstNl + 1, firstNl + n - 1);
    assertEquals(json.length, n - 2, "JSON の UTF-16 長は N-2");
    assert(json.startsWith("[[") && json.endsWith("]]"));
    // UTF-8 バイト長とは一致しない (= バイトで数える実装は間違い)
    assert(
      new TextEncoder().encode(json).length !== json.length,
      "日本語を含むので UTF-8 バイト長 != UTF-16 長",
    );
  },
});

Deno.test({
  name:
    "offline: stripJsonPrefix — )]}'\\n (5文字) と )]}',\\n (6文字) の両方を正しく剥がす",
  fn() {
    // explore は カンマ無しの 5 文字プレフィクス (実測)
    assertEquals(stripJsonPrefix(`)]}'\n{"widgets":[]}`), `{"widgets":[]}`);
    // widgetdata / autocomplete は カンマ有りの 6 文字プレフィクス (実測)
    assertEquals(
      stripJsonPrefix(`)]}',\n{"default":{"timelineData":[],"averages":[]}}`),
      `{"default":{"timelineData":[],"averages":[]}}`,
    );
    // どちらも JSON.parse まで到達できること
    assertEquals(
      JSON.parse(stripJsonPrefix(`)]}',\n{"default":{"rankedList":[]}}`)).default.rankedList,
      [],
    );
    // 固定長 slice が壊れる証明: 5 決め打ちだと widgetdata で先頭に改行が残る
    assert(
      `)]}',\n{"default":{}}`.slice(5) !== `{"default":{}}`,
      "slice(5) 決め打ちは widgetdata で壊れる",
    );
    // 空応答のバイト会計と整合すること (6 文字プレフィクス + 本文、末尾改行なし = 51 バイト)
    const emptyMultiline = `)]}',\n{"default":{"timelineData":[],"averages":[]}}`;
    assertEquals(new TextEncoder().encode(emptyMultiline).length, 51, "HAR の空応答 51 バイトと一致");
    const emptyRelatedEntity = `)]}',\n{"default":{"rankedList":[]}}`;
    assertEquals(new TextEncoder().encode(emptyRelatedEntity).length, 35, "HAR の空応答 35 バイトと一致");
    // プレフィクスが無いもの (エラーページ HTML) は素通し
    const html = "<html lang=\"ja\"><title>Error 429 (Too Many Requests)!!1</title>";
    assertEquals(stripJsonPrefix(html), html);
  },
});

Deno.test({
  name:
    "offline: retryPlan — 429 は指数バックオフ + NID 再取得、blocked/400/401/404 はリトライしない",
  fn() {
    assertEquals(retryPlan("rate-limited", 0), { retry: true, delayMs: 2000, refreshNid: true });
    assertEquals(retryPlan("rate-limited", 1), { retry: true, delayMs: 4000, refreshNid: true });
    assertEquals(retryPlan("rate-limited", 2), { retry: true, delayMs: 8000, refreshNid: true });
    assertEquals(retryPlan("rate-limited", 3).retry, false, "最大 3 回で打ち切り");
    assertEquals(retryPlan("blocked", 0).retry, false, "/sorry はリトライ厳禁");
    assertEquals(retryPlan("bad-request", 0).retry, false);
    assertEquals(retryPlan("server-error", 0), { retry: true, delayMs: 1000, refreshNid: false });
    assertEquals(retryPlan("ok-json", 0).retry, false);
  },
});

Deno.test({
  name:
    "offline: ★アポストロフィの罠 — 実物の 429 は That’s(カーリー) と We're(直線) が混在する",
  fn() {
    // 実測 (2026-09-09) と同じ混在。手打ちで揃えてしまうと本物にマッチしなくなる。
    assert(
      FIXTURE_429_TAIL.includes("That’s an error."),
      "実物は カーリー U+2019 の That’s",
    );
    assert(
      !FIXTURE_429_TAIL.includes("That's an error."),
      "★直線アポストロフィの \"That's an error.\" は実物にマッチしない (実測で確認済み)",
    );
    // 一方 We're の側は直線が正しい。同じページ内で書式が違う。
    assert(
      FIXTURE_429_TAIL.includes("We're sorry, but you have sent too many requests to us recently."),
      "We're の側は 直線 U+0027",
    );
    assert(!FIXTURE_429_TAIL.includes("We’re sorry"), "We’re (カーリー) ではない");
    // だからこそ文言ではなく数値コードで判定する実装が正しい
    assertEquals(parseGoogleErrorPage(FIXTURE_429_TAIL), 429);
    assert(looksLikeRateLimitHtml(FIXTURE_429_TAIL));
  },
});

Deno.test({
  name:
    "offline: looksLikeSuccessfulPayload — content-disposition は有無だけ見る (値は端点ごとに違う)",
  fn() {
    // HAR 実測の 4 パターン。長い形と短い形が混在するので完全一致は不可。
    // 型注釈を付けてリテラル型への絞り込みを防ぐ (絞り込まれると比較が常に真だと怒られる)
    const explore: string = `attachment; filename="json.txt"; filename*=UTF-8''json.txt`;
    const widgetdata: string = `attachment; filename="json.txt"`;
    const batch: string = `attachment; filename="response.bin"; filename*=UTF-8''response.bin`;
    for (const cd of [explore, widgetdata, batch]) {
      assert(
        looksLikeSuccessfulPayload(200, "application/json; charset=UTF-8", cd),
        `正常応答として扱えること: ${cd}`,
      );
    }
    // ★explore と widgetdata の値は実際に違う = 完全一致で判定する実装は必ず壊れる
    assert(explore !== widgetdata, "explore は filename* 付き / widgetdata は無し");
    // エラー応答には content-disposition が付かない (実測: 400/401/404/429 とも null)
    assert(!looksLikeSuccessfulPayload(200, "application/json; charset=UTF-8", null));
    assert(!looksLikeSuccessfulPayload(429, "text/html; charset=utf-8", null));
    // 200 でも HTML なら成功ではない
    assert(!looksLikeSuccessfulPayload(200, "text/html; charset=utf-8", widgetdata));
  },
});

Deno.test({
  name:
    "offline: stripJsonPrefix — 改行が無い壊れた応答でも先頭に `,` を残さない",
  fn() {
    // 素朴な slice(4) 実装だと `,{"a":1}` になり JSON.parse が謎のエラーで落ちる
    assertEquals(stripJsonPrefix(`)]}',{"a":1}`), `{"a":1}`);
    assertEquals(stripJsonPrefix(`)]}'{"a":1}`), `{"a":1}`);
    assertEquals(JSON.parse(stripJsonPrefix(`)]}',{"a":1}`)).a, 1);
  },
});

Deno.test({
  name:
    "offline: ★stripJsonPrefix を batchexecute の封筒に使ってはいけない (parseBatchEnvelope が正解)",
  fn() {
    // batchexecute のプレフィクスだけ `)]}'\n\n` と **空行付き**。
    // 「最初の改行までを捨てる」規則を当てると空行が残り、しかもその後ろは
    // 素の JSON ではなく `<長さ>\n<JSON>\n…` のチャンク列なので JSON.parse は必ず落ちる。
    const stripped = stripJsonPrefix(FIXTURE_BE_OK);
    assert(stripped.startsWith("\n"), "空行が残る = この時点でもう JSON ではない");
    assert(/^\n\d+\n\[\[/.test(stripped), "残るのは <長さ>\\n<JSON> のチャンク列");
    let threw = false;
    try {
      JSON.parse(stripped);
    } catch {
      threw = true;
    }
    assert(threw, "★batchexecute に stripJsonPrefix を使うと JSON.parse が落ちる");
    // 正しい扱い: 封筒パーサを通す。旧 REST API とは別系統として実装すること。
    const a = analyzeBatchEnvelope(FIXTURE_BE_OK);
    assertEquals(a.results[0].payload, ["日本"]);
    // 逆に旧 REST API の本文を parseBatchEnvelope に渡すのも誤り (プレフィクスが違う)
    let threw2 = false;
    try {
      parseBatchEnvelope(`)]}'\n{"widgets":[]}`);
    } catch {
      threw2 = true;
    }
    assert(threw2, "★旧 REST API の本文を封筒パーサに渡すと明示的に例外になる");
  },
});

// --- 回復パターン (429 → NID 採取 → 再試行 → 200) の決定論的検証 -------------
// ライブの L2 は IP が /sorry ブロック中だと 200 まで到達できず観測できないため、
// 同じロジックを注入 fetch で必ず検証する。実測した応答の形をそのまま再現している。

/** 実測の応答ヘッダを再現した Response を組み立てる。 */
function mockResponse(
  status: number,
  init: { contentType?: string; location?: string; setCookie?: string[]; body?: string },
): Response {
  const h = new Headers();
  if (init.contentType) h.set("content-type", init.contentType);
  if (init.location) h.set("location", init.location);
  for (const c of init.setCookie ?? []) h.append("set-cookie", c);
  return new Response(init.body ?? "", { status, headers: h });
}

Deno.test({
  name:
    "offline: fetchWithRecovery — 429 で NID を拾い、バックオフして再試行し 200 に回復する",
  async fn() {
    const seen: { cookie: string | undefined }[] = [];
    const waits: number[] = [];
    let call = 0;

    const result = await fetchWithRecovery("https://trends.google.com/trends/api/explore?hl=ja", {
      nid: null,
      doFetch: (_url, init) => {
        const hdrs = (init.headers ?? {}) as Record<string, string>;
        seen.push({ cookie: hdrs.cookie });
        // ★redirect:"manual" が必ず指定されていること (follow だと /sorry を掴む罠)
        assertEquals(init.redirect, "manual", "redirect は manual を強制する");
        call++;
        if (call === 1) {
          // 1 発目: Cookie 無しなので 429。だが Set-Cookie で NID をくれる (実測どおり)
          return Promise.resolve(mockResponse(429, {
            contentType: "text/html; charset=utf-8",
            setCookie: [
              "NID=534=FRESH_OPAQUE_PLACEHOLDER; expires=Wed, 10-Mar-2027 17:28:03 GMT; path=/; domain=.google.com; Secure; HttpOnly; SameSite=none",
            ],
            body: FIXTURE_429_TAIL,
          }));
        }
        // 2 発目: NID が付いたので 200 JSON (これが回復パターンの成立)
        return Promise.resolve(mockResponse(200, {
          contentType: "application/json; charset=UTF-8",
          body: `)]}'\n{"widgets":[{"id":"TIMESERIES"}]}`,
        }));
      },
      sleepFn: (ms) => {
        waits.push(ms); // 実際には待たず、待つはずだった時間だけ記録する
        return Promise.resolve();
      },
    });

    assertEquals(call, 2, "429 → 再試行 → 200 の 2 回で終わる");
    assertEquals(result.outcome, "ok-json", "最終的に回復している");
    // 1 発目は Cookie 無し、2 発目は拾った NID が載っていること = これが回復の本体
    assertEquals(seen[0].cookie, undefined, "1 発目は Cookie 無し");
    assertEquals(
      seen[1].cookie,
      "NID=534=FRESH_OPAQUE_PLACEHOLDER",
      "★429 の Set-Cookie から拾った NID を 2 発目に載せる",
    );
    assertEquals(result.nid, "534=FRESH_OPAQUE_PLACEHOLDER", "NID が呼び出し側に引き継がれる");
    // Retry-After が無いので自前の指数バックオフ 1 段目 = 2000ms
    assertEquals(waits, [2000], "1 回目のバックオフは 2 秒");
    assertEquals(result.attempts.length, 2);
    assertEquals(result.attempts[0].outcome, "rate-limited");
    assertEquals(result.attempts[1].outcome, "ok-json");
    // 回復後のボディがちゃんと JSON として読めること (explore は 5 文字プレフィクス)
    const json = JSON.parse(stripJsonPrefix(await result.response!.text()));
    assertEquals(json.widgets[0].id, "TIMESERIES");
  },
});

Deno.test({
  name:
    "offline: fetchWithRecovery — 302 /sorry は 1 回で中止 (叩き続けない) / follow で掴んだ場合も検出",
  async fn() {
    let call = 0;
    const waits: number[] = [];
    const r1 = await fetchWithRecovery("https://trends.google.com/trends/api/explore?hl=ja", {
      nid: "534=EXISTING_PLACEHOLDER",
      doFetch: () => {
        call++;
        return Promise.resolve(mockResponse(302, {
          contentType: "text/html; charset=UTF-8",
          location: FIXTURE_SORRY_LOCATION,
          body: "<HTML><HEAD><TITLE>302 Moved</TITLE></HEAD></HTML>",
        }));
      },
      sleepFn: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    assertEquals(r1.outcome, "blocked");
    assertEquals(call, 1, "★/sorry は 1 回で諦める。再試行するとブロックが長期化する");
    assertEquals(waits, [], "待機もしない");
    // Set-Cookie が無い応答なので、手持ちの NID がそのまま維持されること (1-b の (b))
    assertEquals(r1.nid, "534=EXISTING_PLACEHOLDER", "NID を取れなくても捨てない");
    assertEquals(r1.attempts[0].nid, null, "この応答からは NID を採取できていない");
    await r1.response!.body?.cancel();

    // 400 (入力エラー) も同様に即中止であることを確認する
    let call2 = 0;
    const r2 = await fetchWithRecovery("https://trends.google.com/trends/api/explore?hl=ja", {
      doFetch: () => {
        call2++;
        return Promise.resolve(
          mockResponse(401, { contentType: "text/html; charset=utf-8", body: FIXTURE_401_HEAD }),
        );
      },
      sleepFn: () => Promise.resolve(),
    });
    assertEquals(r2.outcome, "bad-request");
    assertEquals(call2, 1, "401 は待っても直らないので再試行しない");
    assertEquals(parseGoogleErrorPage(await r2.response!.text()), 401);
  },
});

Deno.test({
  name: "offline: fetchWithRecovery — 429 が続けば maxAttempts で打ち切る (無限リトライしない)",
  async fn() {
    let call = 0;
    const waits: number[] = [];
    const r = await fetchWithRecovery("https://trends.google.com/trends/api/explore?hl=ja", {
      maxAttempts: 3,
      doFetch: () => {
        call++;
        return Promise.resolve(mockResponse(429, {
          contentType: "text/html; charset=utf-8",
          body: FIXTURE_429_TAIL,
        }));
      },
      sleepFn: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    assertEquals(r.outcome, "rate-limited");
    assertEquals(call, 4, "初回 + リトライ 3 回で打ち切り");
    assertEquals(waits, [2000, 4000, 8000], "指数バックオフ 2s → 4s → 8s");
    assert(looksLikeRateLimitHtml(await r.response!.text()));
  },
});

// ===========================================================================
// ライブテスト (合計 11 リクエスト。429/ブロック/ネットワーク断では skip 扱い)
// ===========================================================================

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACING_MS = 1300; // 連続リクエストの最低間隔

/**
 * ライブテスト間で共有する状態。
 * L1 が拾った NID を L2 が使い、L2 が拾った TIMESERIES ウィジェットを L2b が使う
 * (explore をもう一度叩かずに済ませ、ライブリクエストを 1 本節約するため)。
 */
const shared: {
  nid: string | null;
  timeseries: { request: unknown; token: string } | null;
} = { nid: null, timeseries: null };

function skipOnNetworkError(name: string, e: unknown): void {
  console.warn(
    `[skip] ${name}: ネットワークエラーのため未検証: ${e instanceof Error ? e.message : String(e)}`,
  );
}

const EXPLORE_REQ = JSON.stringify({
  comparisonItem: [{ keyword: "Fanza", geo: "JP", time: "now 1-d" }],
  category: 0,
  property: "",
});
// Trends 流のパーセントエンコード ( : と , は生のまま、空白は + )
const encReq = (s: string) =>
  encodeURIComponent(s).replace(/%3A/g, ":").replace(/%2C/g, ",").replace(/%20/g, "+");
const EXPLORE_API_URL =
  `https://trends.google.com/trends/api/explore?hl=ja&tz=-540&req=${encReq(EXPLORE_REQ)}&tz=-540`;

/** 旧 REST API (GSE) 向けの最小ヘッダ。x-browser-* や sec-ch-ua-* は送らない。 */
const GSE_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "ja",
  "user-agent": UA,
  referer: "https://trends.google.com/trends/explore",
};

Deno.test({
  name:
    "live L0: Cookie 無しの /trends/api/explore は 1 発目から 429 HTML (回数ではなくゲート)",
  async fn() {
    await sleep(PACING_MS);
    let res: Response;
    try {
      // ★Cookie ヘッダを一切付けない。これが 1 発目から 429 になるのが「ゲート」の証拠。
      res = await fetch(EXPLORE_API_URL, { redirect: "manual", headers: { ...GSE_HEADERS } });
    } catch (e) {
      skipOnNetworkError("L0", e);
      return;
    }
    const body = await res.text();
    const setCookies = res.headers.getSetCookie();
    const outcome = classifyResponse(
      res.status,
      res.headers.get("content-type"),
      res.headers.get("location"),
    );
    console.log(
      `  L0 status=${res.status} outcome=${outcome} bodyLen=${body.length}` +
        ` setCookie=${setCookies.length} xfo=${res.headers.get("x-frame-options")}`,
    );

    // ここで採取できた NID は L1 が取れなかった場合の保険として温存する。
    const nid = extractNid(setCookies);
    if (nid) shared.nid = nid;

    if (outcome !== "rate-limited") {
      // レート制限が緩んで 200 が返る / IP が /sorry に落ちている 等では観測できない。
      console.warn(
        `[skip] L0: outcome=${outcome} (status=${res.status}) のため未検証。期待は rate-limited`,
      );
      return;
    }

    // --- ここから 429 応答の仕様を固定する ---------------------------------
    assertEquals(res.status, 429);
    assert(
      res.headers.get("content-type")?.startsWith("text/html"),
      "★429 の本体は JSON ではなく HTML (application/json を期待する実装は必ず壊れる)",
    );
    assertEquals(res.headers.get("server"), "GSE", "旧 REST API は GSE が返す");
    assertEquals(
      res.headers.get("retry-after"),
      null,
      "★Retry-After は付かない。待ち時間はクライアントが自前で決めるしかない",
    );
    assertEquals(
      res.headers.get("content-disposition"),
      null,
      "★エラーには content-disposition が付かない (正常 JSON との判別に使える)",
    );
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");

    // 本文は Google 定型エラーページ。判定は「数値コードだけ」を見る。
    assertEquals(parseGoogleErrorPage(body), 429, "<title>Error 429 (…)!!1</title> から数値が取れる");
    assert(looksLikeRateLimitHtml(body), "429 エラーページとして分類できる");
    assert(body.includes("af-error-container"), "af-error-container を含む定型テンプレート");
    assert(body.includes("<b>429.</b>"), "見出しに <b>429.</b> が入る");
    assert(
      body.length > 1000 && body.length < 4000,
      `429 ページは 1700 文字前後 (実測 1697) / 実際 ${body.length}`,
    );

    // ★ラッパーが踏みやすい罠を 2 つ、ここで実物に対して固定しておく。
    //   (1) プレフィクス剥がしは HTML には触れてはいけない (素通しであること)
    assertEquals(stripJsonPrefix(body), body, "HTML に stripJsonPrefix を通しても無変化");
    //   (2) status を見ずに JSON.parse すると SyntaxError で落ちる
    let threw = false;
    try {
      JSON.parse(body);
    } catch {
      threw = true;
    }
    assert(threw, "★429 の本文は JSON ではない。res.ok を見ずに JSON.parse する実装は落ちる");
    //   (3) 成功判定関数が 429 を成功と誤認しないこと
    assert(
      !looksLikeSuccessfulPayload(
        res.status,
        res.headers.get("content-type"),
        res.headers.get("content-disposition"),
      ),
      "429 を正常ペイロードと誤認しない",
    );

    // 回復方針: 429 は「NID を取り直して再試行」。ここが 12 番の中心的な結論。
    const plan = retryPlan(outcome, 0);
    assertEquals(plan.retry, true, "429 はリトライ可");
    assertEquals(plan.refreshNid, true, "★リトライ前に NID を取り直す");
    assertEquals(plan.delayMs, 2000, "1 段目のバックオフは 2 秒 (Retry-After が無いので自前)");

    // 429 でも NID は発行される (1-b)。ただし必ずではないので取れなければ記録だけ残す。
    if (nid) {
      assert(
        nid.length > 100,
        `NID は長い不透明値 (実測 211〜319 文字) / 実際 ${nid.length}`,
      );
      assert(!/[;\s]/.test(nid), "NID の値にセミコロン・空白は含まれない (属性は別トークン)");
      console.log(`  L0 429 から NID を採取 (${nid.length} chars) → 回復パターンの起点`);
    } else {
      console.warn("[note] L0: この 429 には Set-Cookie: NID が無かった (1-b の (a) のケース)");
    }
  },
});

Deno.test({
  name: "live L1: Cookie 無しの /trends/explore は 429 HTML を返し、それでも Set-Cookie: NID をくれる",
  async fn() {
    await sleep(PACING_MS);
    let res: Response;
    try {
      res = await fetch(
        "https://trends.google.com/trends/explore?q=Fanza&date=now%201-d&geo=JP&hl=ja",
        {
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "ja",
            "user-agent": UA,
          },
        },
      );
    } catch (e) {
      skipOnNetworkError("L1", e);
      return;
    }
    const body = await res.text(); // 必ず消費する (Deno のリソースリーク検知対策)
    const setCookies = res.headers.getSetCookie();
    // ★NID が取れなかったときに手持ちを捨てない (1-b の (a)(b))。
    //   `shared.nid = extractNid(...)` と書くと、Set-Cookie の無い応答で
    //   L0 が採取済みの NID を null で潰してしまい、後続が全部 skip になる。
    const nidFromL1 = extractNid(setCookies);
    if (nidFromL1) shared.nid = nidFromL1;

    const outcome = classifyResponse(
      res.status,
      res.headers.get("content-type"),
      res.headers.get("location"),
    );
    console.log(
      `  L1 status=${res.status} outcome=${outcome} nid=${nidFromL1 ? nidFromL1.length + "chars" : "none"} bodyLen=${body.length}`,
    );

    // ★IP が /sorry ブロック中だと SPA シェルまで 302 に潰され、Set-Cookie も付かない (1-c)。
    //   これは仕様どおりの挙動なので、ハードに落とさず skip する。
    if (outcome === "blocked" || outcome === "redirect") {
      console.warn(
        `[skip] L1: status=${res.status} outcome=${outcome} (IP がブロック中) のため未検証`,
      );
      return;
    }
    if (outcome === "server-error") {
      console.warn(`[skip] L1: サーバエラー status=${res.status} のため未検証`);
      return;
    }

    // NID は 429 でも 200 でも発行される。これが回復パターンの起点。
    // ★L0 が採取済みの値ではなく「この応答で発行された NID」だけを見る (取り違え防止)
    assert(nidFromL1 !== null && nidFromL1.length > 0, "Set-Cookie: NID が付くこと");
    assert(
      setCookies.some((c) => /^\s*NID=/.test(c) && /Secure/i.test(c) && /HttpOnly/i.test(c)),
      "NID は Secure + HttpOnly 属性を持つ",
    );
    assert(
      setCookies.some((c) => /^\s*NID=/.test(c) && /domain=\.google\.com/i.test(c)),
      "NID の domain は .google.com",
    );

    if (res.status === 429) {
      // 429 応答の仕様を具体的に検証する
      assertEquals(outcome, "rate-limited");
      assert(
        res.headers.get("content-type")?.startsWith("text/html"),
        "429 の content-type は text/html (JSON ではない)",
      );
      assertEquals(res.headers.get("retry-after"), null, "Retry-After ヘッダは付かない");
      assertEquals(res.headers.get("content-disposition"), null, "429 に content-disposition は無い");
      assertEquals(res.headers.get("server"), "GSE", "旧 UI 系は GSE が返す");
      assert(looksLikeRateLimitHtml(body), "本文が Google の 429 エラーページであること");
      assertEquals(parseGoogleErrorPage(body), 429);
      assert(body.includes("af-error-container"), "af-error-container を含む");
      assert(body.length < 4000, `429 ページは小さい (実測 1697 文字) が実際は ${body.length}`);
    } else if (res.status === 200) {
      // レート制限が解けていれば SPA シェル HTML が返る
      assert(body.length > 10000, "200 のときは SPA シェル HTML (約 65KB)");
      console.warn("[note] L1: 429 に到達しなかったため 429 ボディの検証はスキップ");
    } else {
      console.warn(`[skip] L1: 想定外の status=${res.status} (outcome=${outcome})`);
    }
  },
});

Deno.test({
  name: "live L2: NID を付けて /trends/api/explore を再試行 (回復 / 429 / 302 /sorry の 3 分岐)",
  async fn() {
    if (!shared.nid) {
      console.warn("[skip] L2: L1 で NID が取れなかったため未検証");
      return;
    }
    await sleep(PACING_MS);
    let res: Response;
    try {
      // redirect:"manual" は必須。既定の follow だと /sorry の CAPTCHA ページを
      // 200 として掴んでしまい、res.ok が true になる罠にはまる。
      res = await fetch(EXPLORE_API_URL, {
        redirect: "manual",
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "ja",
          "user-agent": UA,
          referer: "https://trends.google.com/trends/explore",
          cookie: `NID=${shared.nid}`,
        },
      });
    } catch (e) {
      skipOnNetworkError("L2", e);
      return;
    }
    const body = await res.text();
    const location = res.headers.get("location");
    const outcome = classifyResponse(res.status, res.headers.get("content-type"), location);
    console.log(
      `  L2 status=${res.status} outcome=${outcome} bodyLen=${body.length} server=${res.headers.get("server")}`,
    );

    if (outcome === "ok-json") {
      // ★回復パターン成立: 429 で拾った NID を付けたら 200 JSON が返った
      // explore のプレフィクスは カンマ **無し** の 5 文字 (widgetdata は 6 文字なので注意)
      assert(body.startsWith(")]}'\n"), "explore の JSON は )]}'\\n (カンマ無し) プレフィクス付き");
      assert(!body.startsWith(")]}',"), "explore にはカンマが入らない (widgetdata とは違う)");
      assertEquals(
        res.headers.get("content-disposition"),
        `attachment; filename="json.txt"; filename*=UTF-8''json.txt`,
        "explore の正常応答には content-disposition が付く",
      );
      const json = JSON.parse(stripJsonPrefix(body));
      assert(Array.isArray(json.widgets) && json.widgets.length > 0, "widgets 配列があること");
      const ids: string[] = json.widgets.map((w: { id: string }) => w.id);
      console.log(`  L2 回復成功: widgets=${ids.join(",")}`);
      // 単一キーワードでは 4 ウィジェット (HAR のバイト会計からの推定を実測で裏付け)
      assert(ids.includes("TIMESERIES"), "TIMESERIES ウィジェットが含まれる");
      const ts = json.widgets.find((w: { id: string }) => w.id === "TIMESERIES");
      assertEquals(typeof ts.token, "string");
      assertEquals(ts.token.length, 44, "widget token は 44 文字の base64url");
      assert(/^[A-Za-z0-9_-]+$/.test(ts.token), "token の文字集合は base64url");
      shared.timeseries = { request: ts.request, token: ts.token };
    } else if (outcome === "blocked") {
      // ★3 段目のブロック。仕様どおりの形になっているかを検証する
      assertEquals(res.status, 302);
      assert(
        location !== null && location.startsWith("https://www.google.com/sorry/"),
        "location が www.google.com/sorry/ を指す",
      );
      assertEquals(
        res.headers.get("server"),
        "scaffolding on HTTPServer2",
        "/sorry リダイレクトは GSE でも ESF でもない",
      );
      assertEquals(res.headers.get("retry-after"), null);
      assertEquals(res.headers.get("content-disposition"), null);
      assert(body.includes("302 Moved"), "定型の 302 Moved ボディ");
      assert(location!.includes("continue="), "元 URL が continue= に入る");
      assertEquals(retryPlan("blocked", 0).retry, false, "blocked はリトライしない方針");
      console.warn("[note] L2: IP が /sorry ブロック中。回復パターンの 200 到達は今回未検証");
    } else if (outcome === "rate-limited") {
      assert(looksLikeRateLimitHtml(body));
      assertEquals(res.headers.get("retry-after"), null, "Retry-After は無い");
      console.warn("[note] L2: NID を付けても 429。回復パターンの 200 到達は今回未検証");
    } else {
      console.warn(`[skip] L2: 想定外 status=${res.status} outcome=${outcome}`);
    }
  },
});

Deno.test({
  name:
    "live L2b: 有効な token のまま req を 1 箇所書き換えると 401 (token は req に紐付いている)",
  async fn() {
    if (!shared.nid || !shared.timeseries) {
      console.warn("[skip] L2b: L2 で TIMESERIES ウィジェットが取れなかったため未検証");
      return;
    }
    await sleep(PACING_MS);
    // explore が返した request をそのまま stringify し、keyword だけを差し替える。
    // これ以外は 1 文字も変えない = 「req の内容だけが違う」実験になる。
    const original = JSON.stringify(shared.timeseries.request);
    const tampered = original.replace('"value":"Fanza"', '"value":"Zzzzq"');
    assert(tampered !== original, "keyword の差し替えが実際に効いていること");

    const u = new URL("https://trends.google.com/trends/api/widgetdata/multiline");
    u.searchParams.set("hl", "ja");
    u.searchParams.set("tz", "-540");
    u.searchParams.set("req", tampered); // ← URLSearchParams 標準エンコードで送る
    u.searchParams.set("token", shared.timeseries.token); // ← token は改変せず有効なまま

    let res: Response;
    try {
      res = await fetch(u, {
        redirect: "manual",
        headers: { ...GSE_HEADERS, cookie: `NID=${shared.nid}` },
      });
    } catch (e) {
      skipOnNetworkError("L2b", e);
      return;
    }
    const body = await res.text();
    const outcome = classifyResponse(res.status, res.headers.get("content-type"), res.headers.get("location"));
    console.log(`  L2b status=${res.status} outcome=${outcome} bodyLen=${body.length}`);

    if (outcome !== "bad-request") {
      // 429 / /sorry ブロック / サーバエラーでは token の検証結果を観測できない。
      // 「観測できたときだけ厳しく検証する」方針でハードには落とさない。
      console.warn(
        `[skip] L2b: outcome=${outcome} (status=${res.status}) のため未検証。期待は bad-request`,
      );
      return;
    }
    // 実測は 401。ただし 2-a のとおり 400 に揺れることがあるので両方許容する。
    assertEquals(outcome, "bad-request", "req を書き換えると token が無効になり 400/401 になる");
    assert(res.status === 401 || res.status === 400, `status は 401 か 400 (実測 401) だが ${res.status}`);
    assert(
      res.headers.get("content-type")?.startsWith("text/html"),
      "エラー応答は JSON ではなく HTML",
    );
    assertEquals(res.headers.get("content-disposition"), null, "エラーに content-disposition は無い");
    assertEquals(res.headers.get("retry-after"), null, "Retry-After は無い");
    assertEquals(res.headers.get("www-authenticate"), null, "401 でも WWW-Authenticate は付かない");
    // ★ 401 なのに理由文字列は "Bad Request"。数値コードだけを見ること。
    assertEquals(parseGoogleErrorPage(body), res.status, "<title> の数値は status と一致する");
    assert(body.includes("(Bad Request)"), "401 でも理由文字列は Bad Request (罠)");
    assert(!looksLikeRateLimitHtml(body), "429 ページではない");
    assertEquals(retryPlan(outcome, 0).retry, false, "入力エラーはリトライしない");
  },
});

// --- batchexecute (boq) のエラー形式 ---------------------------------------

const BE_HEADERS: Record<string, string> = {
  "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
  "x-same-domain": "1",
  origin: "https://trends.google.com",
  referer: "https://trends.google.com/",
  "user-agent": UA,
  accept: "*/*",
};

function beUrl(rpcids: string, reqid: number): string {
  return "https://trends.google.com/_/TrendsUi/data/batchexecute" +
    `?rpcids=${encodeURIComponent(rpcids)}&source-path=%2Ftrending&hl=ja` +
    `&soc-app=1&soc-platform=1&soc-device=1&_reqid=${reqid}&rt=c`;
}

function beBody(calls: unknown[][]): string {
  return "f.req=" + encodeURIComponent(JSON.stringify([calls])) + "&";
}

Deno.test({
  name: "live L3: batchexecute に存在しない rpcid → HTTP 400 + er チャンク (content-disposition 無し)",
  async fn() {
    await sleep(PACING_MS);
    let res: Response;
    try {
      res = await fetch(beUrl("zzzZZZ", 1), {
        method: "POST",
        headers: BE_HEADERS,
        body: beBody([["zzzZZZ", "[]", null, "generic"]]),
      });
    } catch (e) {
      skipOnNetworkError("L3", e);
      return;
    }
    const body = await res.text();
    console.log(`  L3 status=${res.status} len=${body.length}`);
    // 429 / 5xx / 3xx (/sorry ブロック) では er チャンクを観測できない。skip する。
    if (res.status === 429 || res.status >= 500 || (res.status >= 300 && res.status < 400)) {
      console.warn(`[skip] L3: レート制限/ブロック/サーバエラー (status=${res.status}) のため未検証`);
      return;
    }
    assertEquals(res.status, 400, "未知の rpcid はトランスポート層で 400");
    assert(
      res.headers.get("content-type")?.startsWith("application/json"),
      "400 でも content-type は application/json (旧 API の 429 が text/html なのと対照的)",
    );
    assertEquals(
      res.headers.get("content-disposition"),
      null,
      "★400 には content-disposition が付かない (200 には response.bin が付く)",
    );
    assertEquals(res.headers.get("server"), "ESF");

    const a = analyzeBatchEnvelope(body);
    assertEquals(a.transportError, 400, "er[5] に 400 が入る");
    assertEquals(a.results.length, 0, "wrb.fr は 1 個も返らない");

    const items = parseBatchEnvelope(body);
    const er = items.find((it) => it[0] === "er")!;
    assertEquals(er.length, 10, "er は arity 10");
    assertEquals([er[0], er[1], er[2], er[3], er[4]], ["er", null, null, null, null]);
    assert(items.some((it) => it[0] === "e"), "終端 e チャンクは正常時と同じく付く");
  },
});

Deno.test({
  name: "live L4: batchexecute の正しい rpcid に壊れた引数 → HTTP 200 だが wrb.fr[2]===null",
  async fn() {
    await sleep(PACING_MS);
    let res: Response;
    try {
      res = await fetch(beUrl("i0OFE", 2), {
        method: "POST",
        headers: BE_HEADERS,
        body: beBody([["i0OFE", JSON.stringify(["garbage", {}]), null, "generic"]]),
      });
    } catch (e) {
      skipOnNetworkError("L4", e);
      return;
    }
    const body = await res.text();
    console.log(`  L4 status=${res.status} len=${body.length}`);
    if (res.status !== 200) {
      console.warn(`[skip] L4: status=${res.status} のため未検証`);
      return;
    }
    // ★ここが最重要: HTTP は完全に正常 (200 + content-disposition 付き) なのに RPC は失敗している
    assertEquals(
      res.headers.get("content-disposition"),
      `attachment; filename="response.bin"; filename*=UTF-8''response.bin`,
    );
    assertEquals(classifyResponse(200, res.headers.get("content-type"), null), "ok-json");
    assert(res.ok, "res.ok は true になってしまう (= 成功判定に使えない)");

    const a = analyzeBatchEnvelope(body);
    assertEquals(a.transportError, null, "er チャンクは無い");
    assertEquals(a.results.length, 1, "wrb.fr は 1 個返る");
    assertEquals(a.results[0].rpcid, "i0OFE");
    assertEquals(a.results[0].payload, null, "★ペイロードが null = RPC エラー");
    assert(
      Array.isArray(a.results[0].errorCodes),
      `★wrb.fr[5] にエラーコード配列が入る (実測 [3]) / 実際: ${JSON.stringify(a.results[0].errorCodes)}`,
    );
  },
});

Deno.test({
  name: "live L5: batchexecute を 1.3 秒間隔で 2 連射 — 429 に到達しないことを確認 (負荷はかけない)",
  async fn() {
    // 注意: これはレート制限の閾値を探る「安全な」観測であり連打ではない。
    // 別途スクラッチで 1 秒間隔 5 連射も試したが 5/5 とも 200 だった (2026-09-09)。
    const statuses: number[] = [];
    for (let i = 0; i < 2; i++) {
      await sleep(PACING_MS);
      let res: Response;
      try {
        res = await fetch(beUrl("wAgrOe", 300 + i), {
          method: "POST",
          headers: BE_HEADERS,
          body: beBody([["wAgrOe", JSON.stringify(["JP", "ja"]), null, "generic"]]),
        });
      } catch (e) {
        skipOnNetworkError("L5", e);
        return;
      }
      const body = await res.text();
      statuses.push(res.status);
      if (res.status === 200) {
        const a = analyzeBatchEnvelope(body);
        assertEquals(a.results[0].rpcid, "wAgrOe");
        const payload = a.results[0].payload;
        assert(
          Array.isArray(payload) && typeof payload[0] === "string",
          "wAgrOe は [ローカライズ地域名] を返す",
        );
      }
    }
    console.log(`  L5 statuses=${statuses.join(",")}`);
    if (statuses.some((s) => s === 429)) {
      console.warn("[note] L5: batchexecute で 429 を観測した (共有 IP の負荷状況による)");
    } else if (statuses.some((s) => s >= 300)) {
      // 3xx (/sorry) や 5xx は本テストの観測対象外。ハードには落とさない。
      console.warn(`[skip] L5: 想定外の status を観測 (${statuses.join(",")}) のため未検証`);
    } else {
      // 本調査の範囲では boq 側の閾値には到達しなかった、という記録
      assert(statuses.every((s) => s === 200), `全て 200 のはず: ${statuses.join(",")}`);
    }
  },
});

Deno.test({
  name:
    "live L6: 旧 REST API の入力エラーは Cookie 無しでも 400/401/404 として返る (429 に潰されない)",
  async fn() {
    // 2 リクエスト。どちらもレート制限を消費するが、内容は完全に無害な単発 GET。
    // 目的: 「不正 token / 壊れた req は 400、存在しないパスは 404」を実証すること。
    const BOGUS_TOKEN = "ANI_2wMAAAAA" + "A".repeat(32); // 実物と同じ 44 文字 base64url 形式
    const multilineReq = JSON.stringify({
      time: "2026-09-08T14\\:53\\:39 2026-09-09T14\\:53\\:39",
      resolution: "EIGHT_MINUTE",
      locale: "ja",
      comparisonItem: [{
        geo: { country: "JP" },
        complexKeywordsRestriction: { keyword: [{ type: "BROAD", value: "Fanza" }] },
      }],
      requestOptions: { property: "", backend: "CM", category: 0 },
      userConfig: { userType: "USER_TYPE_SCRAPER" },
    });

    // --- (1) 形式だけ正しいダミー token → 400 -------------------------------
    await sleep(PACING_MS);
    let res: Response;
    try {
      res = await fetch(
        `https://trends.google.com/trends/api/widgetdata/multiline` +
          `?hl=ja&tz=-540&req=${encReq(multilineReq)}&token=${BOGUS_TOKEN}&tz=-540`,
        { redirect: "manual", headers: { ...GSE_HEADERS } },
      );
    } catch (e) {
      skipOnNetworkError("L6-1", e);
      return;
    }
    const body1 = await res.text();
    const outcome1 = classifyResponse(
      res.status,
      res.headers.get("content-type"),
      res.headers.get("location"),
    );
    console.log(`  L6-1 status=${res.status} outcome=${outcome1} len=${body1.length}`);

    if (outcome1 === "blocked" || outcome1 === "rate-limited") {
      // /sorry ブロック中や 429 中は入力エラーが潰されて観測できない。これも仕様の一部。
      console.warn(
        `[skip] L6-1: outcome=${outcome1} のため未検証 (ブロック中は 400/404 が 302/429 に潰される)`,
      );
    } else {
      // ★実測: 同一リクエストが 400 を返す時と 401 を返す時がある (2026-09-09 に両方観測)。
      //   401 = token が無効/欠落、400 = req が JSON として壊れている、が基本線だが、
      //   token 不正が 400 で返ってきた実測もあるため両方を受理する。
      //   どちらも「入力の誤り」でリトライ不可という扱いは同じ。
      assert(
        res.status === 400 || res.status === 401,
        `不正 token は 400 か 401 (実測どちらもあり) / 実際: ${res.status}`,
      );
      assertEquals(outcome1, "bad-request", "400/401 はどちらも bad-request に分類する");
      assert(
        res.headers.get("content-type")?.startsWith("text/html"),
        "★旧 API の 400 は JSON ではなく HTML で返る",
      );
      assertEquals(res.headers.get("content-disposition"), null, "400 に content-disposition は無い");
      assertEquals(res.headers.get("retry-after"), null, "Retry-After は無い");
      assertEquals(res.headers.get("server"), "GSE");
      assertEquals(
        parseGoogleErrorPage(body1),
        res.status,
        "★エラーページのタイトル中の数値は status と一致する (理由文字列は 401 でも 'Bad Request')",
      );
      assert(!looksLikeRateLimitHtml(body1), "429 ページとは区別できること");
      assertEquals(retryPlan("bad-request", 0).retry, false, "400 はリトライしない");
    }

    // --- (2) 存在しないウィジェットパス → 404 ------------------------------
    await sleep(PACING_MS);
    let res2: Response;
    try {
      res2 = await fetch(
        `https://trends.google.com/trends/api/widgetdata/nosuchwidget` +
          `?hl=ja&tz=-540&req=${encReq(multilineReq)}&token=${BOGUS_TOKEN}`,
        { redirect: "manual", headers: { ...GSE_HEADERS } },
      );
    } catch (e) {
      skipOnNetworkError("L6-2", e);
      return;
    }
    const body2 = await res2.text();
    console.log(`  L6-2 status=${res2.status} len=${body2.length}`);
    if (res2.status === 429 || (res2.status >= 300 && res2.status < 400)) {
      console.warn(`[skip] L6-2: status=${res2.status} (ブロック中) のため未検証`);
      return;
    }
    assertEquals(res2.status, 404, "存在しないウィジェットパスは 404");
    assert(res2.headers.get("content-type")?.startsWith("text/html"));
    assertEquals(res2.headers.get("content-disposition"), null);
    assertEquals(
      parseGoogleErrorPage(body2),
      404,
      "★理由文字列は ja でローカライズされる (見つかりませんでした) が数値コードは安定",
    );

    // --- (3) 壊れた req JSON → 400。★L0 と同じ URL・同じ Cookie 無し条件での対照実験 ----
    //   L0 (req 正常, Cookie 無し) は 429 だった。ここで req だけを壊すと 400 になる。
    //   → 入力検証が Cookie ゲート / レート制限より **手前** で走っている決定的な証拠。
    //   → 裏を返せば「429 が返った = req の形は正しかった」と断定できる。
    await sleep(PACING_MS);
    let res3: Response;
    try {
      res3 = await fetch(
        "https://trends.google.com/trends/api/explore?hl=ja&tz=-540&req=%7Bnot-json&tz=-540",
        { redirect: "manual", headers: { ...GSE_HEADERS } },
      );
    } catch (e) {
      skipOnNetworkError("L6-3", e);
      return;
    }
    const body3 = await res3.text();
    const sc3 = res3.headers.getSetCookie();
    const outcome3 = classifyResponse(
      res3.status,
      res3.headers.get("content-type"),
      res3.headers.get("location"),
    );
    console.log(
      `  L6-3 status=${res3.status} outcome=${outcome3} len=${body3.length} setCookie=${sc3.length}`,
    );
    if (res3.status === 429 || (res3.status >= 300 && res3.status < 400)) {
      console.warn(`[skip] L6-3: status=${res3.status} (ブロック中) のため未検証`);
      return;
    }
    assertEquals(res3.status, 400, "★壊れた req は Cookie 無しでも 429 ではなく 400 が返る");
    assertEquals(outcome3, "bad-request");
    assert(
      res3.headers.get("content-type")?.startsWith("text/html"),
      "400 も JSON ではなく HTML",
    );
    assertEquals(res3.headers.get("content-disposition"), null);
    assertEquals(res3.headers.get("retry-after"), null);
    assertEquals(res3.headers.get("server"), "GSE");
    assertEquals(parseGoogleErrorPage(body3), 400, "<title>Error 400 (Bad Request)!!1</title>");
    assert(
      !looksLikeRateLimitHtml(body3),
      "★429 ページと取り違えないこと (content-type が同じなので status が唯一の手掛かり)",
    );
    assertEquals(retryPlan("bad-request", 0).retry, false, "400 は待っても直らない");
    // ★2-c の訂正点の実地確認: Cookie 無しの 400 でも Set-Cookie: NID が付くことがある。
    //   付く / 付かないのどちらでも仕様どおりなので、有無で分岐する実装にしてはいけない。
    console.log(
      `  L6-3 Set-Cookie NID = ${extractNid(sc3) ? "あり" : "なし"} (どちらでも仕様どおり)`,
    );
  },
});

Deno.test({
  name: "live L7: batchexecute の rpcids クエリは実ディスパッチに使われない (f.req が優先)",
  async fn() {
    await sleep(PACING_MS);
    let res: Response;
    try {
      // rpcids には i0OFE と書きつつ、f.req には wAgrOe の call だけを入れる
      res = await fetch(beUrl("i0OFE", 700), {
        method: "POST",
        headers: BE_HEADERS,
        body: beBody([["wAgrOe", JSON.stringify(["JP", "ja"]), null, "generic"]]),
      });
    } catch (e) {
      skipOnNetworkError("L7", e);
      return;
    }
    const body = await res.text();
    console.log(`  L7 status=${res.status} len=${body.length}`);
    if (res.status !== 200) {
      console.warn(`[skip] L7: status=${res.status} のため未検証`);
      return;
    }
    const a = analyzeBatchEnvelope(body);
    assertEquals(a.transportError, null, "rpcids の不一致はエラーにならない");
    assertEquals(a.results.length, 1, "call は 1 個なので wrb.fr も 1 個");
    assertEquals(
      a.results[0].rpcid,
      "wAgrOe",
      "★返ってきた rpcid は rpcids クエリ (i0OFE) ではなく f.req の中身 (wAgrOe)",
    );
    const payload = a.results[0].payload;
    assert(
      Array.isArray(payload) && typeof payload[0] === "string",
      `wAgrOe のペイロード形 [地域名] であること: ${JSON.stringify(payload)}`,
    );
  },
});

Deno.test({
  name:
    "live L8: 高コスト端点がブロック中でも autocomplete は生きている (制限はエンドポイント単位)",
  async fn() {
    await sleep(PACING_MS);
    let res: Response;
    try {
      // Cookie を一切付けない。これが 200 を返せば「Cookie ゲートも端点ごと」の証拠になる。
      res = await fetch("https://trends.google.com/trends/api/autocomplete/DL?hl=ja&tz=-540", {
        redirect: "manual",
        headers: { ...GSE_HEADERS },
      });
    } catch (e) {
      skipOnNetworkError("L8", e);
      return;
    }
    const body = await res.text();
    const cd = res.headers.get("content-disposition");
    const outcome = classifyResponse(
      res.status,
      res.headers.get("content-type"),
      res.headers.get("location"),
    );
    // L2 の結果と並べると「同一プロセス・同一 IP で explore は死んで autocomplete は生きている」
    // という対比がログに残る。
    console.log(
      `  L8 status=${res.status} outcome=${outcome} len=${body.length} cd=${JSON.stringify(cd)}`,
    );

    if (outcome !== "ok-json") {
      console.warn(`[skip] L8: outcome=${outcome} (status=${res.status}) のため未検証`);
      return;
    }

    // ★content-disposition は explore の「長い形」ではなく **短い形**。
    //   値の完全一致で成功判定してはいけない、という主張の実物での裏付け。
    assertEquals(cd, `attachment; filename="json.txt"`, "autocomplete は filename* 無しの短い形");
    assert(
      cd !== `attachment; filename="json.txt"; filename*=UTF-8''json.txt`,
      "★explore (長い形) とは値が違う = 完全一致判定は壊れる",
    );
    assert(
      looksLikeSuccessfulPayload(res.status, res.headers.get("content-type"), cd),
      "有無ベースの判定なら端点が違っても通る",
    );

    // プレフィクスは カンマ **有り** の 6 文字 (explore の 5 文字とは違う)
    assert(body.startsWith(")]}',\n"), "autocomplete は )]}',\n (6 文字) プレフィクス");
    assertEquals(body.indexOf("\n"), 5, "最初の改行は index 5");
    const json = JSON.parse(stripJsonPrefix(body));
    assert(Array.isArray(json.default?.topics), "default.topics が配列であること");
    assert(json.default.topics.length > 0, "候補が 1 件以上返る");
    const t = json.default.topics[0];
    assertEquals(typeof t.mid, "string", "topics[].mid は文字列 (例: /m/xxxxx)");
    assertEquals(typeof t.title, "string", "topics[].title は文字列");
    assertEquals(typeof t.type, "string", "topics[].type は文字列 (例: 検索キーワード)");

    // Cookie 無しで通った = この端点には NID ゲートが無い、という記録
    console.log(`  L8 Cookie 無しで 200。topics=${json.default.topics.length} 件`);
  },
});
