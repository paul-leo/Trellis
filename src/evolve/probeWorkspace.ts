/**
 * probe 工作区隔离 helper(trellis-evolve 任务 13.3)。
 *
 * 探针会话必须跑在隔离环境里:mkdtemp 工作区(探针自己写文件)、staging
 * 渲染配置(agent 配置面经 host 门面 `createStaging` 渲染进 scratch home,
 * 真实 home 与 agent 原生配置逐字节不变)、重定向 agent 配置 HOME(spawn
 * env 的 HOME/XDG 指向 scratch home,探针不读用户真实配置)。probe 启动
 * 规格经 `assertNoBypassFlags` 断言不含任何审批/沙盒绕过标志(与 7.2 引擎
 * 侧 spawn 规格同一禁令:D12 不使用 bypass 标志)。
 *
 * 本模块只交付隔离与断言;选择器执行与探针任务集不在本期范围。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaging } from "../host/index.js";

/**
 * 审批/沙盒绕过标志词面:命中即拒绝。与引擎侧 7.2 断言
 * (proposer spawn 规格)同一禁令——harness2 的
 * `--dangerously-bypass-approvals-and-sandbox` 不采纳。
 */
export const PROBE_FORBIDDEN_FLAG = /dangerous|bypass|skip-permissions|yolo/i;

/** probe 启动规格:argv + 重定向 agent 配置 HOME 的 env。 */
export interface ProbeSpawnSpec {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * 断言 argv 不含任何审批/沙盒绕过标志(含则抛错并点名)。
 * 命令参数以 argv 数组传递,永不拼 shell 字符串——断言也因此只看词面。
 */
export function assertNoBypassFlags(argv: readonly string[]): void {
  for (const arg of argv) {
    if (PROBE_FORBIDDEN_FLAG.test(arg)) {
      throw new Error(`probe 规格含审批/沙盒绕过标志: ${arg}`);
    }
  }
}

/** 重定向 agent 配置 HOME 的 spawn env(配置面只从隔离 home 读)。 */
export function probeEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
  };
}

/** 构造 probe 启动规格:先断言无绕过标志,再绑定重定向 env。 */
export function probeSpawnSpec(argv: readonly string[], homeDir: string): ProbeSpawnSpec {
  assertNoBypassFlags(argv);
  return { argv, env: probeEnv(homeDir) };
}

export interface CreateProbeWorkspaceOptions {
  /** 源(真实)home——只读,配置面渲染进隔离;绝不写回。 */
  homeDir: string;
  /** 可选:把真实 workspace 树也渲染进隔离(默认不复制,探针工作区空白)。 */
  workspaceRoot?: string | null;
  /** 隔离树的落点;缺省 OS 临时目录。 */
  tmpRoot?: string;
}

export interface ProbeWorkspace {
  /** 全部隔离内容的根(mkdtemp);dispose() 整树删除,可重复调用。 */
  readonly root: string;
  /** 重定向后的 agent 配置 HOME(staging 渲染配置的 scratch home)。 */
  readonly homeDir: string;
  /** 探针会话的工作区(空白 mkdtemp 目录)。 */
  readonly workspaceDir: string;
  /** probe 启动 env(HOME/XDG 重定向到隔离 home)。 */
  readonly env: Readonly<Record<string, string>>;
  dispose(): void;
}

/**
 * 三件套一次到位:mkdtemp 工作区 + staging 渲染配置 + 重定向 HOME env。
 * staging 复制面被 NATIVE_CHECK_SURFACE 约束(凭据形态永不进隔离树,
 * 与 morphix-env 边界一致)。
 */
export function createProbeWorkspace(options: CreateProbeWorkspaceOptions): ProbeWorkspace {
  const staging = createStaging({
    homeDir: options.homeDir,
    workspaceRoot: options.workspaceRoot ?? null,
    tmpRoot: options.tmpRoot,
  });
  const workspaceDir = mkdtempSync(join(staging.root, "probe-workspace-"));
  mkdirSync(join(workspaceDir, ".config"), { recursive: true });
  return {
    root: staging.root,
    homeDir: staging.homeDir,
    workspaceDir,
    env: probeEnv(staging.homeDir),
    dispose(): void {
      // staging.dispose 删整树(workspaceDir 在其内),安全幂等。
      staging.dispose();
      rmSync(staging.root, { recursive: true, force: true });
    },
  };
}
