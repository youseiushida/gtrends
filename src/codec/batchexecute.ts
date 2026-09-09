/**
 * boq RPC (`/_/TrendsUi/data/batchexecute`) のワイヤフォーマット。
 *
 * ## 封筒の形 (`rt=c` のとき)
 *
 * ```text
 * )]}'\n\n          <- プレフィックス (LF が 2 個)
 * 20740\n           <- 長さ行。★UTF-16 コードユニット数
 * [[...]]\n         <- チャンク JSON。長さは (長さ行の値 - 2)
 * 43\n[[...]]\n     <- 以降くり返し
 * 26\n[["e",4,null,null,25092]]\n   <- 終端。25092 は本文全体の UTF-8 バイト長
 * ```
 *
 * ## 実装上の急所
 *
 * - **長さ行は UTF-16 コードユニット数であってバイト長ではない。**
 *   実測反例: `DqDTgb` の長さ行 50055 に対し UTF-16 は 50053、UTF-8 は 86617。
 *   保存済み 21 ボディ中 13 で UTF-8 解釈が破綻する。
 *   日本語が返った瞬間に壊れるので、小さい応答だけ見て実装してはいけない。
 * - 長さ行の値は **前後の LF を含む**。したがって JSON 本体は `N - 2` 文字で、
 *   次の長さ行は `nl + N` から始まる。
 * - **終端チャンクの `T` だけは UTF-8 バイト長**で、同一レスポンス内で単位が混在する。
 * - `rt` を省略すると長さ行も終端チャンクも無い素の JSON 配列が返る。
 * - **`wrb.fr` の順序はリクエスト順と一致しない。** `rpcid` か `slotId` で突合すること。
 * - **HTTP 200 でも RPC 単位で失敗する。** `wrb.fr[2] === null` かつ `wrb.fr[5]` にエラーコード。
 *
 * @module
 */

import { XSSI_PREFIX_HEAD } from "./xssi.ts";

/** 1 つの RPC 呼び出し。 */
export interface RpcCall {
  /** `i0OFE` などの RPC 識別子。 */
  rpcid: string;
  /** 引数配列。`JSON.stringify` されて二段 JSON になる。 */
  args: unknown[];
  /**
   * 応答を突合するための任意の識別子。既定は `"generic"`。
   * 同じ rpcid を 1 バッチで複数回呼ぶなら必ず別々の値を指定する。
   */
  slot?: string;
}

/** 1 つの RPC の実行結果。 */
export interface RpcResult {
  rpcid: string;
  /** リクエストの `slot` がそのままエコーされる。 */
  slot: string;
  /** ペイロード。**RPC が失敗した場合は `null`。** */
  data: unknown;
  /** エラーコード配列。**成功時は `null`。** */
  error: unknown;
}

/** 封筒のパース結果。 */
export interface BatchEnvelope {
  /** 平坦化された全アイテム。 */
  items: unknown[][];
  /** `wrb.fr` アイテムを構造化したもの。 */
  results: RpcResult[];
  /** `er` アイテム。リクエスト全体が失敗したときのみ入る。 */
  requestErrors: unknown[][];
  /** `er[5]` の HTTP ステータス。`er` が無ければ `null`。 */
  transportError: number | null;
  /** 終端チャンクの値 (本文全体の UTF-8 バイト長)。`rt` 省略時は `null`。 */
  totalByteLength: number | null;
  /** `rt=c` のチャンク形式なら `true`、`rt` 省略の素形式なら `false`。 */
  chunked: boolean;
}

/** batchexecute のエンドポイント URL。 */
export const BATCH_EXECUTE_URL = "https://trends.google.com/_/TrendsUi/data/batchexecute";

/**
 * `f.req` のリクエストボディを組み立てる。
 *
 * @param calls 呼び出す RPC の一覧
 * @returns `application/x-www-form-urlencoded` のボディ文字列
 */
export function buildBatchExecuteBody(calls: RpcCall[]): string {
  const fReq = [
    calls.map((c) => [c.rpcid, JSON.stringify(c.args), null, c.slot ?? "generic"]),
  ];
  return "f.req=" + encodeURIComponent(JSON.stringify(fReq)) + "&";
}

/** {@link buildBatchExecuteUrl} のオプション。 */
export interface BatchExecuteUrlOptions {
  /** `"c"` でチャンク形式 (既定)。`null` で `rt` を省略し素の JSON 配列を得る。 */
  rt?: "c" | null;
  /** UI 言語。 */
  hl?: string;
  /** SPA の現在ルート。省略可。 */
  sourcePath?: string;
  /**
   * `WIZ_global_data.FdrFJe`。**必ず文字列で扱うこと** (符号付き 64bit で `Number()` が壊れる)。
   * 実測では省略しても 200 が返る。
   */
  fSid?: string;
  /** `WIZ_global_data.cfb2h` (ビルドラベル)。実測では省略しても 200。 */
  bl?: string;
  /** 単なるキャッシュバスター。 */
  reqid?: number;
}

/**
 * batchexecute の URL を組み立てる。
 *
 * **URL クエリは実測上すべて省略可能。** `rpcids` すらサーバは実ディスパッチに使わず、
 * ボディの `f.req` の中身だけを見る。ブラウザ互換にしたい場合のみ指定する。
 */
