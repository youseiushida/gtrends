// 実行: deno test --allow-net --no-check live_integration/01_session_bootstrap_test.ts
//
// ============================================================================
// Google Trends — セッション / Cookie ブートストラップ仕様
// ----------------------------------------------------------------------------
// ライブ検証日: 2026-09-09 (日本の一般家庭 IP、未ログイン、Deno 2.9.6 の素の fetch)
// HAR 根拠: C:\Users\ushid\Documents\gtrend_claude\.har\trends.google.com.har
//           抽出コーパス .har\extracted\ の以下グループ
//             - trends_explore/00_entry040.txt 〜 07_entry269.txt (8 件, GET /trends/explore の HTML)
//             - TrendsUi_browserinfo/00_entry005.txt, 01_entry350.txt
//             - trends_api_explore/ (13 件), trends_api_widgetdata_*/ , trends_api_autocomplete_*/
//             - TrendsUi_data_batchexecute/ (27 件)
//           ※ HAR には Set-Cookie が 1 件も無い (キャプチャ開始時点で Cookie 確立済みだったため)。
//              したがって「NID をどこで取得するか」は本ファイルのライブ検証が唯一の根拠である。
//
// ============================================================================
// 1. 結論サマリ (ラッパー実装者向け)
// ============================================================================
//
//  Google Trends の「認証」はログインではなく、**Google が発行した NID Cookie を持っているか**
//  だけである。OAuth も API キーも XSRF トークンも存在しない (HAR 全 111 リクエストのヘッダに
//  authorization / x-goog-* / x-client-data は 1 つも無い)。
//
//  そして NID が要るのは **旧 REST API のうち /trends/api/explore と /trends/explore(HTML) だけ**。
//  それ以外はすべて Cookie 無しで通る。実測マトリクス:
//
//   | エンドポイント                          | Cookie 無し | NID 付き | 備考                          |
//   |----------------------------------------|-------------|----------|-------------------------------|
//   | GET  /trends/explore (HTML)            | 429         | 200      | NID 必須                      |
//   | GET  /trends/api/explore               | 429         | 200      | NID 必須 (ウィジェット取得)   |
//   | GET  /trends/api/widgetdata/multiline  | 200         | 200      | **Cookie 不要 / token 必須**  |
//   | GET  /trends/api/autocomplete/<kw>     | 200         | 200      | Cookie 不要                   |
//   | GET  /trends/api/explore/pickers/geo   | 200         | 200      | Cookie 不要                   |
//   | POST /_/TrendsUi/data/batchexecute     | 200         | 200      | Cookie 不要 (ヘッダも不要)    |
//   | GET  /trending (HTML, 新 UI)           | 200         | 200      | Cookie 不要                   |
//
//  → つまり **NID が要るのは「explore のウィジェット定義 (token) を 1 回取りに行くとき」だけ**。
//    token は 24 時間有効 (HAR の 54 個の token を全数デコードして確認済み。
//    抽出コーパスの widgetdata 系 108 リクエストに含まれる token の *ユニーク数* がちょうど 54、
//    かつ 54 個すべてが固定ヘッダ `ANI_2wMAAAAA` で始まることを再確認済み) なので、
//    NID の必要頻度は 1 日 1 回程度まで下げられる。
//
//  補足: 単一キーワードの explore が返すウィジェットが 4 件であることは、HAR 側からも裏が取れる。
//    抽出コーパスの widgetdata リクエスト数は
//      multiline 26 件 / comparedgeo 30 件 / relatedsearches 52 件。
//    relatedsearches がちょうど multiline の 2 倍 (52 = 26 × 2) なのは、
//    **RELATED_TOPICS と RELATED_QUERIES が同じ /widgetdata/relatedsearches エンドポイントを
//    共有している**ため。つまり 1 回の explore に対し
//      TIMESERIES → multiline、GEO_MAP → comparedgeo、
//      RELATED_TOPICS + RELATED_QUERIES → relatedsearches ×2
//    の計 4 ウィジェットが対応する。(comparedgeo が 30 件と多いのは、地域粒度を変えて
//    再取得する UI 操作が HAR に含まれるため。)
//
// ============================================================================
// 2. NID Cookie の取得方法
// ============================================================================
//
//  2-1. どの URL から取れるか (2026-09-09 実測)
//
//   | URL                                                  | status | Set-Cookie: NID | body サイズ |
//   |------------------------------------------------------|--------|-----------------|-------------|
//   | GET https://trends.google.com/                       | 301    | **なし**        | 230 B       |
//   | GET https://trends.google.com/trends/                | 200    | あり            | 662 KB      |
//   | GET https://trends.google.com/trends/explore?...     | 429    | あり            | 1,697 B     |
//   | GET https://trends.google.com/trends/api/explore?... | 429    | **あり**        | 1,697 B     |
//   | GET https://trends.google.com/trending?geo=..&hl=..  | 200    | あり            | 1.22 MB     |
//   | GET https://www.google.com/                          | 200    | あり            | 227 KB      |
//
//   **推奨: 目的の /trends/api/explore をそのまま Cookie 無しで叩き、返ってきた 429 の
//   Set-Cookie から NID を拾って、同じ URL をもう一度叩く。**
//   理由: (a) 転送量が最小 (1.7 KB)、(b) 余計な URL を叩かないのでリクエスト数が増えない、
//         (c) 「NID が無い ⇒ 429」「NID がある ⇒ 200」という因果がそのまま実装フローになる。
//   www.google.com からも NID は取れる (Domain=.google.com なので trends.google.com にも送れる)
//   が、227 KB を無駄に落とすうえ AEC / SEARCH_SAMESITE / __Secure-STRP も一緒に降ってくるので
//   使う理由がない。**https://trends.google.com/ (ルート) は 301 を返すだけで NID を発行しない**
//   ので、ブートストラップ先に選んではいけない (server も sffe で Trends の実体ではない)。
//
//  2-2. Set-Cookie: NID の属性 (実測、複数回とも同一)
//
//     NID=<不透明値>; expires=Wed, 10-Mar-2027 15:50:58 GMT; path=/; domain=.google.com;
//     Secure; HttpOnly; SameSite=none
//
//   - Max-Age は無く expires 絶対時刻のみ。実測で **発行から約 6 か月 (183 日)** 先。
//   - domain=.google.com なので www.google.com で得た NID を trends.google.com に送れる (逆も可)。
//   - path=/ なので Trends 配下すべてに送られる。
//   - HttpOnly / Secure / SameSite=none。Deno の fetch には Cookie ジャーが無いので
//     **自分で Set-Cookie をパースして保持し、次のリクエストの cookie ヘッダに載せる必要がある**。
//   - 落とし穴: **User-Agent ヘッダを一切送らないと、Set-Cookie の属性から Secure と
//     SameSite=none が消えて `path=/; domain=.google.com; HttpOnly` だけになる** (実測)。
//     Cookie の値自体は有効なのでパーサが属性に依存していなければ実害は無いが、
//     `Secure` が必ず付く前提のパーサを書くと壊れる。
//
//  2-3. NID の値の形式 — **不透明。中身を解釈してはいけない。**
//   実測で 2 系統が混在して降ってくる (どちらのフロントエンドに当たったかで変わるらしい):
//     (a) `534=<base64url風の英数字>`  … 長さ 211〜212 文字
//     (b) `CuoBCA…` / `CuwBCA…` / `CvoBCA…` (base64 protobuf 風) … 長さ 316〜319 文字
//   どちらの形式でも /trends/api/explore が 200 になることを実測済み。
//   長さも形式も固定ではないので、**バリデーションを書かず生文字列としてそのまま持ち回ること**。
//
//  2-4. **NID の「値」は本当に検証されている** (重要)
//   `cookie: NID=abc123deadbeef` のようなデタラメな値を送ると **429 のまま**。
//   つまり「NID という名前の Cookie が付いていればよい」のではなく、
//   **サーバが発行した本物の NID である必要がある**。ダミー値でのバイパスは不可。
//
//  2-5. NID は毎レスポンスで再発行される
//   200 応答にも 429 応答にも 401 応答にも毎回 Set-Cookie: NID が付く。値は同じこともあれば
//   違うこともある。**毎レスポンスの Set-Cookie で手元の NID を更新する**実装が安全
//   (ブラウザと同じ挙動になる)。更新しなくても数十リクエストは同じ NID で通ることを実測済み。
//
//  2-6. CONSENT Cookie / consent.google.com へのリダイレクトは発生しない
//   日本 (非 EU/非 UK) の IP からは、上記のどの URL でも consent.google.com への 302 は起きず、
//   CONSENT Cookie も一切降ってこない。HAR 全 456 エントリを走査しても
//   consent.google.com へのリクエストは 0 件、CONSENT Cookie も 0 件
//   (唯一 "consent" を含むのは gstatic の cookie_consent_bar.v3.js = クライアント側バナー JS)。
//   **EU/UK/スイスの IP からは CONSENT フローが挟まる可能性が高いが、本環境では未検証。**
//   ラッパーは「30x で consent.google.com に飛ばされたら明示的なエラーを投げる」程度の
//   防御を入れておくとよい。
//
// ============================================================================
// 3. 必要な最小リクエストヘッダ (1 つずつ落として実測)
// ============================================================================
//
//  結論: **どのエンドポイントも「ヘッダは実質何も要らない」。必要なのは cookie: NID だけ。**
//
//  - GET /trends/api/explore は `cookie: NID=<本物>` **だけ**あれば 200。
//    user-agent なし (Deno のデフォルト UA)、accept なし、referer なし、accept-language なし、
//    origin なし、x-browser-validation なし ― すべて省いて 200 が返ることを実測。
//  - POST /_/TrendsUi/data/batchexecute は `content-type:
//    application/x-www-form-urlencoded;charset=UTF-8` **だけ**で 200。
//    x-same-domain / origin / referer / user-agent / cookie を全部落としても、
//    ブラウザ相当のフルヘッダで送った場合とバイト単位でほぼ同一のレスポンスが返る
//    (15,527 文字 vs 15,527 文字)。→ **x-same-domain: 1 は必須ではない** (HAR ではブラウザが
//    必ず送っているが、サーバは要求していない)。
//  - accept-language は結果に影響しない。`accept-language: ja` と `en-US,en;q=0.9` で
//    レスポンス長・内容とも同一。**言語を決めるのは URL の hl パラメータであってヘッダではない。**
//  - x-browser-validation / x-browser-year / x-browser-channel / x-browser-copyright /
//    sec-ch-ua-* は Chrome が内部的に付ける定数で、**送らなくても通る。偽装すべきでない**
//    (UA との不整合を作るだけで、フィンガープリント上むしろ目立つ)。
//
//  それでも実装で送ることを推奨するヘッダ (害が無く、ブラウザに寄せておく保険):
//    共通:            user-agent: <普通の Chrome UA>
//    /trends/api/*:   accept: application/json, text/plain, */*
//                     referer: https://trends.google.com/trends/explore
//                     cookie: NID=<値>            ← explore 系のみ必須
//    batchexecute:    content-type: application/x-www-form-urlencoded;charset=UTF-8
//                     origin: https://trends.google.com
//                     referer: https://trends.google.com/
//                     x-same-domain: 1
//  ※ user-agent を送る実務上の理由は §2-2 の Set-Cookie 属性の差だけでなく、
//    「UA 無しのクライアントは将来的に締められやすい」という一般論。
//
// ============================================================================
// 4. レスポンスの見分け方 / エラー形式
// ============================================================================
//
//  4-1. XSSI プレフィックスは **エンドポイントごとに違う** (実測、要注意)
//     GET  /trends/api/explore              → ")]}'\n"   (5 バイト、カンマ無し)
//     GET  /trends/api/explore/pickers/geo  → ")]}'\n"   (5 バイト、カンマ無し)
//     GET  /trends/api/widgetdata/multiline → ")]}',\n"  (6 バイト、**カンマ有り**)
//     GET  /trends/api/autocomplete/<kw>    → ")]}',\n"  (6 バイト、**カンマ有り**)
//     POST /_/TrendsUi/data/batchexecute    → ")]}'\n\n" (6 バイト、LF 2 個)
//   → ハードコードせず「最初の \n までを捨てる」`text.slice(text.indexOf("\n") + 1)` が安全。
//
//  4-1b. レスポンスヘッダによる系統の見分け (HAR の抽出コーパスで全数確認済み)
//
//   | エンドポイント          | server | content-disposition        | cache-control (200 時)                        |
//   |------------------------|--------|----------------------------|-----------------------------------------------|
//   | /trends/api/explore     | GSE    | filename="json.txt" **+ filename*** | no-cache, no-store, max-age=0, must-revalidate |
//   | /api/explore/pickers/*  | GSE    | filename="json.txt" **+ filename*** | (同上)                                        |
//   | /api/widgetdata/*       | GSE    | filename="json.txt" のみ    | **private, max-age=0**                        |
//   | /api/autocomplete/*     | GSE    | filename="json.txt" のみ    | **private, max-age=0**                        |
//   | /_/TrendsUi/data/batchexecute | ESF | (無し)                    | no-cache, no-store, max-age=0, must-revalidate |
//
//   - **`filename*=UTF-8''json.txt` が付くのは explore と pickers だけ**。widgetdata と
//     autocomplete には付かない (抽出コーパスの全エントリで一致)。
//   - **cache-control は「エンドポイント」ではなく「ステータス」でも変わる**。
//     widgetdata は 200 なら `private, max-age=0` だが、429 のときは
//     `no-cache, no-store, max-age=0, must-revalidate` になる (har_idx 246 で確認)。
//     → cache-control を成功判定に使ってはいけない。使うなら status + content-type (§4-2)。
//   - server ヘッダは **旧 REST API = GSE / boq (batchexecute, /trending) = ESF** で
//     きれいに分かれる。どちらの系統に当たっているかの手掛かりになる。
//
//   ※ この表は HAR (ブラウザ = Cookie 有りのセッション) だけでなく、
//     **2026-09-09 に Cookie 無しの素の fetch でもライブ確認済み**:
//       GET /trends/api/explore/pickers/geo?hl=ja&tz=-540 (Cookie 無し)
//         → 200 / server: GSE / cache-control: no-cache, no-store, max-age=0, must-revalidate
//         / content-disposition: attachment; filename="json.txt"; filename*=UTF-8''json.txt
//         / content-type: application/json; charset=utf-8 / プレフィックス ")]}'\n" (カンマ無し)
//         / 本文 111,100 文字
//     → explore 系のレスポンス規約は **USER_TYPE_SCRAPER の経路でも HAR と同一**である。
//   ※ 実装／検証の小技: **pickers/geo は Cookie 不要な explore ファミリ**なので、
//     /trends/api/explore が §4-4 の 302 ブロックに入っていても叩ける。
//     explore 系のヘッダ規約 (GSE / no-cache / filename* / カンマ無しプレフィックス) を
//     確かめたいだけなら、ブロック中でも pickers/geo で代用検証できる。
//
//  4-2. ステータスコードの意味 (実測で確定)
//     200 + content-type: application/json  → 正常
//     429 + content-type: text/html         → NID 欠落 or レート制限。body は約 1,697 B の
//                                             "Error 429 (Too Many Requests)!!1" HTML。
//                                             **Retry-After ヘッダは付かない。**
//     401 + content-type: text/html         → widgetdata で token が無い / 壊れている。
//                                             body は約 1,691 B の HTML。
//     302                                   → **レート制限の第 2 段階** (§4-4)
//     301                                   → https://trends.google.com/ ルートのみ
//   **成功判定は `res.status === 200 && ct.startsWith("application/json")` で行うこと。**
//   res.ok だけでは不十分 (429/401 は ok=false なので実は足りるが、302 を follow すると
//   200 + text/html を掴まされうるため content-type も必ず見ること)。
//
//  4-3. 429 と 401 は原因が別物なので区別してエラー型を分けること
//     429 → NID を取り直す / バックオフする
//     401 → widget token が期限切れ or 改竄。explore を叩き直して token を取り直す
//
//  4-4. **429 の先に 302 がある (2026-09-09 実測、重要)**
//   同一 IP から短時間に約 30〜40 リクエストを投げた後、**NID を付けた** /trends/api/explore が
//   429 ではなく **302** を返すようになった。このとき:
//     - **Cookie 無し (NID 無し) の同じリクエストは依然 429 のまま。**
//       (Cookie 無しは元々ブロックの有無に関わらず常に 429 なので、429/302 の違いは
//        「NID を持っているか」で決まる。)
//     - **その場で取り直した新品の NID を付けても 302 のまま。**
//       → このブロックは **NID 単位ではなく IP (クライアント) 単位**。
//         Cookie を捨てて取り直しても復帰しない。
//     - 一方で widgetdata / autocomplete / batchexecute は
//       **同じ IP から同時刻に叩いても 200 を返し続けた**。
//       → ブロックは全 Trends ではなく **/trends/api/explore 系に限定**されている。
//       ※ 2026-09-09 の独立した再検証で明確に再現: explore が 302 を返している最中に、
//         同一プロセス・同一 IP から autocomplete が 200 (topics 5 件)、
//         batchexecute が 200 (9,148 文字) を返し、token 無し widgetdata は
//         429 ではなく **401** を返した。つまりブロック中でも explore 以外の
//         エンドポイントは通常どおり動作し、401/429 の意味も変わらない。
//         → **explore だけをキャッシュで守れば、ブロック中も残りの機能は継続できる。**
//     - **Location は実測で捕捉済み** (推測ではない):
//         https://www.google.com/sorry/index
//           ?continue=<元の /trends/api/explore の URL を丸ごと percent-encode したもの>
//           &hl=ja
//           &q=<100 文字強の base64url チャレンジトークン>
//       = Google の abuse インタースティシャル (reCAPTCHA を解かせる "sorry" ページ)。
//       content-type は text/html; charset=UTF-8。
//       ※ 2026-09-09 の独立した再検証でもこの形をそのまま再現 (Location の 3 パラメータの順序
//         continue → hl → q、q は約 104 文字の base64url) 。偶発的な観測ではない。
//     - `q=` の値はリクエストごとに異なる。`continue=` に元 URL が入るので、
//       ログに出すと検索クエリが漏れる点に注意。
//   → **実装上の必須対策: fetch を `redirect: "manual"` で使うこと。**
//     デフォルトの `redirect: "follow"` だと 302 が透過的に追跡され、
//     **CAPTCHA ページの HTML が status 200 で返ってくる**ため、
//     「200 だから成功」という判定を書いていると壊れたデータを掴む。
//     `redirect: "manual"` にしたうえで、
//     `res.status === 302 && (res.headers.get("location") ?? "").includes("/sorry/")`
//     を「ブロックされた」専用のエラーとして扱うこと。
//   → 復帰方法: このページは自動では解けない (reCAPTCHA)。**NID を取り直しても無駄**なので、
//     長めに待つか IP を変えるしかない。**429 のような短時間バックオフでは復帰しない**ので、
//     429 (数秒〜数十秒で回復) と 302 (実質そのセッションは終了) は
//     必ず別のエラー型に分け、リトライ戦略も分けること。
//   → 発生を避けるには: 同一 IP から短時間に数十リクエストを投げない。
//     NID が要るのは explore だけなので、widget token を 24 時間キャッシュし、
//     widgetdata / autocomplete / batchexecute は Cookie 無しで叩く
//     (NID に紐づく累積カウントを増やさない) という設計が最も安全。
//   widgetdata の token は 44 文字 base64url、デコードすると 33 バイト。
//   bytes[9..13] がビッグエンディアン uint32 の有効期限 (UNIX 秒) で、発行から +24 時間。
//   **token を 1 文字でも書き換えると 401**、つまり末尾 20 バイトは署名として実際に検証されている。
//
// ============================================================================
// 5. Cookie の寿命 / 再取得戦略 (推奨実装)
// ============================================================================
//
//   1) NID を持っていなければ、目的の /trends/api/explore を Cookie 無しで 1 回叩く。
//      → 429 が返るので Set-Cookie から NID を取り出して保存する (メモリ or ファイル)。
//   2) 同じ URL を NID 付きで叩き直す。→ 200。
//   3) 以後、毎レスポンスの Set-Cookie: NID で手元の値を更新する。
//   4) 429 が返り始めたら: まず指数バックオフ (2s → 4s → 8s、最大 3 回)。
//      それでも駄目なら NID を破棄して 1) からやり直す。
//   4') **302 が返ったら話が別** (§4-4)。IP 単位の abuse ブロックなので NID を取り直しても
//      復帰しない。リトライせず即座に専用エラーを投げ、呼び出し側に判断を委ねること。
//      なおこのとき widgetdata / autocomplete / batchexecute はまだ生きているので、
//      キャッシュ済み token があれば処理を続行できる。
//   5) NID の expires は約 6 か月先だが、Google 側の都合で無効化されることがあるため
//      **期限を信用せず「429 が返ったら取り直す」というリアクティブな戦略にすること。**
//   6) widgetdata / autocomplete / pickers / batchexecute には NID を付ける必要が無い。
//      付けても害は無いが、付けないほうがセッションを汚さない。
//
//   なお HAR の正規ブラウザセッション (Cookie も reCAPTCHA トークンも完備) でも
//   111 リクエスト中 1 件 429 が出ている (har_idx 246, widgetdata/multiline)。
//   **429 はセッション単位のブロックではなくリクエスト単位の確率的スロットリング**なので、
//   1 本落ちても他が生きている。並列発火した 247/248/249 は全部 200 だった。
//
// ============================================================================
// 6. このテストの実行モデル
// ============================================================================
//
//  6-1. 消費するライブ HTTP リクエスト数: 最大 12
//    内訳: T01=1 / T02=2 (/trending, ルート) / T03=1 / T04=1 / T05=3 / T06=1 / T07=1 /
//          T08=1 / T08b=1 (pickers/geo)。T09 はネットワークを使わない。
//    NID はモジュール内でキャッシュして使い回す (T04/T08 は T01 が取った NID を再利用するので
//    getNid() は追加リクエストを発生させない)。大きい HTML はボディを cancel して落とさない。
//
//  6-2. レート制限時の挙動: **ハードに落とさず console.warn してスキップする。**
//    実行者の環境やその時点の IP 評価に依存して落ちるテストは、仕様の反証にならないため。
//
//  6-3. **ただし「緑 = 検証できた」ではない (重要)**
//    6-2 の設計の代償として、レート制限中は中核の主張が 1 つも実行されないまま
//    全テストが ok になりうる。実際 2026-09-09 の検証中、IP が §4-4 の 302 ブロックに
//    入った状態で実行したところ、テスト 04 / 05(b,c) / 08 が丸ごとスキップされ、
//    「NID 付き explore → 200」を一度も確かめないまま 8 passed と表示された。
//    そのため本ファイルは **検証台帳 (ledger)** を持ち、主張単位で verified / skipped を
//    記録して、最後のテスト 09 で一覧と警告を印字する。
//    **実行後は必ずテスト 09 の出力を読み、中核 3 件が [OK] になっているか確認すること。**
//    中核 3 件 = ・NID付き explore → 200 + widgets
//                ・widgetdata は Cookie 無しで 200
//                ・最小ヘッダ (cookie のみ) で explore → 200
//    未検証だった場合は時間を空けるか別 IP で再実行する。
//    なお 302 ブロック中でもテスト 08b (pickers/geo) は通るので、explore 系のレスポンス
//    規約 (§4-1b) だけは常に実測で確かめられる — 検証が完全にゼロになることはない。
// ============================================================================

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@^1";

