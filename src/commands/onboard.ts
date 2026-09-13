/**
 * `trellis onboard` — chains `init` → agent detection → migration-source
 * resolution → migrate-category selection (trellis-migrate-category-
 * selection) → managed-agent-set selection (install-then-manage for a
 * selected, not-yet-present agent) → `migrate` → `sync` → `mcp sync` →
 * `secrets audit` into one guided flow (trellis-cli-onboard,
 * trellis-managed-agents) — a user should never have to type a second
 * command by hand to finish onboarding. Source, categories, and managed
 * set are three independent choices (design.md D2): importing from a
 * source never writes back to it, and it is not implicitly added to the
 * managed set. Orchestrates existing commands' own plan/apply logic; no
 * new skill-copy, symlink, conflict-detection, or secrets-scanning
 * judgment is made here.
 */

import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { canUseInteractivePicker, runMultiSelectPicker, runSingleSelectPicker } from "../lib/terminalPicker.js";
import * as claudeCodeProbe from "../probes/claude-code.js";
import * as codexProbe from "../probes/codex.js";
import * as kiroProbe from "../probes/kiro.js";
import * as piProbe from "../probes/pi.js";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId, AgentSnapshot } from "../core/types.js";
import { loadCanonicalSource } from "../core/canonical.js";
import { INSTALL_HINTS, collectInitReport } from "./init.js";
import { applyMigratePlan, collectMigratePlan, printPlan as printMigratePlan } from "./migrate.js";
import type { MigrateKind, MigratePlan } from "./migrate.js";
import { collectSyncReport, printReport as printSyncReport } from "./sync.js";
import type { SyncReport } from "./sync.js";
import { collectMcpSyncReport, printReport as printMcpSyncReport } from "./mcp.js";
import type { McpSyncReport } from "./mcp.js";
import { collectSecretsAuditReport, printReport as printSecretsAuditReport } from "./secretsAudit.js";
import type { SecretsAuditReport } from "./secretsAudit.js";
import { openBackupSession } from "../lib/backup.js";
import { confirmAndInstall } from "../lib/installAgent.js";
import type { ConfirmAndInstallOptions } from "../lib/installAgent.js";

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

function hasContent(s: OnboardAgentSummary): boolean {
  return s.skillCount > 0 || s.hasRealInstructions;
}

export interface RunOnboardOptions {
  /** Non-interactive migration-source choice. */
  agent?: string;
  /** Non-interactive managed-set choice: comma-separated agent ids, or
   * the literal string "none" for "add nothing new this run" — distinct
   * from omitting the flag, which requires a prompt or refuses. */
  manage?: string;
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
  /** Test-only: replaces the real readline multi-select prompt. Returns
   * the raw answer string (same grammar as `--manage`'s value), not a
   * pre-parsed list — so the same parsing/validation code path is
   * exercised whether the answer came from a flag or a prompt. */
  promptForManagedAgents?: (candidates: OnboardAgentSummary[], alreadyManaged: readonly AgentId[]) => Promise<string>;
  /** Test-only: replaces the real migrate-category picker/default logic
   * (trellis-migrate-category-selection). An empty array is a valid
   * answer — "skip migrate for this run" (design.md D6) — distinct from
   * `source` being unresolved at all. */
  promptForMigrateCategories?: (source: OnboardAgentSummary) => Promise<MigrateKind[]>;
  /** Test-only: injected into every `confirmAndInstall` call for a
   * selected, not-yet-present agent. Never a real terminal prompt or a
   * real `npm install` in a unit test. */
  install?: ConfirmAndInstallOptions;
}

export interface OnboardInstallResult {
  agent: AgentId;
  installed: boolean;
  installable: boolean;
}

