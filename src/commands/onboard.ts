/**
 * `trellis onboard` — chains `init` → agent detection → base-agent
 * resolution → `migrate` → `sync` into one guided flow
 * (trellis-cli-onboard). Orchestrates existing commands' own
 * plan/apply logic; no new skill-copy, symlink, or conflict-detection
 * judgment is made here.
 */

import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import * as claudeCodeProbe from "../probes/claude-code.js";
import * as codexProbe from "../probes/codex.js";
import * as kiroProbe from "../probes/kiro.js";
import * as piProbe from "../probes/pi.js";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId, AgentSnapshot } from "../core/types.js";
import { INSTALL_HINTS, collectInitReport } from "./init.js";
import { applyMigratePlan, collectMigratePlan, printPlan as printMigratePlan } from "./migrate.js";
import type { MigratePlan } from "./migrate.js";
import { collectSyncReport, printReport as printSyncReport } from "./sync.js";
import type { SyncReport } from "./sync.js";

const PROBES: Record<AgentId, (homeDir: string) => Promise<AgentSnapshot>> = {
  "claude-code": (homeDir) => claudeCodeProbe.probe(homeDir),
  codex: (homeDir) => codexProbe.probe(homeDir),
  kiro: (homeDir) => kiroProbe.probe(homeDir),
  pi: (homeDir) => piProbe.probe(homeDir),
};

export interface OnboardAgentSummary {
  agent: AgentId;
  present: boolean;
  skillCount: number;
  skillNames: string[];
  /** instructionsFile exists and isn't itself a symlink — real content
   * of that agent's own to potentially migrate, not a judgment about
   * its quality or length. */
  hasRealInstructions: boolean;
}

export async function collectOnboardSummary(homeDir: string = homedir()): Promise<OnboardAgentSummary[]> {
  return Promise.all(
    ALL_AGENTS.map(async (agent) => {
      const snapshot = await PROBES[agent](homeDir);
      if (!snapshot.present) {
        return { agent, present: false, skillCount: 0, skillNames: [], hasRealInstructions: false };
      }
      const skillNames = snapshot.skillRoots.flatMap((root) => root.skills.map((s) => s.name));
      const hasRealInstructions = snapshot.instructionsFile !== undefined && !snapshot.instructionsFile.isSymlink;
      return { agent, present: true, skillCount: skillNames.length, skillNames, hasRealInstructions };
    }),
  );
}

export interface RunOnboardOptions {
  agent?: string;
  dryRun?: boolean;
  json?: boolean;
  /** Defaults to the real `~`; overridable for tests only. */
  homeDir?: string;
  /** Test-only: overrides the real `process.stdin.isTTY` check so the
   * interactive-vs-refuse branch is exercisable without a real terminal. */
  isTTY?: boolean;
  /** Test-only: replaces the real readline prompt with a scripted
   * answer, so the prompt path is exercisable without a real terminal. */
  promptForAgent?: (present: OnboardAgentSummary[]) => Promise<string>;
}

export interface OnboardResult {
  summary: OnboardAgentSummary[];
  base?: AgentId;
  baseReason?: "auto-selected" | "flag" | "prompt";
  migratePlan?: MigratePlan;
  syncReport?: SyncReport;
  refusal?: string;
  /** Only set when no agent is present — the same values `--json` and
   * text output both surface, so a machine caller doesn't have to
   * hardcode them a second time. */
  installHints?: Record<AgentId, string>;
}

async function promptForAgentReal(present: OnboardAgentSummary[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Multiple agents detected:");
    for (const s of present) {
      const skills = s.skillCount > 0 ? ` (${s.skillNames.join(", ")})` : "";
      console.log(`  ${s.agent} — ${s.skillCount} skill(s)${skills}, instructions: ${s.hasRealInstructions ? "yes" : "no"}`);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (await rl.question("Choose a base agent to migrate from: ")).trim();
      if (present.some((s) => s.agent === answer)) return answer;
      console.log(`Not one of the present agents: ${present.map((s) => s.agent).join(", ")}`);
    }
    throw new Error("no valid agent chosen after 2 attempts");
  } finally {
    rl.close();
  }
}