const ORIGIN = "https://trends.google.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/** レート制限対策: 連続リクエストの間隔 */
const GAP_MS = 1300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HAR のブラウザと同じパーセントエンコード ( : と , は生、空白は + ) */
function harEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%3A/g, ":")
    .replace(/%2C/g, ",")
    .replace(/%20/g, "+");
}

/** Set-Cookie 群から NID の値だけ取り出す */
function extractNid(setCookies: string[]): string | null {
  for (const c of setCookies) {
    const m = c.match(/^NID=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

/** Set-Cookie 群から NID の行そのものを取り出す (属性検査用) */
function nidSetCookieLine(setCookies: string[]): string | null {
  return setCookies.find((c) => c.startsWith("NID=")) ?? null;
}

const EXPLORE_REQ = JSON.stringify({
  comparisonItem: [{ keyword: "Fanza", geo: "JP", time: "now 1-d" }],
  category: 0,
  property: "",
});
const EXPLORE_URL =
  `${ORIGIN}/trends/api/explore?hl=ja&tz=-540&req=${harEncode(EXPLORE_REQ)}&tz=-540`;

const API_HEADERS: Record<string, string> = {
  "accept": "application/json, text/plain, */*",
  "accept-language": "ja",
  "user-agent": UA,
  "referer": `${ORIGIN}/trends/explore`,
};

// --- テスト間で共有するキャッシュ (ライブリクエスト数を抑えるため) ---
let cachedNid: string | null = null;
let cachedTimeseriesWidget: { request: unknown; token: string } | null = null;
/** ネットワークが完全に死んでいる場合は以降のテストを全部スキップする */
let networkDead = false;

/**
 * ネットワーク例外を warn に落とすラッパー。null が返ったらスキップ扱い。
 * redirect: "manual" は必須 — follow にすると 302 のレート制限インタースティシャルが
 * 200 + text/html として透過してしまう (§4-4)。
 */
async function tryFetch(
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  if (networkDead) return null;
  try {
    return await fetch(url, { ...init, redirect: "manual" });
  } catch (e) {
    networkDead = true;
    console.warn(`  [skip] ネットワークエラー: ${(e as Error).message}`);
    return null;
  }
}

/** 期待した 200 が得られなかったときに、原因を切り分けられる形で warn を出す */
function warnUnexpected(what: string, res: Response): void {
  const loc = res.headers.get("location");
  const isSorry = (loc ?? "").includes("/sorry/");
  const kind = res.status === 429
    ? "レート制限 (匿名 or 一律)"
    : res.status === 302
    // §4-4: このブロックは IP (クライアント) 単位であって NID 単位ではない。
    // NID を取り直しても復帰しないので「Cookie が焼けた」と誤解しないこと。
    ? `レート制限の第2段階 = IP 単位の abuse ブロック${isSorry ? " (/sorry/ インタースティシャル)" : ""} — NID 再取得では復帰しない (§4-4)`
    : res.status === 401
    ? "token 不正"
    : "不明";
  console.warn(
    `  [skip] ${what}: status=${res.status} (${kind})` +
      (loc ? ` location=${loc}` : "") +
      ` ct=${res.headers.get("content-type")}`,
  );
}

// ============================================================================
// 検証台帳 (verification ledger)
// ----------------------------------------------------------------------------
// 本ファイルの各テストはレート制限 (429 / 302) を握り潰してスキップする設計のため、
// 「8 passed」という表示だけでは *どの仕様主張が実際に確かめられたのか* が分からない。
// 実際 2026-09-09 の検証中、IP が §4-4 の 302 ブロックに入った状態では
// テスト 04 / 05(b,c) / 08 が丸ごとスキップされ、中核の主張 (NID 付き explore → 200) が
// 一度も実行されないまま全テストが緑になった。
// これを可視化するため、主張単位で verified / skipped を記録し、最後にサマリを出す。
// ============================================================================
type ClaimState = "verified" | "skipped";
const ledger: { claim: string; state: ClaimState; note: string }[] = [];
/** 仕様主張が実際にライブで確認できた */
function claimOk(claim: string, note = ""): void {
  ledger.push({ claim, state: "verified", note });
}
/** 仕様主張がレート制限等で確認できなかった */
function claimSkipped(claim: string, note = ""): void {
  ledger.push({ claim, state: "skipped", note });
}
/** 中核の主張 (これがスキップされたら「実質何も検証していない」実行になる) */
const CORE_CLAIMS = [
  "NID付き explore → 200 + widgets",
  "widgetdata は Cookie 無しで 200",
  "最小ヘッダ (cookie のみ) で explore → 200",
];

/**
 * NID を 1 度だけ取得してキャッシュする。
 * 取得経路は「目的の /trends/api/explore を Cookie 無しで叩いて 429 の Set-Cookie を拾う」。
 */
async function getNid(): Promise<string | null> {
  if (cachedNid) return cachedNid;
  const res = await tryFetch(EXPLORE_URL, { headers: API_HEADERS });
  if (!res) return null;
  const sc = res.headers.getSetCookie();
  await res.body?.cancel();
  await sleep(GAP_MS);
  cachedNid = extractNid(sc);
  return cachedNid;
}

// ============================================================================
// テスト 1: NID Cookie は「Cookie 無しで叩いた 429 レスポンス」から取得できる
// ============================================================================
Deno.test({
  name: "01 NID取得: Cookie無しの GET /trends/api/explore は 429 を返しつつ Set-Cookie: NID を発行する",
  fn: async () => {
    const res = await tryFetch(EXPLORE_URL, { headers: API_HEADERS });
    if (!res) return;
    const sc = res.headers.getSetCookie();
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text(); // リソースリーク回避のため必ず消費する

    // まれに 200 が返る (レート制限は確率的) 場合はスキップ扱いにする
    if (res.status !== 429) {
      console.warn(
        `  [warn] Cookie無しで status=${res.status} が返った (通常は 429)。` +
          `レート制限は確率的なのでこの分岐もありうる。`,
      );
      claimSkipped(
        "Cookie無し explore → 429 + Set-Cookie: NID",
        `status=${res.status} が返った`,
      );
      cachedNid ??= extractNid(sc);
      await sleep(GAP_MS);
      return;
    }

    // --- 429 の形 ---
    assertEquals(res.status, 429);
    assert(
      ct.startsWith("text/html"),
      `429 の content-type は text/html のはず。実際: ${ct}`,
    );
    assertEquals(
      res.headers.get("retry-after"),
      null,
      "429 に Retry-After は付かない (実測)",
    );
    assertEquals(
      res.headers.get("content-disposition"),
      null,
      "429 には content-disposition が付かない (200 との判別材料になる)",
    );
    assert(
      body.includes("429"),
      `429 のボディは Google の 'Error 429 (Too Many Requests)' HTML。実際の先頭: ${body.slice(0, 80)}`,
    );
    assert(
      body.length > 500 && body.length < 5000,
      `429 のボディは約 1.7KB。実際: ${body.length}`,
    );

    // --- Set-Cookie: NID の存在と属性 ---
    const line = nidSetCookieLine(sc);
    assert(line !== null, "429 でも Set-Cookie: NID が発行されるはず");
    const nid = extractNid(sc)!;
    assert(nid.length > 50, `NID の値は数百文字。実際: ${nid.length}`);
    assertMatch(
      nid,
      /^[A-Za-z0-9_=\-.:%]+$/,
      "NID の値は不透明トークン (英数字と一部記号)",
    );

    const attrs = line!.slice(line!.indexOf(";")).toLowerCase();
    assert(attrs.includes("path=/"), `NID には path=/ が付く: ${attrs}`);
    assert(
      attrs.includes("domain=.google.com"),
      `NID には domain=.google.com が付く (google.com 配下で共用される): ${attrs}`,
    );
    assert(attrs.includes("httponly"), `NID には HttpOnly が付く: ${attrs}`);
    assert(
      attrs.includes("expires="),
      `NID は Max-Age ではなく expires 絶対時刻を使う: ${attrs}`,
    );
    // Secure / SameSite=none は User-Agent を送った場合にのみ付く (UA 無しだと落ちる)
    assert(
      attrs.includes("secure"),
      `UA を送っている場合 NID には Secure が付く: ${attrs}`,
    );

    // 有効期限は概ね半年先
    const expMatch = line!.match(/expires=([^;]+)/i);
    assert(expMatch, "expires が読めるはず");
    const days = (Date.parse(expMatch![1]) - Date.now()) / 86400_000;
    assert(
      days > 100 && days < 400,
      `NID の寿命は約 6 か月 (実測 183 日前後)。実際: ${days.toFixed(0)} 日`,
    );

    // CONSENT フローに飛ばされていないこと (日本の IP では発生しない)
    assertEquals(
      res.headers.get("location"),
      null,
      "非 EU からは consent.google.com へリダイレクトされない",
    );
    assert(
      !sc.some((c) => c.startsWith("CONSENT=")),
      "非 EU からは CONSENT Cookie は降ってこない",
    );

    cachedNid ??= nid;
    claimOk(
      "Cookie無し explore → 429 + Set-Cookie: NID",
      `len=${nid.length}, ${nid.startsWith("534=") ? "534= 系" : "protobuf 系"}, 期限 ${days.toFixed(0)} 日先`,
    );
    console.log(
      `  NID 取得成功 (len=${nid.length}, 形式=${nid.startsWith("534=") ? "534= 系" : "protobuf 系"})`,
    );
    await sleep(GAP_MS);
  },
});

// ============================================================================
// テスト 2: NID を発行する URL / しない URL
// ============================================================================
Deno.test({
  name: "02 NID取得元: /trending は 200 で NID を発行し、ルート https://trends.google.com/ は 301 で発行しない",
  fn: async () => {
    // (a) 新 UI /trending — 1.2MB あるのでボディは cancel して落とさない
    const a = await tryFetch(`${ORIGIN}/trending?geo=JP&hl=ja`, {
      headers: { "user-agent": UA },
    });
    if (!a) return;
    const aSc = a.headers.getSetCookie();
    const aStatus = a.status;
    const aServer = a.headers.get("server");
    await a.body?.cancel(); // メモリを食わないよう本文は読まずに破棄
    await sleep(GAP_MS);

    if (aStatus === 200) {
      assertEquals(aServer, "ESF", "/trending は boq 系 (server: ESF)");
      assert(
        extractNid(aSc) !== null,
        "/trending は Cookie 無し 200 で NID を発行する",
      );
      claimOk("/trending は Cookie無し 200 で NID を発行", "server=ESF");
    } else {
      console.warn(`  [warn] /trending が status=${aStatus} (通常は 200)`);
      claimSkipped(
        "/trending は Cookie無し 200 で NID を発行",
        `status=${aStatus}`,
      );
    }

    // (b) ルート — 301 のみ。NID を発行しないので、ここをブートストラップ先にしてはいけない
    const b = await tryFetch(`${ORIGIN}/`, { headers: { "user-agent": UA } });
    if (!b) return;
    const bSc = b.headers.getSetCookie();
    const bStatus = b.status;
    const bLoc = b.headers.get("location");
    await b.body?.cancel();
    await sleep(GAP_MS);

    // abuse ブロック中は 302 /sorry/ に化けうるので、その場合はスキップ扱いにする
    // (レート制限でハードに落とさないという本ファイルの方針)
    if (bStatus !== 301) {
      console.warn(
        `  [warn] ルートが status=${bStatus} (通常は 301) location=${bLoc}`,
      );
      claimSkipped("ルート / は 301 で NID を発行しない", `status=${bStatus}`);
      return;
    }
    assertEquals(
      bLoc,
      `${ORIGIN}/trends/`,
      "ルートの飛び先は /trends/",
    );
    assertEquals(
      extractNid(bSc),
      null,
      "ルートの 301 は NID を発行しない (ブートストラップ先に選んではいけない)",
    );
    claimOk("ルート / は 301 で NID を発行しない", `location=${bLoc}`);
  },
});

// ============================================================================
// テスト 3: NID の「値」は検証されている — デタラメな NID では 429 のまま
// ============================================================================
Deno.test({
  name: "03 認証: 偽の NID 値では /trends/api/explore は 200 にならない (名前だけ付けても無駄)",
  fn: async () => {
    const res = await tryFetch(EXPLORE_URL, {
      headers: { ...API_HEADERS, cookie: "NID=abc123deadbeefNOTAREALCOOKIE" },
    });
    if (!res) return;
    const status = res.status;
    const ct = res.headers.get("content-type") ?? "";
    await res.body?.cancel();
    await sleep(GAP_MS);

    // これは本質的な主張なので常にハードに検証する:
    // 偽の NID で 200 が返るなら「NID は名前さえあればよい」ことになり仕様記述が誤りになる。
    assert(
      status !== 200,
      "サーバ発行でない NID では 200 にならない (実測では 429)。" +
        "つまり NID は『存在するか』ではなく『本物か』が見られている。",
    );
    // 正確なステータスは IP の状態に依存する (通常 429 / abuse ブロック中は 302) ため
    // ここはハードに固定しない。
    if (status === 429) {
      assert(ct.startsWith("text/html"), "429 は text/html を返す");
      claimOk("偽の NID では explore は 200 にならない", "status=429");
    } else {
      console.warn(
        `  [warn] 偽 NID に対し status=${status} (通常は 429)。` +
          `200 ではないので主張自体は成立している。`,
      );
      claimOk("偽の NID では explore は 200 にならない", `status=${status}`);
    }
  },
});

// ============================================================================
// テスト 4: NID 付きなら /trends/api/explore は 200 になり、widget と token が取れる
// ============================================================================
Deno.test({
  name: "04 認証: NID 付き GET /trends/api/explore は 200 を返し 4 ウィジェット + 24h 有効な token を含む",
  fn: async () => {
    const nid = await getNid();
    if (!nid) {
      console.warn("  [skip] NID を取得できなかった");
      claimSkipped(CORE_CLAIMS[0], "NID が取得できなかった");
      return;
    }
    const res = await tryFetch(EXPLORE_URL, {
      headers: { ...API_HEADERS, cookie: `NID=${nid}` },
    });
    if (!res) {
      claimSkipped(CORE_CLAIMS[0], "ネットワーク断");
      return;
    }
    const status = res.status;
    const ct = res.headers.get("content-type") ?? "";
    const cd = res.headers.get("content-disposition") ?? "";
    if (status !== 200) {
      warnUnexpected("NID 付き explore", res);
      claimSkipped(
        CORE_CLAIMS[0],
        `status=${status}${status === 302 ? " (IP 単位の abuse ブロック中)" : ""}`,
      );
      await res.body?.cancel();
      await sleep(GAP_MS);
      return;
    }
    const text = await res.text();
    await sleep(GAP_MS);

    assert(
      ct.startsWith("application/json"),
      `成功時の content-type は application/json。実際: ${ct}`,
    );
    assert(
      cd.includes('filename="json.txt"'),
      `explore は content-disposition: attachment; filename="json.txt" を返す。実際: ${cd}`,
    );
    assert(
      cd.includes("filename*=UTF-8''json.txt"),
      "explore と pickers 系だけ filename* が付く (widgetdata / autocomplete には付かない)",
    );
    assertEquals(
      res.headers.get("server"),
      "GSE",
      "旧 REST API は server: GSE — §4-1b",
    );
    assertEquals(
      res.headers.get("cache-control"),
      "no-cache, no-store, max-age=0, must-revalidate",
      "explore の 200 は no-cache 系 (widgetdata/autocomplete の private, max-age=0 とは別) — §4-1b",
    );

    // XSSI プレフィックス: explore は ")]}'\n" (カンマ無し)
    assert(
      text.startsWith(")]}'\n"),
      `explore のプレフィックスは ")]}'\\n" (5バイト、カンマ無し)。実際: ${JSON.stringify(text.slice(0, 8))}`,
    );
    const json = JSON.parse(text.slice(text.indexOf("\n") + 1));

    assert(Array.isArray(json.widgets), "トップレベルに widgets 配列がある");
    const ids: string[] = json.widgets.map((w: { id: string }) => w.id);
    // 単一キーワードでは 4 ウィジェット固定 (HAR のバイト会計による推定をライブで確定)
    assertEquals(
      ids,
      ["TIMESERIES", "GEO_MAP", "RELATED_TOPICS", "RELATED_QUERIES"],
      "単一キーワードの explore は TIMESERIES / GEO_MAP / RELATED_TOPICS / RELATED_QUERIES の 4 件",
    );

    const ts = json.widgets[0];
    for (const k of ["request", "token", "id", "type", "title", "template", "version"]) {
      assert(k in ts, `widget には ${k} キーがある`);
    }
    assertEquals(ts.type, "fe_line_chart", "TIMESERIES の type は fe_line_chart");
    assertEquals(
      ts.request.userConfig.userType,
      "USER_TYPE_SCRAPER",
      "userType は一般ユーザでも常に USER_TYPE_SCRAPER (スクレイパー判定ではない)",
    );
    assertEquals(ts.request.resolution, "EIGHT_MINUTE", "now 1-d は EIGHT_MINUTE");
    assertEquals(ts.request.requestOptions.backend, "CM", "リアルタイム系の backend は CM");
    // time は 1 日未満だとコロンが \: にエスケープされる (自前で組み立てず透過させること)
    assertMatch(
      ts.request.time,
      /^\d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2} \d{4}-\d{2}-\d{2}T\d{2}\\:\d{2}\\:\d{2}$/,
      `time は 'YYYY-MM-DDTHH\\:MM\\:SS YYYY-MM-DDTHH\\:MM\\:SS' 形式。実際: ${ts.request.time}`,
    );

    // --- token の形式と有効期限 (ローカルでデコードできる) ---
    const token: string = ts.token;
    assertEquals(token.length, 44, "token は 44 文字の base64url");
    assertMatch(token, /^[A-Za-z0-9_-]{44}$/, "token は base64url (パディング無し)");
    assert(token.startsWith("ANI_2wMAAAAA"), "token は固定ヘッダ ANI_2wMAAAAA で始まる");
    // base64url → base64。44 文字は 4 の倍数なのでパディングは不要だが、
    // 無条件に "==" を足すと atob が InvalidCharacterError を投げるので長さで判定すること。
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Uint8Array.from(
      atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)),
      (c) => c.charCodeAt(0),
    );
    assertEquals(raw.length, 33, "token をデコードすると 33 バイト固定");
    const expiry = new DataView(raw.buffer).getUint32(9, false); // BE uint32 @ offset 9
    const hours = (expiry - Date.now() / 1000) / 3600;
    assert(
      hours > 23 && hours < 25,
      `token の有効期限は発行から 24 時間 (bytes[9..13] の BE uint32)。実際: ${hours.toFixed(2)} 時間後`,
    );

    cachedTimeseriesWidget = { request: ts.request, token };
    claimOk(
      CORE_CLAIMS[0],
      `widgets=${ids.length}件 (${ids.join(",")}), token 期限 ${hours.toFixed(1)}h 後`,
    );
    console.log(
      `  widgets=${ids.join(",")} / token 期限 = ${new Date(expiry * 1000).toISOString()}`,
    );
  },
});

