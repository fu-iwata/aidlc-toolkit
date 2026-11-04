// 診断の結果を読んで分類するロジックのテスト。`npm test` で実行する。
// フィクスチャは aidlc doctor --json の書式を写した小さな文字列で、実際の記録や aidlc は呼ばない。
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { type DoctorCheck, classify, groupChecks, parseDoctorJson, splitLabel } from "./doctor";

const OK: DoctorCheck = { pass: true, label: "Hooks enabled" };
const WARN: DoctorCheck = {
  pass: false,
  severity: "warn",
  label: "Providers: 1 warning(s)",
  fix: "run `aidlc config`",
};
const FAIL: DoctorCheck = { pass: false, label: "settings.json present", fix: "run `aidlc config --harness claude`" };

test("Given severity warn When classify Then it is a warning whatever pass says", () => {
  assert.equal(classify({ pass: true, severity: "warn", label: "x" }), "warn");
  assert.equal(classify({ pass: false, severity: "warn", label: "x" }), "warn");
});

test("Given no severity When classify Then false is a failure and true is ok", () => {
  assert.equal(classify(FAIL), "fail");
  assert.equal(classify(OK), "ok");
});

test("Given checks of every kind When groupChecks Then they split into three groups in order", () => {
  const groups = groupChecks([OK, WARN, FAIL, { ...OK, label: "Second" }]);
  assert.deepEqual(
    groups.ok.map((c) => c.label),
    ["Hooks enabled", "Second"],
  );
  assert.deepEqual(groups.warn, [WARN]);
  assert.deepEqual(groups.fail, [FAIL]);
});

test("Given the known format When parseDoctorJson Then it returns the message and checks", () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    ok: true,
    status: "warning",
    message: "70 passed, 5 warnings, 0 failed",
    data: { checks: [OK, WARN], passed: 70, warnings: 5, failed: 0 },
  });
  const parsed = parseDoctorJson(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.result.message, "70 passed, 5 warnings, 0 failed");
  assert.deepEqual(parsed.result.checks, [OK, WARN]);
});

test("Given a failing run with JSON When parseDoctorJson Then it still reads the result", () => {
  const raw = JSON.stringify({ schemaVersion: 1, ok: false, message: "1 failed", data: { checks: [FAIL] } });
  const parsed = parseDoctorJson(raw);
  assert.equal(parsed.ok, true);
});

test("Given an unknown schemaVersion When parseDoctorJson Then it is refused with the reason", () => {
  const parsed = parseDoctorJson(JSON.stringify({ schemaVersion: 2, data: { checks: [] } }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.reason, /schemaVersion 2/);
});

test("Given output that is not the expected shape When parseDoctorJson Then it is unreadable", () => {
  assert.equal(parseDoctorJson("not json").ok, false);
  assert.equal(parseDoctorJson(JSON.stringify({ schemaVersion: 1, data: {} })).ok, false);
  assert.equal(
    parseDoctorJson(JSON.stringify({ schemaVersion: 1, data: { checks: [{ label: "x" }] } })).ok,
    false,
  );
});

test("Given a label with a colon When splitLabel Then it splits at the first colon", () => {
  assert.deepEqual(splitLabel("Providers: 1 warning(s)"), ["Providers", "1 warning(s)"]);
  assert.deepEqual(splitLabel("Hooks enabled"), ["Hooks enabled", ""]);
});
