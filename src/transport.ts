/**
 * HTTP の唯一の出口。レスポンス分類とリトライ方針を持つ。
 *
 * ## 設計上の急所
 *
 * - **`res.ok` は使えない。** Google Trends はエラーを `text/html` の 200 で返すことがあり、
 *   成功条件は `status === 200 && content-type が application/json` である。
 * - **`redirect: "manual"` を強制する。** 既定の `follow` だと `/sorry` の CAPTCHA ページを
 *   status 200 として掴んでしまい `res.ok === true` になる。
 *   Deno の `manual` はブラウザと違い basic レスポンスを返すので、
 *   `status` も `Location` も `Set-Cookie` もそのまま読める。
 * - **`Retry-After` はどのエラーにも付かない。** 待ち時間は完全に自前で決める。
 * - エラーページの判定は `<title>Error (\d{3})` の**数値だけ**を見る。
 *   理由文字列は `accept-language` でローカライズされるうえ、
 *   **401 なのに理由が `Bad Request` になる**実例がある。
 *
 * @module
 */

import type { DoFetch, RateLimitKind, Sleep, TrendsOutcome } from "./types.ts";

/** Google の abuse インタースティシャル。ここに飛んだら IP 単位のブロック。 */
const SORRY_PREFIX = "https://www.google.com/sorry/";

/** 既定の User-Agent。省略しても動くが、付けた方が `Set-Cookie` の属性が安定する。 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/**
 * レスポンスを分類する。**ボディを読む前に呼べる** (ストリームを消費しない)。
 *
 * @param status HTTP ステータス
 * @param contentType `content-type` ヘッダ
 * @param location `Location` ヘッダ (3xx のとき)
 * @param finalUrl `res.url`。`redirect: "follow"` で `/sorry` に着地した場合の保険
 */
export function classifyResponse(
  status: number,
  contentType: string | null,
  location: string | null,
  finalUrl?: string,
): TrendsOutcome {
  // follow で着地したケースを最初に潰す。
  if (finalUrl !== undefined && finalUrl.startsWith(SORRY_PREFIX)) return "blocked";
  if (status === 429) return "rate-limited";
  if (status >= 300 && status < 400) {
    return location !== null && location.startsWith(SORRY_PREFIX) ? "blocked" : "redirect";
  }
  // 403 は本調査で一度も観測していないが、未知としてリトライループに落ちるより安全側に倒す。
  if (status === 400 || status === 401 || status === 403) return "bad-request";
  if (status === 404) return "not-found";
  if (status >= 500) return "server-error";
  if (status === 200) {
    const ct = (contentType ?? "").toLowerCase();
    if (ct.startsWith("application/json")) return "ok-json";
    if (ct.startsWith("text/html")) return "html-error";
  }
  return "unknown";
}

/**
 * Google の定型エラーページから HTTP コードを取り出す。
 *
 * 理由文字列はローカライズされるので**数値だけ**を見る
 * (404 は `accept-language: ja` で「見つかりませんでした」になる)。
 * 半角括弧と全角括弧の両方に対応する。
 */
