// 実行: deno test --allow-net --no-check live_integration/07_pickers_geo_category_test.ts
//
// =====================================================================================
// Google Trends 「ピッカー（マスタデータ）」エンドポイント仕様
//   1) GET  /trends/api/explore/pickers/geo        … 地域マスタ（旧 Explore UI 系 / server: GSE）
//   2) GET  /trends/api/explore/pickers/category   … カテゴリマスタ（同上）
//   3) POST /_/TrendsUi/data/batchexecute (rpcids=DqDTgb) … 地域マスタ（新 Trending UI / boq 系 / server: ESF）
//
//   ライブ検証日: 2026-09-09 （日本の IP から、Deno 2.9.6 の素の fetch、Cookie 無し）
//   HAR 根拠:
//     - .har/extracted/trends_api_explore_pickers_geo/00_entry068.txt       (HAR idx 68, 200, size 152482, body 空)
//     - .har/extracted/trends_api_explore_pickers_category/00_entry069.txt  (HAR idx 69, 200, size 65945,  body 空)
//     - .har/extracted/TrendsUi_data_batchexecute/06_entry322.txt           (HAR idx 322, 200, DqDTgb, body 有り 50153 文字)
//   ※ /trends/api/* のレスポンスボディは HAR に 1 バイトも保存されていないため（HAR の
//      content.size は 152482 / 65945 と記録されているが body は空）、1) 2) のスキーマは
//      全て 2026-09-09 のライブ実測で確定させた。3) のみオフラインで確定できる。
//   ※ 3) は HAR entry322 のボディ（50,153 文字）に対して以下を **全数検査**して確定させた:
//        - 封筒の長さ行の規則（JSON 長 = 長さ行 - 2）が 3 チャンク全てで成立
//        - 国 125 件の arity 分布 = {1:82, 2:41, 3:2}、別名を持つのは 7 ヶ国
//        - 下位地域 1,013 件すべてが arity 3 かつコードが完全形（親コード + "-"）
//        - sortKey が「結合マーク除去 + 小文字化」で導出できる … 国 125/125・下位地域 1013/1013
//      これらはテスト 3 / テスト 5 / テスト 8 に落としてある。
//
//   本ファイルのテスト一覧:
//     1. pickers/geo （ライブ）       … 木の形・相対 id・DMA の重複
//     2. pickers/category （ライブ）  … 数値 id・DAG・トップレベル 25 件
//     3. DqDTgb ["en-US",1,0]（ライブ）… 封筒・ペイロード配列レイアウト・sortKey 規則
//     4. DqDTgb フラグ実験 （ライブ 2 回）… 第2/第3引数のセマンティクス
//     5. 封筒パーサのオフライン自己テスト
//     6. pickers/category hl=ja （ライブ）… tz 省略可・hl 非依存性
//     7. DqDTgb args[0] vs URL hl （ライブ）… ローカライズの決定元
//     8. sortKey 規則のオフライン自己テスト
//
// -------------------------------------------------------------------------------------
// 【0】最重要サマリ（ラッパー実装者向け）
// -------------------------------------------------------------------------------------
//   * 3 エンドポイントとも **Cookie 不要 / reCAPTCHA 不要 / token 不要**。素の GET/POST で 200。
//     → 実測: Cookie を一切送らない fetch で pickers/geo・pickers/category とも 200 + 正しい JSON。
//   * 【罠】/trends/explore が 429 と一緒に返す NID Cookie を pickers に付けると **逆に壊れる**。
//     実測 2026-09-09（再現手順と結果を 2 度、独立に確認済み）:
//       (1) GET /trends/explore?q=..&geo=JP&hl=ja  → 429、Set-Cookie は NID 1 本だけ（値は 216 バイト）
//       (2) その NID だけを cookie: に付けて GET /trends/api/explore/pickers/geo?hl=en-US&tz=-540
//           → 302 Found / content-type: text/html / 本文 449 B の HTML /
//              location: https://www.google.com/sorry/index?continue=<元URL>&hl=en-US&q=<チャレンジ>
//       (3) 同じ URL を Cookie 無しで叩くと 200 + 正しい JSON（131,769 B）
//     つまり **Cookie を付けたことが原因で bot 判定ページに飛ばされる**。
//     → **ピッカーには Cookie を付けないこと。** 「NID を付ければ通りやすくなる」は
//        /trends/api/explore（ウィジェット取得）の話であって、pickers には当てはまらない。
//     ※ この挙動は本テストでは自動化していない。再現には意図的に 429 を踏み bot 判定を
//        引き当てる必要があり、テストを回すたびに送信元 IP の評価を下げるため。
//        上記手順を手で実行すれば再現できる。
//   * レスポンスサイズは MB 級ではない（実測、UTF-8 バイト）:
//       pickers/geo      hl=ja    152,482 B / hl=en-US 131,769 B
//       pickers/category hl=ja     65,945 B / hl=en-US  59,698 B
//       DqDTgb ["ja",1,0]          86,719 B  ["ja",1,1] 213,525 B  ["ja",0,0] 6,571 B
//       DqDTgb ["en-US",1,0] 68,984 B / ["en-US",1,1] 173,689 B / ["en-US",0,0] 4,945 B
//     いずれも JSON.parse で一括展開して問題ない規模（数百 KB）。
//     ※ batchexecute のサイズは **同じ引数でも 1〜2 バイト揺れる**（封筒の di / af.httprm チャンクに
//        入るセッション内シーケンス番号の桁数が変わるため）。サイズで同一性を判定しないこと。
//        実例: ["ja",0,0] が 6,571 B の回と 6,572 B の回があった。ペイロードの中身は同一。
//     pickers/geo hl=ja の 152,482 B は HAR (2026-09-08) の content.size 152,482 と、
//     pickers/category hl=ja の 65,945 B は HAR の 65,945 と **完全一致**した。
//     → マスタデータは日単位ではまず変化しない。積極的にキャッシュしてよい（【7】参照）。
//
// -------------------------------------------------------------------------------------
// 【1】GET /trends/api/explore/pickers/geo
// -------------------------------------------------------------------------------------
//   URL   : https://trends.google.com/trends/api/explore/pickers/geo?hl=<hl>&tz=<minutes>
//   Method: GET
//   パラメータ:
//     hl (string, 実質必須) … 表示言語。"ja" / "en-US" などを実測。hl が変えるのは次の 2 つだけ:
//                             (a) name の言語、(b) children の並び順（**ロケール照合順**）。
//                             id（geo コード / カテゴリ ID）と木の形は hl に依存しない。
//                             実測 2026-09-09 (pickers/category のルート直下 25 件の id を出現順に):
//                               hl=en-US: 3,47,44,22,12,5,7,71,8,45,65,11,13,958,19,16,299,14,66,29,533,174,18,20,67
//                                         （英語名のアルファベット順: Arts, Autos, Beauty, Books …）
//                               hl=ja   : 3,13,299,8,5,18,20,16,12,71,66,174,7,45,958,533,47,65,11,22,14,44,29,19,67
//                                         （日本語名の五十音順: アート…, インターネット…, オンライン…）
//                             → **並び順に依存した実装をしてはいけない。必ず id で引くこと。**
//                               集合としては両者完全一致（テスト 2 と テスト 6 で相互検証）。
//     tz (number, 任意)     … 分単位のタイムゾーンオフセット（JS の getTimezoneOffset 規約。JST=-540）。
//                             **省略しても 200 で同一構造が返る**（実測: hl=en-US / hl=ja とも tz 無しで
//                             200、かつ hl=ja の tz 無しレスポンスは 65,945 B で tz=-540 の HAR と
//                             バイト単位で一致 → tz はレスポンスに一切影響しない）。
//                             ピッカーは時刻に無関係なので実質ダミー。ブラウザは常に付ける。
//   認証: 不要（Cookie を送らないこと。上記【0】の罠を参照）
//   必須ヘッダ: 無し。実測では user-agent / accept / accept-language / referer のみで 200。
//   レスポンス:
//     200 / content-type: application/json; charset=utf-8
//     content-disposition: attachment; filename="json.txt"; filename*=UTF-8''json.txt
//     cache-control: no-cache, no-store, max-age=0, must-revalidate
//     本文 = **先頭 5 バイトの )]}'+LF + JSON**。**末尾に改行は付かない**
//            （実測: 最後の 6 文字は d":""}）。→ text.slice(5) して JSON.parse すればよい。
//   スキーマ（再帰。ノードのキーは children / name / id の 3 つだけ。出現順もこの順）:
//     type GeoNode = { children?: GeoNode[]; name: string; id: string };
//     ルート     : { id: "", name: <"Worldwide" | "すべての国" …>, children: <国 250 件> }
//     国ノード   : id = ISO-3166-1 alpha-2 の 2 文字（250/250 が /^[A-Z]{2}$/）
//     下位地域   : **id は親からの相対コード**。例) JP の子は "23"（愛知県）であって "JP-23" ではない。
//                  GB の子は "ENG","NIR","SCT","WLS"、FR の子は "A".."V"、US の子は "AL".."WY"。
//     第3階層    : **US のみ**。州の下に DMA/metro（数値文字列 id, 例 "630"=Birmingham AL）。
//   実測カウント (2026-09-09, hl=ja と hl=en-US で完全一致):
//     国 250 件 / うち下位地域を持つ 192 件・持たない 58 件 / 下位地域ノード計 3,130 件
//     第3階層ノードは延べ 301 件だが **ユニークな DMA コードは 210 件**
//       （1 つの DMA が複数州にまたがるため、州をまたいで重複して現れる。
//        例: "Mobile AL-Pensacola (Ft. Walton Beach) FL" は AL と FL の両方に出る）
//     JP = 47 都道府県 / US = 51（50 州 + DC）/ FR = 22（旧「地域圏」、id は "A".."V"）
//   【落とし穴】explore の geo= パラメータに渡す値は **親 id と子 id を "-" で連結**した形。
//     JP > "13" → geo=JP-13（HAR の explore リクエストで実在するのを確認済み・確定）。
//     US > "AL" > "630" → geo=US-AL-630 になると思われる（**推定**。本調査では未検証）。
//
// -------------------------------------------------------------------------------------
// 【2】GET /trends/api/explore/pickers/category
// -------------------------------------------------------------------------------------
//   URL / パラメータ / 認証 / ヘッダ / プレフィックス は【1】と全く同じ。
//   スキーマ: type CatNode = { children?: CatNode[]; name: string; id: number };  ← id は **数値**
//     ルート : { id: 0, name: "All categories" / "すべてのカテゴリ", children: <25 件> }
//   実測 (2026-09-09):
//     ルート直下 25 件 / ルートを除く総ノード数 1,426 / 最大深さ 5（ルートの子を depth 0 とする）
//     ← hl=en-US と hl=ja で **総ノード数 1,426 も 25 件も完全一致**（テスト 2 / テスト 6 で実測）
//     **id は hl に依存しない**（hl=ja と hl=en-US で id 集合が完全一致。名前と並び順だけが変わる）
//     **id はツリー内で一意ではない**（DAG を木に展開しているため）。
//       ユニーク id 1,132 件に対しノード 1,426 件。231 個の id が複数箇所に出現する。
//       例) 184 "Celebrities & Entertainment News" は Arts & Entertainment 配下と News 配下の両方。
//           1108 "Film & TV Awards" は 4 箇所に出現。
//       重複ノードは **同じ id なら name も必ず同じ**（231/231 で一致）。
//       → id → name の Map を作るのは安全。id → 親パス は 1:N になるので注意。
//     id の範囲: 3 〜 1397（0 はルート＝「すべてのカテゴリ」でのみ使う）
//   ルート直下 25 件の id と英語名（2026-09-09 実測、全件）:
//     3 Arts & Entertainment / 47 Autos & Vehicles / 44 Beauty & Fitness / 22 Books & Literature /
//     12 Business & Industrial / 5 Computers & Electronics / 7 Finance / 71 Food & Drink /
//     8 Games / 45 Health / 65 Hobbies & Leisure / 11 Home & Garden / 13 Internet & Telecom /
//     958 Jobs & Education / 19 Law & Government / 16 News / 299 Online Communities /
//     14 People & Society / 66 Pets & Animals / 29 Real Estate / 533 Reference / 174 Science /
//     18 Shopping / 20 Sports / 67 Travel
//   （日本語名の対応例: 3=アート、エンターテインメント / 71=フード、ドリンク / 20=スポーツ /
//     958=仕事、教育 / 533=資料 / 1237=喫煙、禁煙）
//   【最重要の落とし穴】このカテゴリ ID 体系は **Trending Now (rpcid=i0OFE) のアイテム [10] の
//     カテゴリ ID とは別物**。i0OFE 側は 3=Business & Finance, 4=Entertainment, 17=Sports,
//     20=Climate/Weather という小さな独自番号（1〜20 程度）で、こちらは 3=Arts & Entertainment,
//     12=Business & Industrial, 20=Sports。**混同すると全く違う意味になる。**
//
// -------------------------------------------------------------------------------------
// 【3】POST /_/TrendsUi/data/batchexecute  rpcids=DqDTgb （新 UI の地域ピッカー）
// -------------------------------------------------------------------------------------
//   URL:
//     https://trends.google.com/_/TrendsUi/data/batchexecute
//       ?rpcids=DqDTgb&source-path=%2Ftrending&hl=<hl>
//       &soc-app=1&soc-platform=1&soc-device=1&_reqid=<任意の整数>&rt=c
//     ※ この URL 上の hl は **応答内容に影響しない**（言語は f.req の args[0] で決まる。テスト 7）。
//       ブラウザが付けているので形だけ揃えておけばよい。
//     ブラウザは加えて f.sid=<WIZ_global_data.FdrFJe> と bl=<WIZ_global_data.cfb2h> を付けるが、
//     **省略しても 200**（先行調査で i0OFE、本調査で DqDTgb について実測）。_reqid は単なる
//     キャッシュバスターなので任意の整数でよい。
//   ヘッダ: content-type: application/x-www-form-urlencoded;charset=UTF-8
//           x-same-domain: 1 / origin: https://trends.google.com / referer: https://trends.google.com/
//           （Cookie 不要、at= XSRF トークン不要）
//   ボディ: f.req= + encodeURIComponent(JSON.stringify([[[ "DqDTgb", <argsJSON文字列>, null, "generic" ]]])) + &
//           ※ 末尾に裸の & が 1 個付くのがブラウザの形（付けなくても通るが忠実再現するなら付ける）
//   引数 args（**本調査でセマンティクスを実験的に確定**）:
//     args = [ hl: string, includeSubRegions: 0|1, fullCountryList: 0|1 ]
//       [0] hl … 表示名・sortKey・currentGeo の表示名の言語。
//            **【重要】ペイロードの言語を決めるのは args[0] であって URL の ?hl= ではない。**
//            実測 2026-09-09: URL を ?hl=en-US に固定したまま args=["ja",0,0] を送ると、
//            125 件すべての表示名が日本語（非 ASCII）で返り、currentGeo も [["JP","日本"]]
//            になった。逆に args=["en-US",0,0] では [["JP","Japan"]]。
//            → URL の hl は（少なくとも本 RPC の応答内容には）影響しない。テスト 7 で検証。
//       [1] 0/1 … 下位地域（都道府県・州など）を含めるか。**HAR のブラウザは 1**。
//       [2] 0/1 … 国リストの範囲。0 = 125 件、1 = 250 件。**HAR のブラウザは 0**。
//     実測 (2026-09-09、いずれも 200):
//       ["ja",1,0] → 86,719 B  国 125 件・下位地域あり
//                    （= HAR entry322 と同型。e チャンクの T=86,717 との 2 B 差は di/af.httprm の内部カウンタ差）
//       ["ja",0,0] →  6,571 B  国 125 件・下位地域なし
//       ["ja",1,1] → 213,525 B 国 250 件・下位地域あり
//       ["ja"]     →  6,572 B  国 125 件・下位地域なし   ← 足りない引数は 0 扱い（省略可）
//     → 125 件は「Trends が Trending Now を提供している国」、250 件は ISO 全リスト、と推測される（**推定**）。
//        250 件の集合は pickers/geo の 250 件と **完全一致**した（差分ゼロ、実測）。125 件は 250 件の部分集合。
//   レスポンス封筒: )]}' + LF + LF （6 文字）+ (<10進長さ> LF <チャンクJSON> LF)* 。
//     長さ N は **UTF-16 コードユニット数**（バイト数ではない）。厳密には
//       nl = 長さ数字列を終端する LF の位置 とすると body.slice(nl, nl+N) === LF + JSON + LF、
//       すなわち JSON = body.slice(nl+1, nl+N-1) で JSON.length === N-2、次の長さ行は nl+N から。
//     チャンク内アイテムは ["wrb.fr", rpcid, <ペイロードJSON文字列>, null,null,null, slotId] /
//     ["di",n] / ["af.httprm",n,"...",m] / ["e",k,null,null,<全体のUTF-8バイト長>]。
//     ペイロードは **二段 JSON**（wrb.fr[2] が文字列なのでもう一度 JSON.parse）。
//   ペイロード構造: [ countries, currentGeo ]
//     countries[i] は長さ 1 / 2 / 3 の配列
//       [0] 国ノード = [code, displayName, sortKey] または [code, displayName, sortKey, aliases[]]
//            code       … ISO-3166-1 alpha-2
//            sortKey    … 並べ替え用の正規化名。**ロケール別の規則ではなく、単一の規則**である:
//                           sortKey = NFD 分解 → 結合マーク(U+0300-U+036F, U+3099, U+309A)を除去
//                                     → NFC 合成 → toLowerCase()
//                         つまり「濁点・半濁点・アクセント記号を落として小文字化」の 1 本の規則。
//                         hl=ja: "アイルランド"→"アイルラント" / "アゼルバイジャン"→"アセルハイシャン"
//                         hl=en: "Albania"→"albania" / "Côte d'Ivoire"→"cote d'ivoire" / "Türkiye"→"turkiye"
//                         検証: HAR entry322 (hl=ja) の 国 125/125・下位地域 1013/1013 が上式に一致
//                               （オフライン全数検査）。hl=en-US のライブ 125 件も一致（テスト 3）。
//                               ※ 当初「ja は濁点除去 / en は小文字化」と別規則で記述していたが、
//                                 en の "Côte d'Ivoire"→"cote d'ivoire" が単なる小文字化では説明
//                                 できず、上記の統一規則に訂正した（2026-09-09 検証）。
//                         用途: 前方一致検索・オートコンプリートの照合キー。表示には使わないこと。
//            aliases    … 英字別名。**7 ヶ国だけが持つ**（hl=ja / hl=en とも同じ 7 ヶ国）:
//                         US:[usa] AE:[uae] GB:[uk,britain,great britain] NL:[holland]
//                         CH:[swiss] TR:[turkey] BR:[brasil]
//       [1] 第1階層の下位地域 = [[subCode, name, sortKey], ...]  ※全て arity 3
//            **subCode は完全形**（"JP-23" / "US-AL" / "FR-B"）。pickers/geo の相対 id とは違う。
//       [2] 第2階層（**US と FR の 2 ヶ国のみ**）
//            US = DMA/metro 210 件、コードは数値文字列 "637" 等（pickers/geo の DMA 210 件と集合一致）
//            FR = departement 96 件、コードは "FR-12" 等（**pickers/geo には存在しない階層**）
//     currentGeo = [[code, localizedName]] … **アクセス元 IP から解決した既定地域**（常に 1 件）。
//                  code は hl に依存せず IP で決まる（日本からのアクセスでは常に "JP"）。
//                  localizedName は args[0] でローカライズされる:
//                    args=["ja",...]    → [["JP","日本"]]   (HAR entry322 / ライブとも)
//                    args=["en-US",...] → [["JP","Japan"]]  (ライブ 2026-09-09)
//                  → ラッパーで「ユーザの既定地域」を出したいときはこれを使えばよい。
//                    ただし **IP ジオロケーション依存なので CI 等では値が変わる**。
//                    テストでは code が /^[A-Z]{2}$/ であることだけを検査すること。
//   実測カウント ["ja",1,1] : 国 250 件 = arity1 58 件 + arity2 190 件 + arity3 2 件（US, FR）
//     → 下位地域を持つ国は 192 件で pickers/geo と一致。
//
// -------------------------------------------------------------------------------------
// 【4】2 つの地域マスタの使い分け（実測に基づく比較）
// -------------------------------------------------------------------------------------
//   |                    | pickers/geo (REST)          | DqDTgb (batchexecute)              |
//   |--------------------|-----------------------------|------------------------------------|
//   | 形式               | ネストしたオブジェクト      | ネストした配列（位置引数）         |
//   | 下位地域コード     | **相対**（"23"）            | **完全形**（"JP-23"）              |
//   | 国の件数           | 常に 250                    | 125（既定）/ 250（第3引数=1）      |
//   | 並べ替えキー       | 無し                        | 有り（sortKey）                    |
//   | 別名（uk 等）      | 無し                        | 有り（7 ヶ国）                     |
//   | 既定地域(IP由来)   | 無し                        | 有り（currentGeo）                 |
//   | FR の departement  | **無し**                    | 有り（96 件）                      |
//   | US の DMA          | 有り（州の下、延べ 301 / ユニーク 210） | 有り（フラット 210）   |
//   | サイズ(ja)         | 152,482 B                   | 86,719 B (1,0) / 213,525 B (1,1)   |
//   推奨: explore 系（/trends/api/*）の geo パラメータを組み立てるなら **pickers/geo**
//         （階層 UI を作りやすい）。オートコンプリートや別名解決が要るなら **DqDTgb**。
//
// -------------------------------------------------------------------------------------
// 【5】エラー / レート制限の挙動
// -------------------------------------------------------------------------------------
//   * 429 は content-type: text/html; charset=utf-8、約 1.7 KB の HTML、**Retry-After 無し**、
//     content-disposition 無し。→ 成功判定は
//       res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("application/json")
//     を推奨。JSON.parse する前に content-type を見ること。
//   * 302 → https://www.google.com/sorry/index?... は bot 判定。ピッカーでは
//     「不適切な Cookie を付けた」ときに実測で発生した（【0】）。redirect: "manual" でないと
//     fetch が勝手に追いかけて紛らわしいので、判定したいなら manual にする。
//   * バックオフ: 2s → 4s → 8s の指数バックオフを最大 3 回。それ以上は諦める。
//
// -------------------------------------------------------------------------------------
// 【6】秘密情報について
// -------------------------------------------------------------------------------------
//   本ファイルには Cookie 値・reCAPTCHA トークン等を一切埋め込んでいない（そもそも不要）。
//
// -------------------------------------------------------------------------------------
// 【7】キャッシュ指針
// -------------------------------------------------------------------------------------
//   * サーバは cache-control: no-cache, no-store を返すが、これは HTTP キャッシュの話。
//     内容は事実上ほぼ不変（HAR 2026-09-08 と ライブ 2026-09-09 で **バイト数が完全一致**）。
//   * 推奨: (hl) をキーに **ディスク or メモリで 24 時間〜数週間キャッシュ**する。
//     - 数百 KB なので丸ごと保持して構わない。
//     - ただし全 hl を先読みするとサイズが効いてくる（hl 1 つあたり geo 130〜155 KB +
//       category 60〜66 KB）。**遅延ロード + hl 単位の LRU** が現実的。
//     - **id 部分は hl 非依存**なので、「id ツリー（構造）を 1 回だけ」＋「id→name の辞書を hl ごと」
//       に分けて持てば、多言語対応時のメモリを大幅に削減できる。
//     - カテゴリは id が重複する DAG なので Map<number,string> は上書きで問題ない
//       （同じ id なら name も同じことを実測で確認済み）。
//   * ETag / Last-Modified は返らないので条件付き GET による差分更新はできない。TTL 方式で十分。
//
// -------------------------------------------------------------------------------------
// 【8】本テストのライブリクエスト数
// -------------------------------------------------------------------------------------
//   合計 7 回（pickers/geo x1, pickers/category x2 [en-US, ja], DqDTgb x4）。各リクエスト間に 1.5 秒待機。
//   429 / ネットワーク断のときはハード失敗させず console.warn してスキップする（ハード失敗は
//   実行者の環境で再現しないため）。ただしレスポンスが取れた場合は必ず構造をアサートする。
//   テスト 5 だけはネットワーク不要（オフライン自己検査）。
//
//   実測ログ (2026-09-09, 日本の IP):
//     [pickers/geo en-US]      utf8=131769B countries=250 withSub=192 metros(dedup)=210
//     [pickers/category en-US] utf8=59698B  nodes=1426 uniqueIds=1132 maxDepth=5 topLevel=25
//     [pickers/category ja]    utf8=65945B  nodes=1426 topLevel=25 （= HAR のバイト数と完全一致）
//     [DqDTgb en-US,1,0]       utf8=68984B  countries=125 aliases=7 currentGeo=[["JP","Japan"]]
//     [DqDTgb en-US,0,0]       utf8=4945B   countries=125
//     [DqDTgb en-US,1,1]       utf8=173689B countries=250 withSub=192
//     [DqDTgb ja,0,0]          utf8=6571B   countries=125 currentGeo=[["JP","日本"]]
// =====================================================================================

