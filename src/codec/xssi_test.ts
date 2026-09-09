import { assertEquals, assertThrows } from "@std/assert";
import { parseXssiJson, stripXssiPrefix } from "./xssi.ts";

Deno.test("explore 系の 5 バイトプレフィックスを剥がせる", () => {
  assertEquals(stripXssiPrefix(')]}\'\n{"a":1}'), '{"a":1}');
});

Deno.test("widgetdata 系の 6 バイトプレフィックス (カンマ有り) を剥がせる", () => {
  // ★ここが既存実装の 3 つが壊れていた箇所。
  //   /^\)\]\}'\n?/ や \s* で剥がすと先頭に "," が残り JSON.parse が落ちる。
  assertEquals(stripXssiPrefix(')]}\',\n{"a":1}'), '{"a":1}');
});

Deno.test("batchexecute の LF 2 個プレフィックスでも 1 個目までしか消さない", () => {
  // batchexecute の本体は空行の後ろから始まるので、
  // ここで 2 個目の LF を消してしまうとチャンク走査の起点がずれる。
  assertEquals(stripXssiPrefix(")]}'\n\n106\n[[]]"), "\n106\n[[]]");
});

Deno.test("バイト数を決め打ちしないので両系統を同じ関数で扱える", () => {
  const explore = ")]}'\n" + JSON.stringify({ widgets: [] });
  const widgetdata = ")]}',\n" + JSON.stringify({ default: { timelineData: [] } });
  assertEquals(parseXssiJson<{ widgets: unknown[] }>(explore).widgets, []);
  assertEquals(
    parseXssiJson<{ default: { timelineData: unknown[] } }>(widgetdata).default.timelineData,
    [],
  );
});

Deno.test("プレフィックスが無ければ入力をそのまま返す", () => {
  // HTML のエラーページをここで壊さないための性質。
  const html = "<html><title>Error 429 (Too Many Requests)!!1</title></html>";
  assertEquals(stripXssiPrefix(html), html);
});

Deno.test("改行が無い壊れた応答でも先頭にカンマを残さない", () => {
  assertEquals(stripXssiPrefix(')]}\',{"a":1}'), '{"a":1}');
  assertEquals(stripXssiPrefix(")]}'"), "");
});

Deno.test("JSON でない本文は SyntaxError になる", () => {
  assertThrows(() => parseXssiJson("<html>not json</html>"), SyntaxError);
});