// ============================================================================
// テスト 5: widgetdata は Cookie 不要。ただし token が必須で、壊すと 401
// ============================================================================
Deno.test({
  name: "05 認証: GET /trends/api/widgetdata/multiline は Cookie 無しで 200、token 欠落/改竄は 401",
  fn: async () => {
    // テスト 04 が 200 を取れていれば本物の request/token を使う。
    // 取れていない (レート制限) 場合でも、token 検証の部分だけは合成 req で確認できる。
    const request = cachedTimeseriesWidget?.request ?? {
      time: "2026-09-07T00\\:00\\:00 2026-09-08T00\\:00\\:00",
      resolution: "EIGHT_MINUTE",
      locale: "ja",
      comparisonItem: [{
        geo: { country: "JP" },
        complexKeywordsRestriction: { keyword: [{ type: "BROAD", value: "Fanza" }] },
      }],
      requestOptions: { property: "", backend: "CM", category: 0 },
      userConfig: { userType: "USER_TYPE_SCRAPER" },
    };
    const base =
      `${ORIGIN}/trends/api/widgetdata/multiline?hl=ja&tz=-540&req=${harEncode(JSON.stringify(request))}`;

    // --- (a) token を付けない → 401 (429 でも 400 でもない) ---
    const noTok = await tryFetch(base, { headers: API_HEADERS });
    if (!noTok) return;
    const noTokStatus = noTok.status;
    const noTokCt = noTok.headers.get("content-type") ?? "";
    await noTok.body?.cancel();
    await sleep(GAP_MS);

    // レート制限 (429/302) 中は 401 まで到達しないので、その場合はスキップ扱いにする
    if (noTokStatus === 429 || noTokStatus === 302) {
      warnUnexpected("token 無し widgetdata (実測では 401)", noTok);
      claimSkipped("token 欠落 → 401", `status=${noTokStatus}`);
    } else {
      assertEquals(
        noTokStatus,
        401,
        "token を省くと 401 Unauthorized。429 とは原因が別なのでエラー型を分けること",
      );
      assert(noTokCt.startsWith("text/html"), "401 のボディも JSON ではなく HTML");
      assertEquals(
        noTok.headers.get("content-disposition"),
        null,
        "401 には content-disposition が付かない",
      );
      claimOk("token 欠落 → 401", "429 とは別のエラー型");
    }

    if (!cachedTimeseriesWidget) {
      console.warn(
        "  [skip] テスト 04 が token を取得できなかったため (b)(c) はスキップ。" +
          "token 欠落 → 401 のみ検証済み。",
      );
      claimSkipped("token 1文字改竄 → 401", "本物の token が無い");
      claimSkipped(CORE_CLAIMS[1], "本物の token が無い");
      return;
    }
    const token = cachedTimeseriesWidget.token;

    // --- (b) token を 1 文字だけ書き換える → 401 (署名が実際に検証されている) ---
    const bad = token.slice(0, 40) + (token[40] === "A" ? "B" : "A") + token.slice(41);
    const badRes = await tryFetch(`${base}&token=${encodeURIComponent(bad)}`, {
      headers: API_HEADERS,
    });
    if (!badRes) return;
    const badStatus = badRes.status;
    await badRes.body?.cancel();
    await sleep(GAP_MS);

    if (badStatus === 429 || badStatus === 302) {
      warnUnexpected("改竄 token widgetdata (実測では 401)", badRes);
      claimSkipped("token 1文字改竄 → 401", `status=${badStatus}`);
    } else {
      assertEquals(
        badStatus,
        401,
        "token を 1 文字改竄しただけで 401。末尾 20 バイトは実際に署名として検証されている",
      );
      claimOk("token 1文字改竄 → 401", "署名が実際に検証されている");
    }

    // --- (c) Cookie 無し + 正しい token → 200 (widgetdata に NID は不要) ---
    const ok = await tryFetch(`${base}&token=${encodeURIComponent(token)}&tz=-540`, {
      headers: API_HEADERS, // cookie を敢えて付けない
    });
    if (!ok) return;
    if (ok.status !== 200) {
      warnUnexpected("Cookie 無し widgetdata (実測では 200)", ok);
      claimSkipped(CORE_CLAIMS[1], `status=${ok.status}`);
      await ok.body?.cancel();
      await sleep(GAP_MS);
      return;
    }
    const okCt = ok.headers.get("content-type") ?? "";
    const okText = await ok.text();
    await sleep(GAP_MS);

    assert(
      okCt.startsWith("application/json"),
      `content-type は application/json。実際: ${okCt}`,
    );
    // widgetdata のプレフィックスは explore と違い ")]}',\n" (カンマ有り)
    assert(
      okText.startsWith(")]}',\n"),
      `widgetdata のプレフィックスは ")]}',\\n" (カンマ有り)。実際: ${JSON.stringify(okText.slice(0, 8))}`,
    );
    const j = JSON.parse(okText.slice(okText.indexOf("\n") + 1));
    assert("default" in j, "widgetdata のトップレベルキーは default");
    assert(
      Array.isArray(j.default.timelineData),
      "multiline は default.timelineData 配列を返す",
    );
    assert(
      Array.isArray(j.default.averages),
      "multiline は default.averages 配列も返す",
    );
    claimOk(
      CORE_CLAIMS[1],
      `timelineData=${j.default.timelineData.length} 点 / cookie ヘッダ無し`,
    );
    console.log(
      `  Cookie 無しで multiline 200 / timelineData=${j.default.timelineData.length} 点`,
    );
  },
});