import { assert, assertEquals } from "jsr:@std/assert@^1";

const ORIGIN = "https://trends.google.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ライブリクエストの結果。ok=false のときはテストをスキップする。 */
type Fetched =
  | { ok: true; status: number; contentType: string; body: string }
  | { ok: false; reason: string };

/** 429 のとき 2s/4s/8s のバックオフで最大 3 回リトライする fetch。 */
async function fetchWithBackoff(url: string, init?: RequestInit): Promise<Fetched> {
  let waitMs = 2000;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      await sleep(waitMs);
      waitMs *= 2;
    }
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", ...init });
    } catch (e) {
      return { ok: false, reason: `network error: ${e}` };
    }
    // Deno はレスポンスボディを消費しないとリソースリーク扱いになる。必ず読む。
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status === 429) continue; // バックオフして再試行
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        reason: `redirected (${res.status}) to ${res.headers.get("location")} — bot 判定の可能性`,
      };
    }
    if (res.status !== 200) {
      return { ok: false, reason: `status ${res.status} (${contentType})` };
    }
    return { ok: true, status: res.status, contentType, body };
  }
  return { ok: false, reason: "429 が続いたため断念（レート制限のため未検証）" };
}

/** /trends/api/* の )]}' プレフィックス（5 文字）を剥がして JSON.parse する。 */
function parseRestJson(body: string): unknown {
  assert(body.startsWith(")]}'\n"), "先頭 5 バイトは )]}' + LF でなければならない");
  return JSON.parse(body.slice(5));
}

