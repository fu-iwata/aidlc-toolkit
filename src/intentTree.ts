// アクティビティバーの intent 一覧（TreeView）。読み取り専用で、記録を変えない。
// 一覧と進捗の読み方は intents.ts、使用量の読み方は intentUsage.ts、ファイルの読み方は records.ts にある。
// マルチルートのワークスペースでは、AI-DLC の記録があるフォルダごとに見出しを分ける。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { type IntentUsage, auditReadable, summarizeIntent } from "./intentUsage";
import {
  type Group,
  type IntentEntry,
  type StageRow,
  type StateInfo,
  MARK_LABEL,
  PHASE_LABEL,
  descriptionLines,
  descriptionTitle,
  groupOf,
  mergeIntents,
  parseIntentEntries,
  parseStateMd,
  stateReadable,
  summarize,
} from "./intents";
import { RecordError, describeError, intentsDir, listDir, readActiveSpace, readAuditShards, readText } from "./records";
import { type Rate, formatJpy } from "./usage";

export type IntentView = {
  entry: IntentEntry;
  // intent の記録ディレクトリ（絶対パス）。
  dir: string;
  // project-description.json の説明文。
  description: string;
  // aidlc-state.md が無い intent は undefined。
  state?: StateInfo;
  // 今作業中の intent（active-intent が指すもの）か。
  active: boolean;
  // audit から集計した、完了した stage の使用量。記録が無ければ undefined。
  usage?: IntentUsage;
  // この版で読めない書式の audit のファイルの数。
  unreadableAudit: number;
};

// AI-DLC の記録があるワークスペースのフォルダ。
export type Folder = { root: string; name: string };

// フォルダ 1 つ分の一覧。読めなかったときは error に理由を入れる。
type Snapshot = { folder: Folder; views: IntentView[]; error?: string };

// 使用量の金額を出すための単価表と換算レート。読み直すたびに最新の設定を取る。asOf は単価表の確認日。
// costFactor は日本国内クロスリージョン推論の上乗せ（Cost USD の金額に掛ける。単価表の値には掛け済み）。
export type Pricing = () => Promise<{ rates: Record<string, Rate>; usdJpyRate: number; asOf?: string; costFactor: number }>;

export type Node =
  | { kind: "folder"; snapshot: Snapshot }
  | { kind: "activeGroup"; view: IntentView }
  | { kind: "group"; group: Group; views: IntentView[] }
  | { kind: "intent"; view: IntentView }
  | { kind: "name"; view: IntentView }
  | { kind: "phase"; view: IntentView; phase: string }
  | { kind: "stage"; row: StageRow };

const GROUP_LABEL: Record<Group, string> = {
  "in-flight": "進行中",
  complete: "完了",
  archived: "アーカイブ",
  unregistered: "未登録（intents.json に無い）",
};
const GROUP_ORDER: Group[] = ["in-flight", "complete", "archived", "unregistered"];

// 説明文は JSON の文字列として 1 行で入っている。読めなければ空にする。
async function readDescription(dir: string): Promise<string> {
  const text = await readText(path.join(dir, "project-description.json"));
  if (!text) return "";
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

async function readUsage(
  dir: string,
  rates: Record<string, Rate>,
  costFactor: number,
): Promise<{ usage?: IntentUsage; unreadableAudit: number }> {
  const shards = await readAuditShards(dir);
  return {
    usage: summarizeIntent(shards, rates, costFactor),
    unreadableAudit: shards.filter((s) => !auditReadable(s)).length,
  };
}

// 一覧は、作業中の space の intents.json と active-intent を直接読む。どちらも読み取りだけ。
// intents.json の dirName は parseIntentEntries がフォルダ名 1 つのものだけに絞る。
async function loadSnapshot(root: string, rates: Record<string, Rate>, costFactor: number): Promise<IntentView[]> {
  const dir = intentsDir(root, await readActiveSpace(root));
  const text = await readText(path.join(dir, "intents.json"));
  let registered: IntentEntry[] = [];
  if (text) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // エラーの全文にはファイルの中身の一部が入るので、出さない。
      throw new RecordError("intents.json を JSON として読めません");
    }
    try {
      registered = parseIntentEntries(value);
    } catch {
      throw new RecordError("intents.json の形式が想定と違います。AI-DLC の版が対応していない可能性があります");
    }
  }
  const active = (await readText(path.join(dir, "active-intent")))?.trim() || undefined;

  const dirNames = (await listDir(dir)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return Promise.all(
    mergeIntents(registered, dirNames).map(async (entry) => {
      const intentDir = path.join(dir, entry.dirName);
      const [stateText, description, usage] = await Promise.all([
        readText(path.join(intentDir, "aidlc-state.md")),
        readDescription(intentDir),
        readUsage(intentDir, rates, costFactor),
      ]);
      return {
        entry,
        dir: intentDir,
        description,
        state: stateText === undefined ? undefined : parseStateMd(stateText),
        active: entry.dirName === active,
        ...usage,
      };
    }),
  );
}