// ============================================================================
// テスト 6: autocomplete は Cookie 完全不要
// ============================================================================
Deno.test({
  name: "06 認証: GET /trends/api/autocomplete/<kw> は Cookie 無しで 200 (プレフィックスは )]}', 付き)",
  fn: async () => {
    const res = await tryFetch(
      `${ORIGIN}/trends/api/autocomplete/Fanza?hl=ja&tz=-540`,
      { headers: API_HEADERS },
    );
    if (!res) return;
    const status = res.status;
    const ct = res.headers.get("content-type") ?? "";
    const cd = res.headers.get("content-disposition") ?? "";
    const cc = res.headers.get("cache-control") ?? "";
    const text = await res.text();
    await sleep(GAP_MS);

    if (status !== 200) {
      warnUnexpected("autocomplete (実測では Cookie 無しで 200)", res);
      claimSkipped("autocomplete は Cookie 無しで 200", `status=${status}`);
      return;
    }
    assert(ct.startsWith("application/json"), `content-type: ${ct}`);
    assert(
      cd.includes('filename="json.txt"') && !cd.includes("filename*"),
      `autocomplete は filename* 無しの content-disposition。実際: ${cd}`,
    );
    assertEquals(
      res.headers.get("server"),
      "GSE",
      "旧 REST API は server: GSE (boq 系の ESF と別系統) — §4-1b",
    );
    assertEquals(
      cc,
      "private, max-age=0",
      "autocomplete / widgetdata は **200 のとき** cache-control: private, max-age=0。" +
        "429 のときは no-cache, no-store,... に変わるので成功判定には使えない (§4-1b)",
    );
    assert(
      text.startsWith(")]}',\n"),
      `autocomplete のプレフィックスは ")]}',\\n"。実際: ${JSON.stringify(text.slice(0, 8))}`,
    );
    const j = JSON.parse(text.slice(text.indexOf("\n") + 1));
    assert(Array.isArray(j.default.topics), "autocomplete は default.topics 配列を返す");
    for (const t of j.default.topics) {
      assert(typeof t.mid === "string" && t.mid.startsWith("/"), "topics[].mid は Freebase 風 ID");
      assert(typeof t.title === "string", "topics[].title は表示名");
      assert(typeof t.type === "string", "topics[].type は hl でローカライズされた種別");
    }
    claimOk(
      "autocomplete は Cookie 無しで 200",
      `topics=${j.default.topics.length} 件`,
    );
    console.log(`  autocomplete topics=${j.default.topics.length} 件 (Cookie 無し)`);
  },
});

