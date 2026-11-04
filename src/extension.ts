// VS Code の結線（ステータスバー・Webview・ファイル監視・アクティビティバーの intent 一覧と使用量）。
// 使用量の集計本体は intentUsage.ts（audit の読み方）と usage.ts（単価の計算）、
// intent の読み方は intents.ts / intentTree.ts、ファイルの読み方は records.ts にある。
//
// AI-DLC の記録（aidlc/spaces/）があるフォルダを開いたときだけ起動し（package.json の activationEvents）、
// 記録が無いあいだはビューとステータスバーを出さない（context キー aidlcToolkit.hasRecords）。
// 使用量（今月）は Intent 一覧と同じく、フォルダごとに作業中の space だけを数える。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { type Folder, type Node, IntentTreeProvider, copyName, openState, unreadableAuditNote } from "./intentTree";
import { auditReadable, summarizeAuditMonth } from "./intentUsage";
import { applyFactor, premiumFactor, readUserRates } from "./rates";
import { RecordError, describeError, hasRecords, readActiveSpace, readSpaceAuditShards } from "./records";
import {
  type Rate,
  type RatesFile,
  type RegionalPremium,
  type Summary,
  formatJpy,
  mergeRates,
  monthKeyOf,
} from "./usage";
import { UsageTreeProvider, usageTooltip } from "./usageTree";
import { parseDoctorJson } from "./doctor";
import { type FolderState, DoctorTreeProvider, type Node as DoctorNode } from "./doctorTree";
import { type RunOutcome, runDoctor } from "./doctorRun";

let statusItem: vscode.StatusBarItem;
let panel: vscode.WebviewPanel | undefined;
let timer: NodeJS.Timeout | undefined;
let extensionDir = "";
type Latest = { total: Summary; rate: number; premium: RegionalPremium; asOf?: string; unreadable: number };
let latest: Latest | undefined;
let usageTree: UsageTreeProvider;
let usageView: vscode.TreeView<unknown>;

export function activate(context: vscode.ExtensionContext): void {
  extensionDir = context.extensionPath;
  // ステータスバーは、記録があると分かってから出す（updateVisibility）。
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.name = "AI-DLC Toolkit";
  statusItem.command = "aidlcToolkit.usage.show";
  statusItem.text = "$(loading~spin) AI-DLC";

  // アクティビティバーの使用量。再集計のボタンはビューの見出しに置く。
  usageTree = new UsageTreeProvider();
  usageView = vscode.window.createTreeView("aidlcToolkit.usage", { treeDataProvider: usageTree });
  usageView.message = "集計中…";

  // アクティビティバーの intent 一覧。読み取り専用で、記録の変更を見て読み直す。
  const intents = new IntentTreeProvider(recordFolders, async () => {
    const { rates, asOf, premium } = await loadRates(await recordFolders());
    return { rates, asOf, usdJpyRate: config().get<number>("usdJpyRate", 150), costFactor: premiumFactor(premium) };
  });
  const intentView = vscode.window.createTreeView("aidlcToolkit.intents", {
    treeDataProvider: intents,
    showCollapseAll: true,
  });
  const reloadIntents = async (): Promise<void> => {
    intentView.message = await intents.reload();
    intentView.description = intents.activeLabel();
  };

  context.subscriptions.push(
    statusItem,
    usageTree,
    usageView,
    intentView,
    intents,
    vscode.commands.registerCommand("aidlcToolkit.usage.show", () => showPanel(context)),
    vscode.commands.registerCommand("aidlcToolkit.usage.refresh", () => void refresh()),
    vscode.commands.registerCommand("aidlcToolkit.intents.refresh", () => void reloadIntents()),
    vscode.commands.registerCommand("aidlcToolkit.intents.openState", (node: Node) => void openState(node)),
    vscode.commands.registerCommand("aidlcToolkit.intents.copyName", (node: Node) => void copyName(node)),
  );

  // 記録の監視は、ワークスペースのフォルダごとに置く。フォルダが増減したら置き直す。
  let watchers: vscode.Disposable[] = [];
  const watch = (): void => {
    for (const w of watchers) w.dispose();
    watchers = (vscode.workspace.workspaceFolders ?? []).flatMap((folder) => {
      const stateWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          folder,
          "aidlc/{active-space,spaces/*/intents/**/{aidlc-state.md,intents.json,project-description.json,active-intent}}",
        ),
      );
      const onStateChanged = (): void => intents.scheduleReload(reloadIntents);
      // audit は stage の完了ごとに使用量が書かれるので、変わったら今月の使用量と intent の金額を出し直す。
      // audit が変えるのは金額だけなので、一覧は読み直さず、使用量（今月）と同じ時に金額を出し直す。
      const auditWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, "aidlc/spaces/*/intents/**/audit/*.md"),
      );
      const onAuditChanged = (): void => scheduleRefresh(() => void intents.reprice());
      return [
        stateWatcher,
        stateWatcher.onDidCreate(onStateChanged),
        stateWatcher.onDidChange(onStateChanged),
        stateWatcher.onDidDelete(onStateChanged),
        auditWatcher,
        auditWatcher.onDidCreate(onAuditChanged),
        auditWatcher.onDidChange(onAuditChanged),
        auditWatcher.onDidDelete(onAuditChanged),
      ];
    });
  };
  watch();
  context.subscriptions.push(
    { dispose: () => watchers.forEach((w) => w.dispose()) },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watch();
      void refresh();
      void reloadIntents();
    }),
  );

  // 上乗せの ON/OFF や換算レートなどの設定が変わったら、
  // 使用量（今月）と intent の金額を、待たずに同時に出し直す。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("aidlcToolkit")) return;
      void refresh();
      void intents.reprice();
    }),
  );

  void refresh();
  void reloadIntents();
  activateDoctor(context);
}