export interface OnboardResult {
  summary: OnboardAgentSummary[];
  source?: AgentId;
  sourceReason?: "auto-selected" | "flag" | "prompt";
  /** The full managed set this run acted against — the union of whatever
   * was already in `managed.yaml` plus this run's own new selections
   * that actually resolved (D3: never a subtraction). */
  managedAgents?: AgentId[];
  installResults?: OnboardInstallResult[];
  migratePlan?: MigratePlan;
  /** Set when a source was resolved but zero migrate categories were
   * selected (design.md D6) — distinct from `migratePlan` being absent
   * because no source existed at all, which prints nothing here. */
  migrateSkipped?: string;
  syncReport?: SyncReport;
  mcpSyncReport?: McpSyncReport;
  secretsAuditReport?: SecretsAuditReport;
  refusal?: string;
  /** Only set when no agent is present — the same values `--json` and
   * text output both surface, so a machine caller doesn't have to
   * hardcode them a second time. */
  installHints?: Record<AgentId, string>;
}

function agentSummaryLabel(s: OnboardAgentSummary): string {
  const skills = s.skillCount > 0 ? ` (${s.skillNames.join(", ")})` : "";
  return `${s.agent} — ${s.skillCount} skill(s)${skills}, instructions: ${s.hasRealInstructions ? "yes" : "no"}`;
}

/** Numbered-typing fallback (trellis-onboard-interactive-picker design.md
 * D2) — used only when the terminal can't support the raw-mode picker
 * (`canUseInteractivePicker()` false). Unchanged from before that change. */
