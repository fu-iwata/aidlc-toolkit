// `aidlc doctor --json` の結果を読み、「失敗」「警告」「正常」に分けるロジック。純粋な関数だけで、VS Code の API には依存しない。
// 分類は doctor が返す pass と severity だけで決める。文言（label）は読まない。
// 「失敗」は doctor の値ではなく、pass が false で severity が無い項目を、この拡張機能がそう呼ぶもの。

export type DoctorCheck = { pass: boolean; severity?: string; label: string; fix?: string };
export type Kind = "fail" | "warn" | "ok";
export type DoctorResult = { message: string; checks: DoctorCheck[] };

// 読めるのはこの版の書式だけ。版が変わったら、勝手に読まず「知らない形式」として扱う。
export const SCHEMA_VERSION = 1;

export function classify(check: DoctorCheck): Kind {
  if (check.severity === "warn") return "warn";
  return check.pass ? "ok" : "fail";
}

export function groupChecks(checks: DoctorCheck[]): Record<Kind, DoctorCheck[]> {
  const groups: Record<Kind, DoctorCheck[]> = { fail: [], warn: [], ok: [] };
  for (const check of checks) groups[classify(check)].push(check);
  return groups;
}

export type ParseOutcome = { ok: true; result: DoctorResult } | { ok: false; reason: string };

// 出力を読む。doctor は失敗の時も JSON を返すので、終了コードは見ず、中身だけで判断する。
export function parseDoctorJson(raw: string): ParseOutcome {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "JSON として読めませんでした" };
  }
  if (!isRecord(json)) return { ok: false, reason: "JSON の形が違います" };
  if (json.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: `知らない形式です（schemaVersion ${String(json.schemaVersion)}）` };
  }
  const data = json.data;
  if (!isRecord(data) || !Array.isArray(data.checks)) {
    return { ok: false, reason: "項目（data.checks）が見つかりません" };
  }
  const checks: DoctorCheck[] = [];
  for (const item of data.checks) {
    if (!isRecord(item) || typeof item.pass !== "boolean" || typeof item.label !== "string") {
      return { ok: false, reason: "項目の形が違います" };
    }
    checks.push({
      pass: item.pass,
      label: item.label,
      ...(typeof item.severity === "string" ? { severity: item.severity } : {}),
      ...(typeof item.fix === "string" ? { fix: item.fix } : {}),
    });
  }
  return { ok: true, result: { message: typeof json.message === "string" ? json.message : "", checks } };
}

// 項目の文言を「項目名: 説明」に分ける。`: ` が無い、または前半が長すぎるときは、全体を項目名にする。
export function splitLabel(label: string): [string, string] {
  const at = label.indexOf(": ");
  return at > 0 && at < 48 ? [label.slice(0, at), label.slice(at + 2)] : [label, ""];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
