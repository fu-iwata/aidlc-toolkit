// ワークスペースの AI-DLC の記録（aidlc/）の読み方と、利用者に見せるエラーの文言。
// VS Code の API には依存しないので、node:test で直接テストできる。読むだけで、ファイルを変えない。
// 読みは非同期にし、Extension Host を止めない。
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPlainName } from "./intents";

// 利用者にそのまま見せてよい文言のエラー。ファイルの中身は入れない。
export class RecordError extends Error {}

// ファイルを読む。無ければ undefined。
export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

// ディレクトリの中を読む。無ければ空。
export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// AI-DLC の記録（aidlc/spaces/）があるフォルダか。
export async function hasRecords(root: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(root, "aidlc", "spaces"))).isDirectory();
  } catch {
    return false;
  }
}

// 作業中の space の名前。aidlc/active-space が無ければ default。
// ワークスペースの中身なので、フォルダ名 1 つのときだけ使う（ワークスペースの外を読まない）。
export async function readActiveSpace(root: string): Promise<string> {
  const space = (await readText(path.join(root, "aidlc", "active-space")))?.trim() || "default";
  if (!isPlainName(space)) throw new RecordError("aidlc/active-space の space 名が正しくありません");
  return space;
}

export function intentsDir(root: string, space: string): string {
  return path.join(root, "aidlc", "spaces", space, "intents");
}

// 記録のディレクトリの audit（audit/*.md）を全部読む。clone ごとにファイルが分かれている。
export async function readAuditShards(dir: string): Promise<string[]> {
  const auditDir = path.join(dir, "audit");
  const names = (await listDir(auditDir)).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
  return Promise.all(names.map((name) => fs.readFile(path.join(auditDir, name), "utf-8")));
}

// space の全部の audit（intent ごとの audit/*.md と、intent に属さない space の audit/*.md）を読む。
// Intent 一覧と同じく、作業中の space だけを数えるために使う。
export async function readSpaceAuditShards(root: string, space: string): Promise<string[]> {
  const dir = intentsDir(root, space);
  const intents = (await listDir(dir)).filter((e) => e.isDirectory() && e.name !== "audit");
  const shards = await Promise.all([dir, ...intents.map((e) => path.join(dir, e.name))].map(readAuditShards));
  return shards.flat();
}

// 利用者に見せるエラーの文言。思わぬエラーの全文には、記録の中身の一部が入ることがあるので出さない。
export function describeError(err: unknown): string {
  if (err instanceof RecordError) return err.message;
  const e = err as NodeJS.ErrnoException | undefined;
  if (e && typeof e.code === "string" && typeof e.path === "string") {
    return e.code === "EACCES" || e.code === "EPERM"
      ? `ファイルを読む権限がありません（${e.path}）`
      : `ファイルを読めません（${e.path}、${e.code}）`;
  }
  const base = "記録を読めませんでした。AI-DLC の版が対応していない可能性があります";
  return err instanceof Error ? `${base}（${err.name}）` : base;
}