/**
 * batchexecute の封筒をパースして wrb.fr だけ取り出す。
 * 長さ行は UTF-16 コードユニット数で、前後の LF を 2 つ含む（JSON 長 = N-2）。
 */
function parseBatchExecute(
  text: string,
): Array<{ rpcid: string; slot: string; data: unknown }> {
  assert(
    text.startsWith(")]}'\n\n"),
    `batchexecute の先頭は )]}' + LF + LF のはず: ${JSON.stringify(text.slice(0, 12))}`,
  );
  const items: unknown[][] = [];
  let pos = 6;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) break;
    const lenStr = text.slice(pos, nl).trim();
    if (!/^\d+$/.test(lenStr)) break;
    const n = Number(lenStr);
    const json = text.slice(nl + 1, nl + n - 1);
    assertEquals(json.length, n - 2, "JSON 長は 長さ行 - 2 でなければならない");
    items.push(...(JSON.parse(json) as unknown[][]));
    pos = nl + n;
  }
  return items
    .filter((it) => it[0] === "wrb.fr")
    .map((it) => ({
      rpcid: it[1] as string,
      slot: it[6] as string,
      data: JSON.parse(it[2] as string),
    }));
}

/**
 * DqDTgb を 1 回呼ぶ。args は [hl, includeSubRegions, fullCountryList]。
 * urlHl は URL 側の ?hl=。応答内容には影響しないはず（テスト 7 で args[0] と食い違わせて検証する）。
 */
