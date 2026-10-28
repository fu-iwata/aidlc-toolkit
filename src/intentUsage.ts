// AI-DLC の audit（<record>/audit/*.md）から、使用量と推定コストを集計する純粋なロジック。
// intent ごとの累計と、ワークスペース全体の月ごとの合計の両方をここで出す。
// VS Code の API には依存しないので、node:test で直接テストできる。
//
// audit の STAGE_COMPLETED に engine（.claude/tools/aidlc-usage.ts の aggregateUsageAuditFields）が書く
// 使用量を読む。金額は audit の `Cost USD` を使わず、モデルとトークン数から単価表で計算し直す。
//
// 読み方の注意:
// - STAGE_COMPLETED の数字はその stage の累計（ledger の byStage）。同じ stage がやり直しや Unit ごとに
//   何度も完了すると、後の行ほど大きい。そこで、audit のファイルごと・stage ごとに前回の完了との差分を、
//   その行の使用量とする。差分を足すと最後の行の累計と同じになり、月は各行の `Timestamp` で決められる。
//   前回より減っている項目があれば、ledger が作り直されたとみなし、その行の値をそのまま使う。
// - audit のファイル（shard）は clone ごとに別の ledger から書かれるので、ファイル同士は足す。
// - 動いている途中の stage は、完了するまで入らない。stage の外の会話（AI-DLC を使わない会話）も入らない。
// - トークン数は、丸めの無い合計（`Tokens In`、`Tokens Out`、`Cache Read`、`Cache Write`）を使う。
//   `Tokens By Model` は `59.6k` のように丸められているので、合計をモデルへ分ける比率にだけ使う。
//   モデルが 1 つの stage は丸めが入らない。
// - cache 書込は 5m と 1h が合計されているので 5m とみなす。
//   呼び出し 1 回ごとのプロンプトの長さが分からないので、長文の単価は使わない。
import { type Bucket, type Counts, type Rate, type Summary, emptyCounts, monthKeyOf, normalizeModel, priceCounts } from "./usage";

export type ModelTokens = { model: string; counts: Counts };

// STAGE_COMPLETED の 1 行で新しく増えた使用量（前回の完了との差分）。
export type UsageEntry = { stage: string; timestamp: string; models: ModelTokens[] };

export type IntentUsage = {
  buckets: Bucket[];
  // 標準単価の合計。未価格のモデルは含まない。
  usd: number;
  // 使用量を数えた stage の数。
  stages: number;
  // 単価表に無く金額を出せなかったモデルの名前。
  unpricedModels: string[];
};

const FIELDS = ["input", "output", "cacheRead", "cacheCreate5m"] as const;
type Field = (typeof FIELDS)[number];
type Totals = Pick<Counts, Field>;

// engine の fmtTokensCompact の逆。`1.2k` → 1200、`3.4M` → 3400000、`912` → 912。読めなければ null。
export function parseCompactTokens(value: string): number | null {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)([kM]?)$/);
  if (!m) return null;
  const scale = m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1;
  return Math.round(Number(m[1]) * scale);
}

// `opus-5=244/59.6k/27.1M/524.6k; sonnet-5=...` を読む。並びは 入力/出力/cache 読取/cache 書込。
// 古い形の 3 つ組（cache 書込なし）も受ける。読めない区切りは飛ばす。
export function parseTokensByModel(value: string): ModelTokens[] {
  const out: ModelTokens[] = [];
  for (const seg of value.split(";")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const model = seg.slice(0, eq).trim();
    const parts = seg.slice(eq + 1).split("/").map(parseCompactTokens);
    if (!model || (parts.length !== 3 && parts.length !== 4) || parts.some((n) => n === null)) continue;
    const [input, output, cacheRead, cacheWrite = 0] = parts as number[];
    out.push({ model, counts: { ...emptyCounts(), input, output, cacheRead, cacheCreate5m: cacheWrite } });
  }
  return out;
}