async function promptForAgentNumbered(present: OnboardAgentSummary[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Multiple agents detected:");
    present.forEach((s, i) => {
      console.log(`  ${i + 1}) ${agentSummaryLabel(s)}`);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (await rl.question(`Choose a migration source [1-${present.length}]: `)).trim();
      // Accepts either the number shown or the literal agent id — the
      // latter kept so `--agent`-equivalent scripted callers piping a
      // canned answer in don't have to know the numbering.
      const byIndex = present[Number(answer) - 1];
      if (byIndex) return byIndex.agent;
      if (present.some((s) => s.agent === answer)) return answer;
      console.log(`Not a valid choice: enter a number from 1-${present.length}, or one of ${present.map((s) => s.agent).join(", ")}`);
    }
    throw new Error("no valid migration source chosen after 2 attempts");
  } finally {
    rl.close();
  }
}

/** Arrow-key single-select on a real, raw-mode-capable terminal; falls
 * back to `promptForAgentNumbered` otherwise. Resolves to the exact same
 * string contract either way — a real agent id — so `resolveMigrationSource`
 * and every test injecting `RunOnboardOptions.promptForAgent` need no
 * changes (design.md D5). Cancel (Ctrl+C) prints a message and exits
 * directly, rather than threading a new "cancelled" state through the
 * rest of onboard's return-based refusal plumbing. */
async function promptForAgentReal(present: OnboardAgentSummary[]): Promise<string> {
  if (!canUseInteractivePicker()) {
    return promptForAgentNumbered(present);
  }
  console.log("Multiple agents detected — use Up/Down (or j/k) and Enter to choose a migration source:");
  const index = await runSingleSelectPicker(present.map(agentSummaryLabel));
  if (index === null) {
    console.log("cancelled, no changes made");
    process.exit(1);
  }
  return present[index].agent;
}

/** Numbered-typing fallback — unchanged from before this change (see
 * `promptForAgentNumbered`'s doc comment). */
async function promptForManagedAgentsNumbered(candidates: OnboardAgentSummary[], alreadyManaged: readonly AgentId[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Which agents should Trellis manage? (comma-separated numbers; enter for none new)");
    candidates.forEach((s, i) => {
      const status = s.present ? `present, ${s.skillCount} skill(s)` : "not installed";
      const tag = alreadyManaged.includes(s.agent) ? " [already managed]" : "";
      console.log(`  ${i + 1}) ${s.agent} — ${status}${tag}`);
    });
    const answer = (await rl.question("Select: ")).trim();
    return answer;
  } finally {
    rl.close();
  }
}

/** Checkbox multi-select on a real, raw-mode-capable terminal; falls
 * back to `promptForManagedAgentsNumbered` otherwise. Resolves to the
 * same comma-separated-agent-id string contract `parseManagedSelection`
 * already parses — an empty selection resolves to `""` (comma-separated
 * join of zero items), which `parseManagedSelection` already treats as
 * "none" (design.md D5). Cancel behaves like `promptForAgentReal`'s. */
async function promptForManagedAgentsReal(candidates: OnboardAgentSummary[], alreadyManaged: readonly AgentId[]): Promise<string> {
  if (!canUseInteractivePicker()) {
    return promptForManagedAgentsNumbered(candidates, alreadyManaged);
  }
  console.log("Which agents should Trellis manage? Up/Down (or j/k) to move, Space to toggle, Enter to confirm:");
  const labels = candidates.map((s) => {
    const status = s.present ? `present, ${s.skillCount} skill(s)` : "not installed";
    return `${s.agent} — ${status}`;
  });
  const initiallyChecked = candidates.map((s) => alreadyManaged.includes(s.agent));
  const indices = await runMultiSelectPicker(labels, initiallyChecked);
  if (indices === null) {
    console.log("cancelled, no changes made");
    process.exit(1);
  }
  return indices.map((i) => candidates[i].agent).join(",");
}

/**
 * Resolves which categories (skills, instructions) to migrate from a
 * resolved source (trellis-migrate-category-selection). Unlike the two
 * pickers above, there is no numbered-text fallback to preserve parity
 * with — this concept never existed before this change, so "can't
 * prompt" simply means "default to whichever kind(s) actually have real
 * content, silently" (design.md D4). The picker itself is only offered
 * when the choice is meaningful — both kinds present, a capable
 * terminal, and not a `--json` run (design.md D5). An empty result is a
 * valid answer: "skip migrate for this run" (design.md D6), left for
 * the caller to act on.
 */
async function resolveMigrateCategories(source: OnboardAgentSummary, opts: RunOnboardOptions): Promise<MigrateKind[]> {
  const wantsSkills = source.skillCount > 0;
  const wantsInstructions = source.hasRealInstructions;

  // The choice is only meaningful when both kinds are real — same gate
  // for the injected test seam as for the real picker, mirroring how
  // `promptForAgent`/`promptForManagedAgents` are only ever consulted
  // when their own real prompt would actually apply.
  if (wantsSkills && wantsInstructions && !opts.json) {
    if (opts.promptForMigrateCategories) {
      return opts.promptForMigrateCategories(source);
    }
    if (canUseInteractivePicker()) {
      console.log(`Which categories should be migrated from ${source.agent}? Space to toggle, Enter to confirm:`);
      const indices = await runMultiSelectPicker(["skills", "instructions"], [true, true]);
      if (indices === null) {
        console.log("cancelled, no changes made");
        process.exit(1);
      }
      const kinds: MigrateKind[] = [];
      if (indices.includes(0)) kinds.push("skill");
      if (indices.includes(1)) kinds.push("instructions");
      return kinds;
    }
  }

  const kinds: MigrateKind[] = [];
  if (wantsSkills) kinds.push("skill");
  if (wantsInstructions) kinds.push("instructions");
  return kinds;
}

/** Shared by `--manage` and the interactive prompt's answer — same
 * grammar either way (design.md D4): a real agent id list, comma- or
 * whitespace-separated numbers referring to `candidates`' own order, or
 * the literal `none`. Never guesses on an unparseable token. */
function parseManagedSelection(raw: string, candidates: OnboardAgentSummary[]): { agents: AgentId[] } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") {
    return { agents: [] };
  }
  const tokens = trimmed.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const agents: AgentId[] = [];
  for (const token of tokens) {
    const byIndex = candidates[Number(token) - 1];
    if (byIndex) {
      agents.push(byIndex.agent);
      continue;
    }
    if ((ALL_AGENTS as readonly string[]).includes(token)) {
      agents.push(token as AgentId);
      continue;
    }
    return { error: `"${token}" is not a valid choice — use a number from 1-${candidates.length} or an agent id` };
  }
  return { agents: [...new Set(agents)] };
}