export function buildBatchExecuteUrl(
  calls: RpcCall[],
  opts: BatchExecuteUrlOptions = {},
): string {
  const q = new URLSearchParams();
  if (calls.length > 0) q.set("rpcids", calls.map((c) => c.rpcid).join(","));
  if (opts.sourcePath !== undefined) q.set("source-path", opts.sourcePath);
  if (opts.fSid !== undefined) q.set("f.sid", opts.fSid);
  if (opts.bl !== undefined) q.set("bl", opts.bl);
  if (opts.hl !== undefined) q.set("hl", opts.hl);
  if (opts.reqid !== undefined) q.set("_reqid", String(opts.reqid));
  if (opts.rt !== null) q.set("rt", opts.rt ?? "c");
  const qs = q.toString();
  return qs ? `${BATCH_EXECUTE_URL}?${qs}` : BATCH_EXECUTE_URL;
}

/** batchexecute に必須の唯一のヘッダ。これが無いと 400 になる。 */
export function batchExecuteHeaders(): Record<string, string> {
  return { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" };
}

/**
 * 封筒をパースする。
 *
 * @param text レスポンス本文 (`res.text()` の結果をそのまま渡す)
 * @returns パース結果
 * @throws {Error} プレフィックスが無い、または長さ行が本文と整合しない場合
 */
export function parseBatchExecute(text: string): BatchEnvelope {
  if (!text.startsWith(XSSI_PREFIX_HEAD)) {
    throw new Error(
      `batchexecute の応答ではありません (先頭 ${JSON.stringify(text.slice(0, 40))})`,
    );
  }

  const items: unknown[][] = [];
  let pos = text.indexOf("\n") + 1;
  if (text[pos] === "\n") pos++; // rt=c のときに入る空行

  // 添字で空白を飛ばす。text.slice(pos).trim() は O(n^2) になり 68KB の応答で顕在化する。
  const skipWs = (i: number): number => {
    while (i < text.length && (text[i] === "\n" || text[i] === "\r" || text[i] === " ")) i++;
    return i;
  };

  let chunked = true;
  let totalByteLength: number | null = null;

  pos = skipWs(pos);
  if (text[pos] === "[") {
    // rt 省略形式: 長さ行が無く、残り全部が 1 チャンク。
    chunked = false;
    const parsed = JSON.parse(text.slice(pos)) as unknown[][];
    items.push(...parsed);
  } else {
    while (pos < text.length) {
      pos = skipWs(pos);
      if (pos >= text.length) break;
      const nl = text.indexOf("\n", pos);
      if (nl < 0) break;
      const head = text.slice(pos, nl);
      if (!/^\d+$/.test(head)) break;
      const n = Number(head);

      // 長さ行の値は前後の LF を含む。ずれていたら単位を取り違えている。
      const segment = text.slice(nl, nl + n);
      if (
        nl + n > text.length || segment[0] !== "\n" ||
        segment[segment.length - 1] !== "\n"
      ) {
        throw new Error(
          `長さ行 ${n} が本文と整合しません。長さ行は UTF-16 コードユニット数です ` +
            `(バイト長やコードポイント長で読んでいませんか)`,
        );
      }
      const chunk = JSON.parse(text.slice(nl + 1, nl + n - 1)) as unknown[][];
      items.push(...chunk);
      pos = nl + n;
    }
  }

  const results: RpcResult[] = [];
  const requestErrors: unknown[][] = [];
  for (const it of items) {
    if (it[0] === "wrb.fr") {
      const payload = it[2];
      results.push({
        rpcid: it[1] as string,
        slot: (it[6] ?? "generic") as string,
        data: typeof payload === "string" ? JSON.parse(payload) : null,
        error: it[5] ?? null,
      });
    } else if (it[0] === "er") {
      requestErrors.push(it);
    } else if (it[0] === "e") {
      totalByteLength = (it[4] as number) ?? null;
    }
    // "di" と "af.httprm" は診断用なので無視する。
  }

  const firstError = requestErrors[0];
  const transportError = firstError && typeof firstError[5] === "number" ? firstError[5] : null;

  return { items, results, requestErrors, transportError, totalByteLength, chunked };
}

/**
 * 封筒を再シリアライズする (ラウンドトリップ検証用)。
 *
 * 長さ行は `JSON.stringify(chunk).length + 2` で計算する。
 */
export function serializeBatchExecute(chunks: unknown[][][]): string {
  let out = ")]}'\n\n";
  for (const chunk of chunks) {
    const json = JSON.stringify(chunk);
    out += `${json.length + 2}\n${json}\n`;
  }
  return out;
}

/**
 * HTML の `WIZ_global_data` から値を取り出す。DOM パーサは不要。
 *
 * @param html `/trending` などの HTML
 * @param key `FdrFJe` (= `f.sid`) や `cfb2h` (= `bl`) といったキー
 * @returns 値。見つからなければ `null`
 */
export function extractWizString(html: string, key: string): string | null {
  // テンプレートリテラル内なのでバックスラッシュは二重にする。
  // 実際のパターン: "KEY"\s*:\s*"((?:[^"\\]|\\.)*)"
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = html.match(re);
  if (!m || m[1] === undefined) return null;
  return JSON.parse(`"${m[1]}"`) as string;
}

/**
 * HTML から `f.sid` を取り出す。
 *
 * **必ず文字列のまま扱うこと。** 符号付き 64bit の文字列で負値も出るため、
 * `Number()` を通すと 2^53 を超えて精度が壊れる。
 */
export function extractFSid(html: string): string | null {
  return extractWizString(html, "FdrFJe");
}

/** HTML からビルドラベル `bl` を取り出す。**ハードコードしないこと。** */
export function extractBl(html: string): string | null {
  return extractWizString(html, "cfb2h");
}
