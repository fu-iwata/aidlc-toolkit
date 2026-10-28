// intent の audit からの使用量の集計のテスト。`npm test` で実行する。
import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocateTotals,
  auditReadable,
  parseAuditUsage,
  parseCompactTokens,
  parseTokensByModel,
  summarizeAuditMonth,
  summarizeIntent,
} from "./intentUsage";
import type { Rate } from "./usage";

const rates: Record<string, Rate> = {
  "opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "haiku-5-5": { input: 0.11, output: 0.55, cacheWrite5m: 0.1375, cacheWrite1h: 0.22, cacheRead: 0.011 },
};

// audit の 1 件（engine が書く形）。
function section(event: string, stage: string, extra: string[], timestamp = "2026-10-20T00:00:00Z"): string {
  return [
    "",
    "## Stage Completion",
    `**Timestamp**: ${timestamp}`,
    `**Event**: ${event}`,
    `**Stage**: ${stage}`,
    "**Cost USD**: 999.00",
    ...extra,
    "",
  ].join("\n");
}

const audit = (...sections: string[]): string => sections.join("\n---\n");

test("Given compact token counts When parseCompactTokens Then k and M are expanded and junk is null", () => {
  assert.equal(parseCompactTokens("912"), 912);
  assert.equal(parseCompactTokens("59.6k"), 59600);
  assert.equal(parseCompactTokens("27.1M"), 27100000);
  assert.equal(parseCompactTokens("1.2G"), null);
  assert.equal(parseCompactTokens(""), null);
});

test("Given a Tokens By Model line When parseTokensByModel Then each model gets in/out/cacheRead/cacheWrite", () => {
  const models = parseTokensByModel("opus-5=244/59.6k/27.1M/524.6k; claude-haiku-5-5=1/2/3; bad=1/x/2/3");
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], {
    model: "opus-5",
    counts: { input: 244, output: 59600, cacheRead: 27100000, cacheCreate5m: 524600, cacheCreate1h: 0 },
  });
  // 古い 3 つ組は cache 書込を 0 とする。
  assert.equal(models[1].counts.cacheCreate5m, 0);
});

test("Given one model When parseAuditUsage Then the exact totals are used instead of the rounded values", () => {
  const [stage] = parseAuditUsage(
    audit(
      section("STAGE_COMPLETED", "a", [
        "**Tokens In**: 244",
        "**Tokens Out**: 59612",
        "**Cache Read**: 27123456",
        "**Cache Write**: 524611",
        "**Tokens By Model**: opus-5=244/59.6k/27.1M/524.6k",
      ]),
    ),
  );
  assert.deepEqual(stage.models, [
    { model: "opus-5", counts: { input: 244, output: 59612, cacheRead: 27123456, cacheCreate5m: 524611, cacheCreate1h: 0 } },
  ]);
});

test("Given several models When allocateTotals Then the exact total is split by the rounded ratio and still adds up", () => {
  const models = parseTokensByModel("opus-5=0/1k/0/0; haiku-5-5=0/2k/0/0");
  const out = allocateTotals(models, { input: 7, output: 3001, cacheRead: 0, cacheCreate5m: 0 });
  assert.equal(out[0].counts.output, 1000);
  assert.equal(out[1].counts.output, 2001);
  // 比率が出ない入力は、モデル不明として残す。
  assert.deepEqual(out[2], { model: "", counts: { input: 7, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 } });
});

test("Given the same stage completed twice When parseAuditUsage Then each row is the increase from the previous one", () => {
  const entries = parseAuditUsage(
    audit(
      section("STAGE_COMPLETED", "code-generation", ["**Tokens By Model**: opus-5=0/1k/0/0"]),
      section("STAGE_COMPLETED", "code-generation", ["**Tokens By Model**: opus-5=0/3k/0/0"]),
      section("WORKFLOW_COMPLETED", "code-generation", ["**Tokens By Model**: opus-5=0/100k/0/0"]),
      section("STAGE_STARTED", "build-and-test", ["**Tokens By Model**: opus-5=0/100k/0/0"]),
    ),
  );
  // 累計 1k → 3k なので、1k と 2k。足すと最後の累計 3k と同じ。
  assert.deepEqual(entries.map((e) => e.models[0].counts.output), [1000, 2000]);
});