export async function collectOnboardPlan(opts: RunOnboardOptions = {}): Promise<OnboardResult> {
  const homeDir = opts.homeDir ?? homedir();
  await collectInitReport(homeDir);
  const summary = await collectOnboardSummary(homeDir);
  const present = summary.filter((s) => s.present);

  if (present.length === 0) {
    return { summary, installHints: { ...INSTALL_HINTS } };
  }

  let base: AgentId;
  let baseReason: OnboardResult["baseReason"];

  if (opts.agent) {
    const match = present.find((s) => s.agent === opts.agent);
    if (!match) {
      return {
        summary,
        refusal: `"${opts.agent}" is not one of the present agents (${present.map((s) => s.agent).join(", ")})`,
      };
    }
    base = match.agent;
    baseReason = "flag";
  } else if (present.length === 1) {
    base = present[0].agent;
    baseReason = "auto-selected";
  } else {
    const canPrompt = !opts.json && (opts.isTTY ?? process.stdin.isTTY === true);
    if (!canPrompt) {
      return {
        summary,
        refusal: `multiple agents detected (${present.map((s) => s.agent).join(", ")}) and no terminal to prompt in — pass --agent <id>`,
      };
    }
    const prompt = opts.promptForAgent ?? promptForAgentReal;
    try {
      base = (await prompt(present)) as AgentId;
    } catch (err) {
      return { summary, refusal: err instanceof Error ? err.message : String(err) };
    }
    baseReason = "prompt";
  }

  const migratePlan = await collectMigratePlan(base, homeDir);
  if (!opts.dryRun) {
    applyMigratePlan(migratePlan, homeDir);
  }
  const syncReport = await collectSyncReport({ homeDir, dryRun: opts.dryRun });

  return { summary, base, baseReason, migratePlan, syncReport };
}

export async function runOnboard(opts: RunOnboardOptions = {}): Promise<{ exitCode: number }> {
  const result = await collectOnboardPlan(opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result, opts.dryRun ?? false);
  }

  if (result.refusal) return { exitCode: 1 };
  const hasConflict =
    (result.migratePlan?.items.some((i) => i.action === "conflict") ?? false) ||
    (result.syncReport?.reports.some((r) => r.items.some((i) => i.action === "conflict")) ?? false);
  return { exitCode: hasConflict ? 1 : 0 };
}

function printResult(result: OnboardResult, dryRun: boolean): void {
  if (dryRun) console.log("[dry run]");

  const present = result.summary.filter((s) => s.present);
  if (present.length === 0) {
    console.log("No agent detected on this machine yet. Install one, then re-run `trellis onboard`:");
    for (const agent of ALL_AGENTS) {
      console.log(`  ${agent}: ${INSTALL_HINTS[agent]}`);
    }
    return;
  }

  if (result.refusal) {
    console.error(result.refusal);
    return;
  }

  if (result.baseReason === "auto-selected") {
    console.log(`Only ${result.base} detected — using it as the migration base.`);
  } else if (result.baseReason === "flag") {
    console.log(`Using ${result.base} as the migration base (--agent).`);
  } else if (result.baseReason === "prompt") {
    console.log(`Using ${result.base} as the migration base.`);
  }

  // Reuse `migrate`/`sync`'s own printing verbatim (including the
  // "nothing to migrate" / "already in sync" cases) rather than a second,
  // easily-drifting copy of this formatting. `dryRun: false` here since
  // this function's own leading "[dry run]" line already said so once.
  if (result.migratePlan) {
    console.log("");
    printMigratePlan(result.migratePlan, false);
  }

  if (result.syncReport) {
    console.log("\nsync");
    printSyncReport(result.syncReport, false);
  }

  console.log("\nNext: `trellis mcp sync` to distribute MCP servers, `trellis secrets audit` to check for leaked credentials.");
}
