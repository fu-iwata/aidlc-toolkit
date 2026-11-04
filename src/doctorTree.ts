// アクティビティバーの「診断」のビュー。診断の結果は doctor.ts で分類し、ここでは見せ方だけを決める。
// 実行はボタンを押したときだけ（run）。起動時や記録の変更では実行しない。
import * as vscode from "vscode";
import { type DoctorCheck, type DoctorResult, type Kind, classify, groupChecks, splitLabel } from "./doctor";
import type { Folder } from "./intentTree";

// フォルダごとの状態。結果が無いとき、実行できないとき、読めないときを分けて、それぞれ別の文言で出す。
export type FolderState =
  | { kind: "never" }
  | { kind: "running" }
  | { kind: "untrusted" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "unreadable"; reason: string; raw: string }
  | { kind: "result"; at: Date; result: DoctorResult };

export type Node =
  | { kind: "folder"; folder: Folder }
  | { kind: "message"; label: string; icon: string; tooltip?: string; command?: vscode.Command }
  | { kind: "summary"; folder: Folder; at: Date; counts: Record<Kind, number>; message: string }
  | { kind: "group"; folder: Folder; group: Kind; count: number }
  | { kind: "okToggle"; count: number }
  | { kind: "item"; folder: Folder; check: DoctorCheck; group: Kind }
  | { kind: "fix"; check: DoctorCheck };

const GROUP_NAME: Record<Kind, string> = { fail: "失敗", warn: "警告", ok: "正常" };
const GROUP_ICON: Record<Kind, string> = { fail: "error", warn: "warning", ok: "pass" };

