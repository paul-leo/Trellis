/** Runtime-first Kimi Code launcher.
 *
 * Kimi automatically discovers ~/.agents/skills. When canonical delivery is
 * `mcp`, passing one empty --skills-dir is the only documented way to replace
 * both user/project Skill roots for this launch and prevent duplicate native
 * Skill delivery. Native/both modes invoke Kimi normally.
 */

import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityDeliveryForAgent } from "../core/types.js";
import { loadCanonicalSource } from "../core/canonical.js";

export interface RunKimiOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnProcess;
}

function resolveKimiCommand(homeDir: string, env: NodeJS.ProcessEnv): string {
  const explicit = env.TRELLIS_KIMI_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const homeBinary = join(env.KIMI_CODE_HOME ?? join(homeDir, ".kimi-code"), "bin", "kimi");
  if (existsSync(homeBinary)) return homeBinary;
  try {
    return execFileSync("which", ["kimi"], { encoding: "utf8", env }).trim() || "kimi";
  } catch {
    return "kimi";
  }
}

function hasSkillsDirArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--skills-dir" || arg.startsWith("--skills-dir="));
}

export async function runKimi(args: readonly string[] = [], opts: RunKimiOptions = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const env = { ...process.env, ...(opts.env ?? {}) };
  let canonical;
  try {
    canonical = loadCanonicalSource(homeDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  const delivery = capabilityDeliveryForAgent("kimi-code", canonical.mcp);
  const runtimeOnly = delivery === "mcp";
  if (runtimeOnly && hasSkillsDirArg(args)) {
    console.error("trellis kimi: --skills-dir cannot be combined with Runtime-only delivery; change mcp.runtime.delivery.kimi-code or use native Kimi directly");
    return { exitCode: 1 };
  }

  let emptySkillsDir: string | undefined;
  const launchArgs = [...args];
  if (runtimeOnly) {
    emptySkillsDir = mkdtempSync(join(tmpdir(), "trellis-kimi-empty-skills-"));
    launchArgs.unshift("--skills-dir", emptySkillsDir);
  }

  const command = resolveKimiCommand(homeDir, env);
  const spawn = opts.spawn ?? spawnProcess;
  const child = spawn(command, launchArgs, { stdio: "inherit", env });
  const exitCode = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (emptySkillsDir) rmSync(emptySkillsDir, { recursive: true, force: true });
  return { exitCode };
}
