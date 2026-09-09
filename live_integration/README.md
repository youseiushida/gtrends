# Google Trends 非公開 API 仕様調査レポート

調査日: **2026-09-09** (HAR キャプチャ: 2026-09-08)
対象ホスト: `https://trends.google.com`
検証環境: Deno 2.9.6 / Windows 11 / 日本 (非 EU) の IPv4
成果物: 本 README と `NN_*_test.ts` 13 本 (各ファイルは単体で `deno test` 可能、相互 import なし)

---

## 0. 結論 — 薄いラッパーを作るならこう設計せよ

1. **ブラウザ自動化は不要。`fetch` + 文字列処理 + `JSON.parse` だけで全機能に到達できる。** reCAPTCHA トークンも BotGuard blob も送らずに 200 が返る (実測)。
2. **Trending Now (急上昇) は `POST /_/TrendsUi/data/batchexecute` の `i0OFE` 一発。Cookie 不要・URL クエリ全省略可。** これが最も安定・最も安価な経路。
3. **Explore 系 (時系列/地域/関連) で `NID` Cookie が要るのは `/trends/api/explore` だけ。** `NID` は `GET /trends/explore?...` が返す **429 レスポンスの `Set-Cookie`** から 1.7KB で入手できる。
4. **`explore` は「ウィジェット定義 + 24 時間有効な token」を配るだけの API。** 実データは `token` を付けた `widgetdata/*` から取る。**token は 24h キャッシュせよ** (期限は token 自体からオフラインで読める)。
5. **`widget.request` は絶対に自前で書き換えるな。** token は req の署名で、1 バイト改変すると 401。条件を変えたければ explore を叩き直す。
6. **XSSI プレフィックスの長さはエンドポイントごとに違う。** `slice(5)` 決め打ちは壊れる。**「先頭が `)]}'` なら最初の LF までを捨てる」**の 1 行で統一せよ。
7. **`fetch` は必ず `redirect: "manual"`。** レート制限が悪化すると 429 ではなく **302 → `google.com/sorry/`** に昇格し、follow すると CAPTCHA の HTML を `status 200` で掴む。
8. **成功判定は `status === 200 && content-type が application/json`。** エラーは全部 `text/html`。`res.ok` は使い物にならない。
9. **batchexecute は HTTP 200 でも RPC 単位で失敗する** (`wrb.fr[2] === null`)。ステータスだけ見る実装は必ずバグる。
10. **レート制限は IP 単位・エンドポイント系統ごとに独立。** ただし **1 IP あたり約 100 件/分までは余裕がある** (下記 §1.3 の対照実験)。効くのは並列度であってリクエスト間隔ではない。直列 1 並列 + explore の呼び出し回数最小化 (token キャッシュ + 5 件バッチ) で十分。

---

### 1.3 レート制限の実測モデル (2026-09-09) — トークンバケット

`/trends/api/explore` に対し、**毎回クリーンな JP 住宅 IP** を 1 本ずつ使い、
一般英単語辞書からランダムに引いたキーワードで測定した (計 10 走行)。

#### 破綻位置はレートに依存せず、常に 89〜102 件目

| 目標レート | 実効 | 送信数 | 結果 | 破綻位置 |
|---|---|---|---|---|
| 60/分 | 60.8 | 61 | 完走・事後検査 200 | 焼けず |
| 60/分 × 10 分 | 60.0 | **435+** | 7.25 分間エラーゼロ (手動中断) | **焼けず** |
| 90/分 | 90.6 | 91 | 完走・事後検査 200 | 焼けず |
| 120/分 | 101.8 | 102 | 完走したが**事後検査 429** | #102 付近 |
| 120/分 | 120.8 | 89 | 429 | **#89** |
| 120/分 | 120.9 | 90 | 429 | **#90** |
| 120/分 | — | 90 | 429 | **#90** |
| 120/分 | — | 98 | 429 | **#98** |
| 240/分 | 235.5 | 92 | 429 (23.4 秒で到達) | **#92** |
| 480/分 | 103.8 | 95 | 429 | **#95** |

**レートを 120 → 480 に上げても破綻位置は動かない。** 速く投げれば速くそこに着くだけである。
→ リミッタは毎分レートではなく **容量 90〜100 件のトークンバケット**として振る舞う。

- **バケット容量 ≈ 90〜100 件** (バースト許容量)
- **補充速度は 60/分 と 120/分 の間** — 60/分では 435 件を 7 分以上流しても枯れず、
  120/分では約 45 秒 (≒90 件) で枯れる
- **1 分完走 = 安全ではない。** 120/分の走行は 102 件すべて 200 だったが、
  直後の 1 発が 429 だった。「全部 200 だった」を成功と読むと必ず誤る。
  **走行後に 1 発撃って焼けたかどうかを確かめること。**

#### 429 は **IP スコープ**である (Cookie を替えても回復しない)

クリーンな IP で 429 を 3 回踏み、**待機を一切挟まず**に 3 通りの復帰を試した。

| プローブ | 手段 | 結果 (3 イベント × 2 IP) |
|---|---|---|
| A [対照] | 古い NID のまま即再試行 | **6/6 とも 429** |
| B | 429 が返した NID で即再試行 | **実施不能** (§下記) |
| C [本命] | `/trends/explore` から**新品の NID を取得**して即再試行 | **3/3 とも 429** |

→ **429 は IP 単位。NID/Cookie をどう替えても回復せず、時間経過を待つしかない。**
  Cookie プールもクッキーのローテーションも一切効果が無い。

**重要: レート制限の 429 と、未 Cookie ゲートの 429 は別物である。**

| | 未 Cookie ゲートの 429 | レート制限の 429 |
|---|---|---|
| 発生条件 | Cookie 無しでのアクセス (回数に依存しない) | バケット枯渇 (~90〜100 件目) |
| `Set-Cookie: NID` | **新しい NID を配る** | **配らないか、配っても既存と同一** |
| 復帰方法 | **その NID を付けて即再試行すれば 200** | **時間経過のみ。即再試行は必ず 429** |

この 2 つを混同して「429 を受けたら Set-Cookie の NID を拾って再試行」と一律に実装すると、
レート制限時に**拾うものが無いのに再試行を繰り返す**ことになる。必ず区別すること。

#### 当初の記述の訂正

本 README が当初書いていた「数十回で /sorry」「1〜2 秒間隔が必須」には単独クライアントとしての裏付けが無かった。
あの数字は複数の調査エージェントが同一 IP から**並列に**叩いた総量である。
また途中で書いた「1 IP あたり約 100 件/分」も、30 件 15 秒からの外挿にすぎず誤りだった
(100 件は毎分レートの上限ではなく**バースト容量**であり、持続可能なレートは 60/分 前後)。

---

## 1. 調査サマリ

### 1.1 何を調べたか

Chrome DevTools の HAR (456 エントリ / うち `trends.google.com` 宛 111 件) をオフラインで全数解析し、
HAR にレスポンスボディが残っていない部分をライブ HTTP で叩いて確かめた。
検証結果は 13 本の Deno テストファイルとして固定してある (§9)。

HAR のキャプチャ内容:

- (a) `/trends/explore?q=Fanza&date=now 1-d&geo=JP&hl=ja` を開き、カテゴリ / プロパティ / 期間 / 地域 / キーワードを 13 回操作
- (b) `/trends/trendingsearches/daily?geo=JP&hl=ja` → 302 で `/trending` (新 UI) にリダイレクト

### 1.2 分かったこと (要点)

**Google Trends は 2 つの別サービスが同居している。**

| | 旧 Explore 系 | 新 Trending 系 |
|---|---|---|
| UI | `/trends/explore` (AngularJS 1.x + angular-material) | `/trending` (boq / Wiz) |
| API | `/trends/api/*` (REST 風 GET/POST) | `/_/TrendsUi/data/batchexecute` (RPC バッチ) |
| `server` ヘッダ | `GSE` | `ESF` |
| CSP report-uri | `/trends/cspreport` | `/_/TrendsUi/cspreport` |
| reCAPTCHA | v3 `6LfnfJYaAAAAAGZJh3AZH1Xmkg7dIj3IP5-xz19W` | Enterprise `6LfhzqgrAAAAAGN69At1CIr3hBxoEHOsTYep1qgU` |
| 認証 | `NID` Cookie (explore のみ) | 不要 |
| レートリミッタ | 中程度 (1 IP 約 100 件/分までは 429 ゼロ。**並列**に叩くと 302 /sorry に昇格) | 緩い (本調査で 429 ゼロ) |

この 2 系統は Cookie セットも、XSSI プレフィックスも、エラー形式も、レート制限の枠も別物である。
**同じ「Google Trends API」として 1 つの抽象に押し込めると必ず破綻する。**

**認証・ボット対策は現状ほぼ無力化できている (実測)。**

- `POST /trends/api/explore` の `"FE" + base64(["setoken", tokenA, tokenB])` ボディは**完全に省略しても 200**。
  `tokenB` (13KB〜18KB の BotGuard blob) はブラウザ内 VM でしか生成できないため、必須化されたら fetch 系ラッパーは原理的に詰む。**現状は不要。**
- `batchexecute` に `at=` (XSRF トークン) は存在しない。未ログインなので `WIZ_global_data.SNlM0e` が `null`。
- `x-browser-validation` / `sec-ch-ua-*` は Chrome 由来の定数で、送らなくても 200。**むしろ偽装すべきではない。**
- `userConfig.userType: "USER_TYPE_SCRAPER"` は全ユーザ共通の固定値であり、スクレイパー判定ではない (Cookie 完備のブラウザでも同じ値)。

**HAR にボディが無かった理由は「content-disposition: attachment だから」ではない (訂正)。**
`batchexecute` は `attachment` 付きなのに 27 件中 21 件でボディが保存されている。
真因は **DevTools のページ単位ボディ退避**で、エクスポート時に表示中だったページ (`page_2` = `/trending`) のボディだけが残った。
`/trends/api/*` は 71 件すべて `page_1` (Explore セッション) に属していたため全滅した。
→ **Explore ページを開いたまま HAR を再エクスポートすれば `/trends/api/*` のボディも取れる見込み。**

**バイト会計だけで構造を逆算した先行推定のうち、ライブ実測で覆ったもの:**

| 先行推定 | 実測での訂正 |
|---|---|
| 2 キーワード時の explore は 6 ウィジェット | **8 ウィジェット** (`TITLE_0` / `TITLE_1` は `request` も `token` も持たないため会計上見えなかった) |
| widget のフィールド名は `isPartial` | **`isCurated`** |
| `widgetdata` のプレフィックスは 5 バイト + 末尾改行 | **6 バイト (`)]}',\n`) + 末尾改行なし** (合計が同じなので会計では判別不能だった) |
| POST ボディのプレフィックスは `"FEW"` | **`"FE"` (2 文字)**。`W` は base64 の 1 文字目 (`WyJz` = `["s`) |
| `i0OFE` の `args[3]` はカテゴリフィルタ | **各トレンドに展開するニュース記事の最大件数** |
| `today 5-y` の resolution は MONTH | **WEEK** |
| resolution は 6 種 | **7 種** (`SIXTEEN_MINUTE` が存在する) |

---

## 2. エンドポイント一覧

推奨度: ★★★ = ラッパーの中核 / ★★ = 補助的に使う / ★ = 状況次第 / — = 使うな

### 2.1 旧 REST 系 (`server: GSE`)