// ============================================================================
// テスト 7: batchexecute は Cookie もヘッダもほぼ不要
// ============================================================================
Deno.test({
  name: "07 認証: POST /_/TrendsUi/data/batchexecute は Cookie 無し・content-type だけで 200",
  fn: async () => {
    const body = "f.req=" +
      encodeURIComponent(
        JSON.stringify([[["i0OFE", JSON.stringify([null, null, "JP", 0, "ja", 4]), null, "1"]]]),
      ) + "&";
    // f.sid / bl / soc-* を全部省いた最小クエリ
    const url =
      `${ORIGIN}/_/TrendsUi/data/batchexecute?rpcids=i0OFE&source-path=%2Ftrending&hl=ja&_reqid=1&rt=c`;

    const res = await tryFetch(url, {
      method: "POST",
      body,
      // cookie / user-agent / origin / referer / x-same-domain を敢えて全部落とす
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    });
    if (!res) return;
    const status = res.status;
    const ct = res.headers.get("content-type") ?? "";
    const server = res.headers.get("server");
    const text = await res.text();
    await sleep(GAP_MS);

    if (status !== 200) {
      warnUnexpected("batchexecute (実測では 200)", res);
      claimSkipped(
        "batchexecute は Cookie/ヘッダ無しで 200",
        `status=${status}`,
      );
      return;
    }
    assertEquals(server, "ESF", "boq 系は server: ESF (旧 API の GSE と別系統)");
    assert(ct.startsWith("application/json"), `content-type: ${ct}`);
    // batchexecute のプレフィックスは LF が 2 個
    assert(
      text.startsWith(")]}'\n\n"),
      `batchexecute のプレフィックスは ")]}'\\n\\n" (LF 2 個)。実際: ${JSON.stringify(text.slice(0, 8))}`,
    );
    assert(
      text.includes('"wrb.fr","i0OFE"'),
      "封筒の中に wrb.fr / i0OFE のアイテムが入っている",
    );
    claimOk(
      "batchexecute は Cookie/ヘッダ無しで 200",
      `${text.length} 文字, x-same-domain も f.sid も送らず`,
    );
    console.log(
      `  Cookie もヘッダも無しで batchexecute 200 (${text.length} 文字) — x-same-domain も f.sid も不要`,
    );
  },
});