export class IntentTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private snapshots: Snapshot[] = [];
  private timer: NodeJS.Timeout | undefined;

  private usdJpyRate = 0;
  private asOf: string | undefined;

  constructor(
    private readonly folders: () => Promise<Folder[]>,
    private readonly pricing: Pricing,
  ) {}

  // 読み直す。読めなかったフォルダがあれば理由を返す（ビューのメッセージに出す）。
  async reload(): Promise<string | undefined> {
    const [folders, { rates, usdJpyRate, asOf, costFactor }] = await Promise.all([this.folders(), this.pricing()]);
    this.snapshots = await Promise.all(
      folders.map(async (folder): Promise<Snapshot> => {
        try {
          return { folder, views: await loadSnapshot(folder.root, rates, costFactor) };
        } catch (err) {
          return { folder, views: [], error: describeError(err) };
        }
      }),
    );
    this.usdJpyRate = usdJpyRate;
    this.asOf = asOf;
    this.changed.fire(undefined);
    const errors = this.snapshots.filter((s) => s.error);
    if (errors.length === 0) return undefined;
    return this.snapshots.length > 1
      ? errors.map((s) => `${s.folder.name}: ${s.error}`).join("。")
      : errors[0].error;
  }

  // 単価表や換算レートが変わったときは、一覧は読み直さず金額だけを出し直す。
  // 読んでいる間に一覧が読み直されたら、古い一覧で上書きしない。
  async reprice(): Promise<void> {
    const snapshots = this.snapshots;
    const { rates, usdJpyRate, asOf, costFactor } = await this.pricing();
    const repriced = await Promise.all(
      snapshots.map(async (snapshot) => ({
        ...snapshot,
        views: await Promise.all(
          snapshot.views.map(async (view) => ({ ...view, ...(await readUsage(view.dir, rates, costFactor)) })),
        ),
      })),
    );
    if (this.snapshots !== snapshots) return;
    this.usdJpyRate = usdJpyRate;
    this.asOf = asOf;
    this.snapshots = repriced;
    this.changed.fire(undefined);
  }

  // 記録の書き込みはまとめて 1 回だけ読み直す。
  // run には、読み直したあとビューのメッセージなども直す処理を渡す。
  scheduleReload(run: () => Promise<void>): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void run(), 1000);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.changed.dispose();
  }

  // ビューの見出しの横に出す、作業中の intent の名前。無ければ undefined。
  // マルチルートでは、作業中の intent が 1 つのときだけ出す。
  activeLabel(): string | undefined {
    const active = this.snapshots.flatMap((s) => s.views.filter((v) => v.active));
    if (active.length !== 1) return undefined;
    const view = active[0];
    return `作業中: ${descriptionTitle(view.description, 24) || view.entry.slug}`;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "folder") {
      const item = new vscode.TreeItem(node.snapshot.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(node.snapshot.error ? "warning" : "root-folder");
      item.description = node.snapshot.error;
      item.tooltip = node.snapshot.folder.root;
      return item;
    }

    if (node.kind === "activeGroup") {
      const item = new vscode.TreeItem("作業中", vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("target");
      return item;
    }

    if (node.kind === "group") {
      const item = new vscode.TreeItem(
        `${GROUP_LABEL[node.group]}（${node.views.length}）`,
        node.group === "in-flight" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new vscode.ThemeIcon("folder");
      return item;
    }

    if (node.kind === "intent") {
      const { entry, state, description, usage, unreadableAudit } = node.view;
      const readable = !state || stateReadable(state);
      // 見出しは説明文の 1 行目（無ければ slug）。intent 名は展開した先頭の行に、説明の全文は tooltip に出す。
      const item = new vscode.TreeItem(
        descriptionTitle(description) || entry.slug,
        (state && readable) || description ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      const progress = !state ? "状態ファイルなし" : readable ? summarize(state) : "状態ファイルを読めません";
      const cost = usage ? ` · 推定 ${formatJpy(usage.usd, this.usdJpyRate)}` : "";
      item.description = `${node.view.active ? `作業中 · ${progress}` : progress}${cost}`;
      const tooltip = new vscode.MarkdownString();
      tooltip.appendMarkdown("**");
      tooltip.appendText(entry.dirName);
      tooltip.appendMarkdown("**\n\n");
      if (state && readable) tooltip.appendText(`${summarize(state)}\n\n`);
      if (!readable) tooltip.appendText(`${UNREADABLE_STATE}\n\n`);
      if (unreadableAudit > 0) tooltip.appendText(`${unreadableAuditNote(unreadableAudit)}\n\n`);
      for (const line of descriptionLines(description)) tooltip.appendText(`${line}\n\n`);
      if (usage) appendUsage(tooltip, usage, this.usdJpyRate, this.asOf);
      item.tooltip = tooltip;
      item.iconPath = new vscode.ThemeIcon(
        !readable || unreadableAudit > 0
          ? "warning"
          : node.view.active
            ? "target"
            : entry.status === "in-flight"
              ? "rocket"
              : entry.status === "complete"
                ? "check"
                : entry.status === "archived"
                  ? "archive"
                  : "question",
      );
      item.contextValue = state ? "intent" : "intentNoState";
      return item;
    }

    if (node.kind === "name") {
      const item = new vscode.TreeItem(node.view.entry.dirName, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("tag");
      item.contextValue = "intentName";
      return item;
    }

    if (node.kind === "phase") {
      const status = node.view.state?.phases[node.phase] ?? "";
      const hasStages = (node.view.state?.stages ?? []).some((stage) => stage.phase === node.phase);
      const item = new vscode.TreeItem(
        node.phase,
        hasStages ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      item.description = PHASE_LABEL[status] ?? status;
      item.iconPath = new vscode.ThemeIcon(PHASE_ICON[status] ?? "circle-outline");
      return item;
    }

    const { row } = node;
    const item = new vscode.TreeItem(row.slug, vscode.TreeItemCollapsibleState.None);
    item.description = row.plan === "SKIP" ? "スキップ" : (MARK_LABEL[row.mark] ?? row.mark);
    item.iconPath = new vscode.ThemeIcon(row.plan === "SKIP" ? "circle-slash" : (MARK_ICON[row.mark] ?? "circle-outline"));
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      // フォルダが 1 つなら見出しを挟まない。intent が 1 件も無ければ空にし、案内（viewsWelcome）を出す。
      if (this.snapshots.length === 1) return topLevel(this.snapshots[0].views);
      return this.snapshots
        .filter((snapshot) => snapshot.error || snapshot.views.length > 0)
        .map((snapshot) => ({ kind: "folder" as const, snapshot }));
    }

    if (node.kind === "folder") return topLevel(node.snapshot.views);

    if (node.kind === "activeGroup") {
      return [{ kind: "intent", view: node.view }];
    }

    if (node.kind === "group") {
      return [...node.views]
        .sort((a, b) => b.entry.dirName.localeCompare(a.entry.dirName))
        .map((view) => ({ kind: "intent" as const, view }));
    }

    if (node.kind === "intent") {
      const state = node.view.state;
      const phases: Node[] =
        state && stateReadable(state)
          ? Object.keys(state.phases).map((phase) => ({ kind: "phase" as const, view: node.view, phase }))
          : [];
      return node.view.description ? [{ kind: "name", view: node.view }, ...phases] : phases;
    }

    if (node.kind === "phase") {
      return (node.view.state?.stages ?? [])
        .filter((stage) => stage.phase === node.phase)
        .map((row) => ({ kind: "stage" as const, row }));
    }

    return [];
  }
}

// 作業中の intent は先頭に別に出す。元の見出しの中にも残す。
function topLevel(views: IntentView[]): Node[] {
  const active = views.find((view) => view.active);
  const groups: Node[] = GROUP_ORDER.map((group) => ({
    kind: "group" as const,
    group,
    views: views.filter((view) => groupOf(view.entry) === group),
  })).filter((group) => group.views.length > 0);
  return active ? [{ kind: "activeGroup", view: active }, ...groups] : groups;
}

const UNREADABLE_STATE =
  "状態ファイル（aidlc-state.md）の書式を読めません。AI-DLC の版が、この拡張機能の対応している版と違う可能性があります。";

export function unreadableAuditNote(count: number): string {
  return `書式を読めない audit が ${count} 件あります。AI-DLC の版が、この拡張機能の対応している版と違う可能性があります。その分は金額に入っていません。`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString("ja-JP");
}

// tooltip の末尾に、intent の使用量（合計とモデル別の内訳）を足す。
function appendUsage(tooltip: vscode.MarkdownString, usage: IntentUsage, usdJpyRate: number, asOf?: string): void {
  tooltip.appendMarkdown("---\n\n**");
  tooltip.appendText(
    `推定コスト（完了した ${usage.stages} stage の累計）: ${formatJpy(usage.usd, usdJpyRate)}（$${usage.usd.toFixed(2)}）`,
  );
  tooltip.appendMarkdown("**\n\n");
  for (const bucket of usage.buckets) {
    const cost = bucket.usd === null ? "未価格" : formatJpy(bucket.usd, usdJpyRate);
    const c = bucket.counts;
    tooltip.appendText(
      `${bucket.model}: ${cost}（入力 ${fmtTokens(c.input)} / 出力 ${fmtTokens(c.output)} / ` +
        `cache 読取 ${fmtTokens(c.cacheRead)} / cache 書込 ${fmtTokens(c.cacheCreate5m + c.cacheCreate1h)}）\n\n`,
    );
  }
  if (usage.unpricedModels.length > 0) {
    tooltip.appendText(`単価表に無いモデル（${usage.unpricedModels.join("、")}）は金額に含めていません。\n\n`);
  }
  tooltip.appendText(
    `audit のトークン数と単価表${asOf ? `（${asOf} 時点）` : ""}の単価からの推定で、請求額とは一致しません。` +
      "複数のモデルを使った stage は、合計を Tokens By Model の比率でモデルへ分けています。動いている途中の stage は含みません。",
  );
}

// フェーズとステージの印に付けるアイコン（VS Code の codicon）。
const PHASE_ICON: Record<string, string> = {
  Verified: "pass",
  Active: "sync",
  Skipped: "circle-slash",
  Pending: "circle-outline",
};

const MARK_ICON: Record<string, string> = {
  x: "pass-filled",
  "-": "sync",
  "?": "question",
  R: "refresh",
  S: "circle-slash",
  " ": "circle-outline",
};

// 一覧から、intent の状態ファイル（aidlc-state.md）を開く。
export async function openState(node: Node): Promise<void> {
  if (node.kind !== "intent") return;
  const file = path.join(node.view.dir, "aidlc-state.md");
  try {
    await fs.access(file);
  } catch {
    void vscode.window.showWarningMessage("状態ファイル（aidlc-state.md）が見つかりません");
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
}

// 一覧から、intent 名（記録のディレクトリ名）をクリップボードにコピーする。intent の行と、展開した intent 名の行から使う。
export async function copyName(node: Node): Promise<void> {
  if (node.kind !== "intent" && node.kind !== "name") return;
  await vscode.env.clipboard.writeText(node.view.entry.dirName);
  void vscode.window.setStatusBarMessage(`コピーしました: ${node.view.entry.dirName}`, 3000);
}