function callDqDTgb(args: unknown[], urlHl = "en-US"): Promise<Fetched> {
  const reqid = (Math.floor(Math.random() * 100000) + 1) * 100;
  const url = `${ORIGIN}/_/TrendsUi/data/batchexecute` +
    `?rpcids=DqDTgb&source-path=%2Ftrending&hl=${encodeURIComponent(urlHl)}` +
    `&soc-app=1&soc-platform=1&soc-device=1&_reqid=${reqid}&rt=c`;
  const fReq = JSON.stringify([[["DqDTgb", JSON.stringify(args), null, "generic"]]]);
  return fetchWithBackoff(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-same-domain": "1",
      "origin": ORIGIN,
      "referer": `${ORIGIN}/`,
      "user-agent": UA,
      "accept": "*/*",
    },
    body: "f.req=" + encodeURIComponent(fReq) + "&",
  });
}

/** ピッカー（REST）を 1 回呼ぶ。**Cookie は絶対に付けない**（付けると /sorry に飛ぶ）。 */
function callPicker(kind: "geo" | "category", hl: string, tz?: number): Promise<Fetched> {
  const url = `${ORIGIN}/trends/api/explore/pickers/${kind}?hl=${encodeURIComponent(hl)}` +
    (tz === undefined ? "" : `&tz=${tz}`);
  return fetchWithBackoff(url, {
    headers: {
      "user-agent": UA,
      "accept": "application/json, text/plain, */*",
      "accept-language": hl,
      "referer": `${ORIGIN}/trends/explore`,
    },
  });
}

type GeoNode = { children?: GeoNode[]; name: string; id: string };
type CatNode = { children?: CatNode[]; name: string; id: number };

/**
 * DqDTgb の sortKey 生成規則（本調査で確定）。
 *   NFD 分解 → 結合マーク（濁点 U+3099 / 半濁点 U+309A / ラテン系アクセント U+0300-U+036F）を除去
 *   → NFC 合成 → 小文字化
 * HAR entry322 (hl=ja) の 国 125/125・下位地域 1013/1013 と、ライブ hl=en-US の 125/125 で成立。
 */