function field(section: string, name: string): string | undefined {
  return section.match(new RegExp(`^\\*\\*${name}\\*\\*: (.*)$`, "m"))?.[1]?.trim();
}

// 丸めの無い合計を、モデル別の丸めた値の比率でモデルへ分ける。最後のモデルに端数を寄せ、
// 合計が元の値と一致するようにする。比率が出ない（丸めた値がすべて 0）ときは、モデル不明として残す。
export function allocateTotals(models: ModelTokens[], totals: Totals): ModelTokens[] {
  const out = models.map(({ model }) => ({ model, counts: emptyCounts() }));
  let unknown: Counts | undefined;
  for (const f of FIELDS) {
    const total = totals[f];
    const weight = models.reduce((sum, m) => sum + m.counts[f], 0);
    if (weight === 0) {
      if (total > 0) {
        unknown ??= emptyCounts();
        unknown[f] = total;
      }
      continue;
    }
    let rest = total;
    models.forEach((m, i) => {
      const share = i === models.length - 1 ? rest : Math.round((total * m.counts[f]) / weight);
      out[i].counts[f] = share;
      rest -= share;
    });
  }
  return unknown ? [...out, { model: "", counts: unknown }] : out;
}

// STAGE_COMPLETED の 1 行の読み取り値（その stage の累計）。
type Reading = { stage: string; timestamp: string; weights: ModelTokens[]; totals: Totals };

function sumWeights(models: ModelTokens[]): Totals {
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0 };
  for (const m of models) for (const f of FIELDS) t[f] += m.counts[f];
  return t;
}

function readCompletions(text: string): Reading[] {
  const out: Reading[] = [];
  for (const section of text.split(/^---$/m)) {
    if (field(section, "Event") !== "STAGE_COMPLETED") continue;
    const stage = field(section, "Stage");
    if (!stage) continue;
    const byModel = field(section, "Tokens By Model");
    const weights = byModel ? parseTokensByModel(byModel) : [];
    let totals: Totals;
    if (field(section, "Tokens In") !== undefined) {
      const num = (name: string): number => Number(field(section, name)) || 0;
      totals = { input: num("Tokens In"), output: num("Tokens Out"), cacheRead: num("Cache Read"), cacheCreate5m: num("Cache Write") };
    } else if (weights.length > 0) {
      totals = sumWeights(weights);
    } else {
      continue;
    }
    out.push({ stage, timestamp: field(section, "Timestamp") ?? "", weights, totals });
  }
  return out;
}

// 差分の比率。モデルごとの増えた分を使う。丸めのせいで増えた分が全部 0 の項目は、今の累計の比率を使う。
function deltaWeights(current: ModelTokens[], previous: ModelTokens[]): ModelTokens[] {
  const prev = new Map(previous.map((m) => [m.model, m.counts]));
  const deltas = current.map(({ model, counts }) => {
    const before = prev.get(model);
    const d = emptyCounts();
    for (const f of FIELDS) d[f] = Math.max(0, counts[f] - (before?.[f] ?? 0));
    return { model, counts: d };
  });
  for (const f of FIELDS) {
    if (deltas.every((m) => m.counts[f] === 0)) deltas.forEach((m, i) => (m.counts[f] = current[i].counts[f]));
  }
  return deltas;
}

const isEmpty = (c: Counts): boolean => FIELDS.every((f) => c[f] === 0);