| エンドポイント | 用途 | メソッド | 認証 | 生死 | 推奨 |
|---|---|---|---|---|---|
| `GET /trends/explore?q=..&date=..&geo=..&hl=..` | SPA の HTML シェル。**Cookie 無しだと 429 だが `Set-Cookie: NID` が付く** → NID 入手経路 | GET | 不要 (429 前提) | 生 | ★★★ (NID 取得専用) |
| `POST /trends/api/explore?hl=..&tz=..&req=..` | **ウィジェット定義 + token 発行**。実データは返さない | POST (GET でも可) | **`NID` 必須** (無いと 429) | 生 | ★★★ |
| `GET /trends/api/widgetdata/multiline?hl=..&tz=..&req=..&token=..` | 時系列 (Interest over time) | GET | **不要** (token のみ) | 生 | ★★★ |
| `GET /trends/api/widgetdata/comparedgeo?...` | 地域別 (Interest by region / city / DMA) | GET | **不要** | 生 | ★★★ |
| `GET /trends/api/widgetdata/relatedsearches?...` | 関連キーワード / 関連トピック | GET | **不要** | 生 | ★★★ (ただし ENTITY は常に空、§5.4) |
| `GET /trends/api/autocomplete/<keyword>?hl=..&tz=..` | キーワード → エンティティ (mid) 解決 | GET | **不要**。200 に `Set-Cookie: NID` が付く | 生 | ★★★ |
| `GET /trends/api/explore/pickers/geo?hl=..&tz=..` | 地域マスタ (250 ヶ国 + 下位地域 3,130) | GET | **不要。Cookie を付けると 302 /sorry** | 生 | ★★ (要キャッシュ) |
| `GET /trends/api/explore/pickers/category?hl=..&tz=..` | カテゴリマスタ (1,426 ノード) | GET | **不要**。同上 | 生 | ★★ (要キャッシュ) |
| `GET /trends/trendingsearches/daily?geo=..&hl=..` | 旧デイリートレンド UI | GET | — | **302 → `/trending`** | — |
| `GET /trends/api/dailytrends` | 旧デイリートレンド API | GET | — | **404 (廃止)** | — |
| `GET /trends/api/realtimetrends` | 旧リアルタイムトレンド API | GET | — | **404 (廃止)** | — |
| `GET /trending/rss?geo=..` | 急上昇 RSS 2.0 | GET | **不要** | **生** (200 / 約 19KB) | ★ (10 件固定、情報量少) |

### 2.2 新 boq 系 (`server: ESF`)

すべて `POST https://trends.google.com/_/TrendsUi/data/batchexecute` の RPC。
**URL クエリは 10 個すべて省略可能** (`rt=c` すら省略可 = レスポンス形式が変わる)。
**必須ヘッダは `content-type: application/x-www-form-urlencoded;charset=UTF-8` の 1 本だけ。** Cookie 不要。

| rpcid | 用途 | 引数 | reCAPTCHA | 生死 | 推奨 |
|---|---|---|---|---|---|
| `i0OFE` | **Trending Now 一覧** | `[null, null, geo, newsCount, hl, hours]` | 不要 | 生 | ★★★ |
| `wAgrOe` | geo コード → ローカライズ表示名 | `[geoCode, hl]` | 不要 | 生 | ★★ |
| `DqDTgb` | 地域ピッカー (国 + 下位地域) | `[hl, includeSubRegions(0/1), fullCountryList(0/1)]` | 不要 | 生 | ★★ |
| `hzg6Ed` | オートコンプリート (**サムネイル付き**) | `[query, hl]` | 不要 | 生 | ★ (旧 REST の方が扱いやすい) |
| `g4kJzf` | トレンド語のスパークライン時系列 | `[terms, null, null, null, [token,1,""], 1]` | **引数に Enterprise token を含む** | 生? | ★ (トークン無しでの挙動が未検証) |
| `we8Zrc` | ホーム画面用データ (推定) | `[geo, null, hl, null, null, [token,1,""]]` | **同上** | 生? | — (未解明) |
| `Tnt4U` | 用途不明。常に `[[]]` | `[]` | 不要 | 生 | — |
| `MHC2q` | 用途不明。常に `[]` | `[[geoCode]]` | 不要 | 生 | — |

### 2.3 HTML からのブートストラップ

| URL | 取れるもの | Cookie |
|---|---|---|
| `GET /trending?geo=..&hl=..` (200 / 約 1.22MB) | `WIZ_global_data` の `FdrFJe`(=`f.sid`) / `cfb2h`(=`bl`) / `irnl4d`(Enterprise サイトキー) / `rtQCxc`(=`tz`)、**および `AF_initDataCallback` に埋め込まれた `i0OFE` の結果 (`hours=24`、JP で 432 件)** | 不要。`Set-Cookie: NID` が付く |
| `GET /trends/explore?...` | Cookie 無しでは **429** で中身なし。`WIZ_global_data` も `AF_initDataCallback` も**存在しない** (レガシー Angular なので構造上ない) | — |

> **`f.sid` / `bl` は実測では batchexecute に不要**だった (両方省いても 200)。
> 将来の締め付けに備えて抽出ロジックを持っておく価値はあるが、通常フローで `/trending` の 1.2MB を落とす必要はない。
> 抽出は正規表現で足りる: `/"FdrFJe"\s*:\s*"((?:[^"\\]|\\.)*)"/` (HTML 1.2MB 中に出現回数 1)。

---

## 3. 典型フロー

### 3.1 Explore フル取得 (時系列 + 地域 + 関連キーワード)

```
[1] NID 取得 (24h に 1 回でよい)
    GET https://trends.google.com/trends/explore?q=<kw>&date=<time>&geo=<geo>&hl=<hl>
    Cookie: なし / redirect: manual
      -> 429 Too Many Requests (text/html, 約 1697B)   <-- これが正常
      -> Set-Cookie: NID=<値>; expires=+6か月; path=/; domain=.google.com; Secure; HttpOnly; SameSite=none
    ※ 「429 なのに成功」という直感に反する挙動。ボディは捨ててヘッダだけ使う。
    ※ より安い代替: GET /trends/api/autocomplete/<kw> は 200 で NID を付けてくれる。

[2] ウィジェット定義 + token 取得 (条件を変えるたびに 1 回)
    POST https://trends.google.com/trends/api/explore?hl=<hl>&tz=<tz>&req=<JSON>
    Cookie: NID=<値>          <-- ここだけ Cookie 必須
    Body : 空 (0 バイト)       <-- reCAPTCHA トークンは不要
      -> 200 application/json; charset=utf-8
         content-disposition: attachment; filename="json.txt"; filename*=UTF-8''json.txt
         本文 = ")]}'\n" + {"widgets":[...], "keywords":[...], "timeRanges":[...],
                            "shareText":"...", "shouldShowMultiHeatMapMessage":bool}

    単一キーワードなら widgets は必ずこの 4 個 (順序も固定):
      widgets[0] id=TIMESERIES       type=fe_line_chart          -> multiline
      widgets[1] id=GEO_MAP          type=fe_geo_chart_explore   -> comparedgeo
      widgets[2] id=RELATED_TOPICS   type=fe_related_searches    -> relatedsearches (keywordType=ENTITY)
      widgets[3] id=RELATED_QUERIES  type=fe_related_searches    -> relatedsearches (keywordType=QUERY)

[3] 実データ取得 (Cookie 不要。token が有効な 24 時間は [2] を再実行しなくてよい)
    GET /trends/api/widgetdata/multiline?hl=<hl>&tz=<tz>
        &req=<JSON.stringify(widget.request) をそのまま>
        &token=<widget.token をそのまま>
    Cookie: なし
      -> 200 application/json; charset=UTF-8
         本文 = ")]}',\n" + {"default":{"timelineData":[...],"averages":[...]}}
                  ^^ カンマに注意。explore とプレフィックス長が違う

    comparedgeo / relatedsearches も同じ形。widget.request は 1 バイトも触らないこと。
```

**token の寿命判定 (オフラインで可能):**

```
token: 44 文字 base64url (先頭は常に "ANI_2wMAAAAA")
  -> base64url decode -> 33 バイト
     bytes[0..8]   = 00 d2 3f db 03 00 00 00 00   (固定ヘッダ。HAR 54/54 + ライブで同一)
     bytes[9..12]  = ビッグエンディアン uint32 = 失効 UNIX 秒 (= 発行時刻 + 86400)
     bytes[13..32] = 20 バイトの署名 (widget ごとに一意)

※ 44 は 4 の倍数なのでパディング不要。無条件に "==" を足すと atob が
   InvalidCharacterError で落ちる。"=".repeat((4 - len % 4) % 4) と書くこと
   (本調査で実際に踏んだバグ)。
```

### 3.2 Trending Now (batchexecute 単発)

```
POST https://trends.google.com/_/TrendsUi/data/batchexecute
  (クエリ文字列は完全に空でも 200。ブラウザ互換にするなら
   ?rpcids=i0OFE&rt=c&hl=ja&_reqid=1 程度で十分)
Headers: content-type: application/x-www-form-urlencoded;charset=UTF-8   <-- これ 1 本だけで通る
Cookie : なし
Body   : f.req=<percent-encoded JSON>&

  f.req のデコード後:
    [[ ["i0OFE", "[null,null,\"JP\",0,\"ja\",4]", null, "generic"] ]]
        ^rpcid    ^args を JSON.stringify した「二段 JSON」   ^null  ^slotId (任意文字列)

  -> 200 application/json; charset=utf-8
     content-disposition: attachment; filename="response.bin"; filename*=UTF-8''response.bin

     ")]}'\n\n"          <-- 6 文字 (LF が 2 個)
     "20740\n"           <-- 長さ行 (UTF-16 コードユニット数)
     "[[\"wrb.fr\",\"i0OFE\",\"<ペイロードを JSON 文字列化したもの>\",null,null,null,\"generic\"]]\n"
     "43\n[[\"di\",26],[\"af.httprm\",25,\"...\",41]]\n"
     "26\n[[\"e\",4,null,null,25092]]\n"   <-- 最終チャンク。25092 は本文全体の UTF-8 バイト長

  ペイロードは JSON.parse を 2 回通す (wrb.fr[2] が文字列)。
```

**封筒パーサ (これだけで全 RPC に対応できる):**

```ts
function parseBatchExecute(text: string) {
  if (!text.startsWith(")]}'")) throw new Error("bad prefix");
  const items: unknown[][] = [];
  let pos = text.indexOf("\n") + 1;      // ")]}'" 行を捨てる
  if (text[pos] === "\n") pos++;         // rt=c の空行
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) break;
    const head = text.slice(pos, nl);
    if (!/^\d+$/.test(head)) {           // rt 省略形式: 長さ行が無くチャンクがベタ置き
      items.push(...JSON.parse(text.slice(pos)));
      break;
    }
    const n = Number(head);              // ★ UTF-16 コードユニット数 (バイトではない)
    items.push(...JSON.parse(text.slice(nl + 1, nl + n - 1)));  // ★ JSON.length === n - 2
    pos = nl + n;                        // ★ 次の長さ行の先頭
  }
  return items
    .filter((it) => it[0] === "wrb.fr")
    .map((it) => ({
      rpcid: it[1] as string,
      slot:  it[6] as string,
      error: it[5],                      // ★ null 以外なら RPC 失敗
      data:  it[2] === null ? null : JSON.parse(it[2] as string),
    }));
}
```

---

## 4. パラメータリファレンス

### 4.1 `time` (explore の `req.comparisonItem[].time` / URL の `date=`)

文法は 5 形態 (すべて実測):

| 形 | 例 | 備考 |
|---|---|---|
| `now N-H` | `now 1-H` `now 4-H` | 秒精度の窓。`H` は**大文字** |
| `now N-d` | `now 1-d` `now 7-d` | 同上。`d` は**小文字** |
| `today N-m` / `today N-y` | `today 1-m` `today 12-m` `today 5-y` | 日付精度 |
| `all` / `all_YYYY` | `all` `all_2008` | `all` の窓は `2004-01-01 <今日(UTC)>`。`all_2008` は `2008-01-01 ...` |
| 絶対指定 | `2024-01-01 2024-03-31` / `2026-09-08T10 2026-09-09T10` | 日付形式は verbatim にエコー。時刻形式は `THH` までしか書けず、サーバが `THH\:00\:00` に正規化 |