// ============================================================================
// テスト 8: 最小ヘッダ — cookie: NID だけで explore が通る / accept-language は無関係
// ============================================================================
Deno.test({
  name: "08 最小ヘッダ: cookie: NID だけ (UA/accept/referer 無し) でも explore は 200",
  fn: async () => {
    const nid = await getNid();
    if (!nid) {
      console.warn("  [skip] NID を取得できなかった");
      claimSkipped(CORE_CLAIMS[2], "NID が取得できなかった");
      return;
    }
    // user-agent も accept も referer も accept-language も送らない
    const res = await tryFetch(EXPLORE_URL, { headers: { cookie: `NID=${nid}` } });
    if (!res) {
      claimSkipped(CORE_CLAIMS[2], "ネットワーク断");
      return;
    }
    const status = res.status;
    const ct = res.headers.get("content-type") ?? "";
    const sc = res.headers.getSetCookie();
    if (status !== 200) {
      warnUnexpected("ヘッダ最小の explore (実測では 200)", res);
      claimSkipped(CORE_CLAIMS[2], `status=${status}`);
      await res.body?.cancel();
      await sleep(GAP_MS);
      return;
    }
    const text = await res.text();
    await sleep(GAP_MS);

    assert(ct.startsWith("application/json"), `content-type: ${ct}`);
    assert(text.startsWith(")]}'\n"), "本文の形は通常どおり");
    const json = JSON.parse(text.slice(text.indexOf("\n") + 1));
    assertEquals(
      json.widgets.length,
      4,
      "ヘッダを削っても返るウィジェット数は変わらない",
    );

    // 落とし穴の記録: UA を送らないと Set-Cookie から Secure / SameSite=none が消える
    const line = nidSetCookieLine(sc);
    if (line) {
      const attrs = line.toLowerCase();
      if (!attrs.includes("secure")) {
        console.log(
          "  [仕様メモ] User-Agent 無しのリクエストでは Set-Cookie: NID から Secure / SameSite=none が落ちる " +
            "(値自体は有効)。Cookie パーサが Secure 必須を前提にしないこと。",
        );
      }
    }
    claimOk(CORE_CLAIMS[2], "他ヘッダ 0 個、cookie: NID のみ");
    console.log("  cookie: NID のみ (他ヘッダ 0 個) で 200 を確認");
  },
});

