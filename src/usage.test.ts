// 集計ロジックのテスト。`npm test` で実行する。
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { type Rate, mergeRates, monthKeyOf, normalizeModel } from "./usage";

const rates: Record<string, Rate> = {
  "sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
};

test("normalizeModel strips provider, bracket tag, revision and date; never rounds a point release", () => {
  assert.equal(normalizeModel("claude-sonnet-5-5", rates), "sonnet-5-5");
  assert.equal(normalizeModel("jp.anthropic.claude-sonnet-5-5", rates), "sonnet-5-5");
  assert.equal(normalizeModel("claude-sonnet-5-5[1m]", rates), "sonnet-5-5");
  assert.equal(normalizeModel("anthropic.claude-opus-5-v1:0", rates), "opus-5");
  // 点リリースは主版の単価に丸めない。
  assert.equal(normalizeModel("claude-opus-5-5", rates), null);
  assert.equal(normalizeModel("claude-haiku-5-5", rates), null);
});

test("monthKeyOf uses the configured time zone at the month boundary", () => {
  // 2026-10-31T16:00:00Z は JST では 11 月 1 日 01:00。
  assert.equal(monthKeyOf("2026-10-31T16:00:00Z", "Asia/Tokyo"), "2026-11");
  assert.equal(monthKeyOf("2026-10-31T16:00:00Z", "UTC"), "2026-10");
  assert.equal(monthKeyOf("not a date", "Asia/Tokyo"), null);
});

test("Given bundled and workspace rate tables When mergeRates Then the workspace row wins and missing models are filled from bundled", () => {
  const workspace = { rates: { "sonnet-5-5": rates["opus-5"] } };
  const merged = mergeRates({ rates: { "sonnet-5-5": rates["sonnet-5-5"], "haiku-5-5": rates["opus-5"] } }, workspace);
  assert.equal(merged.rates?.["sonnet-5-5"], rates["opus-5"]);
  assert.equal(merged.rates?.["haiku-5-5"], rates["opus-5"]);
});
