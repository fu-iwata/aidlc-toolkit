// 設定の単価の読み取りと上乗せのテスト。`npm test` で実行する。
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { applyFactor, premiumFactor, readUserRates } from "./rates";

const row = { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 };

test("Given the premium is on When premiumFactor and applyFactor Then every rate is multiplied", () => {
  const factor = premiumFactor({ enabled: true, rate: 0.1 });
  assert.equal(factor, 1.1);
  const applied = applyFactor({ "opus-5-5": row }, factor)["opus-5-5"];
  assert.ok(Math.abs(applied.output - 22) < 1e-9);
  assert.ok(Math.abs(applied.cacheRead - 0.22) < 1e-9);
});

test("Given the premium is off or missing When premiumFactor Then the standard rates are used", () => {
  assert.equal(premiumFactor({ enabled: false, rate: 0.1 }), 1);
  assert.equal(premiumFactor(undefined), 1);
  const rates = { "opus-5-5": row };
  assert.equal(applyFactor(rates, 1), rates);
});

test("Given valid rows in the setting When readUserRates Then they are used as rates", () => {
  const result = readUserRates({ "opus-5-5": { ...row, note: "dropped" } });
  assert.deepEqual(result, { rates: { "opus-5-5": row }, invalid: [] });
});

test("Given bad rows in the setting When readUserRates Then only the good rows are used and the bad keys are reported", () => {
  const result = readUserRates({
    "opus-5-5": row,
    "Claude-Opus-5": row,
    "sonnet-5-5": { ...row, output: -1 },
    "haiku-5-5": { input: 1 },
    "opus-5": "4",
  });
  assert.deepEqual(result.rates, { "opus-5-5": row });
  assert.deepEqual(result.invalid, ["Claude-Opus-5", "sonnet-5-5", "haiku-5-5", "opus-5"]);
});

test("Given the setting is missing or not an object When readUserRates Then nothing is used", () => {
  for (const value of [undefined, null, [], "x"]) assert.deepEqual(readUserRates(value), { rates: {}, invalid: [] });
});