- **`now` の基準は常に UTC。`tz` は窓の算出に一切効かない** (実測: `tz=-540` と `tz=0` で窓端が同一)。
  ローカル日付で切りたければ自分で UTC に換算して絶対指定を使う。
- 返る `widget.request.time` は **1 日未満の窓のときだけコロンがバックスラッシュエスケープされる**
  (JS 文字列としては `2026-09-07T15\:49\:55`、JSON テキスト上は `\\:`、URL 上は `%5C%5C:`)。
  **自前で組み立てず、explore が返した文字列をそのまま透過させること。**
- エラー: 逆順 (`2024-03-31 2024-01-01`) と全区間未来 (`2030-01-01 2030-03-31`) は **400**。
  データ開始前 (`2000-01-01 2004-06-01`) と約 15 時間先の未来終端は **200 で受理**される。
- 不正な `time` は 400 (`text/html`、約 1691B)。リトライ不能なので送信前のローカル検証
  (start < end / start は今日以前 / start >= 2004-01-01) の価値が高い。

### 4.2 `resolution` (サーバが窓長だけから決める。クライアントは指示できない)

| resolution | backend | 窓長 (実測) | バケット |
|---|---|---|---|
| `MINUTE` | `CM` | ≤ 4h | 60 秒 |
| `EIGHT_MINUTE` | `CM` | 5h 〜 33h | 480 秒 |
| `SIXTEEN_MINUTE` | `CM` | 37h 〜 60h | 960 秒 |
| `HOUR` | `CM` | 72h 〜 7d | 3600 秒 |
| `DAY` | `IZG` | 8d 〜 **269d** | 86400 秒 |
| `WEEK` | `IZG` | **270d** 〜 1827d | 604800 秒 |
| `MONTH` | `IZG` | 2093d 〜 | 28〜31 日 (**不定**) |

- 切替点で実測確定しているのは **DAY→WEEK が 269 日 / 270 日の間**のみ (1 日刻みで確認)。
  他の境界には未測定区間が残る: (4h, 5h] / (33h, 37h] / (60h, 72h] / (7d, 8d] / (1827d, 2093d]。
- **`SIXTEEN_MINUTE` は UI のプリセット期間では絶対に出ない** (時刻付き絶対指定でのみ到達できる)。
- `backend` は resolution と 1:1 (`CM` = リアルタイム系 / `IZG` = 非リアルタイム系)。切替点は HOUR→DAY と一致。
- **`now 1-H` は 60 点ではなく 58 点だった。期間 ÷ バケット幅で点数を決め打ちしてはいけない。**
  また `MONTH` のときだけステップが 28〜31 日で不定なので、等間隔チェックを掛けてはいけない。

### 4.3 `geo`

| 指定 | `req` 内の形 | GEO_MAP の resolution |
|---|---|---|
| `""` (全世界) | `"geo": {}` | `COUNTRY` |
| `"JP"` | `{"country":"JP"}` | `REGION` |
| `"JP-13"` | `{"region":"JP-13"}` | `CITY` |
| `"US-CA-807"` | `{"dma":"807"}` (州部分は捨てられる) | `CITY` |

- **大文字必須。`"jp"` は 400。存在しないコード `"ZZ"` も 400。**
- `pickers/geo` が返す下位地域 id は**親からの相対コード** (`JP` の子は `"23"` であって `"JP-23"` ではない)。
  explore に渡すときは **親 id + `"-"` + 子 id** で組み立てる (`JP-13` は HAR の実リクエストと一致・確定)。
  米国 DMA の `US-<州>-<DMA番号>` 形式もライブで 200 を確認済み。
- `DqDTgb` (batchexecute) の下位地域コードは**完全形** (`"JP-23"` / `"US-AL"` / `"FR-B"`) で、`pickers/geo` とは形式が違う。**混ぜるな。**
- 件数 (実測): 国 250 / 下位地域を持つ国 192 / 下位地域ノード 3,130 / 第 3 階層は US のみ
  (延べ 301・ユニーク 210。1 つの DMA が複数州にまたがるため **dedupe 必須**) / JP=47 / US=51 / FR=22。
- FR の階層が 2 API で違う。`pickers/geo` は FR = 22 地域圏のみ (département なし)、`DqDTgb` は FR に département 96 件を持つ。

### 4.4 `category`

- **explore のカテゴリ ID と Trending Now (`i0OFE`) のカテゴリ ID は完全に別体系。混同厳禁。**
  - explore: `pickers/category` のツリー。ID 範囲 3〜1397。`3`=Arts & Entertainment / `12`=Business & Industrial / `20`=Sports / `8`=Games。
  - `i0OFE` の `item[10]`: 1〜20 の独自番号。`3`=Business & Finance / `4`=Entertainment / `17`=Sports / `20`=Climate & Weather (**実データからの推定**)。
- **explore 側は妥当性を検証しない。`category=999999` でも 200 が返り、`requestOptions.category` にそのままエコーされる。**
  妥当性チェックは `pickers/category` の一覧を使って自前で行うしかない。
- `pickers/category` の ID は **hl 非依存**だが **ツリー内で一意ではない**
  (DAG を木に展開しているため、ノード 1,426 に対しユニーク ID 1,132、231 個が複数箇所に出現)。
  ただし**同じ ID なら name も必ず同じ**なので `Map<number, string>` は安全。ID → 親パスは 1:N。
- トップレベル 25 件: 3 Arts & Entertainment / 47 Autos & Vehicles / 44 Beauty & Fitness / 22 Books & Literature /
  12 Business & Industrial / 5 Computers & Electronics / 7 Finance / 71 Food & Drink / 8 Games / 45 Health /
  65 Hobbies & Leisure / 11 Home & Garden / 13 Internet & Telecom / 958 Jobs & Education / 19 Law & Government /
  16 News / 299 Online Communities / 14 People & Society / 66 Pets & Animals / 29 Real Estate / 533 Reference /
  174 Science / 18 Shopping / 20 Sports / 67 Travel

### 4.5 `property` (URL 上の `gprop`)

- 値は `""` (ウェブ検索) / `"images"` / `"news"` / `"froogle"` (ショッピング) / `"youtube"` の 5 種。
- **widget 集合は property で変わらない** (5 種すべてで `[TIMESERIES, GEO_MAP, RELATED_TOPICS, RELATED_QUERIES]`)。
  YouTube でも GEO_MAP は REGION のまま。property は `requestOptions.property` にエコーされ、
  後段の widgetdata がどのコーパスを見るかを決めるだけ。
- **検証されない。`property="bogus"` でも 200 でエコーされる。**
- `category` と `property` は `req` から**省略可能**。その場合 `requestOptions` が `{"backend":"CM"}` だけになる。
  一方 `comparisonItem[].time` は必須で、省略すると 400。

### 4.6 `hl`

- 反映先が**エンドポイントで違う**:
  - `TIMESERIES` / `GEO_MAP` → `request.locale` に**そのまま** (`"en-US"`)
  - `RELATED_TOPICS` / `RELATED_QUERIES` → `request.language` に**主サブタグだけ** (`"en"`)
- 無効値 (`hl="zz-ZZ"`) はエラーにならず **`en-US` にフォールバック**する。
- ローカライズされるもの: `widget.title` / `GEO_MAP.searchInterestLabel` / `keywords[].type` / `timeRanges[]` /
  `shareText` / `TITLE_N.text` / RISING の `formattedValue` / autocomplete の `type` / `geoName`。
- `widgetdata` では **`hl` クエリが `req.locale` より優先**する (`locale="ja"` のまま `hl=en` を送ると出力は英語)。
- **`accept-language` ヘッダは結果に一切影響しない** (`ja` と `en-US,en;q=0.9` でレスポンスが完全同一)。
  言語を決めるのは URL の `hl` だけ。

### 4.7 `tz`

- 単位は**分**、符号規約は JS の `Date#getTimezoneOffset()` と同じ (**JST = `-540`**、UTC より東が負)。
- **explore の窓算出には一切効かない** (実測)。効くのは `multiline` の `formattedTime` / `formattedAxisTime` の表示シフトだけ。
  実測: epoch `1788795840` (= 2026-09-07T15:44Z) が `tz=-540&hl=ja` で `"2026/09/08 0:44"`、
  `tz=0&hl=en` で `"Sep 7, 2026 at 3:44 PM"`、`tz=240&hl=ja` で `"2026/09/07 11:44"`。
  `time` (epoch) / `value` / `hasData` は完全に不変。
- `tz=1440` / `-1440` / `99999` は **400**。有効範囲は `|tz| < 1440` と**推定** (±1439 は未検証)。
- `pickers/*` と `autocomplete` では `tz` は**完全に無意味** (有無でレスポンスがバイト単位で一致)。
- ブラウザは explore と multiline で **`tz` を 2 回付ける** (`hl,tz,req,tz`) が、
  これは AngularJS の interceptor による二重付与で **1 回でも動く**。

---

## 5. レスポンススキーマの要点

### 5.1 `POST /trends/api/explore`

プレフィックス `)]}'\n` (**5 バイト、カンマ無し**)。トップレベルのキーは 5 つで全部:

```jsonc
{
  "widgets": [ /* 下記 */ ],
  "keywords": [{"keyword":"Fanza","name":"Fanza","type":"検索キーワード"}],
  "timeRanges": ["過去 1 日"],
  "shareText": "...",
  "shouldShowMultiHeatMapMessage": false
}
```

widget 共通フィールド: `id` / `type` / `title` / `template` / `embedTemplate` / `version` (文字列 `"1"`) / `isLong` / **`isCurated`**。
データ取得系のみ `request` と `token` を持つ (`token` は widget ごとに相異なる)。
`GEO_MAP` 系は widget 直下にも `geo` / `resolution` / `searchInterestLabel` / `displayMode` / `color` / `index` / `bullet` を持つ
(これは描画メタで `request.resolution` とは別物)。

**キーワード数による widget 構成 (実測):**

| キーワード数 | widgets |
|---|---|
| 1 | `TIMESERIES`, `GEO_MAP`, `RELATED_TOPICS`, `RELATED_QUERIES` (4 個) |
| N ≥ 2 (同一 geo) | `TIMESERIES`, `GEO_MAP`, 以降 `TITLE_i`, `GEO_MAP_i`, `RELATED_QUERIES_i` を i=0..N-1 (**2 + 3N 個**。N=5 で 17 個を実測) |
| N ≥ 2 (geo 混在) | `TIMESERIES`, **`geos_note`**, 以下同じ (統合 GEO_MAP の代わりに注意文テキスト widget) |

- **N ≥ 2 では `RELATED_TOPICS` が一切返らない。** 関連トピックが欲しければキーワードごとに explore を 1 回ずつ叩くしかない。
- `TITLE_i` / `geos_note` は `type: "fe_text"` で `request` も `token` も持たない (`text.text` にラベルが入るだけ)。
- 統合 `GEO_MAP` は N ≥ 2 で `type: "fe_multi_heat_map"` になり `request` に `"dataMode":"PERCENTAGES"` が付く。
- **`comparisonItem` の上限は 5 件。6 件で 400。**
- `keyword` に Knowledge Graph の mid (`/m/02vqfm`) を渡すと `keywords[0]` が
  `{keyword:"/m/02vqfm", name:"Coffee", type:"Beverage"}` になり、
  `complexKeywordsRestriction.keyword[0].type` が `BROAD` → `ENTITY` に変わる。
- **異常系の 200 に注意:** `comparisonItem` に `keyword` を書かず `complexKeywordsRestriction` を直接書くと
  200 だが縮退し、widgets が `rt_note` テキスト 1 個だけになる。
  **token を 1 つも持たない 200 応答は異常として扱うこと。**

`widget.request` のスキーマ (エンドポイント別):