const COMBINING_MARK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // ラテン系の結合アクセント（Côte → Cote, Türkiye → Turkiye）
  [0x3099, 0x309a], // 日本語の結合濁点・半濁点（ラント ← ランド, ハイシャン ← バイジャン）
];

function normalizeSortKey(name: string): string {
  let out = "";
  for (const ch of name.normalize("NFD")) {
    const cp = ch.codePointAt(0)!;
    if (COMBINING_MARK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) continue;
    out += ch;
  }
  return out.normalize("NFC").toLowerCase();
}

/**
 * pickers/category のルート直下 25 件の id（2026-09-09 実測、昇順）。
 * **hl を変えても集合は不変**であることをテスト 2 (en-US) と テスト 6 (ja) の両方で検証する。
 * 並び順は hl のロケール照合順で変わるのでここでは昇順に正規化して比較する。
 */
const CATEGORY_TOP_LEVEL_IDS = [
  3, 5, 7, 8, 11, 12, 13, 14, 16, 18, 19, 20, 22, 29, 44, 45, 47, 65, 66, 67, 71, 174, 299, 533,
  958,
] as const;

/** テスト 2 が記録した hl=en-US の出現順。テスト 6 で「並び順は hl 依存」を示すのに使う。 */
let enUsTopLevelOrder: number[] | null = null;
/** テスト 2 が記録した hl=en-US の総ノード数。テスト 6 で「木の形は hl 非依存」を示すのに使う。 */
let enUsCategoryNodeCount: number | null = null;

// =====================================================================================
// テスト 1: pickers/geo （ライブ 1 リクエスト）
// =====================================================================================
Deno.test({
  name: "pickers/geo: Cookie 無しで 200・)]}' プレフィックス・{children,name,id} の再帰木",
  fn: async () => {
    const r = await callPicker("geo", "en-US", -540);
    if (!r.ok) {
      console.warn(`[skip] pickers/geo: ${r.reason}`);
      return;
    }
    assert(r.contentType.startsWith("application/json"), `JSON が返るはず: ${r.contentType}`);

    const root = parseRestJson(r.body) as GeoNode;

    // --- ルート ---
    assertEquals(root.id, "", "ルートの id は空文字（= geo 未指定 / Worldwide）");
    assertEquals(typeof root.name, "string");
    assert(root.name.length > 0, "ルートの name は hl でローカライズされた文字列");
    assert(Array.isArray(root.children), "ルートは children を持つ");

    // --- ノードのキーはちょうど 3 つ ---
    const keys = new Set<string>();
    (function scan(n: GeoNode) {
      for (const k of Object.keys(n)) keys.add(k);
      for (const c of n.children ?? []) scan(c);
    })(root);
    assertEquals(
      [...keys].sort().join(","),
      "children,id,name",
      "geo ノードのキーは children / id / name のみ",
    );

    // --- 国 ---
    const countries = root.children!;
    assert(
      countries.length >= 240,
      `国は 250 件前後のはず（実測 250, 2026-09-09）: ${countries.length}`,
    );
    for (const c of countries) {
      assert(/^[A-Z]{2}$/.test(c.id), `国コードは ISO-3166-1 alpha-2: ${JSON.stringify(c.id)}`);
    }

    // --- JP: 47 都道府県、子 id は「相対」コード ---
    const jp = countries.find((c) => c.id === "JP");
    assert(jp, "JP が存在する");
    assertEquals(jp!.children?.length, 47, "JP の下位地域は 47 都道府県");
    for (const p of jp!.children!) {
      assert(
        /^\d{2}$/.test(p.id),
        `JP の子 id は 2 桁数字の相対コード（"JP-13" ではない）: ${JSON.stringify(p.id)}`,
      );
    }
    // explore の geo パラメータ形式は 親 id + "-" + 子 id
    assert(
      jp!.children!.some((p) => `JP-${p.id}` === "JP-13"),
      "JP-13（東京都）が親子連結で構成できる",
    );

    // --- US: 州 51 件、その下に DMA（第3階層は US のみ） ---
    const us = countries.find((c) => c.id === "US");
    assert(us, "US が存在する");
    assertEquals(us!.children?.length, 51, "US は 50 州 + DC の 51 件");
    const metroIds = us!.children!.flatMap((s) => (s.children ?? []).map((m) => m.id));
    assert(metroIds.length > 0, "US の州は DMA を子に持つ");
    for (const m of metroIds.slice(0, 20)) {
      assert(/^\d{3}$/.test(m), `DMA コードは 3 桁の数値文字列: ${JSON.stringify(m)}`);
    }
    // 同じ DMA が複数州にまたがるため、延べ数 > ユニーク数 になる（実測 301 / 210）
    assert(
      new Set(metroIds).size < metroIds.length,
      "DMA は州をまたいで重複出現する（延べ 301 / ユニーク 210 を実測）",
    );

    // --- 第3階層を持つのは US だけ（FR の departement は REST には無い） ---
    const threeLevel = countries
      .filter((c) => (c.children ?? []).some((s) => (s.children ?? []).length > 0))
      .map((c) => c.id);
    assertEquals(threeLevel, ["US"], "第3階層を持つ国は US のみ（FR は 22 地域圏まで）");

    // --- 下位地域を持たない国も普通にある ---
    const leafCountries = countries.filter((c) => (c.children ?? []).length === 0);
    assert(leafCountries.length > 0, "下位地域を持たない国が存在する（実測 58 件）");

    console.log(
      `[pickers/geo] utf8=${new TextEncoder().encode(r.body).length}B countries=${countries.length} ` +
        `withSub=${countries.length - leafCountries.length} metros(dedup)=${new Set(metroIds).size}`,
    );
  },
});

