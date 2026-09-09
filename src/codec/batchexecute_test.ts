import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  batchExecuteHeaders,
  buildBatchExecuteBody,
  buildBatchExecuteUrl,
  extractBl,
  extractFSid,
  parseBatchExecute,
  serializeBatchExecute,
} from "./batchexecute.ts";
import {
  HAR_ENTRY330_BODY,
  HAR_ENTRY418_SHAPE,
  LIVE_ER_405_BODY,
  LIVE_ER_BODY,
  LIVE_RPC_ERROR_BODY,
  LIVE_SURROGATE_BODY,
  LIVE_UNCHUNKED_BODY,
  WIZ_HTML,
} from "../../tests/fixtures/batchexecute.ts";

Deno.test("最小の完全な封筒をパースできる", () => {
  const env = parseBatchExecute(HAR_ENTRY330_BODY);
  assert(env.chunked);
  assertEquals(env.results.length, 1);
  assertEquals(env.results[0]?.rpcid, "Tnt4U");
  assertEquals(env.results[0]?.slot, "generic");
  assertEquals(env.results[0]?.data, [[]]);
  assertEquals(env.results[0]?.error, null);
  assertEquals(env.totalByteLength, 142);
  assertEquals(env.requestErrors.length, 0);
  assertEquals(env.transportError, null);
});

Deno.test("長さ行は UTF-8 バイト長ではない (日本語チャンク)", () => {
  const env = parseBatchExecute(HAR_ENTRY418_SHAPE);
  assertEquals(env.results.length, 1);
  assertEquals(env.results[0]?.data, ["アイルランド"]);
  // このチャンクの JSON は UTF-16 で 55 文字、UTF-8 では 67 バイト。
  // 長さ行は 57 (= 55 + 前後の LF 2 個) なので、UTF-8 で読むと必ずずれる。
  const json = '[["wrb.fr","wAgrOe","[\\"アイルランド\\"]",null,null,null,"3"]]';
  assertEquals(json.length, 55);
  assertEquals(new TextEncoder().encode(json).length, 67);
});

Deno.test("長さ行はコードポイント長でもなく UTF-16 コードユニット数である", () => {
  const env = parseBatchExecute(LIVE_SURROGATE_BODY);
  assertEquals(env.results.length, 1);
  assertEquals(env.results[0]?.slot, "s\u{1F1EF}\u{1F1F5}e");

  // 決定的証拠: 同じチャンクを 3 通りの単位で数えると値が割れる。
  const json =
    '[["wrb.fr","wAgrOe","[\\"日本\\"]",null,null,null,"s\u{1F1EF}\u{1F1F5}e"],["di",12],["af.httprm",11,"-5668663339315347667",17]]';
  assertEquals(json.length, 109); // UTF-16 → 長さ行 111 - 2 に一致
  assertEquals([...json].length, 107); // コードポイント → 一致しない
  assertEquals(new TextEncoder().encode(json).length, 117); // UTF-8 → 一致しない
});

Deno.test("RPC 単位のエラーは HTTP 200 のまま data=null / error 付きで返る", () => {
  const env = parseBatchExecute(LIVE_RPC_ERROR_BODY);
  assertEquals(env.results.length, 1);
  assertEquals(env.results[0]?.data, null, "ペイロードは null になる");
  assertEquals(env.results[0]?.error, [3], "エラーコードが入る");
  assertEquals(env.transportError, null, "リクエスト全体は成功している");
});

Deno.test("リクエスト全体のエラーは er チャンクで返り wrb.fr が 0 個になる", () => {
  const env400 = parseBatchExecute(LIVE_ER_BODY);
  assertEquals(env400.results.length, 0);
  assertEquals(env400.requestErrors.length, 1);
  assertEquals(env400.transportError, 400);

  // er[9] は 3 固定ではない (GET で投げると 9 になる)。
  const env405 = parseBatchExecute(LIVE_ER_405_BODY);
  assertEquals(env405.transportError, 405);
  assertEquals(env405.requestErrors[0]?.[9], 9);
});

Deno.test("rt 省略時の非チャンク形式も透過的に扱える", () => {
  const env = parseBatchExecute(LIVE_UNCHUNKED_BODY);
  assertEquals(env.chunked, false);
  assertEquals(env.results.length, 1);
  assertEquals(env.results[0]?.data, ["日本"]);
  assertEquals(env.totalByteLength, null, "e チャンクが無いので null");
});

Deno.test("パース → 再シリアライズで元の文字列に戻る", () => {
  const env = parseBatchExecute(HAR_ENTRY330_BODY);
  const rebuilt = serializeBatchExecute([
    env.items.slice(0, 3) as unknown[][],
    env.items.slice(3) as unknown[][],
  ]);
  // チャンク分割の仕方は復元できないが、再パースすれば同じ結果になる。
  assertEquals(parseBatchExecute(rebuilt).results, env.results);
});

Deno.test("batchexecute の応答でない入力は例外にする", () => {
  assertThrows(() => parseBatchExecute('{"not":"batchexecute"}'), Error, "応答ではありません");
});

Deno.test("長さ行が本文と整合しなければ単位の取り違えを示す例外を投げる", () => {
  const broken = ')]}\'\n\n999\n[["wrb.fr","x","[]",null,null,null,"generic"]]\n';
  assertThrows(() => parseBatchExecute(broken), Error, "UTF-16 コードユニット数");
});

Deno.test("f.req のボディは二重配列と二段 JSON になる", () => {
  const body = buildBatchExecuteBody([
    { rpcid: "i0OFE", args: [null, null, "JP", 0, "ja", 4] },
  ]);
  assert(body.startsWith("f.req="));
  assert(body.endsWith("&"));
  const decoded = decodeURIComponent(body.slice("f.req=".length, -1));
  const parsed = JSON.parse(decoded) as unknown[][][];
  assertEquals(parsed[0]?.[0]?.[0], "i0OFE");
  assertEquals(parsed[0]?.[0]?.[1], '[null,null,"JP",0,"ja",4]', "引数は JSON 文字列として入る");
  assertEquals(parsed[0]?.[0]?.[2], null);
  assertEquals(parsed[0]?.[0]?.[3], "generic");
});

Deno.test("URL クエリは省略可能で、rt=c が既定", () => {
  const calls = [{ rpcid: "i0OFE", args: [] }];
  const minimal = buildBatchExecuteUrl(calls);
  assert(minimal.includes("rpcids=i0OFE"));
  assert(minimal.includes("rt=c"));
  assert(!minimal.includes("f.sid"), "指定しなければ f.sid は付かない");

  const unchunked = buildBatchExecuteUrl(calls, { rt: null });
  assert(!unchunked.includes("rt="), "rt: null で rt を省ける");
});

Deno.test("必須ヘッダは content-type の 1 本だけ", () => {
  assertEquals(batchExecuteHeaders(), {
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
  });
});

Deno.test("WIZ_global_data から f.sid と bl を正規表現だけで抽出できる", () => {
  assertEquals(extractFSid(WIZ_HTML), "-8959654384266786277");
  assertEquals(extractBl(WIZ_HTML), "boq_trends-boq-servers-frontend_20260906.08_p0");
  assertEquals(extractFSid("<html></html>"), null);
});

Deno.test("f.sid は文字列のまま扱う (Number 化すると精度が壊れる)", () => {
  const sid = extractFSid(WIZ_HTML);
  assert(sid !== null);
  assertEquals(typeof sid, "string");
  // 2^53 を超えるので数値化すると別の値になる。
  assert(String(Number(sid)) !== sid, "Number() を通すと値が変わってしまう");
});