// ============================================================================
// テスト 8b: explore ファミリのレスポンス規約を pickers/geo で検証する
// ----------------------------------------------------------------------------
// /trends/api/explore は §4-4 の 302 ブロックに入ると叩けなくなり、テスト 04 / 08 が
// 丸ごとスキップされてしまう。しかし **pickers/geo は同じ explore ファミリでありながら
// Cookie 不要でブロック対象外**なので、ブロック中でも
// 「explore 系は GSE / no-cache / filename* 付き / カンマ無しプレフィックス」という
// §4-1b の規約を実測で確かめられる。
// → レート制限下でも検証がゼロにならないようにするための代替経路 (2026-09-09 確立)。
// ============================================================================
Deno.test({
  name: "08b 規約: explore ファミリ (pickers/geo) は Cookie 無しで 200・GSE・no-cache・filename* 付き",
  fn: async () => {
    const res = await tryFetch(
      `${ORIGIN}/trends/api/explore/pickers/geo?hl=ja&tz=-540`,
      { headers: API_HEADERS }, // cookie を敢えて付けない
    );
    if (!res) {
      claimSkipped("explore ファミリのヘッダ規約 (pickers/geo)", "ネットワーク断");
      return;
    }
    const status = res.status;
    const ct = res.headers.get("content-type") ?? "";
    const cd = res.headers.get("content-disposition") ?? "";
    const text = await res.text();
    await sleep(GAP_MS);

    if (status !== 200) {
      warnUnexpected("pickers/geo (実測では Cookie 無しで 200)", res);
      claimSkipped("explore ファミリのヘッダ規約 (pickers/geo)", `status=${status}`);
      return;
    }

    assertEquals(res.headers.get("server"), "GSE", "旧 REST API は server: GSE (§4-1b)");
    assertEquals(
      res.headers.get("cache-control"),
      "no-cache, no-store, max-age=0, must-revalidate",
      "explore ファミリの 200 は no-cache 系 (widgetdata/autocomplete の private とは別) — §4-1b",
    );
    assert(
      cd.includes('filename="json.txt"') && cd.includes("filename*=UTF-8''json.txt"),
      `explore と pickers だけ filename* が付く。実際: ${cd}`,
    );
    assert(ct.startsWith("application/json"), `content-type: ${ct}`);
    // explore ファミリのプレフィックスはカンマ *無し* の 5 バイト
    assert(
      text.startsWith(")]}'\n"),
      `explore ファミリは ")]}'\\n" (カンマ無し)。実際: ${JSON.stringify(text.slice(0, 8))}`,
    );
    assert(
      !text.startsWith(")]}',\n"),
      "explore ファミリに widgetdata 系のカンマ付きプレフィックスは付かない",
    );

    // 中身も検証する (ヘッダだけ見て終わらせない)
    // スキーマ (2026-09-09 実測): { id: string, name: string, children: Node[] } の再帰木。
    // ルートは国の配列、その children が第一級行政区画 (日本なら都道府県)。
    const json = JSON.parse(text.slice(text.indexOf("\n") + 1));
    assertEquals(
      Object.keys(json).sort(),
      ["children", "id", "name"],
      "pickers/geo のトップレベルは id / name / children の 3 キー",
    );
    assert(Array.isArray(json.children), "pickers/geo は children 配列を返す");
    assert(
      json.children.length > 100,
      `世界中の国が入るので 100 件超 (実測 250 件)。実際: ${json.children.length}`,
    );
    const jp = json.children.find((c: { id?: string }) => c.id === "JP");
    assert(jp, "children に id=JP (ISO 3166-1 alpha-2) の項目がある");
    assert(typeof jp.name === "string" && jp.name.length > 0, "国ノードは name を持つ");
    // hl=ja が効いていることを「非 ASCII であること」で確かめる
    // (表示名そのものは Google 側の文言変更を受けうるので固定文字列で縛らない)
    assert(
      // deno-lint-ignore no-control-regex
      /[^\x00-\x7F]/.test(jp.name),
      `hl=ja では国名がローカライズされ非 ASCII になる。実際: ${jp.name}`,
    );
    // 第一級行政区画 (都道府県) が入れ子で入っている
    assert(Array.isArray(jp.children), "JP ノードは children (都道府県) を持つ");
    assertEquals(jp.children.length, 47, "日本の第一級行政区画は 47 都道府県");
    for (const pref of jp.children) {
      assert(typeof pref.id === "string", "都道府県ノードは id を持つ");
      assertMatch(pref.id, /^\d{2}$/, `都道府県 id は 2 桁ゼロ埋め数字。実際: ${pref.id}`);
      assert(typeof pref.name === "string" && pref.name.length > 0, "都道府県ノードは name を持つ");
    }

    claimOk(
      "explore ファミリのヘッダ規約 (pickers/geo)",
      `GSE / no-cache / filename* / カンマ無し接頭辞, children=${json.children.length} 件`,
    );
    console.log(
      `  pickers/geo 200 (Cookie 無し) — 国=${json.children.length} 件, JP="${jp.name}" 配下 ${jp.children.length} 都道府県`,
    );
  },
});

