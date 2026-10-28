// アクティビティバーの使用量（今月の推定コスト）のビュー。集計は extension.ts の refresh が行い、結果をここへ渡す。
import * as vscode from "vscode";
import { type Bucket, type Summary, formatJpy } from "./usage";

type UsageNode = { kind: "total" } | { kind: "model"; bucket: Bucket };

function fmtTokens(n: number): string {
  return n.toLocaleString("ja-JP");
}

export class UsageTreeProvider implements vscode.TreeDataProvider<UsageNode> {
  private readonly changed = new vscode.EventEmitter<UsageNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private latest: { total: Summary; rate: number; asOf?: string } | undefined;

  update(total: Summary, rate: number, asOf?: string): void {
    this.latest = { total, rate, asOf };
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.changed.dispose();
  }

  getTreeItem(node: UsageNode): vscode.TreeItem {
    const { total, rate, asOf } = this.latest as { total: Summary; rate: number; asOf?: string };
    if (node.kind === "total") {
      const item = new vscode.TreeItem(`今月（${total.monthKey}）の推定: ${formatJpy(total.usd, rate)}`);
      item.description = `$${total.usd.toFixed(2)}`;
      item.tooltip = usageTooltip(asOf);
      item.iconPath = new vscode.ThemeIcon("graph");
      item.command = { command: "aidlcToolkit.usage.show", title: "内訳を表示" };
      return item;
    }

    const { bucket } = node;
    const item = new vscode.TreeItem(bucket.model);
    item.description = bucket.usd === null ? "未価格" : `${formatJpy(bucket.usd, rate)}（$${bucket.usd.toFixed(2)}）`;
    item.tooltip = [
      `入力: ${fmtTokens(bucket.counts.input)}`,
      `出力: ${fmtTokens(bucket.counts.output)}`,
      `cache 読取: ${fmtTokens(bucket.counts.cacheRead)}`,
      `cache 書込: ${fmtTokens(bucket.counts.cacheCreate5m + bucket.counts.cacheCreate1h)}`,
    ].join("\n");
    item.iconPath = new vscode.ThemeIcon("symbol-misc");
    return item;
  }

  getChildren(node?: UsageNode): UsageNode[] {
    if (node || !this.latest) return [];
    return [
      { kind: "total" },
      ...this.latest.total.buckets.map((bucket) => ({ kind: "model" as const, bucket })),
    ];
  }
}

// 使用量の合計の説明。ステータスバーと使用量のビューで同じ文言を使う。
export function usageTooltip(asOf?: string): string {
  return (
    "作業中の space の AI-DLC の audit から、今月に完了した stage の使用量を単価表" +
    `${asOf ? `（${asOf} 時点）` : ""}で計算した推定コスト。請求額とは一致しません。クリックで内訳を表示`
  );
}