export function deactivate(): void {
  if (timer) clearTimeout(timer);
}

function config() {
  return vscode.workspace.getConfiguration("aidlcToolkit");
}

// 診断のビュー。実行はボタンを押したときだけ。結果はフォルダごとに doctorTree.ts が持つ。
function activateDoctor(context: vscode.ExtensionContext): void {
  const doctor = new DoctorTreeProvider();
  const view = vscode.window.createTreeView("aidlcToolkit.doctor", { treeDataProvider: doctor });
  const output = vscode.window.createOutputChannel("AI-DLC Toolkit");
  // 見出しのバッジ（失敗と警告の件数）は、結果が変わるたびに出し直す。
  const onChange = doctor.onDidChangeTreeData(() => {
    view.badge = doctor.badge();
  });

  // 記録のあるフォルダに合わせて一覧を置き直す。信頼していないフォルダは、実行せず「信頼していない」と出す。
  const syncFolders = async (): Promise<void> => {
    const folders = await recordFolders();
    doctor.setFolders(folders);
    for (const folder of folders) {
      if (!vscode.workspace.isTrusted) doctor.setState(folder, { kind: "untrusted" });
      else if (doctor.stateOf(folder).kind === "untrusted") doctor.setState(folder, { kind: "never" });
    }
  };

  const runAll = async (): Promise<void> => {
    const folders = await recordFolders();
    doctor.setFolders(folders);
    for (const folder of folders) {
      if (!vscode.workspace.isTrusted) {
        doctor.setState(folder, { kind: "untrusted" });
        continue;
      }
      doctor.setState(folder, { kind: "running" });
      const outcome = await runDoctor(folder.root, config().get<string>("aidlcPath", ""));
      doctor.setState(folder, toFolderState(outcome));
    }
  };

  context.subscriptions.push(
    doctor,
    view,
    onChange,
    output,
    vscode.workspace.onDidChangeWorkspaceFolders(() => void syncFolders()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void syncFolders()),
    vscode.commands.registerCommand("aidlcToolkit.doctor.run", () => void runAll()),
    vscode.commands.registerCommand("aidlcToolkit.doctor.toggleOk", () => doctor.toggleOk()),
    vscode.commands.registerCommand("aidlcToolkit.doctor.copyAll", () =>
      void copyText(doctor.copyText(), "診断の結果をコピーしました"),
    ),
    vscode.commands.registerCommand("aidlcToolkit.doctor.copyItem", (node: DoctorNode) => {
      if (node.kind === "item") void copyText(node.check.label, "項目をコピーしました");
    }),
    vscode.commands.registerCommand("aidlcToolkit.doctor.copyFix", (node: DoctorNode) => {
      if (node.kind === "item" || node.kind === "fix") void copyText(node.check.fix ?? "", "直し方をコピーしました");
    }),
    // 読めなかった出力は、そのまま出力パネルに出す。画面の中には出さない。
    vscode.commands.registerCommand("aidlcToolkit.doctor.showOutput", (folder: Folder) => {
      const state = doctor.stateOf(folder);
      if (state.kind !== "unreadable") return;
      output.clear();
      output.append(state.raw);
      output.show(true);
    }),
  );
  void syncFolders();
}

