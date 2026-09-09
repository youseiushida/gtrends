/**
 * NID Cookie のライフサイクルと、リクエストのペース制御。
 *
 * ## NID について
 *
 * - 必要な Cookie は **`NID` 1 つだけ**。`OTZ` / `_ga*` / `__utm*` はサーバが見ていない。
 * - **値はサーバ側で本当に検証されている。** デタラメな値では 429 のまま通らない。
 * - 取得経路は 2 つあり、**`/trending` は 200 で配ってくれるので穏当**。
 *   `/trends/explore` は 429 を返しつつ配る (これも正常な挙動)。
 * - **`/trends/api/autocomplete/<kw>` は 200 で NID を配る**ので、
 *   「エンティティ解決 + NID 取得」を 1 発で済ませられる。
 *
 * ## ペース制御
 *
 * サーバのリミッタは**容量 90〜100 件のトークンバケット**として振る舞い、
 * 補充速度は 60/分 と 120/分 の間。実測では 60/分 で 435 件を 7 分以上流しても枯れず、
 * 120/分 では約 45 秒 (≒90 件) で枯れた。
 *
 * したがって既定は **60 件/分・同時実行 1** に固定する。
 * 効くのはリクエスト間隔よりも**並列度**なので、直列化が最重要。
 *
 * @module
 */

import {
  DEFAULT_USER_AGENT,
  extractNid,
  fetchWithRecovery,
  type RecoveryResult,
  TrendsHttpError,
} from "./transport.ts";
import type { DoFetch, Sleep } from "./types.ts";

/** Trends のオリジン。 */
export const ORIGIN = "https://trends.google.com";

/** 既定のリクエスト間隔 (ミリ秒)。60 件/分。 */
export const DEFAULT_MIN_INTERVAL_MS = 1000;

/** {@link Session} のオプション。 */
export interface SessionOptions {
  /** HTTP の継ぎ目。既定は `globalThis.fetch`。 */
  doFetch?: DoFetch;
  /** 待機関数。既定は `setTimeout`。 */
  sleepFn?: Sleep;
  /** 現在時刻を返す関数。テストで固定できるように注入可能。 */
  now?: () => number;
  /** リクエストの最小間隔 (ミリ秒)。既定 1000 (= 60 件/分)。 */
  minIntervalMs?: number;
  /** 送信する User-Agent。`null` を渡すと送らない。 */
  userAgent?: string | null;
  /** 既に持っている NID があれば渡す (プロセス外に永続化して使い回せる)。 */
  nid?: string | null;
  /** 429 のときの最大試行回数。 */
  maxAttempts?: number;
}

/**
 * NID の保持とペース制御を担うセッション。
 *
 * **同時実行は 1 に直列化される。** 並列に呼んでも内部でキューイングされる。
 */
export class Session {
  #doFetch: DoFetch;
  #sleepFn: Sleep;
  #now: () => number;
  #minIntervalMs: number;
  #userAgent: string | null;
  #nid: string | null;
  #maxAttempts: number;
  /** 直列化のためのキュー。 */
  #chain: Promise<unknown> = Promise.resolve();
  #lastRequestAt = 0;

  constructor(options: SessionOptions = {}) {
    this.#doFetch = options.doFetch ?? globalThis.fetch.bind(globalThis);
    this.#sleepFn = options.sleepFn ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.#now = options.now ?? (() => Date.now());
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#userAgent = options.userAgent === undefined ? DEFAULT_USER_AGENT : options.userAgent;
    this.#nid = options.nid ?? null;
    this.#maxAttempts = options.maxAttempts ?? 3;
  }

  /** 現在保持している NID。永続化して次回の {@link SessionOptions.nid} に渡せる。 */
  get nid(): string | null {
    return this.#nid;
  }

  /** 共通のリクエストヘッダを組み立てる。 */
  #headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) };
    if (this.#userAgent !== null) h["user-agent"] = this.#userAgent;
    return h;
  }