// =====================================================================================
// テスト 2: pickers/category （ライブ 1 リクエスト）
// =====================================================================================
Deno.test({
  name: "pickers/category: id は数値・hl 非依存・DAG（id がツリー内で重複する）",
  fn: async () => {
    await sleep(1500); // レート制限対策
    const r = await callPicker("category", "en-US", -540);
    if (!r.ok) {
      console.warn(`[skip] pickers/category: ${r.reason}`);
      return;
    }
    assert(r.contentType.startsWith("application/json"), `JSON が返るはず: ${r.contentType}`);

    const root = parseRestJson(r.body) as CatNode;

    assertEquals(root.id, 0, "ルートのカテゴリ ID は 0（= 全カテゴリ）");
    assertEquals(typeof root.name, "string");
    assert(
      Array.isArray(root.children) && root.children.length >= 20,
      `ルート直下は 25 件前後（実測 25）: ${root.children?.length}`,
    );

    const keys = new Set<string>();
    (function scan(n: CatNode) {
      for (const k of Object.keys(n)) keys.add(k);
      for (const c of n.children ?? []) scan(c);
    })(root);
    assertEquals(
      [...keys].sort().join(","),
      "children,id,name",
      "category ノードのキーは children / id / name のみ",
    );

    // 全ノードを走査して id -> name の集合を作る
    const idToNames = new Map<number, Set<string>>();
    let total = 0;
    let maxDepth = 0;
    (function walk(n: CatNode, depth: number) {
      for (const c of n.children ?? []) {
        total++;
        maxDepth = Math.max(maxDepth, depth);
        assertEquals(typeof c.id, "number", "カテゴリ id は number");
        assert(c.id > 0, "ルート以外の id は正の整数");
        const s = idToNames.get(c.id) ?? new Set<string>();
        s.add(c.name);
        idToNames.set(c.id, s);
        walk(c, depth + 1);
      }
    })(root, 0);

    assert(total >= 1000, `総ノード数は 1400 件前後（実測 1426）: ${total}`);
    assert(maxDepth >= 4, `階層は 5 段程度ある（実測 maxDepth=5）: ${maxDepth}`);
    enUsCategoryNodeCount = total; // テスト 6 で hl=ja と突き合わせる

    // DAG: 同一 id が複数箇所に出るが、name は必ず一致する
    assert(
      idToNames.size < total,
      `id はツリー内で重複する（実測: ユニーク 1132 / ノード 1426）: unique=${idToNames.size} total=${total}`,
    );
    for (const [id, names] of idToNames) {
      assertEquals(names.size, 1, `id=${id} は複数箇所に出ても name は 1 つ: ${[...names]}`);
    }

    // トップレベルの id 集合は固定（hl 非依存の不変条件。テスト 6 の hl=ja と同じ定数で照合する）
    enUsTopLevelOrder = root.children!.map((c) => c.id);
    assertEquals(
      [...enUsTopLevelOrder].sort((a, b) => a - b),
      [...CATEGORY_TOP_LEVEL_IDS],
      "ルート直下 25 件の id 集合は 2026-09-09 実測値と一致するはず",
    );

    // 代表的なトップレベル ID（英語名で確認）
    const topLevel = new Map(root.children!.map((c) => [c.id, c.name]));
    const expectTop: Array<[number, RegExp]> = [
      [3, /Arts\s*&\s*Entertainment/i],
      [5, /Computers\s*&\s*Electronics/i],
      [7, /Finance/i],
      [8, /Games/i],
      [12, /Business\s*&\s*Industrial/i],
      [16, /News/i],
      [18, /Shopping/i],
      [20, /Sports/i],
      [47, /Autos\s*&\s*Vehicles/i],
      [71, /Food\s*&\s*Drink/i],
      [174, /Science/i],
      [958, /Jobs\s*&\s*Education/i],
    ];
    for (const [id, re] of expectTop) {
      const name = topLevel.get(id);
      assert(name !== undefined, `トップレベルに id=${id} が存在する`);
      assert(re.test(name!), `id=${id} の名前が想定と一致しない: ${name}`);
    }

    // 深い階層の実例（2026-09-09 実測）
    assert(idToNames.has(1237), "id=1237 (Smoking & Smoking Cessation) が存在する");
    // DAG の実例: 184 は Arts & Entertainment 配下と News 配下の 2 箇所に出る
    assert(idToNames.has(184), "id=184 (Celebrities & Entertainment News) が存在する");

    console.log(
      `[pickers/category] utf8=${new TextEncoder().encode(r.body).length}B nodes=${total} ` +
        `uniqueIds=${idToNames.size} maxDepth=${maxDepth} topLevel=${root.children!.length}`,
    );
  },
});

// =====================================================================================
// テスト 3: batchexecute DqDTgb の封筒とペイロード （ライブ 1 リクエスト）
// =====================================================================================
Deno.test({
  name: "batchexecute DqDTgb: 封筒の長さ行は UTF-16・ペイロードは [countries, currentGeo]",
  fn: async () => {
    await sleep(1500);
    const r = await callDqDTgb(["en-US", 1, 0]);
    if (!r.ok) {
      console.warn(`[skip] DqDTgb: ${r.reason}`);
      return;
    }
    assert(r.contentType.startsWith("application/json"), `JSON が返るはず: ${r.contentType}`);

    const frames = parseBatchExecute(r.body); // 長さ行 == JSON長+2 の検算もこの中で行う
    assertEquals(frames.length, 1, "1 RPC なので wrb.fr は 1 件");
    assertEquals(frames[0].rpcid, "DqDTgb");
    assertEquals(frames[0].slot, "generic", "リクエストの slotId がそのままエコーされる");

    const payload = frames[0].data as [unknown[], unknown[]];
    assertEquals(payload.length, 2, "ペイロードは [countries, currentGeo] の 2 要素");

    const countries = payload[0] as Array<Array<unknown>>;
    const currentGeo = payload[1] as Array<Array<string>>;

    assert(countries.length >= 100, `既定 (第3引数=0) の国数は 125 前後: ${countries.length}`);

    // currentGeo: IP から解決された既定地域 [[code, localizedName]]
    assertEquals(currentGeo.length, 1, "currentGeo は 1 要素");
    assertEquals(currentGeo[0].length, 2, "currentGeo[0] は [code, name] の 2 要素");
    assert(/^[A-Z]{2}$/.test(currentGeo[0][0]), `currentGeo のコードは 2 文字: ${currentGeo[0][0]}`);

    // 国ノードの形
    let aliasCount = 0;
    for (const c of countries) {
      assert(c.length >= 1 && c.length <= 3, `国要素の長さは 1..3: ${c.length}`);
      const node = c[0] as unknown[];
      assert(node.length === 3 || node.length === 4, `国ノードは arity 3 か 4: ${node.length}`);
      assert(/^[A-Z]{2}$/.test(node[0] as string), `国コード: ${node[0]}`);
      assertEquals(typeof node[1], "string", "displayName は文字列");
      assertEquals(typeof node[2], "string", "sortKey は文字列");
      // sortKey は「結合マーク除去 + 小文字化」で displayName から機械的に導出される。
      // hl=en-US では "Côte d'Ivoire" → "cote d'ivoire" / "Türkiye" → "turkiye" が効いてくるので、
      // 単なる toLowerCase() では説明できない（この 2 件が規則の決め手）。
      assertEquals(
        node[2],
        normalizeSortKey(node[1] as string),
        `sortKey は NFD→結合マーク除去→NFC→小文字化 で導出できるはず: ${node[0]} ${node[1]}`,
      );
      if (node.length === 4) {
        aliasCount++;
        assert(Array.isArray(node[3]), "aliases は配列");
        for (const a of node[3] as unknown[]) assertEquals(typeof a, "string");
      }
      // 下位地域は「完全形」コード（"JP-23" のように親コードを含む）
      for (const sub of (c[1] as unknown[][] | undefined) ?? []) {
        assertEquals(sub.length, 3, "下位地域は [code, name, sortKey] の arity 3");
        assert(
          (sub[0] as string).startsWith(node[0] + "-"),
          `下位地域コードは完全形（親コード + "-"）: ${sub[0]} under ${node[0]}`,
        );
        assertEquals(
          sub[2],
          normalizeSortKey(sub[1] as string),
          `下位地域にも同じ sortKey 規則が効く: ${sub[0]} ${sub[1]}`,
        );
      }
    }
    assertEquals(aliasCount, 7, "英字別名を持つ国は 7 ヶ国（US/AE/GB/NL/CH/TR/BR）");

    // GB の別名に uk が含まれる
    const gb = countries.find((c) => (c[0] as unknown[])[0] === "GB")!;
    const gbAliases = (gb[0] as unknown[])[3] as string[];
    assert(gbAliases.includes("uk"), `GB の別名に uk: ${JSON.stringify(gbAliases)}`);

    // 第2階層（US の DMA / FR の departement）を持つのは 2 ヶ国だけ
    const threeLevel = countries
      .filter((c) => c.length >= 3)
      .map((c) => (c[0] as unknown[])[0] as string)
      .sort();
    assertEquals(threeLevel.join(","), "FR,US", "第2階層を持つのは US と FR のみ");
    const us = countries.find((c) => (c[0] as unknown[])[0] === "US")!;
    const usMetros = us[2] as unknown[][];
    assert(usMetros.length >= 200, `US の DMA は 210 件前後: ${usMetros.length}`);
    assert(/^\d{3}$/.test(usMetros[0][0] as string), "DMA コードは 3 桁の数値文字列");

    console.log(
      `[DqDTgb en-US,1,0] utf8=${new TextEncoder().encode(r.body).length}B countries=${countries.length} ` +
        `aliases=${aliasCount} currentGeo=${JSON.stringify(currentGeo)}`,
    );
  },
});