// 実行の結果を、ツリーの状態に直す。
function toFolderState(outcome: RunOutcome): FolderState {
  if (outcome.kind === "missing") return { kind: "missing" };
  if (outcome.kind === "error") return { kind: "error", message: outcome.message };
  const parsed = parseDoctorJson(outcome.stdout);
  return parsed.ok
    ? { kind: "result", at: new Date(), result: parsed.result }
    : { kind: "unreadable", reason: parsed.reason, raw: outcome.stdout };
}

async function copyText(text: string, done: string): Promise<void> {
  if (!text) {
    vscode.window.setStatusBarMessage("コピーする結果がありません", 2000);
    return;
  }
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(done, 2000);
}

// AI-DLC の記録があるワークスペースのフォルダ。
async function recordFolders(): Promise<Folder[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const found = await Promise.all(folders.map(async (f) => ((await hasRecords(f.uri.fsPath)) ? f : undefined)));
  return found.filter((f) => f !== undefined).map((f) => ({ root: f.uri.fsPath, name: f.name }));
}

// 記録が無いあいだは、アクティビティバーのビューとステータスバーを出さない。
function updateVisibility(folders: Folder[]): void {
  const has = folders.length > 0;
  void vscode.commands.executeCommand("setContext", "aidlcToolkit.hasRecords", has);
  if (has) statusItem.show();
  else statusItem.hide();
}

// 単価表を読む。無ければ空。
// JSON として読めないときは、エラーの全文（ファイルの先頭の一部が入る）ではなく、読めなかったことだけを伝える。
// modelRatesPath にはどのファイルでも書けるので、資格情報などの中身を画面に出さないため。
async function readRatesFile(file: string): Promise<RatesFile> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new RecordError(`単価表を読めません（${file}）`);
  }
  try {
    return JSON.parse(text) as RatesFile;
  } catch {
    throw new RecordError(`単価表を JSON として読めません（${file}）`);
  }
}

// AI-DLC が用意する正の単価表（同梱の単価表より優先する）。設定 aidlcToolkit.modelRatesPath が空なら、
// 記録があるフォルダごとの .claude/tools/data/model-rates.json を、先のフォルダを優先して重ねる。
async function readExtraRates(folders: Folder[]): Promise<RatesFile> {
  const configured = config().get<string>("modelRatesPath", "").trim();
  const files = configured
    ? [configured]
    : folders.map((f) => path.join(f.root, ".claude", "tools", "data", "model-rates.json"));
  const tables = await Promise.all(files.map(readRatesFile));
  return { rates: Object.assign({}, ...tables.map((t) => t.rates ?? {}).reverse()) };
}

