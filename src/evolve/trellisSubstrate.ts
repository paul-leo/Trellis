/**
 * TrellisSubstrate(trellis-evolve 任务 9.1–9.3)。
 *
 * 引擎 Substrate 协议的 Trellis 实现。内部只经 `src/host/` 窄门面接入
 * 托管(单向依赖:引擎包 + host 门面,见 10.3 的边界测试):
 *
 *   surface()         → TRELLIS_SURFACE(任务 9.1)
 *   materialise()     → host 门面的 staging 上渲染候选树;真实 canonical
 *                       逐字节不动(9.2)
 *   preflight()       → 花钱前的 doctor 级自检;canonical 缺席或检查有
 *                       发现时抛错,消息带修复命令;不启动任何模型链(9.2)
 *   execute()         → 委托构造时供给的 launcher body 拉起探针会话,
 *                       每 run_id 一个 run_dir;无 launcher 即报错(9.3)
 *   read_trajectory() → 会话记录渲染为共享语法(9.3,见 trajectory.ts)
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  is_allowed,
  makeInstall,
  makeRunRequest,
  read_tree,
  type Install,
  type Launcher,
  type Path,
  type Substrate,
  type SurfaceSpec,
  type Tree,
} from "@trellis/evolve-engine";
import { createStaging, readSurface, runChecks, type Staging } from "../host/index.js";
import { TRELLIS_SURFACE } from "./surface.js";
import { applyTreeToStaging } from "./treeToCanonical.js";
import { renderSessionEvents } from "./trajectory.js";

export interface TrellisSubstrateOptions {
  homeDir: string;
  /** 进程观察到的 workspace root;null/缺省 = 只评全局层。 */
  workspaceRoot?: string | null;
  /** staging 落盘位置(测试缝,默认 OS tmpdir)。 */
  tmpRoot?: string;
  /** benchmark/探针侧供给的 launcher body(harness2 分工:substrate 拥有
   * 表面与 staging,launcher 拥有 runner 选择、env 接线与读回位置;
   * 每个 run_id 一个 run_dir 由 launcher 落地)。缺席时 execute 报错,
   * 不会退化到任何隐式 spawn。 */
  launcher?: Launcher;
}

/** preflight 的通过规则:doctor 发现除 `mcp-unreachable`(某台 server 没
 * 应答握手是信息而不是环境病)之外都阻断;secrets audit 的任何发现都阻断
 * (凭据字面值在场时不做任何探针);`sync --check` 的 pending 项不阻断 ——
 * 未同步的渲染是常态,L1 的 verdict 差集自己会看 sync 条目。 */
const PREFLIGHT_ALLOWED_DOCTOR_KINDS: ReadonlySet<string> = new Set(["mcp-unreachable"]);

export class TrellisSubstrate implements Substrate {
  readonly name = "trellis";

  private readonly homeDir: string;
  private readonly workspaceRoot: string | null;
  private readonly tmpRoot?: string;
  private readonly launcher?: Launcher;
  /** fingerprint → staging,以便 execute 结束后释放 scratch。 */
  private readonly stagings = new Map<string, Staging>();

  constructor(options: TrellisSubstrateOptions) {
    this.homeDir = options.homeDir;
    this.workspaceRoot = options.workspaceRoot ?? null;
    if (options.tmpRoot !== undefined) this.tmpRoot = options.tmpRoot;
    if (options.launcher !== undefined) this.launcher = options.launcher;
  }

  surface(): SurfaceSpec {
    return TRELLIS_SURFACE;
  }

