// AI-DLC の intent の一覧と進捗を読む純粋なロジック。VS Code の API には依存しないので、node:test で直接テストできる。
// 読むだけで、ファイルを変えない。
//
// 進捗の書式は .claude/tools/ の aidlc-state.md の出力に合わせている。書式が変わったらここを直す。

export type IntentStatus = "in-flight" | "complete" | "archived" | "unknown";

export type IntentEntry = {
  slug: string;
  dirName: string;
  status: IntentStatus;
};

export type StageRow = {
  slug: string;
  // Stage Progress の印の中身（" " `-` `?` `R` `x` `S`）。
  mark: string;
  plan: "EXECUTE" | "SKIP";
  // 所属するフェーズ（例: Inception）。
  phase: string;
};

export type StateInfo = {
  // フェーズ名 → Pending / Active / Verified / Skipped。
  phases: Record<string, string>;
  stages: StageRow[];
  parked: boolean;
  activeAgent?: string;
};

export const PHASE_LABEL: Record<string, string> = {
  Pending: "未着手",
  Active: "進行中",
  Verified: "完了",
  Skipped: "スキップ",
};

export const MARK_LABEL: Record<string, string> = {
  " ": "未着手",
  "-": "進行中",
  "?": "承認待ち",
  R: "差し戻し中",
  x: "完了",
  S: "スキップ",
};

// 一覧の見出し。intent の状態ごとに分ける。
export type Group = "in-flight" | "complete" | "archived" | "unregistered";

export function groupOf(entry: IntentEntry): Group {
  if (entry.status === "in-flight") return "in-flight";
  if (entry.status === "complete") return "complete";
  if (entry.status === "archived") return "archived";
  return "unregistered";
}

function normalizeStatus(value: unknown): IntentStatus {
  return value === "in-flight" || value === "complete" || value === "archived" ? value : "unknown";
}

// フォルダ名 1 つだけか（パスの区切り、`.`、`..`、NUL を含まない）。
// intents.json の dirName や active-space はワークスペースの中身なので、パスに組む前にこれで確かめ、
// ワークスペースの外を読まないようにする。
export function isPlainName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\:\0]/.test(name);
}

// intents.json（intent の配列）を読む。dirName がフォルダ名 1 つでない行は捨てる。
export function parseIntentEntries(value: unknown): IntentEntry[] {
  if (!Array.isArray(value)) throw new Error("intent の一覧の形式が想定と違います");
  return value
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        slug: typeof r.slug === "string" ? r.slug : "",
        dirName: typeof r.dirName === "string" ? r.dirName : "",
        status: normalizeStatus(r.status),
      };
    })
    .filter((entry) => isPlainName(entry.dirName));
}

// 登録されていない intent（ディレクトリだけ残っているもの）を、未登録として加える。日付で始まる名前だけを見る。
export function mergeIntents(registered: IntentEntry[], dirNames: string[]): IntentEntry[] {
  const known = new Set(registered.map((entry) => entry.dirName));
  const extra = dirNames
    .filter((dir) => /^\d{6}-/.test(dir) && !known.has(dir))
    .map((dir) => ({ slug: dir.replace(/^\d{6}-/, ""), dirName: dir, status: "unknown" as const }));
  return [...registered, ...extra];
}

// `## 見出し` の直後から、次の `## ` の手前までの行を返す。
function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    out.push(line);
  }
  return out;
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

export function parseStateMd(text: string): StateInfo {
  const phases: Record<string, string> = {};
  for (const line of section(text, "Phase Progress")) {
    const m = /^- \*\*([A-Za-z]+)\*\*: (\S+)\s*$/.exec(line);
    if (m) phases[m[1]] = m[2];
  }

  const stages: StageRow[] = [];
  let phase = "";
  for (const line of section(text, "Stage Progress")) {
    const header = /^### ([A-Z]+) PHASE/.exec(line);
    if (header) {
      phase = titleCase(header[1]);
      continue;
    }
    const m = /^- \[(.)\] (\S+) — (EXECUTE|SKIP)\s*$/.exec(line);
    if (m) stages.push({ slug: m[2], mark: m[1], plan: m[3] as "EXECUTE" | "SKIP", phase });
  }

  const agent = /^- \*\*Active Agent\*\*: (\S.*)$/m.exec(text);
  return {
    phases,
    stages,
    parked: /^- \*\*Parked\*\*: \S/m.test(text),
    activeAgent: agent?.[1].trim(),
  };
}

// この版で読める書式の状態ファイルか。Phase Progress と Stage Progress のどちらも読めなければ、
// AI-DLC の書式が変わったとみなす（黙って空の進捗を出さない）。
export function stateReadable(state: StateInfo): boolean {
  return Object.keys(state.phases).length > 0 || state.stages.length > 0;
}

// 今進めている stage。進行中、承認待ち、差し戻し中のいずれか。
export function currentStage(stages: StageRow[]): StageRow | undefined {
  return stages.find((stage) => stage.mark === "-" || stage.mark === "?" || stage.mark === "R");
}

// 一覧の行に出す一言（例: 「Inception / domain-design（承認待ち）」）。
export function summarize(state: StateInfo): string {
  const current = currentStage(state.stages);
  if (current) {
    const label = MARK_LABEL[current.mark] ?? current.mark;
    const parked = state.parked ? "・中断中" : "";
    return `${current.phase} / ${current.slug}（${label}${parked}）`;
  }
  const phases = Object.entries(state.phases);
  const active = phases.find(([, status]) => status === "Active");
  if (active) return `${active[0]}（${PHASE_LABEL[active[1]] ?? active[1]}）`;
  return "完了";
}

// 説明文を、空行を除いた行の配列にする。行頭の `compose ` は /aidlc の指示の語なので外す。
export function descriptionLines(text: string): string[] {
  return text
    .replace(/^compose\s+/, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// 一覧の行の見出しに使う、説明文の 1 行目。長いときは max 文字で切って「…」を付ける。
export function descriptionTitle(text: string, max = 40): string {
  const first = descriptionLines(text)[0] ?? "";
  const chars = Array.from(first);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : first;
}