// 単価は、ワークスペースの .claude/ の単価表（AI-DLC が用意する正の表）→ 拡張機能に同梱の単価表（足りないモデルだけ）
// → 設定 aidlcToolkit.modelRates の順に重ね、先のものを優先する。同梱の単価表は読むだけで、個人の単価は設定に書く。
// 日本国内クロスリージョン推論の上乗せが ON（設定 aidlcToolkit.regionalPremium）なら、設定の行も含めて全部の単価に掛ける。
// 長文の単価は使わない（audit からは呼び出し 1 回ごとのプロンプトの長さが分からない）。
async function loadRates(folders: Folder[]): Promise<{
  rates: Record<string, Rate>;
  premium: RegionalPremium;
  invalid: string[];
  asOf?: string;
}> {
  const [own, extra] = await Promise.all([
    readRatesFile(path.join(extensionDir, "model-rates.json")),
    readExtraRates(folders),
  ]);
  const merged = mergeRates(own, extra);
  const user = readUserRates(config().get("modelRates"));
  const premium = {
    enabled: config().get<boolean>("regionalPremium", false),
    rate: own.regionalPremium?.rate ?? 0.1,
  };
  const rates = { ...merged.rates, ...user.rates };
  return { rates: applyFactor(rates, premiumFactor(premium)), premium, invalid: user.invalid, asOf: own.asOf };
}

// 記録があるフォルダごとに、作業中の space の audit を全部読む。
async function readActiveAuditShards(folders: Folder[]): Promise<string[]> {
  const shards = await Promise.all(folders.map(async (f) => readSpaceAuditShards(f.root, await readActiveSpace(f.root))));
  return shards.flat();
}

let running = false;
let pending = false;

async function refresh(): Promise<void> {
  // 同時に 2 回走らせない。走行中に来た要求は終わったあと 1 回だけ回す。
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    const folders = await recordFolders();
    updateVisibility(folders);
    if (folders.length === 0) return;
    const tz = config().get<string>("timeZone", "Asia/Tokyo");
    const rate = config().get<number>("usdJpyRate", 150);
    let monthKey: string | null = null;
    try {
      monthKey = monthKeyOf(new Date().toISOString(), tz);
    } catch {
      // IANA 名でないタイムゾーンは Intl が RangeError を投げる。下で利用者向けの文言にする。
    }
    if (!monthKey) throw new RecordError(`設定 aidlcToolkit.timeZone のタイムゾーン（${tz}）が正しくありません`);

    // AI-DLC の audit の STAGE_COMPLETED を、その時刻の月で集計する。
    const [{ rates, premium, invalid, asOf }, shards] = await Promise.all([
      loadRates(folders),
      readActiveAuditShards(folders),
    ]);
    const total = summarizeAuditMonth(shards, { monthKey, timeZone: tz, rates, costFactor: premiumFactor(premium) });
    const unreadable = shards.filter((s) => !auditReadable(s)).length;
    latest = { total, rate, premium, asOf, unreadable };
    statusItem.text = `$(graph) AI-DLC 推定 ${formatJpy(total.usd, rate)}`;
    statusItem.tooltip = `${monthKey}: ${usageTooltip(asOf)}`;
    statusItem.backgroundColor = undefined;
    usageTree.update(total, rate, asOf);
    const notes = [
      unreadable > 0 ? unreadableAuditNote(unreadable) : "",
      invalid.length > 0 ? `設定 aidlcToolkit.modelRates の形が正しくない行（${invalid.join("、")}）は使っていません` : "",
      total.unpricedRows > 0 ? `単価表に無いモデルの使用量 ${total.unpricedRows} 件は金額に含めていません` : "",
    ].filter(Boolean);
    usageView.message = notes.length > 0 ? notes.join("。") : undefined;
    if (panel) panel.webview.html = renderHtml(latest);
  } catch (err) {
    const message = describeError(err);
    statusItem.text = "$(warning) AI-DLC";
    statusItem.tooltip = `使用量を集計できませんでした: ${message}`;
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    usageView.message = `使用量を集計できませんでした: ${message}`;
  } finally {
    running = false;
    if (pending) {
      pending = false;
      void refresh();
    }
  }
}

// 連続した書き込みをまとめて、最後の書き込みの 2 秒後に 1 回だけ出し直す。also は同じ時に行う処理。
function scheduleRefresh(also: () => void): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void refresh();
    also();
  }, 2000);
}

function showPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal();
  } else {
    panel = vscode.window.createWebviewPanel("aidlcToolkit.usage", "AI-DLC Toolkit: 使用量", vscode.ViewColumn.Active, {
      enableScripts: false,
    });
    panel.onDidDispose(() => (panel = undefined), null, context.subscriptions);
  }
  if (latest) {
    panel.webview.html = renderHtml(latest);
  } else {
    void refresh();
  }
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTokens(n: number): string {
  return n.toLocaleString("ja-JP");
}

function renderHtml({ total, rate, premium, asOf, unreadable }: Latest): string {
  const rows = total.buckets
    .map((b) => {
      const cacheWrite = b.counts.cacheCreate5m + b.counts.cacheCreate1h;
      return `<tr>
        <td>${esc(b.model)}</td>
        <td class="num">${fmtTokens(b.counts.input)}</td>
        <td class="num">${fmtTokens(b.counts.output)}</td>
        <td class="num">${fmtTokens(b.counts.cacheRead)}</td>
        <td class="num">${fmtTokens(cacheWrite)}</td>
        <td class="num">${b.usd === null ? "未価格" : `$${b.usd.toFixed(2)}`}</td>
        <td class="num">${b.usd === null ? "未価格" : formatJpy(b.usd, rate)}</td>
      </tr>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 16px; min-width: 220px; display: inline-block; }
  .card .label { opacity: 0.8; font-size: 12px; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .warn { color: var(--vscode-editorWarning-foreground); margin-top: 12px; }
  .note { opacity: 0.8; font-size: 12px; margin-top: 16px; line-height: 1.6; }
</style>
</head>
<body>
<h2>今月の推定コスト（${esc(total.monthKey)}）</h2>
<div class="card">
  <div class="label">作業中の space の AI-DLC の audit の、今月に完了した stage の使用量</div>
  <div class="value">${formatJpy(total.usd, rate)}</div>
  <div class="label">$${total.usd.toFixed(2)}・請求額とは一致しません</div>
</div>
${unreadable > 0 ? `<div class="warn">${esc(unreadableAuditNote(unreadable))}</div>` : ""}
<table>
  <thead><tr>
    <th>モデル</th>
    <th class="num">入力</th>
    <th class="num">出力</th>
    <th class="num">cache 読取</th>
    <th class="num">cache 書込</th>
    <th class="num">USD</th>
    <th class="num">JPY</th>
  </tr></thead>
  <tbody>
${rows || `<tr><td colspan="7">今月の利用はありません</td></tr>`}
  </tbody>
</table>
<div class="note">
  集計の元は、このワークスペースの作業中の space（aidlc/active-space）の AI-DLC の audit（aidlc/spaces/&lt;space&gt;/intents/*/audit/*.md）の STAGE_COMPLETED です。各 stage の累計の、前回の完了からの増えた分を、その行の時刻の月に入れています。<br>
  月は時刻を設定 aidlcToolkit.timeZone で見た年月で決めています。動いている途中の stage と、AI-DLC の stage の外の会話は含みません。<br>
  複数のモデルを使った stage は、丸めの無い合計を Tokens By Model の比率でモデルへ分けています。長文の単価は使っていません。<br>
  換算レート: 1 USD = ${esc(String(rate))} JPY（設定 aidlcToolkit.usdJpyRate）。<br>
  金額は単価表（拡張機能に同梱の model-rates.json${asOf ? `、${esc(asOf)} 時点の公式の標準単価` : ""}と、設定 aidlcToolkit.modelRates）の単価からの推定で、請求額とは一致しません。${
    premium.enabled
      ? `日本国内クロスリージョン推論の上乗せ（+${Math.round(premium.rate * 1000) / 10}%）を含めています。`
      : "日本国内クロスリージョン推論の上乗せは含めていません。"
  }（設定 aidlcToolkit.regionalPremium）。Web 検索などトークン以外の料金、税は含みません。<br>
  ${total.unpricedRows > 0 ? `単価表に無いモデルの使用量 ${total.unpricedRows} 件は金額に含めていません（未価格）。` : ""}
</div>
</body>
</html>`;
}