// =====================================================================================
// テスト 4: DqDTgb 第2/第3引数のセマンティクス （ライブ 2 リクエスト）
// =====================================================================================
Deno.test({
  name: "DqDTgb: 第2引数=下位地域の有無 / 第3引数=国リストの範囲 (125 vs 250)",
  fn: async () => {
    await sleep(1500);
    const rNoSub = await callDqDTgb(["en-US", 0, 0]);
    if (!rNoSub.ok) {
      console.warn(`[skip] DqDTgb (0,0): ${rNoSub.reason}`);
      return;
    }
    await sleep(1500);
    const rFull = await callDqDTgb(["en-US", 1, 1]);
    if (!rFull.ok) {
      console.warn(`[skip] DqDTgb (1,1): ${rFull.reason}`);
      return;
    }

    const noSub = (parseBatchExecute(rNoSub.body)[0].data as unknown[][])[0] as unknown[][];
    const full = (parseBatchExecute(rFull.body)[0].data as unknown[][])[0] as unknown[][];

    // 第2引数 0 → 下位地域が 1 件も付かない（全要素が長さ 1）
    for (const c of noSub) {
      assertEquals(c.length, 1, "第2引数=0 のとき国要素は [node] のみ（下位地域なし）");
    }
    const noSubBytes = new TextEncoder().encode(rNoSub.body).length;
    const fullBytes = new TextEncoder().encode(rFull.body).length;
    assert(
      noSubBytes * 5 < fullBytes,
      `下位地域なしは桁違いに小さい（実測 6.5KB vs 213KB）: ${noSubBytes} vs ${fullBytes}`,
    );

    // 第3引数 1 → 国リストが拡張される（125 → 250）
    assert(
      full.length > noSub.length,
      `第3引数=1 で国数が増える（実測 125 → 250）: ${noSub.length} → ${full.length}`,
    );
    assert(full.length >= 240, `全件モードは 250 件前後: ${full.length}`);

    // 125 件は 250 件の部分集合
    const fullCodes = new Set(full.map((c) => (c[0] as unknown[])[0] as string));
    for (const c of noSub) {
      const code = (c[0] as unknown[])[0] as string;
      assert(fullCodes.has(code), `既定 125 件は全件 250 件の部分集合であるべき: ${code} が無い`);
    }

    // 全件モードでは下位地域も付いている
    const withSub = full.filter((c) => c.length >= 2).length;
    assert(withSub >= 180, `下位地域を持つ国は 192 件前後（pickers/geo と一致）: ${withSub}`);

    console.log(
      `[DqDTgb flags] (0,0)=${noSub.length}countries/${noSubBytes}B  ` +
        `(1,1)=${full.length}countries/${fullBytes}B withSub=${withSub}`,
    );
  },
});

// =====================================================================================
// テスト 5: 封筒パーサのオフライン自己テスト（ネットワーク不使用）
//   長さ行が UTF-16 コードユニット数であること、サロゲートペアを含んでも成立することを確認する。
//   ※ サーバが実際にサロゲートペアを含むレスポンスを返すケースは本調査では未観測。
//      ここで検証しているのは「文書化した規則どおりに実装すれば壊れない」ことである。
// =====================================================================================
Deno.test({
  name: "封筒パーサ: 長さ行は UTF-16 コードユニット数（サロゲートペア込みで検算）",
  fn: () => {
    const payload = JSON.stringify([[["XX", "日本🗾", "x"]], [["JP", "日本"]]]);
    const chunk = JSON.stringify([["wrb.fr", "DqDTgb", payload, null, null, null, "generic"]]);
    const tail = JSON.stringify([["e", 2, null, null, 0]]);
    // 長さ = JSON の UTF-16 長 + 2（前後の LF）
    const envelope = ")]}'\n\n" +
      `${chunk.length + 2}\n${chunk}\n` +
      `${tail.length + 2}\n${tail}\n`;

    // 意図的に「バイト長ではない」ことを示す
    assert(
      new TextEncoder().encode(chunk).length > chunk.length,
      "非 ASCII を含むので UTF-8 バイト長 > UTF-16 長",
    );

    const frames = parseBatchExecute(envelope);
    assertEquals(frames.length, 1);
    assertEquals(frames[0].rpcid, "DqDTgb");
    assertEquals(frames[0].slot, "generic");
    const data = frames[0].data as [unknown[], unknown[]];
    assertEquals((data[0][0] as unknown[])[1], "日本🗾", "サロゲートペアが壊れずに復元される");
    assertEquals(data[1], [["JP", "日本"]]);
  },
});

/** 全文字が ASCII か。「hl=ja なのに英語のままではないか」の判定に使う。 */
const isAllAscii = (s: string) => [...s].every((ch) => ch.codePointAt(0)! < 0x80);

/** ひらがな・カタカナ・CJK 統合漢字を 1 文字でも含むか。 */
const hasJapanese = (s: string) =>
  [...s].some((ch) => {
    const cp = ch.codePointAt(0)!;
    return (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x4e00 && cp <= 0x9fff);
  });

// =====================================================================================
// テスト 6: pickers/category を hl=ja・tz 省略で取得 （ライブ 1 リクエスト）
//   検証したい仕様:
//     (a) tz は省略可能（無くても 200 で同じ構造・同じバイト数）
//     (b) id 集合・ノード数・木の形は hl 非依存。**名前と並び順だけ**が変わる
//     (c) 本文末尾に改行が付かない（)]}' + JSON でちょうど終わる）
// =====================================================================================
Deno.test({
  name: "pickers/category hl=ja: tz 省略可・id 集合と件数は hl 非依存・並び順だけが変わる",
  fn: async () => {
    await sleep(1500);
    const r = await callPicker("category", "ja"); // ← tz を意図的に付けない
    if (!r.ok) {
      console.warn(`[skip] pickers/category(ja): ${r.reason}`);
      return;
    }
    assert(r.contentType.startsWith("application/json"), `JSON が返るはず: ${r.contentType}`);

    // (c) 末尾に改行やパディングが無い（trim せずに JSON.parse できる）
    assert(!r.body.endsWith("\n"), "本文は改行で終わらない");
    const root = parseRestJson(r.body) as CatNode;

    // (b-1) ルートは同じ id=0、名前だけ日本語
    assertEquals(root.id, 0, "ルートの id は hl に依らず 0");
    assert(hasJapanese(root.name), `hl=ja のルート名は日本語のはず: ${root.name}`);

    // (b-2) トップレベルの id 集合が en-US と完全一致（テスト 2 と同じ定数で照合）
    const jaOrder = root.children!.map((c) => c.id);
    assertEquals(jaOrder.length, 25, "ルート直下は hl に依らず 25 件");
    assertEquals(
      [...jaOrder].sort((a, b) => a - b),
      [...CATEGORY_TOP_LEVEL_IDS],
      "hl=ja でも id 集合は hl=en-US と完全一致する",
    );

    // (b-3) 並び順は hl 依存（ロケール照合順）。テスト 2 が走っていれば直接比較する。
    if (enUsTopLevelOrder) {
      assert(
        jaOrder.join(",") !== enUsTopLevelOrder.join(","),
        "並び順は hl で変わる（出現順に依存した実装は壊れる）: " +
          `ja=${jaOrder.join(",")} en=${enUsTopLevelOrder.join(",")}`,
      );
    } else {
      console.warn("[info] テスト 2 がスキップされたため並び順の直接比較は省略");
    }

    // (b-4) 木の形（ノード総数）も hl 非依存
    let total = 0;
    const jaNames = new Map<number, string>();
    (function walk(n: CatNode) {
      for (const c of n.children ?? []) {
        total++;
        jaNames.set(c.id, c.name);
        walk(c);
      }
    })(root);
    // 「hl を変えても木の形は同じ」を、同じ実行内で取った en-US の実測値と突き合わせて示す。
    // 絶対値のハードコードは Google 側のカテゴリ追加で壊れるので、不変条件として比較する。
    if (enUsCategoryNodeCount !== null) {
      assertEquals(
        total,
        enUsCategoryNodeCount,
        "総ノード数は hl 非依存（同一実行内の hl=en-US と一致するはず）",
      );
    } else {
      assert(total >= 1000, `総ノード数は 1400 件前後（2026-09-09 実測 1426）: ${total}`);
      console.warn("[info] テスト 2 がスキップされたためノード数の hl 間比較は省略");
    }

    // (b-5) 名前がきちんと翻訳されている（英語のままではない）
    for (const id of [3, 71, 20, 958]) {
      const name = jaNames.get(id);
      assert(name !== undefined, `id=${id} が存在する`);
      assert(!isAllAscii(name!), `hl=ja では id=${id} の名前が英語のままではない: ${name}`);
      assert(hasJapanese(name!), `id=${id} の名前は日本語: ${name}`);
    }
    // 代表値のスポット確認（2026-09-09 実測。表記ゆれに強いよう部分一致で見る）
    assert(jaNames.get(71)!.includes("フード"), `71 は「フード、ドリンク」相当: ${jaNames.get(71)}`);
    assert(jaNames.get(20)!.includes("スポーツ"), `20 は「スポーツ」: ${jaNames.get(20)}`);

    // (a) tz 無しでも中身は完全な JSON。2026-09-09 時点では 65,945 B ちょうどで、
    //     HAR (2026-09-08, hl=ja&tz=-540) の content.size 65945 とバイト単位で一致した。
    //     → tz はレスポンスに一切影響せず、マスタデータも日をまたいで不変。
    //     ただし将来のカテゴリ追加で当然変わるので、テストでは桁だけ検査して実測値はログに出す。
    const bytes = new TextEncoder().encode(r.body).length;
    assert(
      bytes > 40_000 && bytes < 200_000,
      `hl=ja のカテゴリマスタは数十 KB 台（2026-09-09 実測 65,945 B）: ${bytes}`,
    );
    if (bytes !== 65945) {
      console.warn(`[info] サイズが 2026-09-09 実測 (65945 B) から変化: ${bytes} B`);
    }

    console.log(
      `[pickers/category ja] utf8=${bytes}B nodes=${total} topLevel=${jaOrder.length} ` +
        `3=${jaNames.get(3)} 71=${jaNames.get(71)}`,
    );
  },
});