```jsonc
// TIMESERIES -> multiline
{ "time":"2026-09-07T14\\:53\\:39 2026-09-08T14\\:53\\:39", "resolution":"EIGHT_MINUTE", "locale":"ja",
  "comparisonItem":[{"geo":{"country":"JP"},
                     "complexKeywordsRestriction":{"keyword":[{"type":"BROAD","value":"Fanza"}]}}],
  "requestOptions":{"property":"","backend":"CM","category":0},
  "userConfig":{"userType":"USER_TYPE_SCRAPER"} }

// GEO_MAP -> comparedgeo   (geo がトップレベル、time が comparisonItem 側)
{ "geo":{"country":"JP"},
  "comparisonItem":[{"time":"2008-01-01 2026-09-08","complexKeywordsRestriction":{...}}],
  "resolution":"REGION", "locale":"ja",
  "requestOptions":{...}, "userConfig":{...}
  /* , "dataMode":"PERCENTAGES" は複数キーワード統合時のみ */ }

// RELATED_TOPICS / RELATED_QUERIES -> relatedsearches
{ "restriction":{"geo":{"country":"JP"}, "time":"...",
                 "originalTimeRangeForExploreUrl":"now 1-d",
                 "complexKeywordsRestriction":{...}},
  "keywordType":"ENTITY" /* または "QUERY" */,
  "metric":["TOP","RISING"],
  "trendinessSettings":{"compareTime":"2026-09-06T14\\:53\\:39 2026-09-07T14\\:53\\:39"},
  "requestOptions":{...}, "language":"ja", "userCountryCode":"JP", "userConfig":{...} }
```

- `trendinessSettings.compareTime`: 通常は「直前の同じ長さの窓」。
  **`all` / `all_YYYY` だけは「窓開始 .. 窓開始 + 1 年」** (`all_2008` → `2008-01-01 2009-01-01`)。
  日付精度の窓では「終端 = 窓開始日の前日、長さは同じ」。
- `userCountryCode` は geo でも hl でもなく**アクセス元 IP の国**。日本から `geo=US&hl=en-US` を叩いても `"JP"`。
- **落とし穴:** geo 混在比較のときの `RELATED_QUERIES_N` は `restriction.originalTimeRangeForExploreUrl` に
  **時間範囲ではなくローカライズされた地域名** (`"日本"` / `"アメリカ合衆国"`) が入る (Google 側のバグと思われる)。
  この値を時間範囲としてパースしてはいけない。単一 geo のときは正しく `"now 1-d"` が入る。

### 5.2 `GET /trends/api/widgetdata/multiline` (時系列)

プレフィックス `)]}',\n` (**6 バイト、カンマ有り**)。**末尾に改行は付かない。**

```jsonc
{"default":{"timelineData":[ /* point */ ], "averages":[ /* number */ ]}}
```

`point` のフィールドはこの 8 個で全部 (ライブ 7 応答・1,000 点超の和集合):

| キー | 型 | 備考 |
|---|---|---|
| `time` | **string** | UNIX 秒の 10 進**文字列**。数値ではない |
| `formattedTime` | string | `tz` / `hl` でローカライズ |
| `formattedAxisTime` | string | 同上 |
| `value` | `number[N]` | 0〜100 の整数。N = `comparisonItem` の件数 |
| `hasData` | `boolean[N]` | |
| `formattedValue` | `string[N]` | |
| `isPartial` | `boolean?` | **最後の 1 点にだけ `true` が付く。他の点はプロパティ自体が存在しない (false ではなく undefined)** |
| `axisNote` | `{text:string}?` | Google 側の計測方法変更の注記 (2011-01 / 2016-01 / 2022-01 で観測) |

- **0-100 正規化は「系列ごと」ではなく「全系列を通した最大が 100」** (iPhone/Android 比較で max(value[0])=100, max(value[1])=36)。
  `value[i]` の並びは `req.comparisonItem[i]` の順と一致する。
- **`hasData[i] === true` でも `value[i] === 0` になる** (実値が 0 超 1 未満のとき)。
  そのとき `formattedValue[i]` は `"1 未満"` のようなローカライズ文字列になる。
  **`formattedValue` を `parseInt` するな。** `hasData === false` の点は必ず `value === 0`。
- `averages` は **`comparisonItem` が 1 件のとき常に `[]`** (`widget.showAverages=false` と対応)。
  2 件以上のとき、**`hasData=false` の点も 0 として含めた全点の算術平均を四捨五入した整数**が入る
  (実測 273 点で 40.919→41 / 10.993→11 が一致。`hasData=true` の点だけの平均では説明できない)。
- `hl=en` の `formattedTime` は AM/PM の直前が **U+202F (narrow no-break space)**。
  `"3:44 PM"` のような素朴な文字列一致は失敗する。
- **データ 0 件も 200 の正常応答** (`{"default":{"timelineData":[],"averages":[]}}`、前置込み 51 バイト)。429 と区別すること。
- **確定値だけ欲しいなら末尾 1 点 (`isPartial: true`) を捨てる。**

### 5.3 `GET /trends/api/widgetdata/comparedgeo` (地域別)

`{"default":{"geoMapData":[ ... ]}}`。**アイテム形状が resolution で 2 種類に割れる (最大の落とし穴)。**

| resolution | キー |
|---|---|
| `COUNTRY` / `REGION` / `DMA` | `geoCode`, `geoName`, `value[]`, `formattedValue[]`, `maxValueIndex`, `hasData[]` |
| **`CITY`** | **`geoCode` が無い。代わりに `coordinates:{lat,lng}`** + `geoName`, `value[]`, `formattedValue[]`, `maxValueIndex`, `hasData[]` |

→ **CITY では地域を一意識別するコードが取れない。** 地名と緯度経度で扱うしかない。

- `hasData[i] === false` のとき `value[i] = 0` かつ `formattedValue[i] = ""`。
  **`value` だけでは「人気度 0」と「データ無し」を区別できない。**
- `geoMapData` は `value` の降順にソート済みで、先頭の `value[0]` は 100。ただし全件 `hasData=false` のときは順序不定。
- 要素数 (実測): JP/REGION=47 (`JP-01`〜`JP-47` が重複なく揃う) / JP/CITY=200 / JP-13/CITY=58 / US-CA/DMA=14 / world/COUNTRY=250。
- **`includeLowSearchVolumeGeos: true`** (ブラウザは送らない任意 boolean) を `req` に後付けすると、
  配列長は変わらないまま `hasData=true` の件数が増える (world/COUNTRY で 9 → 100)。
  「低ボリューム地域にも値を出すか」であって「地域を追加するか」ではない。
- DMA の `geoCode` は ISO ではなく **Nielsen DMA の数値コード文字列** (`"862"` = サクラメント‐ストックトン‐モデスト)。
  `geoName` は `req.locale` の言語にローカライズされる。
- `geo={country:"JP"}` のまま `resolution=COUNTRY` にすると **400**
  (CITY への書き換えは 200 なので、署名エラーではなく組み合わせが意味的に不正なため、と**推定**)。

### 5.4 `GET /trends/api/widgetdata/relatedsearches` (関連)

プレフィックス `)]}',\n` (6 バイト)。

```jsonc
{"default":{"rankedList":[ {"rankedKeyword":[ /* TOP */ ]}, {"rankedKeyword":[ /* RISING */ ]} ]}}
```

- `rankedList` は `req.metric` (HAR 26/26 で `["TOP","RISING"]` 固定) と順序まで 1:1 対応する。
- **`TOP` のアイテム:** `query` / `value` (0〜100 の整数、降順、先頭は必ず 100) / `formattedValue` (`String(value)`) /
  **`hasData`** (常に true) / `link`。1 リストあたり最大 **25 件**。
- **`RISING` のアイテム:** `query` / `value` / `formattedValue` / `link`。
  **`hasData` が存在しない** (TOP とキー集合が違う。共通型にするなら optional にすること)。
- `RISING` の `formattedValue` はロケール依存: `hl=ja` → `"急激増加"` / `"2,250% 増加"` (先頭に `+` なし)、
  `hl=en-US` → `"Breakout"` / `"+300%"` (先頭に `+` あり)。
  **ブレイクアウト判定は閾値ではなく「`formattedValue` に数字が含まれないか」で行うこと**
  (数字が含まれる場合、数字だけ抜いて連結すると `value` と一致する。全件で成立)。
  閾値は実測ブラケット `(4650, 5200]` までしか絞れておらず、よく言われる 5000 は**推定**。
- **`link` は相対パス** `/trends/explore?q=<+区切り>&date=<originalTimeRangeForExploreUrl>&geo=<geo>`。
- 本文は**純 ASCII** (非 ASCII は `\uXXXX` エスケープ。さらに Gson の HTML セーフ既定で
  `=` は `=`、`&` は `&` にエスケープされる)。
  したがって `body.length` (UTF-16) === UTF-8 バイト数 が常に成立する
  (batchexecute の長さ行が UTF-16 単位である話とは別の現象)。

**★ 最大の注意: `RELATED_TOPICS` (`keywordType: "ENTITY"`) は常に空を返す。**
HAR の実ブラウザセッション 12/12 (全て `content.size=35`) もライブ 4/4 も `{"default":{"rankedList":[]}}` だった。
explore に mid を渡して `type` が `ENTITY` になったケースでも空。
**「ENTITY は空が正常」として扱うこと。**
`rankedKeyword` が `topic:{mid,title,type}` を持つという一般に知られた構造は、本調査では**一度も観測できていない**。

無データ時の形が **ENTITY と QUERY で非対称**:

| | 本文 | 全体バイト数 |
|---|---|---|
| ENTITY 空 | `{"default":{"rankedList":[]}}` | 35 |
| QUERY 空 | `{"default":{"rankedList":[{"rankedKeyword":[]},{"rankedKeyword":[]}]}}` | 76 |
| multiline 空 | `{"default":{"timelineData":[],"averages":[]}}` | 51 |

(いずれも「6 バイトのプレフィックス + JSON + 末尾改行なし」で 1 バイトの誤差なく一致する。
先行調査の「5 バイト + 末尾改行」でも合計が同じになるため、バイト会計だけでは判別できなかった。)

### 5.5 `GET /trends/api/autocomplete/<keyword>`

プレフィックス `)]}',\n` (6 バイト)、末尾改行なし。

```jsonc
{"default":{"topics":[{"mid":"/g/11g2ldrmg2","title":"FANZA","type":"トピック"}, ...]}}
```

- `topics[i]` のキーは **`mid` / `title` / `type` のちょうど 3 個** (9 応答 45 件で確認)。**サムネイル URL は返らない。**
- **件数は常にちょうど 5 件。** 1 文字クエリ (`"a"`) でも 5 件返る (最小クエリ長の制限なし)。
- **Cookie 完全不要。しかも 200 に `Set-Cookie: NID` が付く** (「NID 入手 + エンティティ解決」の一石二鳥)。
- キーワードは **URL パス末尾**。`encodeURIComponent()` 必須 (`encodeURI()` では不足)。
  `/trends/api/autocomplete/AC/DC` は **404**、`AC%2FDC` なら 200 で `{"mid":"/m/0134s5","title":"AC/DC","type":"Rock band"}`。
- `mid` は `/m/...` (旧 Freebase) か `/g/...` (Knowledge Graph)。非 ASCII は `\uXXXX` エスケープで返る。
- `type` の `"Topic"` / `"トピック"` は「型不明」の汎用ラベル (新 `hzg6Ed` では空文字列 `""` に対応)。
  **曖昧性解消 UI で意味のあるラベルとして見せてはいけない。**

### 5.6 `POST batchexecute` — `i0OFE` (Trending Now)

引数: `[null, null, geo, newsCount, hl, hours]` (第 7 要素 `1` の有無はペイロードに一切影響しない)。

ペイロード: `[null, items]`。`items[i]` は **arity 13 固定**:

