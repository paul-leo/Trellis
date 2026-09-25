/**
 * Install-then-manage (trellis-managed-agents design.md D5): selecting a
 * not-yet-present agent into the managed set is itself the authorization
 * to install it, but never silently — one confirmation, then a real
 * `npm install -g <package>` child process. Kiro and Kimi Code use official
 * install scripts rather than an npm package and are refused before this
 * module is ever reached.
 */

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { AgentId } from "../core/types.js";

/** Only agents with a real `npm install -g <pkg>` command — Kiro's own
 * `INSTALL_HINTS` entry is a download URL, not a package, and is never
 * looked up here. */
export const NPM_INSTALLABLE: Record<Exclude<AgentId, "kiro" | "kimi-code" | "zcode">, string> = {
  "claude-code": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  pi: "@earendil-works/pi-coding-agent",
};

export interface ConfirmAndInstallOptions {
  /** Test/real seam, same pattern as onboard's `promptForAgent` — a real
   * terminal confirmation by default. */
  confirm?: (agent: AgentId, pkg: string) => Promise<boolean>;
  /** Test/real seam — never a real `npm install` in a unit test. */
  runInstall?: (pkg: string) => void;
}

async function confirmReal(agent: AgentId, pkg: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${agent} is not installed. Install it now (npm install -g ${pkg})? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function runInstallReal(pkg: string): void {
  // argv array, never a shell string — the package name is never
  // interpolated into anything a shell parses.
  execFileSync("npm", ["install", "-g", pkg], { stdio: "inherit" });
}

export interface ConfirmAndInstallResult {
  installed: boolean;
  /** False when the agent has no supported npm installation path — the
   * caller refuses it with its official installation hint instead of
   * prompting. */
  installable: boolean;
}

export async function confirmAndInstall(agent: AgentId, opts: ConfirmAndInstallOptions = {}): Promise<ConfirmAndInstallResult> {
  if (agent === "kiro" || agent === "kimi-code" || agent === "zcode") {
    return { installed: false, installable: false };
  }
  const pkg = NPM_INSTALLABLE[agent];
  const confirm = opts.confirm ?? confirmReal;
  const runInstall = opts.runInstall ?? runInstallReal;

  const agreed = await confirm(agent, pkg);
  if (!agreed) {
    return { installed: false, installable: true };
  }
  runInstall(pkg);
  return { installed: true, installable: true };
}