export function parseGoogleErrorPage(html: string): number | null {
  const m = html.match(/<title>Error (\d{3}) [(（]/);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/**
 * 429 の 2 種別を判定する。
 *
 * - **未 Cookie ゲート**は新しい NID を配るので、それを付けて即再試行すれば 200 になる。
 * - **レート制限**は何も配らない (または既存と同一) ため、時間経過を待つしかない。
 *   新品の NID を取り直しても回復しないことを実測で確認済み (IP スコープ)。
 *
 * @param setCookies レスポンスの `Set-Cookie` 行 (`Headers.getSetCookie()` の結果)
 * @param currentNid 直前まで使っていた NID (`NID=` を含まない値部分)
 */
export function classifyRateLimit(
  setCookies: readonly string[],
  currentNid: string | null,
): RateLimitKind {
  const offered = extractNid(setCookies);
  if (offered === null) return "rate-limit";
  if (currentNid !== null && offered === currentNid) return "rate-limit";
  return "cookie-gate";
}

/**
 * `Set-Cookie` 行から NID の値を取り出す。
 *
 * **必ず `Headers.getSetCookie()` を使うこと。** `headers.get("set-cookie")` は
 * 複数の Set-Cookie をカンマで結合してしまい壊れる。
 *
 * NID の値は不透明で 2 系統 (211 文字前後と 316 文字前後) が混在するため、
 * **長さや書式の検証は書かない。**
 */
export function extractNid(setCookies: readonly string[]): string | null {
  for (const line of setCookies) {
    const m = line.match(/^\s*NID=([^;]+)/);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

/** {@link retryPlan} の結果。 */
export interface RetryPlan {
  retry: boolean;
  delayMs: number;
  /** 再試行前に NID を取り直すべきか。 */
  refreshNid: boolean;
}

/**
 * リトライ方針を決める。
 *
 * - `rate-limited` … 指数バックオフ (2s → 4s → 8s)。NID も取り直す。
 * - `server-error` … 短いバックオフ (1s → 2s → 4s)。
 * - **それ以外は全てリトライしない。** とくに `blocked` (302 `/sorry`) を叩き続けると
 *   ブロックが長期化する。
 *
 * @param outcome {@link classifyResponse} の結果
 * @param attempt 0 始まりの試行回数
 * @param maxAttempts 最大試行回数
 * @param jitter 0〜1 の乱数。テストで固定できるように引数化してある
 */
export function retryPlan(
  outcome: TrendsOutcome,
  attempt: number,
  maxAttempts: number = 3,
  jitter: number = 0.5,
): RetryPlan {
  if (attempt + 1 >= maxAttempts) return { retry: false, delayMs: 0, refreshNid: false };
  // jitter を ±25% に写す。
  const factor = 0.75 + jitter * 0.5;
  if (outcome === "rate-limited") {
    return { retry: true, delayMs: Math.round(2000 * 2 ** attempt * factor), refreshNid: true };
  }
  if (outcome === "server-error") {
    return { retry: true, delayMs: Math.round(1000 * 2 ** attempt * factor), refreshNid: false };
  }
  return { retry: false, delayMs: 0, refreshNid: false };
}

/** {@link fetchWithRecovery} の 1 回の試行の記録。 */
export interface RecoveryAttempt {
  status: number;
  outcome: TrendsOutcome;
  /** この応答が配った NID。配らなければ `null`。 */
  nid: string | null;
  /** 429 のとき、その種別。 */
  rateLimitKind: RateLimitKind | null;
  waitedMs: number;
}

/** {@link fetchWithRecovery} の結果。 */
export interface RecoveryResult {
  response: Response;
  attempts: RecoveryAttempt[];
  /** 最終的に保持している NID。 */
  nid: string | null;
  outcome: TrendsOutcome;
}

/** {@link fetchWithRecovery} のオプション。 */
export interface RecoveryOptions {
  nid?: string | null;
  maxAttempts?: number;
  headers?: Record<string, string>;
  /** HTTP の継ぎ目。テストではここを差し替える。 */
  doFetch: DoFetch;
  /** 待機関数。テストでは実時間を待たない実装を渡す。 */
  sleepFn?: Sleep;
  /** バックオフの jitter (0〜1)。テストで固定するために注入できる。 */
  jitter?: number;
}

const defaultSleep: Sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 「429 → `Set-Cookie` の NID を拾って再試行 → 200」の回復パターンを実装した fetch。
 *
 * 成功・失敗を問わず毎回 `Set-Cookie` から NID を拾い直す
 * (**429 / 400 / 401 でも NID は配られる**ため)。
 *
 * @throws {Error} `doFetch` が例外を投げた場合はそのまま伝播する
 */
export async function fetchWithRecovery(
  url: string,
  opts: RecoveryOptions,
): Promise<RecoveryResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  let nid = opts.nid ?? null;
  const attempts: RecoveryAttempt[] = [];

  for (let attempt = 0;; attempt++) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (nid !== null) headers.cookie = `NID=${nid}`;
    // redirect: "manual" は必須。follow だと /sorry を 200 として掴む。
    const res = await opts.doFetch(url, { redirect: "manual", headers });

    const outcome = classifyResponse(
      res.status,
      res.headers.get("content-type"),
      res.headers.get("location"),
      res.url === "" ? undefined : res.url,
    );
    const setCookies = res.headers.getSetCookie();
    const fresh = extractNid(setCookies);
    const rateLimitKind = outcome === "rate-limited" ? classifyRateLimit(setCookies, nid) : null;
    if (fresh !== null) nid = fresh;

    const plan = retryPlan(outcome, attempt, maxAttempts, opts.jitter ?? 0.5);
    if (!plan.retry) {
      attempts.push({ status: res.status, outcome, nid: fresh, rateLimitKind, waitedMs: 0 });
      return { response: res, attempts, nid, outcome };
    }
    attempts.push({
      status: res.status,
      outcome,
      nid: fresh,
      rateLimitKind,
      waitedMs: plan.delayMs,
    });
    // 再試行するので掴んだままのボディを解放する (Deno のリソースリーク対策)。
    await res.body?.cancel();
    await sleepFn(plan.delayMs);
  }
}

/**
 * 成功レスポンスかどうかを判定してボディを返す。
 *
 * 失敗時はボディを解放したうえで例外を投げる。
 *
 * @throws {TrendsHttpError} 成功でない場合
 */
export async function readJsonBody(result: RecoveryResult): Promise<string> {
  const { response, outcome } = result;
  if (outcome !== "ok-json") {
    const body = await response.text().catch(() => "");
    throw new TrendsHttpError(outcome, response.status, body);
  }
  return await response.text();
}

/** HTTP レイヤのエラー。 */
export class TrendsHttpError extends Error {
  /** 分類結果。呼び出し側はこれを見て挙動を分ける。 */
  readonly outcome: TrendsOutcome;
  readonly status: number;
  /** Google の定型エラーページから読み取ったコード。読めなければ `null`。 */
  readonly googleErrorCode: number | null;

  constructor(outcome: TrendsOutcome, status: number, body: string) {
    const code = parseGoogleErrorPage(body);
    super(
      `Google Trends の応答が ${outcome} でした (status=${status}` +
        (code !== null ? `, error page=${code}` : "") + ")",
    );
    this.name = "TrendsHttpError";
    this.outcome = outcome;
    this.status = status;
    this.googleErrorCode = code;
  }
}
