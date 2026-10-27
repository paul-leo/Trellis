// sandbox.ts — harness2/core/proposer.call 内联的"穷人沙盒"原语(结构性偏差:
// Python 在 call() 内联这些机械,TS 先抽为独立模块,供 5.1 的 Proposer.call 组装)。
//
// 对应关系:
//   withSessionWorkspace ↔ tempfile.mkdtemp(prefix="harness2-prop-") + context 拷入
//                          + finally shutil.rmtree(tmp, ignore_errors=True)
//   copyTree             ↔ shutil.copytree(src, dst, dirs_exist_ok=True)
//   harvestSubpath       ↔ Proposer._harvest:收割 tmp/<sub> 到持久目录
//   runWithTimeout       ↔ subprocess.run(..., timeout=wall) 的超时杀进程语义
//                          (显式 setTimeout + SIGKILL;抛 TimeoutExpiredError)
//   safeLabel            ↔ re.sub(r"[^A-Za-z0-9_.-]+", "_", label)
//
// 4.2 验证清单落点:每次调用独立临时目录、失败清理、harvest 子路径完整、
// 超时进程确实被杀。

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";

/** Python re.sub(r"[^A-Za-z0-9_.-]+", "_", label)。 */
export function safeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

/** shutil.copytree(src, dst, dirs_exist_ok=True) 的全量拷贝语义。 */
export async function copyTree(src: string, dst: string): Promise<void> {
  await fs.cp(src, dst, { recursive: true, force: true });
}

/**
 * 在一次性会话工作目录里跑 fn:独立 mkdtemp,可选把 context_dir 拷入 <tmp>/context,
 * 无论 fn 成败都在 finally 清理(rmtree ignore_errors 语义)。
 */
export async function withSessionWorkspace<T>(
  fn: (tmp: string) => Promise<T>,
  opts: { prefix?: string; contextDir?: string | null } = {},
): Promise<T> {
  const tmp = await fs.mkdtemp(join(os.tmpdir(), opts.prefix ?? "harness2-prop-"));
  try {
    if (opts.contextDir && (await isDir(opts.contextDir))) {
      await copyTree(opts.contextDir, join(tmp, "context"));
    }
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * 会话目录销毁前把 tmp/<sub> 拷到持久位置(Proposer._harvest)。
 * src 不是目录时返回 null。dest 基目录:auditDir 或独立 mkdtemp("harness2-harvest-")。
 * 目标 `<base>/<safe>[.<cacheKey>].workspace` 先整树删再拷。
 */
export async function harvestSubpath(
  tmp: string,
  sub: string,
  label: string,
  opts: { auditDir?: string | null; cacheKey?: string } = {},
): Promise<string | null> {
  const src = join(tmp, sub);
  if (!(await isDir(src))) return null;
  const base =
    opts.auditDir && opts.auditDir.length > 0
      ? opts.auditDir
      : await fs.mkdtemp(join(os.tmpdir(), "harness2-harvest-"));
  let safe = safeLabel(label);
  if (opts.cacheKey) safe = `${safe}.${opts.cacheKey}`;
  const dest = join(base, `${safe}.workspace`);
  await fs.rm(dest, { recursive: true, force: true });
  await copyTree(src, dest);
  return dest;
}

/**
 * 标签安全化后的持久文件名基座(Proposer._paths 的 safe 部分,audit 用)。
 * 返回 `<safe>[.<cacheKey>]`。
 */
export function auditStem(label: string, cacheKey = ""): string {
  let safe = safeLabel(label);
  if (cacheKey) safe = `${safe}.${cacheKey}`;
  return safe;
}

/** Python subprocess.TimeoutExpired 的可识别形态;带 pid 供测试验证进程已死。 */
export class TimeoutExpiredError extends Error {
  readonly cmd: string;
  readonly wall: number;
  readonly pid: number | null;

  constructor(cmd: string, wall: number, pid: number | null) {
    super(`timeout after ${wall}s`);
    this.name = "TimeoutExpiredError";
    this.cmd = cmd;
    this.wall = wall;
    this.pid = pid;
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * subprocess.run(cmd, timeout=wall) 的超时语义:到点 SIGKILL,
 * 等子进程真正退出后抛 TimeoutExpiredError(故错误面世时 pid 已死)。
 * 正常结束返回 stdout/stderr(编码文本)与退出码/信号。
 */
export function runWithTimeout(
  cmd: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    wall: number;
    env?: NodeJS.ProcessEnv;
    input?: string;
  },
): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise, reject) => {
    const child = spawn(cmd, args as string[], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // subprocess.run 超时即杀;SIGKILL 确保不留活口。
      child.kill("SIGKILL");
    }, opts.wall * 1000);

    const finish = (): void => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new TimeoutExpiredError(cmd, opts.wall, child.pid ?? null));
      }
    };
    child.on("error", (e) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new TimeoutExpiredError(cmd, opts.wall, child.pid ?? null));
      } else {
        reject(e);
      }
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish();
        return;
      }
      clearTimeout(timer);
      resolvePromise({ stdout: out, stderr: err, code, signal });
    });
  });
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