async function resolveManagedAgents(
  opts: RunOnboardOptions,
  summary: OnboardAgentSummary[],
  alreadyManaged: readonly AgentId[],
): Promise<{ newlySelected: AgentId[] } | { refusal: string }> {
  if (opts.manage !== undefined) {
    const parsed = parseManagedSelection(opts.manage, summary);
    if ("error" in parsed) return { refusal: parsed.error };
    return { newlySelected: parsed.agents };
  }

  const canPrompt = !opts.json && (opts.isTTY ?? process.stdin.isTTY === true);
  if (!canPrompt) {
    return { refusal: "no managed-agent selection given and no terminal to prompt in — pass --manage <ids> or --manage none" };
  }
  const prompt = opts.promptForManagedAgents ?? promptForManagedAgentsReal;
  const answer = await prompt(summary, alreadyManaged);
  const parsed = parseManagedSelection(answer, summary);
  if ("error" in parsed) return { refusal: parsed.error };
  return { newlySelected: parsed.agents };
}

function readManagedYaml(homeDir: string): AgentId[] {
  return loadCanonicalSource(homeDir).managedAgents as AgentId[];
}

function writeManagedYaml(homeDir: string, agents: AgentId[]): void {
  writeFileSync(join(homeDir, ".trellis", "managed.yaml"), `agents: [${agents.join(", ")}]\n`);
}