// =====================================================================================
// テスト 7: DqDTgb のローカライズは f.req の args[0] が決める（URL の ?hl= ではない）
//   （ライブ 1 リクエスト）
//   URL 側を ?hl=en-US に固定したまま args=["ja",0,0] を送り、日本語が返ることを確認する。
//   ラッパー実装者が最も間違えやすい点（URL の hl だけ変えても言語が変わらない）。
// =====================================================================================
Deno.test({
  name: "DqDTgb: 言語は args[0] が決定する（URL の hl= は応答に影響しない）",
  fn: async () => {
    await sleep(1500);
    // URL の hl は en-US のまま、引数だけ ja にする
    const r = await callDqDTgb(["ja", 0, 0], "en-US");
    if (!r.ok) {
      console.warn(`[skip] DqDTgb(ja via en-US url): ${r.reason}`);
      return;
    }
    const frames = parseBatchExecute(r.body);
    assertEquals(frames.length, 1);
    assertEquals(frames[0].rpcid, "DqDTgb");
    const [countries, currentGeo] = frames[0].data as [unknown[][], string[][]];

    assert(countries.length >= 100, `既定の国数は 125 前後: ${countries.length}`);

    // 全件が日本語表示名 = URL の hl=en-US は無視されている
    const jaCount = countries.filter((c) => hasJapanese((c[0] as string[])[1])).length;
    assertEquals(
      jaCount,
      countries.length,
      `URL が hl=en-US でも args[0]="ja" なら全件日本語になるはず: ${jaCount}/${countries.length}`,
    );

    // currentGeo の表示名も args[0] でローカライズされる（コードは IP 由来なので形だけ見る）
    assertEquals(currentGeo.length, 1, "currentGeo は 1 件");
    assert(/^[A-Z]{2}$/.test(currentGeo[0][0]), `currentGeo のコード: ${currentGeo[0][0]}`);
    assert(
      hasJapanese(currentGeo[0][1]),
      `currentGeo の表示名も日本語になる: ${JSON.stringify(currentGeo[0])}`,
    );

    // 第2引数=0 なので下位地域は付かない
    for (const c of countries) assertEquals(c.length, 1, "args[1]=0 では国ノードのみ");

    // sortKey 規則は言語によらず同一（濁点・半濁点が落ちる）
    let sortKeyDiff = 0;
    for (const c of countries) {
      const [code, name, sortKey] = c[0] as string[];
      assertEquals(
        sortKey,
        normalizeSortKey(name),
        `hl=ja でも同じ sortKey 規則: ${code} ${name} -> ${sortKey}`,
      );
      if (sortKey !== name) sortKeyDiff++;
    }
    assert(
      sortKeyDiff > 50,
      `日本語では濁点・半濁点が落ちる国名が多数ある（実測 84/125）: ${sortKeyDiff}`,
    );

    // 別名は言語非依存（英字のまま）
    const gb = countries.find((c) => (c[0] as string[])[0] === "GB");
    assert(gb, "GB が存在する");
    const gbAliases = (gb![0] as unknown[])[3] as string[];
    assert(
      Array.isArray(gbAliases) && gbAliases.includes("uk"),
      `別名は hl=ja でも英字のまま: ${JSON.stringify(gbAliases)}`,
    );

    console.log(
      `[DqDTgb args=ja urlHl=en-US] utf8=${new TextEncoder().encode(r.body).length}B ` +
        `countries=${countries.length} ja=${jaCount} sortKeyDiff=${sortKeyDiff} ` +
        `currentGeo=${JSON.stringify(currentGeo)}`,
    );
  },
});

// =====================================================================================
// テスト 8: sortKey 正規化規則のオフライン自己テスト（ネットワーク不使用）
//   HAR entry322 (hl=ja) の 国 125/125・下位地域 1013/1013、および hl=en-US のライブ 125/125 に
//   対して全数検査で成立を確認済み。ここではその代表例を固定値として残す。
// =====================================================================================
Deno.test({
  name: "sortKey 規則: NFD → 結合マーク除去 → NFC → 小文字化",
  fn: () => {
    const cases: Array<[string, string]> = [
      // hl=ja（HAR entry322 実測）
      ["アイルランド", "アイルラント"],
      ["アゼルバイジャン", "アセルハイシャン"],
      ["日本", "日本"], // 濁点が無ければ不変
      ["アメリカ合衆国", "アメリカ合衆国"],
      // hl=en-US（ライブ 2026-09-09 実測）
      ["Albania", "albania"],
      ["Türkiye", "turkiye"],
      ["Côte d’Ivoire", "cote d’ivoire"], // アポストロフィ U+2019 は保持される
      // 下位地域（HAR entry322 実測: AE-RK）
      ["Ras al Khaimah", "ras al khaimah"],
    ];
    for (const [input, expected] of cases) {
      assertEquals(normalizeSortKey(input), expected, `normalizeSortKey(${input})`);
    }
    // 「単なる toLowerCase では不十分」であることを明示する
    assert(
      "Türkiye".toLowerCase() !== "turkiye",
      "toLowerCase だけでは Türkiye → turkiye にならない（結合マーク除去が必須）",
    );
  },
});