export class DoctorTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private folders: Folder[] = [];
  private states = new Map<string, FolderState>();
  private showOk = false;

  dispose(): void {
    this.changed.dispose();
  }

  // 記録のあるフォルダを渡す。前の結果のうち、もう無いフォルダのものは捨てる。
  setFolders(folders: Folder[]): void {
    this.folders = folders;
    for (const key of [...this.states.keys()]) {
      if (!folders.some((f) => f.root === key)) this.states.delete(key);
    }
    this.changed.fire(undefined);
  }

  setState(folder: Folder, state: FolderState): void {
    this.states.set(folder.root, state);
    this.changed.fire(undefined);
  }

  stateOf(folder: Folder): FolderState {
    return this.states.get(folder.root) ?? { kind: "never" };
  }

  // 見出しのバッジ。失敗と警告の件数の合計。0 件なら出さない。
  badge(): { value: number; tooltip: string } | undefined {
    let bad = 0;
    for (const folder of this.folders) {
      const state = this.stateOf(folder);
      if (state.kind !== "result") continue;
      const groups = groupChecks(state.result.checks);
      bad += groups.fail.length + groups.warn.length;
    }
    return bad > 0 ? { value: bad, tooltip: "失敗と警告の件数" } : undefined;
  }

  toggleOk(): void {
    this.showOk = !this.showOk;
    this.changed.fire(undefined);
  }

  // 結果を、人に渡せる文字の形にする。見出しの「すべてコピー」と、同じ文面を使う。
  copyText(): string {
    const parts: string[] = [];
    for (const folder of this.folders) {
      const state = this.stateOf(folder);
      if (state.kind !== "result") continue;
      const lines = state.result.checks
        .filter((c) => classify(c) !== "ok")
        .map((c) => `[${GROUP_NAME[classify(c)]}] ${c.label}${c.fix ? `\n  fix: ${c.fix}` : ""}`);
      parts.push([`aidlc doctor (${state.result.message})`, ...lines].join("\n"));
    }
    return parts.join("\n\n");
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "folder": {
        const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon("folder");
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.tooltip) item.tooltip = node.tooltip;
        if (node.command) item.command = node.command;
        return item;
      }
      case "summary": {
        const item = new vscode.TreeItem(
          `最終実行 ${node.at.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`,
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = `失敗 ${node.counts.fail} · 警告 ${node.counts.warn} · 正常 ${node.counts.ok}`;
        item.iconPath = new vscode.ThemeIcon("history");
        item.tooltip = `aidlc doctor: ${node.message}`;
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(
          `${GROUP_NAME[node.group]}（${node.count}）`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon(GROUP_ICON[node.group]);
        return item;
      }
      case "okToggle": {
        const item = new vscode.TreeItem(`正常（${node.count}）`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("pass");
        item.tooltip = "正常の項目を表示します";
        item.command = { command: "aidlcToolkit.doctor.toggleOk", title: "正常の項目を表示" };
        return item;
      }
      case "item": {
        const [name, rest] = splitLabel(node.check.label);
        const hasFix = Boolean(node.check.fix) && node.group !== "ok";
        const item = new vscode.TreeItem(
          name,
          hasFix ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.description = rest || undefined;
        item.iconPath = new vscode.ThemeIcon(GROUP_ICON[node.group]);
        item.tooltip = new vscode.MarkdownString(
          `**${GROUP_NAME[node.group]}**: ${node.check.label}${hasFix ? `\n\n直し方: ${node.check.fix}` : ""}`,
        );
        item.contextValue = hasFix ? "doctorItemWithFix" : "doctorItem";
        return item;
      }
      case "fix": {
        const item = new vscode.TreeItem("直し方", vscode.TreeItemCollapsibleState.None);
        item.description = node.check.fix;
        item.iconPath = new vscode.ThemeIcon("tools");
        item.tooltip = `${node.check.fix}\n\n（コマンドは実行しません。右クリックでコピーできます）`;
        item.contextValue = "doctorFix";
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      if (this.folders.length === 0) return [{ kind: "message", label: "AI-DLC の記録がありません", icon: "info" }];
      if (this.folders.length === 1) return this.contentOf(this.folders[0]);
      return this.folders.map((folder) => ({ kind: "folder", folder }));
    }
    if (node.kind === "folder") return this.contentOf(node.folder);
    if (node.kind === "group") return this.itemsOf(node.folder, node.group);
    if (node.kind === "item" && node.group !== "ok" && node.check.fix) return [{ kind: "fix", check: node.check }];
    return [];
  }

  private contentOf(folder: Folder): Node[] {
    const state = this.stateOf(folder);
    switch (state.kind) {
      case "never":
        return [{ kind: "message", label: "まだ実行していません", icon: "info", tooltip: "ボタンを押すと実行します" }];
      case "running":
        return [{ kind: "message", label: "aidlc doctor を実行しています…", icon: "loading~spin" }];
      case "untrusted":
        return [
          {
            kind: "message",
            label: "信頼していないワークスペースでは実行しません",
            icon: "shield",
            tooltip: "診断は aidlc コマンドを実行するので、ワークスペースを信頼したときだけ動きます。",
          },
        ];
      case "missing":
        return [
          {
            kind: "message",
            label: "aidlc コマンドが見つかりません",
            icon: "warning",
            tooltip: "aidlcToolkit.aidlcPath に aidlc のパスを書くか、PATH に aidlc を入れてください。",
            command: { command: "workbench.action.openSettings", title: "設定を開く", arguments: ["aidlcToolkit.aidlcPath"] },
          },
        ];
      case "error":
        return [{ kind: "message", label: "診断を実行できませんでした", icon: "error", tooltip: state.message }];
      case "unreadable":
        return [
          { kind: "message", label: "診断の結果を読めません", icon: "warning", tooltip: state.reason },
          {
            kind: "message",
            label: "文字の出力を開く",
            icon: "output",
            command: { command: "aidlcToolkit.doctor.showOutput", title: "文字の出力を開く", arguments: [folder] },
          },
        ];
      case "result": {
        const groups = groupChecks(state.result.checks);
        const counts = { fail: groups.fail.length, warn: groups.warn.length, ok: groups.ok.length };
        const nodes: Node[] = [{ kind: "summary", folder, at: state.at, counts, message: state.result.message }];
        if (counts.fail === 0 && counts.warn === 0) nodes.push({ kind: "message", label: "問題はありません", icon: "pass" });
        for (const group of ["fail", "warn"] as const) {
          if (groups[group].length > 0) nodes.push({ kind: "group", folder, group, count: groups[group].length });
        }
        if (groups.ok.length > 0) {
          nodes.push(this.showOk
            ? { kind: "group", folder, group: "ok", count: groups.ok.length }
            : { kind: "okToggle", count: groups.ok.length });
        }
        return nodes;
      }
    }
  }

  private itemsOf(folder: Folder, group: Kind): Node[] {
    const state = this.stateOf(folder);
    if (state.kind !== "result") return [];
    return groupChecks(state.result.checks)[group].map((check) => ({ kind: "item", folder, check, group }));
  }
}
