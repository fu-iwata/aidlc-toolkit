// ワークスペースの AI-DLC の記録の読み方と、エラーの文言のテスト。`npm test` で実行する。
// 一時ディレクトリに小さな記録を作って読む。実際の記録は読まない。
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { RecordError, describeError, hasRecords, readActiveSpace, readSpaceAuditShards } from "./records";

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-toolkit-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test("Given two spaces When readSpaceAuditShards reads the active one Then only that space's audit is returned", async () => {
  const root = workspace({
    "aidlc/active-space": "team-a\n",
    "aidlc/spaces/team-a/intents/audit/s.md": "space-a",
    "aidlc/spaces/team-a/intents/261001-x/audit/c.md": "intent-a",
    "aidlc/spaces/team-a/intents/261001-x/audit/notes.txt": "not audit",
    "aidlc/spaces/team-b/intents/261002-y/audit/c.md": "intent-b",
  });
  const space = await readActiveSpace(root);
  assert.equal(space, "team-a");
  assert.deepEqual((await readSpaceAuditShards(root, space)).sort(), ["intent-a", "space-a"]);
});

test("Given no active-space file When readActiveSpace Then the default space is used", async () => {
  assert.equal(await readActiveSpace(workspace({})), "default");
});

test("Given an active-space that is a path When readActiveSpace Then it is refused with a RecordError", async () => {
  const root = workspace({ "aidlc/active-space": "../../.." });
  await assert.rejects(readActiveSpace(root), RecordError);
});

test("Given a folder with or without aidlc/spaces When hasRecords Then only the one with records is true", async () => {
  assert.equal(await hasRecords(workspace({ "aidlc/spaces/default/intents/intents.json": "[]" })), true);
  assert.equal(await hasRecords(workspace({ "README.md": "x" })), false);
});

test("Given errors of each kind When describeError Then the message is for people and carries no file contents", () => {
  assert.equal(describeError(new RecordError("intents.json を JSON として読めません")), "intents.json を JSON として読めません");
  const denied = Object.assign(new Error("EACCES: permission denied, open '/w/a.md'"), { code: "EACCES", path: "/w/a.md" });
  assert.equal(describeError(denied), "ファイルを読む権限がありません（/w/a.md）");
  const other = Object.assign(new Error("EIO: i/o error"), { code: "EIO", path: "/w/b.md" });
  assert.equal(describeError(other), "ファイルを読めません（/w/b.md、EIO）");
  const bug = new TypeError("Cannot read properties of undefined (reading 'secret')");
  assert.equal(describeError(bug), "記録を読めませんでした。AI-DLC の版が対応していない可能性があります（TypeError）");
  assert.equal(describeError("x"), "記録を読めませんでした。AI-DLC の版が対応していない可能性があります");
});
