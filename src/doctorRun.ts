// `aidlc --project-dir <フォルダ> doctor --json` を実行する。VS Code の API には依存しない。
// シェルを通さず、引数は配列で渡す（フォルダ名に空白や記号があっても、そのまま 1 つの引数になる）。
import { type ExecFileException, execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

// doctor は数秒で終わる。固まったときに待ち続けないよう、上限を決めておく。
export const DOCTOR_TIMEOUT_MS = 60_000;
// 出力の大きさの上限。想定より大きいときは読まずに打ち切る。
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export type RunOutcome =
  | { kind: "output"; stdout: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

// 実行するコマンドの候補。設定があればそれだけ。無ければ PATH の aidlc、次に ~/.local/bin/aidlc（install.sh の既定の場所）。
export function commandCandidates(configured: string): string[] {
  const trimmed = configured.trim();
  if (trimmed) return [trimmed];
  return ["aidlc", path.join(os.homedir(), ".local", "bin", "aidlc")];
}

export function runDoctor(projectDir: string, configured: string): Promise<RunOutcome> {
  const candidates = commandCandidates(configured);
  return new Promise((resolve) => {
    const tryNext = (index: number): void => {
      if (index >= candidates.length) {
        resolve({ kind: "missing" });
        return;
      }
      execFile(
        candidates[index],
        ["--project-dir", projectDir, "doctor", "--json"],
        { timeout: DOCTOR_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && isMissing(error)) {
            tryNext(index + 1);
            return;
          }
          // 失敗のときも doctor は JSON を返すので、終了コードが 0 でなくても出力があれば結果として読む。
          if (stdout.trim()) {
            resolve({ kind: "output", stdout });
            return;
          }
          if (error?.killed) {
            resolve({ kind: "error", message: `${DOCTOR_TIMEOUT_MS / 1000} 秒以内に終わりませんでした` });
            return;
          }
          resolve({ kind: "error", message: stderr.trim() || error?.message || "出力がありませんでした" });
        },
      );
    };
    tryNext(0);
  });
}

function isMissing(error: ExecFileException): boolean {
  return error.code === "ENOENT";
}