test("Given a second completion that adds a model When parseAuditUsage Then the increase goes to the model that grew", () => {
  const entries = parseAuditUsage(
    audit(
      section("STAGE_COMPLETED", "a", ["**Tokens In**: 0", "**Tokens Out**: 1000", "**Cache Read**: 0", "**Cache Write**: 0", "**Tokens By Model**: opus-5=0/1k/0/0"]),
      section("STAGE_COMPLETED", "a", [
        "**Tokens In**: 0",
        "**Tokens Out**: 3000",
        "**Cache Read**: 0",
        "**Cache Write**: 0",
        "**Tokens By Model**: opus-5=0/1k/0/0; claude-haiku-5-5=0/2k/0/0",
      ]),
    ),
  );
  assert.deepEqual(
    entries[1].models.map((m) => [m.model, m.counts.output]),
    [["claude-haiku-5-5", 2000]],
  );
});

test("Given totals that went down When parseAuditUsage Then the ledger is treated as rebuilt and the row counts in full", () => {
  const entries = parseAuditUsage(
    audit(
      section("STAGE_COMPLETED", "a", ["**Tokens By Model**: opus-5=0/5k/0/0"]),
      section("STAGE_COMPLETED", "a", ["**Tokens By Model**: opus-5=0/2k/0/0"]),
    ),
  );
  assert.deepEqual(entries.map((e) => e.models[0].counts.output), [5000, 2000]);
});

test("Given a completed stage with totals only When parseAuditUsage Then it is counted as an unknown model", () => {
  const [stage] = parseAuditUsage(
    audit(section("STAGE_COMPLETED", "intent-capture", ["**Tokens In**: 10", "**Tokens Out**: 20", "**Cache Write**: 5"])),
  );
  assert.equal(stage.models[0].model, "");
  assert.equal(stage.models[0].counts.output, 20);
  assert.equal(stage.models[0].counts.cacheCreate5m, 5);
});

test("Given audit shards When summarizeIntent Then cost comes from tokens and rates, not Cost USD", () => {
  const usage = summarizeIntent(
    [
      audit(section("STAGE_COMPLETED", "a", ["**Tokens By Model**: opus-5=0/1M/0/0; claude-haiku-5-5=0/1M/0/0"])),
      // 別の clone の shard は足す。
      audit(section("STAGE_COMPLETED", "a", ["**Tokens By Model**: opus-5=0/1M/0/0; claude-sonnet-9=0/1M/0/0"])),
    ],
    rates,
  );
  assert.ok(usage);
  assert.equal(usage.stages, 2);
  // opus-5 の出力 2M × $25 + haiku-5-5 の出力 1M × $0.55。Cost USD の 999 は使わない。
  assert.equal(usage.usd, 50.55);
  assert.equal(usage.buckets[0].model, "opus-5");
  assert.equal(usage.buckets.find((b) => b.model === "haiku-5-5")?.usd, 0.55);
  assert.deepEqual(usage.unpricedModels, ["claude-sonnet-9"]);
});

test("Given completions in two months When summarizeAuditMonth Then only the increase made in the month counts", () => {
  const shard = audit(
    section("STAGE_COMPLETED", "a", ["**Tokens By Model**: opus-5=0/1M/0/0"], "2026-09-30T14:59:00Z"),
    // 日本時間では 10 月 1 日。
    section("STAGE_COMPLETED", "a", ["**Tokens By Model**: opus-5=0/3M/0/0"], "2026-09-30T15:00:00Z"),
    section("STAGE_COMPLETED", "b", ["**Tokens By Model**: claude-sonnet-9=0/1M/0/0"], "2026-10-02T00:00:00Z"),
  );
  const oct = summarizeAuditMonth([shard], { monthKey: "2026-10", timeZone: "Asia/Tokyo", rates });
  // 10 月に増えた opus-5 の出力 2M × $25。
  assert.equal(oct.usd, 50);
  assert.equal(oct.monthKey, "2026-10");
  assert.equal(oct.unpricedRows, 1);
  const sep = summarizeAuditMonth([shard], { monthKey: "2026-09", timeZone: "Asia/Tokyo", rates });
  assert.equal(sep.usd, 25);
  assert.equal(sep.unpricedRows, 0);
});

test("Given no usage in the audit When summarizeIntent Then it is undefined", () => {
  assert.equal(summarizeIntent([audit(section("STAGE_COMPLETED", "a", []))], rates), undefined);
  assert.equal(summarizeIntent([], rates), undefined);
});

test("Given audit text When auditReadable Then a file with events or an empty file is readable and anything else is not", () => {
  assert.equal(auditReadable(section("STAGE_COMPLETED", "intent-capture", [])), true);
  assert.equal(auditReadable("# AI-DLC Audit Log\n"), true);
  assert.equal(auditReadable(""), true);
  assert.equal(auditReadable("# AI-DLC Audit Log\n\n## x\nevent=STAGE_COMPLETED stage=a\n"), false);
});