  /** 最小間隔を守るまで待つ。 */
  async #pace(): Promise<void> {
    const elapsed = this.#now() - this.#lastRequestAt;
    const wait = this.#minIntervalMs - elapsed;
    if (wait > 0) await this.#sleepFn(wait);
    this.#lastRequestAt = this.#now();
  }

  /** 直列に実行する。 */
  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task, task);
    // 失敗しても後続を止めない。
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * NID を付けてリクエストする。ペース制御と 429 回復を含む。
   *
   * @param url 絶対 URL
   * @param opts `withCookie: false` で Cookie を送らない
   *   (**pickers は Cookie を付けると 302 になる**ので必ず false にすること)
   */
  request(
    url: string,
    opts: { withCookie?: boolean; headers?: Record<string, string> } = {},
  ): Promise<RecoveryResult> {
    return this.#serialize(async () => {
      await this.#pace();
      const result = await fetchWithRecovery(url, {
        nid: opts.withCookie === false ? null : this.#nid,
        maxAttempts: this.#maxAttempts,
        headers: this.#headers(opts.headers),
        doFetch: this.#doFetch,
        sleepFn: this.#sleepFn,
      });
      // 応答が新しい NID を配っていれば取り込む。
      if (result.nid !== null) this.#nid = result.nid;
      return result;
    });
  }

  /**
   * NID を確保する。既に持っていれば何もしない。
   *
   * `/trending` (200 で配る) を先に試し、駄目なら `/trends/explore` (429 でも配る) を試す。
   *
   * @param force 既に持っていても取り直す
   * @returns 取得できた NID。取得できなければ `null`
   */
  async ensureNid(force = false): Promise<string | null> {
    if (this.#nid !== null && !force) return this.#nid;

    for (const url of [`${ORIGIN}/trending?geo=US&hl=en-US`, `${ORIGIN}/trends/explore?hl=en-US`]) {
      const result = await this.request(url, { withCookie: false });
      // HTML は使わないので必ず解放する (Deno のリソースリーク対策)。
      await result.response.body?.cancel();
      const fresh = extractNid(result.response.headers.getSetCookie());
      if (fresh !== null) {
        this.#nid = fresh;
        return fresh;
      }
      // 429 でも NID が付かないことがある。その場合は次の経路を試す。
    }
    return null;
  }

  /**
   * JSON を取得する。成功でなければ例外を投げる。
   *
   * @throws {TrendsHttpError} 200 + `application/json` でなかった場合
   */
  async getJson(
    url: string,
    opts: { withCookie?: boolean; headers?: Record<string, string> } = {},
  ): Promise<string> {
    const result = await this.request(url, opts);
    if (result.outcome !== "ok-json") {
      const body = await result.response.text().catch(() => "");
      throw new TrendsHttpError(result.outcome, result.response.status, body);
    }
    return await result.response.text();
  }

  /**
   * テキストを取得する (HTML / RSS 用)。
   *
   * @throws {TrendsHttpError} 200 でなかった場合
   */
  async getText(
    url: string,
    opts: { withCookie?: boolean; headers?: Record<string, string> } = {},
  ): Promise<string> {
    const result = await this.request(url, opts);
    if (result.response.status !== 200) {
      const body = await result.response.text().catch(() => "");
      throw new TrendsHttpError(result.outcome, result.response.status, body);
    }
    return await result.response.text();
  }

  /**
   * POST して JSON を取得する (batchexecute 用)。
   *
   * @throws {TrendsHttpError} 200 + `application/json` でなかった場合
   */
  postForm(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<string> {
    return this.#serialize(async () => {
      await this.#pace();
      const res = await this.#doFetch(url, {
        method: "POST",
        redirect: "manual",
        headers: this.#headers(headers),
        body,
      });
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      if (res.status !== 200 || !ct.startsWith("application/json")) {
        const text = await res.text().catch(() => "");
        throw new TrendsHttpError(
          res.status === 200 ? "html-error" : res.status === 429 ? "rate-limited" : "bad-request",
          res.status,
          text,
        );
      }
      return await res.text();
    });
  }
}
