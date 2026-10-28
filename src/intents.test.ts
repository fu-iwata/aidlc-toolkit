// intent の一覧と進捗を読むロジックのテスト。`npm test` で実行する。
// フィクスチャは実データの書式を写した小さな文字列で、実際の記録は読まない。
import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentStage,
  descriptionLines,
  descriptionTitle,
  groupOf,
  isPlainName,
  mergeIntents,
  parseIntentEntries,
  parseStateMd,
  stateReadable,
  summarize,
} from "./intents";

const STATE_MD = `# AI-DLC State Tracking

## Project Information
- **Project**: サンプルの機能を追加したい
- **Active Agent**: aidlc-architect-agent

## Runtime State
- **Parked**: 2026-01-15T00:00:00Z

- **Parked At Stage**: domain-design

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

- **Initialization**: Verified
- **Ideation**: Verified
- **Inception**: Active
- **Construction**: Pending
- **Operation**: Skipped

## Stage Progress
<!-- Checkbox states: [ ] not started -->

### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [x] state-init — EXECUTE

### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [ ] practices-discovery — SKIP
- [-] domain-design — EXECUTE
- [ ] units-generation — EXECUTE
`;

test("parseStateMd reads phases, stages with their phase, and the parked flag", () => {
  const state = parseStateMd(STATE_MD);
  assert.deepEqual(state.phases, {
    Initialization: "Verified",
    Ideation: "Verified",
    Inception: "Active",
    Construction: "Pending",
    Operation: "Skipped",
  });
  assert.equal(state.stages.length, 6);
  assert.deepEqual(state.stages[0], { slug: "workspace-scaffold", mark: "x", plan: "EXECUTE", phase: "Initialization" });
  assert.deepEqual(state.stages[3], { slug: "practices-discovery", mark: " ", plan: "SKIP", phase: "Inception" });
  assert.equal(state.parked, true);
  assert.equal(state.activeAgent, "aidlc-architect-agent");
});

test("parseStateMd does not read the Parked At Stage line as the parked flag", () => {
  const text = STATE_MD.replace("- **Parked**: 2026-01-15T00:00:00Z\n", "");
  assert.equal(parseStateMd(text).parked, false);
});

test("currentStage finds the in-progress, awaiting, or revising stage", () => {
  const state = parseStateMd(STATE_MD);
  assert.equal(currentStage(state.stages)?.slug, "domain-design");
  assert.equal(currentStage([]), undefined);
});

test("summarize names the phase, the stage, and the parked state", () => {
  assert.equal(summarize(parseStateMd(STATE_MD)), "Inception / domain-design（進行中・中断中）");
});

test("summarize shows the active phase when no stage is open", () => {
  const text = STATE_MD.replace("- [-] domain-design", "- [x] domain-design");
  assert.equal(summarize(parseStateMd(text)), "Inception（進行中）");
});

test("parseIntentEntries reads the intents.json array and rejects any other shape", () => {
  const entry = { slug: "sample-feature", dirName: "260115-sample-feature", status: "in-flight" };
  assert.deepEqual(parseIntentEntries([entry]), [entry]);
  assert.throws(() => parseIntentEntries({ space: "default", intents: [entry] }));
});

test("parseIntentEntries keeps the archived status that intent archive writes", () => {
  const rows = parseIntentEntries([{ slug: "a", dirName: "261013-a", status: "archived" }]);
  assert.deepEqual(rows, [{ slug: "a", dirName: "261013-a", status: "archived" }]);
});

test("parseIntentEntries maps an unknown status to unknown and drops rows without dirName", () => {
  const rows = parseIntentEntries([
    { slug: "a", dirName: "261013-a", status: "weird" },
    { slug: "b", status: "complete" },
  ]);
  assert.deepEqual(rows, [{ slug: "a", dirName: "261013-a", status: "unknown" }]);
});

test("Given a dirName that leaves the intents folder, When parseIntentEntries reads it, Then the row is dropped", () => {
  const rows = parseIntentEntries([
    { slug: "a", dirName: "261013-a", status: "complete" },
    { slug: "up", dirName: "../../..", status: "complete" },
    { slug: "nested", dirName: "261013-a/../../x", status: "complete" },
    { slug: "win", dirName: "..\\x", status: "complete" },
    { slug: "abs", dirName: "/etc", status: "complete" },
    { slug: "dot", dirName: ".", status: "complete" },
  ]);
  assert.deepEqual(rows, [{ slug: "a", dirName: "261013-a", status: "complete" }]);
});

test("isPlainName accepts one folder name and rejects anything that is a path", () => {
  assert.equal(isPlainName("default"), true);
  assert.equal(isPlainName("261013-a"), true);
  for (const name of ["", ".", "..", "../x", "a/b", "a\\b", "/etc", "C:\\x", "a\0b"]) {
    assert.equal(isPlainName(name), false, name);
  }
});

test("parseIntentEntries rejects a payload that is not an intent list", () => {
  assert.throws(() => parseIntentEntries({ space: "default" }), /想定と違います/);
});

test("mergeIntents adds directories that are not registered and ignores non-intent folders", () => {
  const registered = [{ slug: "x", dirName: "261022-x", status: "complete" as const }];
  const merged = mergeIntents(registered, ["261022-x", "260116-another-intent", "audit", "active-intent"]);
  assert.deepEqual(
    merged.map((entry) => [entry.dirName, entry.status]),
    [
      ["261022-x", "complete"],
      ["260116-another-intent", "unknown"],
    ],
  );
});

test("groupOf puts an unknown status into the unregistered group", () => {
  assert.equal(groupOf({ slug: "a", dirName: "261013-a", status: "in-flight" }), "in-flight");
  assert.equal(groupOf({ slug: "a", dirName: "261013-a", status: "complete" }), "complete");
  assert.equal(groupOf({ slug: "a", dirName: "261013-a", status: "archived" }), "archived");
  assert.equal(groupOf({ slug: "a", dirName: "261013-a", status: "unknown" }), "unregistered");
});

test("descriptionLines drops blank lines and the leading compose word", () => {
  assert.deepEqual(descriptionLines("compose 一行目の説明。\n\n  二行目の説明。 \n"), [
    "一行目の説明。",
    "二行目の説明。",
  ]);
  assert.deepEqual(descriptionLines(""), []);
});

test("descriptionTitle takes the first line and cuts a long one with an ellipsis", () => {
  assert.equal(descriptionTitle("見出しの行\n本文の行"), "見出しの行");
  assert.equal(descriptionTitle("あいうえおかきくけこ", 5), "あいうえお…");
  assert.equal(descriptionTitle("あいうえお", 5), "あいうえお");
  assert.equal(descriptionTitle(""), "");
});

test("Given a state file in a format this version cannot read When stateReadable Then it is false", () => {
  assert.equal(stateReadable(parseStateMd(STATE_MD)), true);
  assert.equal(stateReadable(parseStateMd("# AI-DLC State\n\n## Progress\n- Inception: done\n")), false);
});