| idx | 型 | 意味 |
|---|---|---|
| 0 | string | 表示用トレンド語 |
| 1 | `null \| NewsArticle[]` | **`args[3]` (newsCount) が 0 なら全件 null。1 以上なら記事が展開される** |
| 2 | string | geo コード |
| 3 | `[int]` | 開始 UNIX 秒 (**要素 1 個の配列**。600 秒の倍数) |
| 4 | `[int] \| null` | 終了 UNIX 秒。**`null` = トレンド継続中** |
| 5 | null | 常に null |
| 6 | int | 検索ボリューム下限 (`{100,200,500,1000,2000,5000,10000,20000,50000,1000000}` を観測) |
| 7 | null | 常に null |
| 8 | int | 増加率 % (`{50,75,100,200,...,1000}` を観測。1000 が最頻) |
| 9 | string[] | 関連クエリ。**`item[9][0] === item[0]` が 279/279 で成立** |
| 10 | int[] | カテゴリ ID (1〜3 個。1〜20 の**独自**体系。§4.4 参照) |
| 11 | `[[int,string,string]]` | 記事参照 `[記事ID, 言語, geo]` のみ。本文 / URL / 画像は含まない |
| 12 | string | 正規化キー |

- **`item[12]` の正規化規則 (HAR 279/279 で機械検証):**
  `s.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC")`
  濁点・半濁点だけでなくラテン文字のアクセントも落ちる
  (`"séamus coleman"` → `"seamus coleman"`、`"男子バレー アジア選手権"` → `"男子ハレー アシア選手権"`)。
- `item[1]` の `NewsArticle` は arity 5 (画像が無い記事は要素ごと存在せず arity 4):
  `[記事タイトル, 記事URL (媒体の実 URL。Google リダイレクタではない), 媒体名, [公開UNIX秒], サムネイルURL]`。
  **`item[1]` と `item[11]` は独立で長さも一致しない** (`item[1]` が 16 件でも `item[11]` は 3 件、など)。
- **`args[5]` = 遡る時間窓 (時間単位)。** 実測 (geo=JP): 4 → 65 件 / 13KB、24 → 428 件 / 102KB、
  48 → 777 件 / 193KB、168 → 2,491 件 / 647KB。168 (7 日) まで 200。
  ブラウザ UI は 4、`/trending` の HTML 埋め込み (`ds:0`) は 24 を使う。
- **`args[3]` = ニュース記事の最大展開数。** 実測 (geo=JP, hours=4): 0 → 13KB、1 → 30KB、16 → 228KB、17 → 232KB。
  **アイテム件数・カテゴリ分布・開始時刻分布は変わらない** (絞り込みではない)。
- **ページング機構は存在しない** (cursor / offset / limit に相当する引数もフィールドも無い)。1 リクエストで窓内の全件が返る。
- **並び順は「開始時刻順」でも「ボリューム降順」でも「継続中が先」でもない。順序に依存するな。**
- **`hours` と `newsCount` を同時に大きくするとレスポンスが急増する** (容易に数 MB 級)。メモリに注意。
- **RPC 単位のエラー:** 存在しない geo (`"XX"`) を渡すと HTTP は 200 のまま、
  `["wrb.fr","i0OFE",null,null,null,[3],"generic"]` (140 バイト) が返る。§6.3 参照。

### 5.7 `POST batchexecute` — その他の RPC

- **`DqDTgb`** `[hl, includeSubRegions, fullCountryList]`。
  第 2 引数 0 で下位地域が消える (ja: 86,719B → 6,571B)。
  **第 3 引数 1 で国が 125 → 250 件に拡張**され、`pickers/geo` の 250 ヶ国と**完全一致** (差分ゼロ)。引数省略は 0 扱い。
  ペイロード = `[countries, currentGeo]`。国ノードは `[code, displayName, sortKey]`
  (+ 英字別名を持つのは **7 ヶ国のみ**: US:[usa] AE:[uae] GB:[uk,britain,great britain] NL:[holland] CH:[swiss] TR:[turkey] BR:[brasil])。
  `sortKey` は `hl=ja` では濁点除去済みカナ (アイルランド→アイルラント)、`hl=en` では単なる小文字化。
  `currentGeo` = `[["JP","日本"]]` はアクセス元 IP から解決された既定地域 (hl を変えてもコードは同じ)。
- **`wAgrOe`** `[geoCode, hl]` → `["アイルランド"]` (長さ 1 の配列)。
- **`hzg6Ed`** `[query, hl]` → `[[item, ...]]`。item は **arity 5**:
  `[mid, title, type (不明なら "" ), thumbnailUrl | null, boolean]`。
  **候補ゼロのときは `[[]]` ではなく `[]` を返す** (`payload[0] ?? []` と書かないと undefined を踏む)。
  **2 文字以上でないと候補を返さない** (1 文字は空応答 136 バイト、HAR の `content.size` と完全一致)。
  第 5 要素の boolean は「サムネイル画像の表示ヒント (ロゴなので切り抜くな、等)」と**推測**。
  同じ mid でもクエリが変われば反転し、同時にサムネイルも別画像になる。画像 null の item は必ず false。**この値に依存するな。**
- **`Tnt4U`** `[]` → 常に `[[]]`。**`MHC2q`** `[[geo]]` → 常に `[]`。用途不明。呼出順は `MHC2q → Tnt4U → i0OFE`。
- **`g4kJzf`** (スパークライン) は引数に reCAPTCHA Enterprise トークンを含む。トークン無しで通るかは**未検証**。
  引数 `[terms, null, null, null, [token,1,""], 1]`、`terms[i] = [geo, term, resolution, null, 3]`。
  `resolution=3` → 91 点 / 960 秒バケット / 24.27h、`resolution=2` → 31 点 / 480 秒バケット / 4.13h。1 リクエスト最大 10 語。
  ペイロードは `[[row,...]]`、row は arity 5 `[term, null, null, 平均値(int), points[]]`、
  point は arity 5 `[生値|null, 丸め値 0-100, [[開始],[終了]], 先頭末尾のみ true, バケット充足率]`。
  `row[3]` は `point[1]` の算術平均を四捨五入した値 (35/35 系列で完全一致)。

### 5.8 `GET /trending/rss?geo=..`

RSS 2.0 + `xmlns:ht="https://trends.google.com/trending/rss"`。**`<item>` はちょうど 10 件固定**
(件数指定パラメータは見つからず)。Cookie 不要、`text/xml; charset=utf-8`、約 19KB。

- `<ht:approx_traffic>` = `"100+"` `"2000+"` のような閾値文字列
- `<description/>` は常に空。`<link>` はフィード自身の URL で個別ページではない (無意味)
- **`<pubDate>` のオフセットは `geo=JP` でも `-0700` 固定** (ローカル時刻とみなさず、オフセット込みでパースすること)
- `<ht:news_item>` は **0〜3 件（上限 3、可変）** (`<ht:news_item_title>` / `<ht:news_item_snippet>` (常に空だが要素は必ず存在) /
  `<ht:news_item_url>` / `<ht:news_item_picture>` / `<ht:news_item_source>`)
  - ★訂正の経緯 (2026-09-09、**2 度誤っている**): 当初「3 件固定」→ 0 件の item を踏んで否定 →
    「0 か 3 の二値」→ 1 件・2 件の item を踏んで否定。いずれも 1 サンプルからの過剰な一般化が原因。
    確定した分布は geo=JP×2 + US + GB の計 40 item で **0件=4 / 1件=1 / 2件=3 / 3件=34**。
    3 件が多数派だが保証はない。ラッパーは 0〜2 件の item をすべて許容すること。
  - `<ht:picture>` と `<ht:news_item_picture>` は **要素が存在しても中身が空文字**のことがある。
    空文字を「画像あり」と誤判定せず null に正規化すること。

情報量では `i0OFE` (`newsCount > 0`) が完全に上位互換 (開始/終了時刻・増加率・カテゴリ・関連クエリが取れ、
件数も 10 件に限定されない)。軽さ最優先なら RSS。

---

## 6. 落とし穴集

### 6.1 XSSI プレフィックスの長さがエンドポイントごとに違う (実測)

| エンドポイント | プレフィックス | 末尾改行 |
|---|---|---|
| `/trends/api/explore` | `)]}'\n` (5) | なし |
| `/trends/api/explore/pickers/*` | `)]}'\n` (5) | なし |
| `/trends/api/widgetdata/multiline` | **`)]}',\n` (6、カンマ有り)** | なし |
| `/trends/api/widgetdata/relatedsearches` | **`)]}',\n` (6)** | なし |
| `/trends/api/autocomplete/<kw>` | **`)]}',\n` (6)** | なし |
| `/_/TrendsUi/data/batchexecute` | `)]}'\n\n` (6、LF が 2 個) | あり |

> `comparedgeo` については報告が食い違っている (5 バイトとする実測と、widgetdata 系は一律 6 バイトとする実測)。
> **どちらでも壊れない書き方をせよ:**
> ```ts
> const json = text.startsWith(")]}'") ? text.slice(text.indexOf("\n") + 1) : text;
> ```
> `slice(5)` 決め打ちは `widgetdata` で `,` が残って `JSON.parse` が落ちる。

### 6.2 batchexecute の長さ行の単位 — **UTF-16 コードユニット** (実測で確定)

```
body.slice(nl, nl + N) === "\n" + <チャンクJSON> + "\n"
  ^ nl は長さ数字列を終端する LF の位置、N は長さ行の値
  ^ したがって JSON = body.slice(nl+1, nl+N-1)、JSON.length === N - 2
  ^ 次の長さ行は nl + N から始まる
```

- **「LF を読み飛ばして N 文字読む」と 1 文字ずれる** (N は前後 2 個の LF を含んでいる)。
- **バイト数ではない。** 反例: `DqDTgb` の長さ行 50055 に対し UTF-16 50053 / UTF-8 **86617**。
  `i0OFE` の 20740 に対し UTF-16 20738 / UTF-8 **24992**。`g4kJzf` の 50484 に対し UTF-16 50482 / UTF-8 **50594**。
  保存済み 21 ボディ中 13 ボディで UTF-8 解釈が破綻する (残り 8 は中身が ASCII のみで 3 つの単位が偶然一致する)。
  **小さいレスポンスだけ見て実装すると日本語が返った瞬間に壊れる。**
- UTF-16 であることは、`f.req` の `slotId` に `"s🇯🇵e"` (2 コードポイント / 4 UTF-16 ユニット / 8 UTF-8 バイト) を
  入れてサーバにエコーさせる手口で確定した。長さ行 111 に対し
  UTF-16 = 109 (= N-2 ✅) / コードポイント = 107 (✗) / UTF-8 = 117 (✗)。
- **同一レスポンス内で単位が混在する。** 終端チャンク `[["e", k, null, null, T]]` の `T` は**本文全体の UTF-8 バイト長**。
  照合するなら `new TextEncoder().encode(body).length` と比べること。`k` は全チャンク平坦化後のアイテム総数 (1 始まり)。
- **`res.text()` が返す文字列にそのまま `slice` すれば正しく動く。** 自前でバイト計算しないこと。

### 6.3 batchexecute の順序とエラー

- **チャンク境界は単なるフラッシュ点で意味を持たない。** 必ず全チャンクを平坦化してから `[0] === "wrb.fr"` で拾う。
- **レスポンスの `wrb.fr` の順序はリクエストの call 順と一致しない** (HAR・ライブとも逆転を実測)。
  `rpcid` か `slotId` で突合すること。同じ rpcid を 1 バッチで複数回呼ぶなら `slotId` 必須
  (`f.req` の `call[3]` が `wrb.fr[6]` にそのままエコーされる)。
- **RPC 単位のエラーは HTTP 200 のまま返る。**
  `["wrb.fr","i0OFE",null,null,null,[3],"generic"]` — つまり
  **`wrb.fr[2]` (ペイロード) が null、`wrb.fr[5]` にエラーコード配列 `[3]`**。
  `content-disposition` も付き、見た目は完全な正常応答。**`res.ok` では絶対に検出できない。**