export async function collectOnboardPlan(opts: RunOnboardOptions = {}): Promise<OnboardResult> {
  const homeDir = opts.homeDir ?? homedir();
  await collectInitReport(homeDir);
  const summary = await collectOnboardSummary(homeDir);
  const present = summary.filter((s) => s.present);

  if (present.length === 0) {
    return { summary, installHints: { ...INSTALL_HINTS } };
  }

  const sourceCandidates = present.filter(hasContent);
  let source: AgentId | undefined;
  let sourceReason: OnboardResult["sourceReason"];

  if (opts.agent) {
    const match = present.find((s) => s.agent === opts.agent);
    if (!match) {
      return {
        summary,
        refusal: `"${opts.agent}" is not one of the present agents (${present.map((s) => s.agent).join(", ")})`,
      };
    }
    source = match.agent;
    sourceReason = "flag";
  } else if (sourceCandidates.length === 1) {
    source = sourceCandidates[0].agent;
    sourceReason = "auto-selected";
  } else if (sourceCandidates.length > 1) {
    const canPrompt = !opts.json && (opts.isTTY ?? process.stdin.isTTY === true);
    if (!canPrompt) {
      return {
        summary,
        refusal: `multiple agents detected (${sourceCandidates.map((s) => s.agent).join(", ")}) and no terminal to prompt in — pass --agent <id>`,
      };
    }
    const prompt = opts.promptForAgent ?? promptForAgentReal;
    try {
      source = (await prompt(sourceCandidates)) as AgentId;
    } catch (err) {
      return { summary, refusal: err instanceof Error ? err.message : String(err) };
    }
    sourceReason = "prompt";
  }
  // sourceCandidates.length === 0: nothing with real content to migrate
  // from — source stays undefined, managed-set selection still proceeds.

  const alreadyManaged = readManagedYaml(homeDir);
  const managedResult = await resolveManagedAgents(opts, summary, alreadyManaged);
  if ("refusal" in managedResult) {
    return { summary, source, sourceReason, refusal: managedResult.refusal };
  }

  const installResults: OnboardInstallResult[] = [];
  const resolvedNew: AgentId[] = [];
  for (const agent of managedResult.newlySelected) {
    const alreadyPresent = summary.find((s) => s.agent === agent)?.present ?? false;
    if (alreadyPresent) {
      resolvedNew.push(agent);
      continue;
    }
    // A selected, not-yet-present agent: install-then-manage (design.md
    // D5). `--json`/non-interactive callers still get a real confirm
    // step here (never silently installed) — with no injected `confirm`
    // and no TTY, the real readline prompt itself will simply never
    // resolve to "yes" in a non-interactive run, so nothing installs;
    // callers that want this path automated must inject `opts.install`.
    if (opts.json && !opts.install?.confirm) {
      return {
        summary,
        source,
        sourceReason,
        refusal: `"${agent}" is not installed — installing it requires a confirmation, which --json never prompts for. Inject a confirm handler or install ${agent} first.`,
      };
    }
    const result = await confirmAndInstall(agent, opts.install);
    installResults.push({ agent, installed: result.installed, installable: result.installable });
    if (result.installed) {
      resolvedNew.push(agent);
    }
    // Declined or (Kiro) not installable: excluded from this run's
    // managed set, not an abort of the rest of the flow.
  }

  const managedAgents = [...new Set([...alreadyManaged, ...resolvedNew])];
  if (!opts.dryRun) {
    writeManagedYaml(homeDir, managedAgents);
  }

  let migratePlan: MigratePlan | undefined;
  let migrateSkipped: string | undefined;
  if (source) {
    const sourceSummary = summary.find((s) => s.agent === source)!;
    const categories = await resolveMigrateCategories(sourceSummary, opts);
    if (categories.length > 0) {
      migratePlan = await collectMigratePlan(source, homeDir, categories);
      if (!opts.dryRun) {
        applyMigratePlan(migratePlan, homeDir);
      }
    } else {
      migrateSkipped = "migrate skipped — no categories selected";
    }
  }

  // One session for the whole chained run (trellis-backup-rollback) —
  // `--dry-run` opens none, there's nothing either stage will write.
  // Neither collectSyncReport nor collectMcpSyncReport finalizes a
  // session they were handed; only this caller does, once, after both.
  const backupSession = opts.dryRun ? undefined : openBackupSession(homeDir, "onboard");
  const syncReport = await collectSyncReport({ homeDir, dryRun: opts.dryRun, managedAgents, backupSession });
  const mcpSyncReport = await collectMcpSyncReport({ homeDir, dryRun: opts.dryRun, managedAgents, backupSession });
  backupSession?.finalize();
  // Read-only, no dryRun concept — same report either way, run last since
  // it audits the config mcp sync just wrote (or, on --dry-run, whatever
  // was already there before this run).
  const secretsAuditReport = await collectSecretsAuditReport({ homeDir, managedAgents });

  return {
    summary,
    source,
    sourceReason,
    managedAgents,
    installResults: installResults.length > 0 ? installResults : undefined,
    migratePlan,
    migrateSkipped,
    syncReport,
    mcpSyncReport,
    secretsAuditReport,
  };
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
    (result.syncReport?.reports.some((r) => r.items.some((i) => i.action === "conflict")) ?? false) ||
    (result.mcpSyncReport?.reports.some((r) => r.items.some((i) => i.action === "conflict")) ?? false) ||
    (result.secretsAuditReport?.findings.length ?? 0) > 0;
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

  if (result.sourceReason === "auto-selected") {
    console.log(`Only ${result.source} has real content — using it as the migration source.`);
  } else if (result.sourceReason === "flag") {
    console.log(`Using ${result.source} as the migration source (--agent).`);
  } else if (result.sourceReason === "prompt") {
    console.log(`Using ${result.source} as the migration source.`);
  } else {
    console.log("No agent has real content to migrate from — starting from canonical's placeholder.");
  }

  for (const install of result.installResults ?? []) {
    console.log(
      install.installed
        ? `Installed ${install.agent}.`
        : install.installable
          ? `${install.agent} was not installed and the install was declined — left out of this run's managed set.`
          : `${install.agent} has no npm package to install (see \`trellis init\`'s install hint) — left out of this run's managed set.`,
    );
  }
  console.log(`Managed agents: ${result.managedAgents && result.managedAgents.length > 0 ? result.managedAgents.join(", ") : "(none)"}`);

  // Reuse `migrate`/`sync`'s own printing verbatim (including the
  // "nothing to migrate" / "already in sync" cases) rather than a second,
  // easily-drifting copy of this formatting. `dryRun: false` here since
  // this function's own leading "[dry run]" line already said so once.
  if (result.migratePlan) {
    console.log("");
    printMigratePlan(result.migratePlan, false);
  } else if (result.migrateSkipped) {
    console.log("");
    console.log(result.migrateSkipped);
  }

  if (result.syncReport) {
    console.log("\nsync");
    printSyncReport(result.syncReport, false);
  }

  if (result.mcpSyncReport) {
    console.log("\nmcp sync");
    printMcpSyncReport(result.mcpSyncReport, false);
  }

  if (result.secretsAuditReport) {
    console.log("\nsecrets audit");
    printSecretsAuditReport(result.secretsAuditReport);
  }
}
