/**
 * 进化状态目录(trellis-evolve 任务 10.4)。
 *
 * 路径按 8.1 定案:`~/.trellis/evolve/`,与 canonical 内容面(agents.md/
 * skills/MCP 定义/memories)分离——进化子系统独占写入、只追加,`trellis
 * sync` 等读面不消费它。其下按用途分子目录:
 *   `signals/` recorder 按进程分文件追加的信号(11.1);
 *   `archive/` 运行档案:提案/探针/verdict/备份会话标识/L2 比较记录;
 *   `pending/` 待批提案存储(12.4)。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const EVOLVE_STATE_SUBDIRS = ["signals", "archive", "pending"] as const;

export function evolveStateDir(homeDir: string): string {
  return join(homeDir, ".trellis", "evolve");
}

/** 幂等创建状态目录骨架(0700);只在 `~/.trellis/evolve/` 下落盘。 */
export function ensureEvolveStateDir(homeDir: string): string {
  const root = evolveStateDir(homeDir);
  for (const name of EVOLVE_STATE_SUBDIRS) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return root;
}

function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * "加入 .gitignore 如适用":状态根本身位于 git work tree 时(如用户把
 * `~/.trellis` 收进 dotfiles 仓库),把 `evolve/` 写进状态根的
 * `.gitignore`,让只追加状态不进版本库;不在 work tree 内则什么都不
 * 做(零副作用)。幂等,重复调用不产生重复条目。
 */
export function ensureStateGitignored(homeDir: string): "added" | "present" | "not-a-repo" {
  const stateRoot = join(homeDir, ".trellis");
  if (findGitRoot(stateRoot) === null) return "not-a-repo";
  const ignorePath = join(stateRoot, ".gitignore");
  if (existsSync(ignorePath)) {
    const existing = readFileSync(ignorePath, "utf-8");
    const lines = existing.split("\n").map((line) => line.trim());
    if (lines.some((line) => line === "evolve/" || line === "/evolve/" || line === "evolve")) return "present";
    appendFileSync(ignorePath, existing.endsWith("\n") || existing.length === 0 ? "evolve/\n" : "\nevolve/\n");
    return "added";
  }
  appendFileSync(ignorePath, "evolve/\n");
  return "added";
}