- **リクエスト全体のエラーは HTTP 400 + `er` チャンク**:
  `["er",null,null,null,null,400,null,null,null,3]` (arity 10、index 5 = HTTP ステータス、index 9 = 3)。
  `wrb.fr` は 1 個も返らない。誘発条件: 存在しない rpcid / 壊れた `f.req` JSON / `f.req` フィールドそのものが無い。
- `3` は gRPC 標準コードの `INVALID_ARGUMENT` と一致するが、これは値の一致からの**推定**。
- **`rpcids` クエリは実ディスパッチに使われない。** `?rpcids=i0OFE` と指定しつつ `f.req` に `wAgrOe` だけを入れると
  `wAgrOe` が返る。サーバは `f.req` の中身だけを見る。
- **`rt` はレスポンス形式のスイッチ。** `rt=c` = 長さ行付きチャンク封筒 (ブラウザはこれ)。
  `rt` 省略 = `)]}'\n\n` の直後にチャンク JSON が 1 個ベタ置き (長さ行なし・終端 `e` チャンクなし・末尾 LF なし)。
  `rt=b` = protobuf バイナリ (`content-type: application/octet-stream`)。
  パースは `rt` 省略の方が楽だが、途中切断を検出する術が無くなる。

### 6.4 `token` の期限と署名スコープ

- 期限は **発行 + 24 時間ちょうど** (HAR 54/54 で 86399 or 86400 秒)。token 自体からオフラインで読める (§3.1)。
- **`req` を改変すると 401。** 実測で 401 になった改変:
  keyword / time / `resolution` (multiline) / `locale` / `requestOptions.category` / `geo`。
  token 省略も 401、token を 1 文字改竄しても 401。
- **例外 (実測):** `comparedgeo` に限り **`resolution` を `REGION` → `CITY` に書き換えても 200**、
  `includeLowSearchVolumeGeos` を後付けしても 200。
  → **explore を 1 回叩けば、追加の explore なしで「都道府県別」と「市区町村別」を取り分けられる。**
  署名対象は `geo` / `locale` / `requestOptions` / `comparisonItem` と考えられる (**推定**)。
  `multiline` の `resolution` は署名対象なので、**この例外を一般化してはいけない。**
- **401 なのにエラーページのタイトルは `Error 401 (Bad Request)!!1`。** 400 とボディ長 (1691 バイト) まで完全に同一。
  エラー判定は `/<title>Error (\d{3}) [(（]/` のように**数値コードだけ**を見ること
  (404 は `accept-language: ja` で `Error 404 (見つかりませんでした)!!1` と日本語化される)。
- 同じ日の 2 回の実行で、同一の不正 token リクエストが 1 回目 400 / 2 回目 401 を返した事例がある。
  **400 と 401 は同じ「入力エラー」バケツに入れるのが安全。**

### 6.5 429 と 302 /sorry

- **429 は `content-type: text/html; charset=utf-8`、本文約 1697 バイト、`Retry-After` ヘッダ無し、`content-disposition` 無し。**
  目印: `<title>Error 429 (Too Many Requests)!!1</title>` / `id="af-error-container"` /
  `We're sorry, but you have sent too many requests to us recently.`
- **429 の先に 302 のブロック段階がある。** 同一 IP から**並列に**数十リクエスト投げると、`/trends/api/explore` が
  (※直列なら 1 IP で 30 連続 × 0.5〜2 秒間隔でも 429 ゼロ。昇格の主因は総量ではなく並列度 — §1.3)
  `302 → https://www.google.com/sorry/index?continue=<元URL>&hl=ja&q=<チャレンジ>`
  (Google の abuse インタースティシャル / reCAPTCHA) に昇格する。
- **この 302 は NID 単位ではなく IP 単位。** その場で取り直した新品の NID を付けても 302 のまま。
- **`fetch` のデフォルト `redirect: "follow"` だと 302 が黙って追跡され、CAPTCHA ページの HTML が
  `status 200` + `text/html` で返る。** `res.ok === true` になり、`JSON.parse` が謎の `SyntaxError` で
  落ちる形で表面化する。**`redirect: "manual"` を必ず指定せよ。**
  代替として `res.url` が `https://www.google.com/sorry/` で始まらないかを確認する手もある。
- **ブロックはエンドポイント系統ごとに独立。** explore が 302 に落ちている最中でも、
  `widgetdata` は 401 を、存在しないパスは 404 を、`batchexecute` は 200 を正常に返し続けた。
  **「429 が出た = 全部死んだ」と判断してはいけない。**
- **429 は確率的。** HAR の正規ブラウザセッション (Cookie も reCAPTCHA も完備) でも、
  並列 4 本のうち 1 本だけが 429 になった例がある (残り 3 本は 200)。
- **429 / 400 / 401 のレスポンスにも `Set-Cookie: NID` が付く。** エラー応答の `Set-Cookie` を捨てないこと。

### 6.6 Cookie まわり

- **必要なのは `NID` だけ。** `OTZ` / `_ga*` / `__utm*` は GA の遺物でサーバは見ていない。
- **`NID` の値はサーバ側で本当に検証されている。** `NID=abc123deadbeef` のようなデタラメ値では 429 のまま。
  「NID という名前の Cookie さえあればよい」ではなく、ダミー値でのバイパスは不可。
- **NID の値は不透明で 2 系統が混在する**: `534=...` (211〜212 文字) と
  `CuoBCA...` / `CuwBCA...` (base64 protobuf 風、316〜319 文字)。同じ URL でもどちらが降るか一定しない。
  **長さ・書式のバリデーションを書くな。生文字列で持ち回れ。**
- **`User-Agent` を一切送らないと、`Set-Cookie: NID` の属性から `Secure` と `SameSite=none` が消える**
  (`path=/; domain=.google.com; HttpOnly` だけになる)。`Secure` が必ず付く前提の Cookie パーサは壊れる。
- **`https://trends.google.com/` は 301 (`Location: /trends/`) を返し `Set-Cookie` を一切出さない**
  (`server: sffe`)。ブートストラップ先にしてはいけない。
- **`pickers/geo` に Cookie を付けると 302 /sorry になった** (Cookie 無しなら同じ URL が 200)。
  **ピッカーには Cookie を付けるな。** ただしこれが (a) 429 由来の NID が特殊だから
  (b) Cookie を付けること自体が引き金 (c) IP が既に汚れていたから、のどれかは切り分けられていない。
- **日本 (非 EU) の IP では `consent.google.com` へのリダイレクトも `CONSENT` Cookie も一切発生しない**
  (HAR 456 エントリを走査して 0 件)。EU / UK / スイスからの挙動は**完全に未検証**。

### 6.7 その他

- **`content-disposition: attachment` は無視してよい。** `fetch` では単なるヘッダなのでダウンロードにはならない。
  むしろ**成功判定の補助材料**になる (200 の JSON 応答には必ず付き、HTML エラーには付かない)。
- **`userConfig.userType: "USER_TYPE_SCRAPER"` はスクレイパー判定ではない。**
  Cookie 完備の Chrome でも同じ値 (HAR 13/13, 15/15, 26/26)。
  全一般ユーザ共通の固定値なので、これを見て挙動を変えないこと。
  詳細と、「SCRAPER だと不自然なゼロが返る」という有名な報告の検証は §6.8 を参照。

#### 6.8 `USER_TYPE_SCRAPER` と「不自然なゼロ」— 有名な報告の検証 (2026-09-09)

pytrends には有名な未解決 issue が 2 件あり、「SCRAPER 扱いだとデータが劣化する」と広く信じられている。