// audit の 1 ファイルから、STAGE_COMPLETED の行ごとに増えた使用量を返す。
export function parseAuditUsage(text: string): UsageEntry[] {
  const previous = new Map<string, Reading>();
  const out: UsageEntry[] = [];
  for (const reading of readCompletions(text)) {
    const prev = previous.get(reading.stage);
    previous.set(reading.stage, reading);
    let totals = reading.totals;
    let weights = reading.weights;
    if (prev && FIELDS.every((f) => reading.totals[f] >= prev.totals[f])) {
      totals = { ...totals };
      for (const f of FIELDS) totals[f] -= prev.totals[f];
      weights = deltaWeights(reading.weights, prev.weights);
    }
    // モデル別の内訳が無く合計だけある行は、モデル不明（未価格）として数える。
    const models = (
      weights.length > 0 ? allocateTotals(weights, totals) : [{ model: "", counts: { ...emptyCounts(), ...totals } }]
    ).filter((m) => !isEmpty(m.counts));
    if (models.length > 0) out.push({ stage: reading.stage, timestamp: reading.timestamp, models });
  }
  return out;
}

// audit のモデル名を単価表のキーにする。engine は単価表のキー（`opus-5`）か、
// 自分の単価表に無ければ生の ID（`claude-haiku-5-5`）を書くので、両方を受ける。
function rateKey(model: string, rates: Record<string, Rate>): string | null {
  return Object.hasOwn(rates, model) ? model : normalizeModel(model, rates);
}

// 使用量をモデル別に集めて値段を付ける。
function price(entries: UsageEntry[], rates: Record<string, Rate>) {
  const buckets = new Map<string, Bucket>();
  const unpriced = new Set<string>();
  let usd = 0;
  let unpricedRows = 0;
  for (const entry of entries) {
    for (const { model: raw, counts } of entry.models) {
      const key = rateKey(raw, rates);
      const model = key ?? (raw || "(不明)");
      const bucket = buckets.get(model) ?? { model, counts: emptyCounts(), usd: key ? 0 : null };
      for (const f of FIELDS) bucket.counts[f] += counts[f];
      bucket.counts.cacheCreate1h += counts.cacheCreate1h;
      buckets.set(model, bucket);
      if (!key) {
        unpriced.add(model);
        unpricedRows++;
        continue;
      }
      const cost = priceCounts(counts, rates[key]);
      bucket.usd = (bucket.usd ?? 0) + cost;
      usd += cost;
    }
  }
  return {
    buckets: [...buckets.values()].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1)),
    usd,
    unpricedModels: [...unpriced],
    unpricedRows,
  };
}

// この版で読める書式の audit か。中身があるのに `**Event**:` の行が 1 つも無ければ、
// AI-DLC の書式が変わったとみなす（黙って 0 円にしない）。見出しだけのファイルは読めるものとする。
export function auditReadable(text: string): boolean {
  const body = text.replace(/^# .*$/m, "").trim();
  return body === "" || /^\*\*Event\*\*: /m.test(text);
}

// intent の audit の全ファイルの中身から、モデル別の使用量と推定コストを出す。使用量が無ければ undefined。
export function summarizeIntent(shards: string[], rates: Record<string, Rate>): IntentUsage | undefined {
  let stages = 0;
  const entries: UsageEntry[] = [];
  for (const text of shards) {
    const shardEntries = parseAuditUsage(text);
    stages += new Set(shardEntries.map((e) => e.stage)).size;
    entries.push(...shardEntries);
  }
  if (stages === 0) return undefined;
  const { buckets, usd, unpricedModels } = price(entries, rates);
  return { buckets, usd, stages, unpricedModels };
}

// audit の全ファイル（全部の intent）の中身から、指定の月（YYYY-MM）の使用量をモデル別に出す。
// 月は各 STAGE_COMPLETED の `Timestamp` を timeZone で見た年月で決める。
export function summarizeAuditMonth(
  shards: string[],
  opts: { monthKey: string; timeZone: string; rates: Record<string, Rate> },
): Summary {
  const entries = shards
    .flatMap(parseAuditUsage)
    .filter((entry) => monthKeyOf(entry.timestamp, opts.timeZone) === opts.monthKey);
  const { buckets, usd, unpricedRows } = price(entries, opts.rates);
  return { monthKey: opts.monthKey, buckets, usd, unpricedRows };
}
