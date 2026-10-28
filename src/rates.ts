// 設定の単価（aidlcToolkit.modelRates）の読み取りと、日本国内クロスリージョン推論の上乗せの適用。純粋なロジック。
// VS Code の API には依存しないので、node:test で直接テストできる。
import type { Rate, RegionalPremium } from "./usage";

// 単価表の 1 行の項目。
export const RATE_FIELDS = ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"] as const;

// 単価表のキー。normalizeModel が作る形（小文字・数字・点・ハイフン）に合わせる。
const MODEL_RE = /^[a-z0-9][a-z0-9.-]*$/;

// 計算に使う倍率。上乗せが ON なら 1 + rate、OFF や未設定なら 1。
export function premiumFactor(premium: RegionalPremium | undefined): number {
  return premium?.enabled ? 1 + premium.rate : 1;
}

export function applyFactor(rates: Record<string, Rate>, factor: number): Record<string, Rate> {
  if (factor === 1) return rates;
  return Object.fromEntries(
    Object.entries(rates).map(([model, rate]) => [
      model,
      Object.fromEntries(RATE_FIELDS.map((f) => [f, rate[f] * factor])) as Rate,
    ]),
  );
}

// 設定に書かれた単価を読む。設定の形（package.json の JSON Schema）は VS Code が警告するだけで値は届くので、
// ここでも確かめる。正しい行だけを使い、使わなかった行のキーは invalid で返す（利用者に知らせる）。
export function readUserRates(value: unknown): { rates: Record<string, Rate>; invalid: string[] } {
  const rates: Record<string, Rate> = {};
  const invalid: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { rates, invalid };
  for (const [model, rate] of Object.entries(value)) {
    const fields = typeof rate === "object" && rate !== null ? (rate as Record<string, unknown>) : {};
    const ok =
      MODEL_RE.test(model) &&
      RATE_FIELDS.every((f) => typeof fields[f] === "number" && Number.isFinite(fields[f]) && (fields[f] as number) >= 0);
    if (ok) rates[model] = Object.fromEntries(RATE_FIELDS.map((f) => [f, fields[f]])) as Rate;
    else invalid.push(model);
  }
  return { rates, invalid };
}