| issue | 主張 | 状態 |
|---|---|---|
| [#534](https://github.com/GeneralMills/pytrends/issues/534) (2022-10) | **ブラウザは `USER_TYPE_LEGIT_USER`、pytrends は `USER_TYPE_SCRAPER`。結果がかなり違う** | 未解決のままリポジトリごとアーカイブ (2025-04) |
| [#592](https://github.com/GeneralMills/pytrends/issues/592) (2023-07) | `timeframe='today 5-y'` で全週ゼロになる | 未解決 |

**結論: 2026-09-09 時点でどちらも再現しない。前提そのものが失効している。**

**(1) `USER_TYPE_LEGIT_USER` はもう存在しない**

- HAR (2026-09-08、reCAPTCHA トークン・Cookie・`x-browser-validation` 完備の実 Chrome) の
  widgetdata リクエスト **54/54 が `USER_TYPE_SCRAPER`**。`LEGIT_USER` は HAR 全体
  (URL / postData / レスポンス / JS バンドル) に **1 件も出現しない**。
- → #534 の「ブラウザは LEGIT_USER」という前提は、少なくとも現在は成り立たない。
  Google が全員 SCRAPER に統一したものと見られる。

**(2) `userType` はクライアントから変更できない (実測)**

| 試行 | 結果 |
|---|---|
| explore の `req` に `userConfig:{userType:"USER_TYPE_LEGIT_USER"}` を注入 | **200 だが無視され `SCRAPER` が返る** |
| 同 `USER_TYPE_GOOGLER` / `BOGUS_VALUE` を注入 | 同上 (400 にすらならない) |
| `widget.request.userConfig.userType` を書き換えて widgetdata | **401** (token は `userConfig` を含む req 全体の署名) |

→ サーバ側で決まる値であり、**A/B 比較の対照群を作ること自体が不可能**。

**(3) 「不自然なゼロ」は再現しない。ゼロは正当な下限効果である**

`today 5-y` (= #592 の条件) ほか全 timeframe で測定:

| キーワード | ゼロ率 | 孤立ゼロ | 最長ゼロ連続 | 非ゼロ中央値 |
|---|---|---|---|---|
| `youtube` (today 5-y, 262 点) | **0.0%** | 0 | 0 | 79 |
| `youtube` (today 12-m / 3-m / now 7-d) | **すべて 0.0%** | 0 | 0 | — |
| `nintendo switch` | **0.0%** | 0 | 0 | 35 |
| `shirasu don` (低ボリューム) | 96.6% | **0** | 94 | 54 |
| `kombu dashi ramen` (低ボリューム) | 97.7% | **0** | 79 | 82 |
| `zzzqqxyw nonexistent term` | 99.2% | **0** | 172 | — |

判定の根拠:

- **高ボリューム語は `today 5-y` を含む全 timeframe でゼロが 1 点も出ない** → #592 は再現しない。
- **孤立ゼロ (非ゼロに挟まれた単独の 0) が全ケースで 0 件**、ゼロは必ず**連続**して現れる。
  意図的な間引きなら散発的な孤立ゼロが出るはずで、この分布は**低ボリューム帯の下限効果**の特徴。
- **同一クエリ 3 回が完全一致** (`today 12-m`, 53 点)。リクエストごとのサンプリングやノイズ注入は無い。
- ゼロ率はボリューム帯に対して単調 (0% → 96.6% → 97.7% → 99.2%)。

**(4) 付随して見つかった落とし穴**

ボリュームゼロの語では、`default.timelineData` が **「262 点すべて 0」で返る場合と、空配列で返る場合の
両方がある** (同一クエリを別セッションで実行して両方観測)。
**空配列を必ず許容すること。** `timelineData[0]` を無条件に触ると落ちる。

**(5) ラッパー実装者への指針**

`userType` を見て挙動を変える意味は無い。変更もできない。
データが薄いと感じたら疑うべきは SCRAPER 判定ではなく、**キーワードの検索ボリュームそのもの**である。
低ボリューム語で 0 が並ぶのは仕様であり、劣化ではない。

- **`req` のパーセントエンコードはブラウザ模倣不要。** ブラウザ (AngularJS) は `:` `,` を素通しし空白を `+` にする
  独特のエンコードをするが、素の `encodeURIComponent(JSON.stringify(req))`
  (`:`→`%3A`, `,`→`%2C`, 空白→`%20`) でもサーバは受理する
  (explore / multiline / comparedgeo / relatedsearches すべてで実測)。
- **`f.sid` は必ず文字列で扱え。** 符号付き 64bit の文字列で負値が普通に出る (`-8959654384266786277`)。
  `Number()` すると 2^53 超で精度が壊れる。
- **`bl` (ビルドラベル) をハードコードするな。** Google のデプロイで変わる。
- **`explore` レスポンスの本文末尾に改行が付かない場合がある。** `text.slice(5)` ではなく
  `/^\)\]\}'[,]?\n/` の除去、あるいは §6.1 の「最初の LF まで捨てる」を推奨。
- **抽出済み HAR コーパスの `trending/00_entry285.txt` は本文が 400,000 文字で truncate されている**
  (実体 1,259,918 文字)。`AF_initDataCallback` は 1,168,145 文字目付近にあるため、
  このファイルだけ読むと「初期データは無い」と誤結論する。生 HAR から取り直すこと。
- **`accept-language` ヘッダは意味を持たない。** 言語は URL の `hl` だけで決まる。
- **`x-same-domain: 1` は必須ではない。** ブラウザは必ず送るが、送らなくても batchexecute は 200。

---

## 7. 推奨アーキテクチャ

### 7.1 依存ゼロで実装可能か → **可能** (実測で確認)

必要なのは `fetch` / `JSON.parse` / `encodeURIComponent` / `String.prototype.slice` /
`atob` (または手書き base64url デコード) / 正規表現だけ。
ヘッドレスブラウザも jsdom も HTML パーサも protobuf ライブラリも不要。
本調査の 13 テストファイルは、アサーション用の `jsr:@std/assert` 以外に依存していない。

### 7.2 層構成

```
+---------------------------------------------------------+
| api/    利用者向けの薄い関数群                             |
|   trendingNow(geo, {hours, newsCount, hl})               |
|   interestOverTime(keywords, {time, geo, category, ...}) |
|   interestByRegion(...) / relatedQueries(...)            |
|   autocomplete(keyword, hl) / geoTree(hl) / catTree(hl)  |
+---------------------------------------------------------+
| codec/  純粋関数。ネットワークに触らない -> 単体テスト容易     |
|   stripXssiPrefix(text)      先頭 )]}' なら最初の LF まで捨てる
|   parseBatchExecute(text)    封筒 -> wrb.fr[] (UTF-16 長さ行)
|   buildBatchExecuteBody(calls)  -> "f.req=...&"
|   decodeWidgetToken(token)   -> { expiresAt: Date }
|   normalizeTrendKey(s)       NFD -> \p{Mn} 除去 -> NFC
|   resolutionForSpan(spanSeconds) / parseWidgetTime(s)
+---------------------------------------------------------+
| session/ NID と widget token のライフサイクル管理            |
|   getNid()        429 の Set-Cookie から拾う。メモリ保持      |
|   getWidgets(req) explore を叩く。widget を 24h キャッシュ    |
+---------------------------------------------------------+
| transport/ HTTP の唯一の出口                               |
|   request(url, init)                                     |
|     - redirect: "manual" を強制                           |
|     - 成功判定: status 200 && content-type application/json|
|     - 302 /sorry / 429 / 401 / 400 / 404 を型付きエラーに分類|
|     - 直列化 (同時実行 1) + 最小間隔 1〜2 秒                  |
|     - 毎レスポンスの Set-Cookie: NID を session に反映        |
+---------------------------------------------------------+
```

**層を跨ぐ設計原則:**

1. **`widget.request` は codec を通さない。** `explore` が返した JSON オブジェクトを丸ごと `JSON.stringify` して
   透過させるだけ。フィールドを解釈して再構築する誘惑に負けると token が無効になる。
2. **旧 REST と boq を同じ抽象に押し込めない。** エラー形式もレート枠もプレフィックスも別物なので、
   transport の分類関数を 2 本持つ方が結果的に短くなる。
3. **Trending Now は explore に依存させない。** `batchexecute` だけで完結するので、
   explore が 302 ブロック中でも動き続ける。
4. **codec 層はネットワーク不要 = テストが安定する。** 本調査の 13 番のテストがまさにこれで、
   ライブ検証が 429 で落ちたときの切り分け基準線として機能する。

### 7.3 リトライ戦略 (実測に基づく)

| 応答 | 判定 | 対処 |
|---|---|---|
| `200` + `application/json` | 成功 | batchexecute はさらに `wrb.fr[2] !== null` を確認 |
| `200` + `wrb.fr[2] === null` | RPC 引数エラー | **リトライ禁止。** 引数を直す |
| `400` / `401` | 入力エラー (req 不正 / token 不正・失効) | **リトライ禁止。** 401 なら explore を叩き直して token 再取得 |
| `404` | パス誤り or 廃止 API | **リトライ禁止** |
| `429` | 確率的スロットリング | `Set-Cookie` の NID を更新して指数バックオフ **2s → 4s → 8s (jitter ±25%)、最大 3 回** |
| `302` → `google.com/sorry/` | **IP 単位のブロック** | **リトライ厳禁。** 分オーダーのクールダウン。他系統は生きているので処理は継続できる |
| ネットワーク断 | — | 3 回まで |

- **`Retry-After` はどのエラーにも付かない。** 待ち時間は完全にクライアント側で決めるしかない。
- **同時実行は 1。** 並列化した瞬間に 429 → 302 の階段を駆け上がる。
- 実測の目安: NID ありで 1.2 秒間隔・6 連射なら 429 ゼロ。
  ただし複数プロセスが同一 IP を共有すると数十リクエストで 302 に到達する。
  実際、本調査でも 2s/4s/8s のバックオフでは足りず、4 段目 (2s/6s/18s/40s) でようやく通ったケースがあった。
- **explore の呼び出し回数を減らすことが唯一の実効的なレート制限対策。**
  widgetdata / autocomplete / batchexecute / pickers は Cookie 不要で枠も緩い。

### 7.4 キャッシュ戦略

| 対象 | TTL | 根拠 |
|---|---|---|
| **`NID` Cookie** | プロセス内保持。429 を受けたら取り直す | `Set-Cookie` の `expires` は約 6 か月先だが実際の有効期間は未検証。**リアクティブ戦略が安全** |
| **`widget.token` + `widget.request`** | **24 時間** (token の失効時刻をオフラインで読んで判定) | HAR 54/54 で発行 + 86400 秒。**ただし日を跨いだ実証はしていない** |
| `pickers/geo` (hl 別) | **7 日程度** | hl=ja の 152,482 バイトが HAR (前日) と**1 バイトの差もなく一致**。日単位で不変 |
| `pickers/category` (hl 別) | **7 日程度** | 同上 (65,945 バイトが完全一致) |
| `DqDTgb` (地域ピッカー) | 同上 | 250 ヶ国の集合が `pickers/geo` と完全一致 |
| `autocomplete` | 数分〜数時間 | エンティティ解決は変動が遅い |
| `i0OFE` (Trending Now) | **5〜10 分** | `item[3]` / `item[4]` が 10 分刻みなので、それより短いポーリングは無駄 |
| `multiline` / `comparedgeo` | resolution 依存 (MINUTE なら 1 分、MONTH なら 1 日) | — |

- **`ETag` / `Last-Modified` は返らない**ので条件付き GET はできない。TTL 方式のみ。
  全エンドポイントに `expires: Mon, 01 Jan 1990 00:00:00 GMT` が付き、実質キャッシュ不可の指定になっている
  (= HTTP キャッシュ層は使えないので、アプリ側で持つしかない)。
- マスタデータは **「ID ツリー (構造) 1 本 + `id → name` 辞書を hl ごと」に分割**して持つと
  多言語対応時のメモリが激減する (カテゴリ ID も geo コードも hl 非依存)。
- 全 hl を先読みすると hl 1 つあたり geo 130〜155KB + category 60〜66KB かかる。
  **遅延ロード + hl 単位の LRU** を推奨。
- キャッシュは**メモリで十分**。最大でも `pickers/geo` の 152KB 程度で、MB 級にはならない
  (`i0OFE` を `hours=168` で叩くと 647KB になるので、そこだけは注意)。

---

## 8. 未解決事項 / 今後の調査項目

### 8.1 優先度: 高 (ラッパーの設計判断に直結する)

1. **`widget.token` の 24 時間有効性を日を跨いで実証していない。**
   token 内の失効時刻が発行 +86400 秒であることは HAR 54 サンプルで確定しているが、
   **翌日その token で `widgetdata` が実際に 200 を返すか**は未確認。24h キャッシュ戦略の前提が崩れると設計が変わる。
2. **`302 /sorry` ブロックの継続時間と発動閾値が未測定。** 数分の間隔では復帰しなかった。
   「何リクエストで発動し、何分で解けるか」が分からないとクールダウンの既定値を決められない。
   また発動条件が「短時間の総リクエスト数」なのか「`/trends/api/explore` への集中」なのかも切り分けていない。
3. **`comparedgeo` の XSSI プレフィックスが 5 バイトか 6 バイトか、報告が食い違っている。**
   「最初の LF まで捨てる」実装なら実害はないが、仕様としては未確定。
4. **`RELATED_TOPICS` (`keywordType: "ENTITY"`) が空でない応答を返す条件が不明。**
   HAR 12/12 + ライブ 4/4 すべて空。機能が事実上廃止されているのか、条件次第で返るのかが分からない。
5. **`token` の署名スコープの正確な境界。** `comparedgeo` の `resolution` / `includeLowSearchVolumeGeos` だけが
   署名対象外だった。`dataMode` が署名対象かは未検証。境界が分かれば explore の呼び出し回数をさらに減らせる。

### 8.2 優先度: 中

6. **`i0OFE` の `args[0]` / `args[1]` (全観測で null) の意味。** null 以外を渡す実験は未実施。
7. **`i0OFE` のカテゴリ ID (1〜20) のラベル。** ラベル文字列は RPC レスポンスにも `/trending` の HTML にも含まれず、
   カテゴリ絞り込み引数も見つからなかった。逆引きするには boq の JS バンドルを読むか、
   UI をブラウザで操作して HAR を再取得するしかない。`2` / `14` / `16` は判定不能。
   そもそも「カテゴリで絞り込む方法」が別 RPC なのかクライアント側フィルタなのかも不明。
8. **`i0OFE` の `hours` / `newsCount` の上限。** `hours=168` / `newsCount=17` までは 200 を確認。
   それ以上の値や負値は未検証。
9. **`we8Zrc` / `g4kJzf` を reCAPTCHA トークン無しで呼んだときの挙動。**
   `we8Zrc` はトークン無しで 200 だが `["Japan"]` のような小さい応答しか得られておらず、
   トークン欠落による縮退の可能性が高い。
10. **resolution 切替点の未測定区間** (4h,5h] / (33h,37h] / (60h,72h] / (7d,8d] / (1827d,2093d]。
    あと 4〜6 リクエストの二分探索で詰められる。
11. **`tz` の有効範囲の境界** (±1439 が受理されるか)。
12. **`comparedgeo` の `maxValueIndex` が 1 以上になる実例**を取れていない
    (地域によって優勢キーワードが入れ替わる組み合わせが必要)。意味は「`value` 配列中の最大値のインデックス」と**推定**。
13. **`batchexecute` の 429 応答形式が未観測。** boq 側で一度も 429 にならなかったため、
    HTTP 429 なのか封筒内の `er` チャンクなのか不明。
14. **`wrb.fr[5]` のエラーコード体系。** `[3]` (= `INVALID_ARGUMENT` と推定) しか観測できていない。
    他のコードを返させる条件、および `er` チャンクの index 1〜4 / 6〜8 (全て null) の意味も不明。
15. **不正な `category` / `property` で explore が 200 を返したあと、後段の `widgetdata` が
    空データを返すのかエラーを返すのか**は未検証 (空データを返すと**推定**)。

### 8.3 優先度: 低 / 環境依存

16. **EU / UK / スイスの IP からの CONSENT フロー**は完全に未検証。日本の IP では発生しないことのみ確認済み。
17. **`batchexecute` の長さ行が UTF-16 コードユニットか Unicode コードポイントか。**
    `slotId` エコー法で UTF-16 と確定させたが、これは「サーバがエコーする文字列」に対する挙動であり、
    通常のペイロードに astral 文字 (絵文字など) が含まれるケースは依然として観測できていない
    (HAR 21 ボディにもライブ応答にも BMP 外文字が 1 文字も無い)。
    **実装上は UTF-16 を採れば両説どちらでも正しく動く**ため実害はない。
18. **`hzg6Ed` の第 5 要素 boolean の意味** (サムネイル表示ヒントと推測)。実際の画像を取得して検証していない。
    反証可能な予測: true の画像は透過 / 白背景のロゴ、false の画像は写真。
19. **`x-browser-validation` を送らないことによる長期的な不利益**の有無。単発では観測できない。
    reCAPTCHA トークンの有無が 429 の発生閾値に影響するかも同様に未検証。
20. **`/trends/api/*` のレスポンス本文の HAR 再キャプチャ。** Explore ページを開いたまま
    HAR をエクスポートすればボディが取れる見込みだが未検証。取れればオフライン回帰テストの範囲が大幅に広がる。
21. **`req` に `comparisonItem` / `keyword` を省略した場合の既定値**、
    `keyword` に Trends 検索構文 (`+` による OR、引用符付き完全一致) を入れたときの
    `complexKeywordsRestriction` の変化。
22. **`explore` の POST ボディの base64 が標準 base64 か base64url か。**
    13 サンプルすべてで 62/63 番目の文字 (`+/` または `-_`) が 1 文字も出現しなかったため判別不能。
    ボディ自体が不要なので実害はない。

---

## 9. テストファイル一覧

すべて **単体で実行可能** (相互 import なし)。外部依存は `jsr:@std/assert@^1` のみ。
ネットワークを使うテストは 429 / ネットワーク断で**ハードに落とさず `console.warn` + skip** する設計になっている。

### 実行方法

```bash
# リポジトリルート (gtrend_claude/) から実行する

# 1 ファイルだけ実行
deno test --allow-net --no-check live_integration/08_trending_now_test.ts

# ネットワーク不要のオフライン検証だけ実行 (HAR コーパスを読むので --allow-read が要る)
deno test --allow-read --no-check live_integration/13_har_offline_conformance_test.ts

# 全部実行 (★レート制限に注意。直列実行のまま回すこと)
deno test --allow-net --allow-read --no-check live_integration/
```

> **`--parallel` を絶対に付けないこと。** Deno 2 の `deno test` は**既定で直列実行**なので、
> 上のコマンドをそのまま使えばよい (旧 Deno 1.x の `--jobs=1` は Deno 2 で廃止されており、
> 付けると `error: unexpected argument '--jobs=1' found` で即座に落ちる。検証環境 Deno 2.9.6 で実測)。
> `--parallel` を付けると同一 IP から一斉にリクエストが飛び、
> 数十秒で `302 /sorry` のブロックに到達して全テストが skip になる。
> 実測では 1 ファイルあたり 8〜9 リクエストを消費する。
> 全 13 本を続けて回すなら**ファイル間に数分の間隔**を空けるのが望ましい。
>
> なお、テストが `skip` を大量に出す場合は「実装が壊れている」のではなく
> 「IP がレート制限中」である可能性が高い。まず `13_har_offline_conformance_test.ts`
> (ネットワーク不要) を回して codec 層の健全性を確認すること。

### 一覧

| # | ファイル | 検証内容 | ネットワーク |
|---|---|---|---|
| 01 | `01_session_bootstrap_test.ts` | NID の取得元マトリクス / Cookie が必要なエンドポイントの切り分け / 最小ヘッダセット / XSSI プレフィックスの系統差 / 302 `/sorry` の検出と `redirect:"manual"` の必要性 / token の base64url パディング | 要 |
| 02 | `02_explore_widget_tokens_test.ts` | **reCAPTCHA 不要の実証** (空ボディ POST で 200) / explore レスポンスのトップレベル 5 キー / 単一・複数キーワードの widget 構成 / token の 33 バイト構造と 24h 期限 / **req 改変 → 401** / mid によるエンティティ指定 / `tz` が窓算出に効かないこと | 要 |
| 03 | `03_widgetdata_multiline_test.ts` | 時系列スキーマ (point の 8 フィールド) / `isPartial` は末尾 1 点のみ / 全系列通しの 0-100 正規化 / `hasData=true` でも `value=0` になる罠 / `averages` の定義 / date → resolution 対応表 / `tz` は表示のみに作用 / `axisNote` | 要 |
| 04 | `04_widgetdata_comparedgeo_test.ts` | 地域別スキーマ / **CITY だけ `geoCode` が無く `coordinates` になる** / `hasData=false` の扱い / **token の署名スコープ (`resolution` は対象外)** / `includeLowSearchVolumeGeos` / DMA の Nielsen コード / 複数キーワードの `PERCENTAGES` | 要 |
| 05 | `05_widgetdata_relatedsearches_test.ts` | **プレフィックスが 6 バイト (`)]}',\n`) であることの実証** / TOP と RISING のキー集合の差 / ブレイクアウト判定 / ENTITY が常に空であること / 空応答の非対称性 / `language` / `userCountryCode` | 要 |
| 06 | `06_autocomplete_test.ts` | 旧 REST autocomplete のスキーマ (`mid`/`title`/`type` の 3 キー・常に 5 件) / パスの `encodeURIComponent` 必須 (`AC/DC` → 404) / 新 `hzg6Ed` の arity 5 とサムネイル / 候補ゼロ時に `[]` を返す罠 / 新旧 2 系統の `type` 対応 | 要 |
| 07 | `07_pickers_geo_category_test.ts` | pickers は **Cookie 無しで 200 / Cookie を付けると 302** / geo ツリーの相対 id / カテゴリ ID の DAG 性 (ID 重複 231 件) / **explore と Trending Now でカテゴリ体系が別物であること** / `DqDTgb` の 3 引数の意味 / キャッシュ根拠 (HAR とバイト単位一致) | 要 |
| 08 | `08_trending_now_test.ts` | **`args[3]` がニュース記事件数であることの発見** / `args[5]` = 時間窓 / item の arity 13 / 正規化キーの NFD 規則 / ページング不在 / 廃止エンドポイントの現況 (404 / 302) / RSS フィードの生存確認とスキーマ | 要 |
| 09 | `09_batchexecute_wire_format_test.ts` | **長さ行が UTF-16 であることの確定** (絵文字 slotId エコー法) / **URL クエリ 10 個すべて不要** / `rt` によるレスポンス形式の切替 / `er` チャンクと `wrb.fr[5]` のエラー形式 / ラウンドトリップ検証 / `f.sid` / `bl` の HTML 抽出 | 要 |
| 10 | `10_time_range_grammar_test.ts` | time 文法 5 形態 / **`SIXTEEN_MINUTE` の発見** / resolution 境界の挟み撃ち (DAY→WEEK = 269/270 日) / backend との 1:1 対応 / `all` の窓 / `compareTime` の規則 / 不正 time の 400 | 要 |
| 11 | `11_geo_category_property_matrix_test.ts` | geo 粒度 → resolution の写像 / DMA の 3 パート形式 / **category / property は検証されない** / hl の反映先が 2 種類 / `comparisonItem` 上限 5 件 / **geo 混在時の `geos_note` と `originalTimeRangeForExploreUrl` のバグ** / `tz` の有効範囲 | 要 |
| 12 | `12_errors_and_ratelimit_test.ts` | 429 / 400 / 401 / 404 / 302 の実体と見分け方 / `Retry-After` 不在 / **エラー応答にも `Set-Cookie` が付くこと** / **batchexecute の RPC 個別エラーが 200 で返ること** / プレフィックス長の系統差 / リトライ戦略のリファレンス実装 | 要 |
| 13 | `13_har_offline_conformance_test.ts` | **HAR コーパスに対する完全オフライン回帰テスト。** 長さ行が UTF-8 でないことの反例 21 件 / 封筒の切り出し規則 / `f.req` 構造 / widget token 54 件の構造と 24h 期限 / 空レスポンスのバイト会計 / HAR にボディが無い真因 (DevTools のページ単位退避) | **不要** (HAR のみ) |

---

## 10. 注意事項 / 免責

### 10.1 これは Google の非公開内部 API である

- 本ドキュメントに書かれたエンドポイント・パラメータ・レスポンス形式は、
  **Google が公開・文書化しているものではない。**
  ブラウザの通信を観察して逆算した結果であり、
  **予告なく、いつでも、一切の互換性配慮なく変更・廃止されうる。**
- 実際に本調査中だけでも、`/trends/api/dailytrends` と `/trends/api/realtimetrends` が **404 (廃止)**、
  `/trends/trendingsearches/daily` が **302 (新 UI へのリダイレクト)** になっていることを確認している。
  旧 `/trends/api/*` ファミリ全体が `server: GSE` という退役中のスタック上にあり、
  **中期的に消える可能性が高い。**
- `bl` (ビルドラベル) は Google のデプロイのたびに変わる。`f.sid` はページロードごとに変わる。
  **ハードコードするな。**
- 新 boq 系 (`/_/TrendsUi/*`) は reCAPTCHA **Enterprise** に移行済みで、
  per-action token + 2 分 TTL という厳格な運用をしている。
  現状は `i0OFE` などトークン不要な RPC が多いが、
  **将来 BotGuard blob (`tokenB`) の検証が始まれば `fetch` ベースのラッパーは原理的に詰む**
  (ヘッドレスブラウザ必須になる)。
  ラッパーは「トークン要求エラー」を他のエラーと区別できる型を最初から用意しておくのが賢明。
- 本ドキュメントの内容は **2026-09-09 時点の実測**に基づく。時間が経つほど信頼度は下がる。
  異常を検知したら、まず本 README の記述ではなく実際のレスポンスを疑うこと。

### 10.2 個人利用 / 低頻度アクセスを前提とすべき

**本調査で得られた最も実務的な知見は「効くのは並列度であって間隔ではない」ということである。**
複数のプロセスが同一 IP から**並列に**数十リクエストを投げると `429` → `302 /sorry` の階段を駆け上がったが、
**直列なら 1 IP で 30 連続 × 0.5 秒間隔でも 429 はゼロだった** (§1.3)。
1 IP あたり概ね 100 件/分までは余裕がある。

なお **これを超える量が必要なら経路を変えるべきである。** IP や Cookie をローテーションして
制限を超える設計は Google の利用規約が禁じる回避行為であり、本調査の対象外とした。
大量取得が要件なら次を検討すること:
BigQuery 公開データセット `bigquery-public-data.google_trends` (公式・無料・バルク) /
Google Trends 公式 API / ライセンス済みの商用 SERP プロバイダ。

**推奨する自制ライン (実測に基づく):**

- 同時実行数 **1** (並列化しない ← これが最重要)
- リクエスト間隔 **0.5 秒以上**あれば実測上は十分 (1〜2 秒はより安全側)
- `explore` の呼び出しは **token キャッシュで最小化** (同一条件なら 24 時間に 1 回)
- マスタデータ (`pickers/*`, `DqDTgb`) は **日単位でキャッシュ**
- Trending Now のポーリングは **5〜10 分間隔以上**
  (データ自体が 10 分刻みなので、それより細かくしても新しい情報は得られない)
- `302 /sorry` を受けたら**即座に停止**し、分オーダーで待つ。リトライで突破しようとしない
- 1 回の `i0OFE` で `hours=168` を投げると 647KB、`newsCount` も上げると数 MB になる。
  **必要な窓だけを取る**


---

*本 README は 2026-09-09 時点の実測に基づく。
実測で確かめた事実には「実測」、根拠が推論にとどまるものには「推定」「推測」と明記した。
明記のない記述は HAR コーパス (2026-09-08 キャプチャ) の全数解析による確定事実である。*