// ============================================================================
// テスト 9: 検証サマリ — この実行で何が本当に確かめられたのかを明示する
// ----------------------------------------------------------------------------
// レート制限 (429 / 302) を握り潰す設計上、「全部 ok」でも中核の主張が一度も
// 実行されていない可能性がある。そのまま緑を信用すると、実際には未検証の仕様を
// 検証済みと誤認する。ここで台帳を印字し、中核がスキップされていれば明示的に警告する。
// (レート制限は環境要因なのでハードには落とさない — 落とすのは台帳自体が壊れている場合のみ)
// ============================================================================
Deno.test({
  name: "09 検証サマリ: この実行で実際に検証できた仕様主張の一覧",
  fn: () => {
    if (networkDead) {
      console.warn("  [skip] ネットワークが到達不能なため検証サマリなし");
      return;
    }
    assert(
      ledger.length > 0,
      "台帳が空。テストが 1 つも主張を記録していない = 本ファイルの計装が壊れている",
    );

    const verified = ledger.filter((e) => e.state === "verified");
    const skippedEntries = ledger.filter((e) => e.state === "skipped");

    console.log(`\n  === 検証台帳 (${verified.length}/${ledger.length} 件が実測で確認済み) ===`);
    for (const e of ledger) {
      const mark = e.state === "verified" ? "[OK]  " : "[SKIP]";
      console.log(`  ${mark} ${e.claim}${e.note ? ` — ${e.note}` : ""}`);
    }

    const skippedCore = CORE_CLAIMS.filter((c) =>
      !verified.some((v) => v.claim === c)
    );
    if (skippedCore.length > 0) {
      console.warn(
        `\n  [重要] 中核の主張 ${skippedCore.length}/${CORE_CLAIMS.length} 件がこの実行では未検証:\n` +
          skippedCore.map((c) => `         - ${c}`).join("\n") +
          `\n         → テストは緑だが「確かめられた」わけではない。` +
          `\n         → 原因は IP 単位のレート制限 (§4-4) の可能性が高い。` +
          ` 時間を空けるか別 IP で再実行して確認すること。`,
      );
    } else {
      console.log(
        `\n  中核の主張 ${CORE_CLAIMS.length} 件すべてを実測で確認済み。`,
      );
    }
    if (skippedEntries.length > 0) {
      console.log(`  (スキップ ${skippedEntries.length} 件は上記 [SKIP] を参照)`);
    }
  },
});
