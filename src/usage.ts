// 使用量の型と、単価表・単価の計算・月の判定・円の表示の純粋なロジック。
// VS Code の API には依存しないので、node:test で直接テストできる。
// audit の読み方は intentUsage.ts にある。
//
// モデル名の正規化は .claude/tools/aidlc-usage.ts に合わせている。変更するときは両方を見比べること。

export type Rate = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

export type Counts = {
  input: number;
  output: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
};

export type Bucket = {
  // 表示用のモデル名。単価表のキー（例: `sonnet-5-5`）か、分からなければ生の ID。
  model: string;
  counts: Counts;
  // 標準単価での USD。単価表に無いモデルは null（トークンは数えるが金額は出さない）。
  usd: number | null;
};

export type Summary = {
  monthKey: string;
  buckets: Bucket[];
  // 標準単価の合計。未価格の行は含まない。
  usd: number;
  // 単価表に無く金額を出せなかった使用量の件数（stage の完了 1 件のモデル 1 つで 1 件）。
  unpricedRows: number;
};

// 日本国内クロスリージョン推論（Bedrock の jp. の推論プロファイル）の、基本料金（グローバル）への上乗せ。
// rate は割合（0.1 で 10%）。ON/OFF は設定 aidlcToolkit.regionalPremium で決める。
export type RegionalPremium = { enabled: boolean; rate: number };

export type RatesFile = {
  _comment?: string;
  // 単価を公式の料金表で確かめた日（YYYY-MM-DD）。画面に「〜時点」と出す。
  asOf?: string;
  // 単価表の値は公式の標準単価。上乗せが ON のとき、計算には各単価に (1 + rate) を掛けた値を使う。
  regionalPremium?: { rate: number };
  rates?: Record<string, Rate>;
};

// 単価表を重ねる。extra（ワークスペースの .claude/ の単価表、AI-DLC が用意する正の表）にある行はそのまま使い、
// extra に無いモデルの行だけを base（拡張機能に同梱の単価表）で補う。
export function mergeRates(base: RatesFile, extra: RatesFile): RatesFile {
  return { rates: { ...base.rates, ...extra.rates } };
}


export const emptyCounts = (): Counts => ({
  input: 0,
  output: 0,
  cacheCreate5m: 0,
  cacheCreate1h: 0,
  cacheRead: 0,
});

// 単価表のキーへの正規化。aidlc-usage.ts の normalizeModel と同じ規則:
// プロバイダ接頭辞（`jp.anthropic.` など）と [1m] / -vN / 日付サフィックスを落とし、
// キーに完全一致したものだけ返す。点リリース（opus-5-5）を主版（opus-5）へ丸めない。
export function normalizeModel(modelId: string, rates: Record<string, Rate>): string | null {
  if (!modelId) return null;
  let s = modelId.trim().toLowerCase();
  const provider = s.match(/^(?:[a-z0-9-]+\.)?anthropic\./);
  if (provider) s = s.slice(provider[0].length);
  if (!s.startsWith("claude-")) return null;
  s = s
    .slice("claude-".length)
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d{8}$/, "");
  return Object.hasOwn(rates, s) ? s : null;
}

export function priceCounts(counts: Counts, rate: Rate): number {
  return (
    (counts.input / 1e6) * rate.input +
    (counts.output / 1e6) * rate.output +
    (counts.cacheCreate5m / 1e6) * rate.cacheWrite5m +
    (counts.cacheCreate1h / 1e6) * rate.cacheWrite1h +
    (counts.cacheRead / 1e6) * rate.cacheRead
  );
}

// タイムスタンプを指定のタイムゾーンで見た「YYYY-MM」。
export function monthKeyOf(timestamp: string, timeZone: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return year && month ? `${year}-${month}` : null;
}

export function formatJpy(usd: number, usdJpyRate: number): string {
  return `¥${Math.round(usd * usdJpyRate).toLocaleString("ja-JP")}`;
}