  /**
   * 把候选树渲染到 canonical 的 scratch 副本上。离 schema 的路径是
   * materialise 错误而不是静默丢弃 —— 编辑写了什么就必须 staged 什么,
   * 否则 verdict 在评一个与候选不一致的东西。
   */
  async materialise(treeDir: Path, _spec: unknown, _ctx: Readonly<Record<string, string>>): Promise<Install> {
    const rejected: string[] = [];
    const tree: Tree = await read_tree(TRELLIS_SURFACE, treeDir, { rejected });
    if (rejected.length > 0) {
      throw new Error(`tree contains paths outside the editable surface: ${rejected.sort().join(", ")}`);
    }
    for (const rel of Object.keys(tree)) {
      if (!is_allowed(TRELLIS_SURFACE, rel)) {
        throw new Error(`tree path "${rel}" is not on the editable surface`);
      }
    }

    const staging = createStaging({
      homeDir: this.homeDir,
      workspaceRoot: this.workspaceRoot,
      ...(this.tmpRoot !== undefined ? { tmpRoot: this.tmpRoot } : {}),
    });
    try {
      applyTreeToStaging(tree, staging.homeDir);
    } catch (err) {
      staging.dispose();
      throw err;
    }

    const fingerprint = fingerprintTree(tree);
    this.stagings.set(fingerprint, staging);
    return makeInstall({
      staging_dir: staging.root,
      fingerprint,
      // 只暴露 scratch 路径:真实 home/workspace 的路径字符串都不进
      // Install —— 探针工作区不含工作区之外的用户数据,从数据结构上成立。
      extras: {
        home: staging.homeDir,
        ...(staging.workspaceRoot ? { workspace: staging.workspaceRoot } : {}),
      },
    });
  }

  /** 释放 materialise 建立的 scratch(execute 结束后由调用方触发)。 */
  releaseInstall(install: Install): void {
    const staging = this.stagings.get(install.fingerprint);
    if (staging) {
      staging.dispose();
      this.stagings.delete(install.fingerprint);
    }
  }

  /**
   * 花钱前自检:canonical 必须已初始化(否则修修复命令是 `trellis init`);
   * host 检查必须干净(否则指向 `trellis doctor` / `trellis secrets
   * audit`)。只读,不 spawn 任何模型链。
   */
  async preflight(): Promise<void> {
    try {
      readSurface({ homeDir: this.homeDir, workspaceRoot: this.workspaceRoot });
    } catch {
      throw new Error(
        `trellis-evolve preflight: no canonical source under ${join(this.homeDir, ".trellis")} — run \`trellis init\` first`,
      );
    }
    const result = await runChecks({ homeDir: this.homeDir, workspaceRoot: this.workspaceRoot });
    const failing = result.entries.filter(
      (entry) => !(entry.source === "doctor" && PREFLIGHT_ALLOWED_DOCTOR_KINDS.has(entry.kind)) && entry.source !== "sync",
    );
    if (failing.length > 0) {
      const bySource = new Map<string, number>();
      for (const entry of failing) bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + 1);
      const summary = [...bySource.entries()].map(([source, n]) => `${source}: ${n}`).join(", ");
      const remediation = [...bySource.keys()]
        .map((source) => (source === "secrets" ? "trellis secrets audit" : "trellis doctor"))
        .map((cmd) => `\`${cmd}\``)
        .join(" / ");
      const sample = failing.slice(0, 5).map((entry) => `  - ${entry.id}`).join("\n");
      throw new Error(
        `trellis-evolve preflight: ${failing.length} check finding(s) on the live surface (${summary}) — inspect with ${remediation}:\n${sample}`,
      );
    }
  }

  /**
   * 探针会话执行(harness2 原分工):委托给构造时供给的 launcher body,
   * 每个 run_id 一个 run_dir 由 launcher 落地。substrate 自己不 spawn —
   * 没有 launcher 就报错,不存在隐式默认 runner。
   */
  async execute(taskRef: string, install: Install, runIds: readonly string[], timeout: number): Promise<Path[]> {
    if (!this.launcher) {
      throw new Error(
        "TrellisSubstrate was constructed without a launcher body; the probe adapter must supply one (it owns runner choice, env wiring and read-back locations)",
      );
    }
    return this.launcher(
      makeRunRequest({ task_ref: taskRef, run_ids: runIds, timeout: Math.trunc(timeout) }),
      install,
    );
  }

  /** 会话记录渲染为共享语法(见 trajectory.ts 的捕获格式与截断语义)。 */
  async read_trajectory(streamPath: Path, opts: { obs_trunc: number; max_chars: number; args_trunc?: number }): Promise<string> {
    return renderSessionEvents(streamPath, {
      obsTrunc: opts.obs_trunc,
      maxChars: opts.max_chars,
      ...(opts.args_trunc !== undefined ? { argsTrunc: opts.args_trunc } : {}),
    });
  }
}

/** sha256 over the sorted (rel, content) pairs — digests the SOURCE tree,
 * matching Install.fingerprint's contract. */
function fingerprintTree(tree: Tree): string {
  const hash = createHash("sha256");
  for (const rel of Object.keys(tree).sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(tree[rel]!);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
