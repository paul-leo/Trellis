/**
 * Normalizes every chained stage's own report shape into one flat list
 * (trellis-onboard-closed-loop design.md D5) — the single source both
 * `runOnboard`'s exit code and the terminal verdict block derive from,
 * so the two can never disagree the way the five-clause inline boolean
 * this replaces once could.
 *
 * Each normalizer reads its stage's existing report type; none of them
 * re-implement conflict detection — they translate an already-computed
 * verdict (a plan item's `action`, a finding being present at all) into
 * one shared shape. A stage whose report is absent (never ran, e.g. no
 * migration source) contributes nothing, not an error.
 */

import type { AdapterPlanItem } from "../core/adapter.js";
import type { AgentId } from "../core/types.js";
import type { MigratePlan } from "./migrate.js";
import type { SyncReport } from "./sync.js";
import type { McpSyncReport } from "./mcp.js";
import type { MemorySyncResult } from "./memory.js";
import type { SecretsAuditReport } from "./secretsAudit.js";
import type { DoctorReport } from "./doctor.js";

export type VerdictSeverity = "blocked" | "warning";

export interface VerdictItem {
  stage: string;
  severity: VerdictSeverity;
  message: string;
  remediation?: string;
  agent?: AgentId;
}

function itemMessage(stage: string, agent: AgentId | undefined, description: string): VerdictItem {
  const item: VerdictItem = { stage, severity: "blocked", message: description };
  if (agent) item.agent = agent;
  return item;
}

/** Shared by `sync` and `mcp sync` — `AgentSyncReport` and
 * `AgentMcpSyncReport` are structurally identical
 * (`{ agent, present, items: AdapterPlanItem[] }`), so one function
 * serves both rather than two copies that could drift. */
function normalizePlanItems(
  stage: string,
  reports: readonly { agent: AgentId; items: readonly AdapterPlanItem[] }[] | undefined,
): VerdictItem[] {
  if (!reports) return [];
  const items: VerdictItem[] = [];
  for (const report of reports) {
    for (const item of report.items) {
      if (item.action !== "conflict") continue;
      const verdict = itemMessage(stage, report.agent, item.description);
      if (item.remediation) verdict.remediation = item.remediation;
      items.push(verdict);
    }
  }
  return items;
}

export function normalizeMigrateVerdict(plan: MigratePlan | undefined): VerdictItem[] {
  if (!plan) return [];
  const items: VerdictItem[] = [];
  for (const item of plan.items) {
    if (item.action !== "conflict") continue;
    const verdict: VerdictItem = { stage: "migrate", severity: "blocked", message: item.detail };
    if (item.remediation) verdict.remediation = item.remediation;
    items.push(verdict);
  }
  return items;
}

export function normalizeSyncVerdict(report: SyncReport | undefined): VerdictItem[] {
  return normalizePlanItems("sync", report?.reports);
}

export function normalizeMcpSyncVerdict(report: McpSyncReport | undefined): VerdictItem[] {
  return normalizePlanItems("mcp sync", report?.reports);
}

/**
 * The self-verification re-plan (design.md D2b): a re-plan run
 * immediately after a real apply, against the state that apply just
 * wrote. Any remaining `"create"`/`"conflict"` item here means the
 * write itself did not hold — distinct from, and always `blocked`
 * regardless of what the original apply reported, because it directly
 * contradicts this run's own claim of having written it.
 */
export function normalizeSelfVerificationVerdict(
  stage: "sync" | "mcp sync",
  reports: readonly { agent: AgentId; items: readonly AdapterPlanItem[] }[] | undefined,
): VerdictItem[] {
  if (!reports) return [];
  const items: VerdictItem[] = [];
  for (const report of reports) {
    for (const item of report.items) {
      if (item.action !== "create" && item.action !== "conflict") continue;
      items.push({
        stage: `${stage} (verify)`,
        severity: "blocked",
        agent: report.agent,
        message: `expected to have written "${item.target}" but a re-plan still finds it outstanding: ${item.description}`,
        remediation: `re-run \`trellis ${stage === "sync" ? "sync" : "mcp sync"}\` and, if this repeats, check for a filesystem permission or symlink problem at ${item.target}`,
      });
    }
  }
  return items;
}

export function normalizeMemorySyncVerdict(result: MemorySyncResult | undefined): VerdictItem[] {
  if (!result) return [];
  if (!result.configured) {
    return [{ stage: "memory sync", severity: "warning", message: result.reason }];
  }
  const items: VerdictItem[] = [];
  for (const item of result.plan.items) {
    if (item.action !== "conflict") continue;
    items.push({ stage: "memory sync", severity: "blocked", message: item.detail });
  }
  return items;
}

export function normalizeSecretsAuditVerdict(report: SecretsAuditReport | undefined): VerdictItem[] {
  if (!report) return [];
  return report.findings.map((finding) => {
    const item: VerdictItem = { stage: "secrets audit", severity: "blocked", message: `${finding.file}: ${finding.detail}` };
    if (finding.agent !== "environment") item.agent = finding.agent;
    return item;
  });
}

/**
 * A finding naming an agent outside the managed set is a `warning`, not
 * `blocked` — onboard did not touch that agent, so its drift is not this
 * run's failure (design.md D3). A finding with no `agent` at all (only
 * cross-agent `"drift"`, per `src/commands/doctor.ts`'s own findings
 * construction) is conservatively `blocked`: it inherently spans more
 * than one agent, and there is no way to prove none of them are managed.
 */
/** Any path under `homeDir` prints as `~/…` rather than an absolute
 * scratch/real path — the run's own `homeDir`, never `homedir()`, so a
 * test's scratch home abbreviates the same way a real run does. */
function abbreviate(text: string, homeDir: string): string {
  return text.split(homeDir).join("~");
}

/**
 * Always the last thing `printResult` prints, on every run including a
 * fully clean one — the exact regression this change exists to fix: a
 * run with a real early-stage conflict must not end on a later stage's
 * unrelated success line (trellis-onboard-closed-loop spec: "Every run
 * terminates in a verdict that matches its exit code").
 */
export function printVerdict(verdict: readonly VerdictItem[], homeDir: string): void {
  const blocked = verdict.filter((item) => item.severity === "blocked");
  const warnings = verdict.filter((item) => item.severity === "warning");

  console.log("");
  console.log("verdict");

  if (blocked.length === 0 && warnings.length === 0) {
    console.log("✅ nothing needs attention — every stage completed cleanly and verified");
    console.log("exit code: 0 — nothing blocked this run");
    return;
  }

  if (blocked.length > 0) {
    console.log(`❌ ${blocked.length} blocking issue(s):`);
    for (const item of blocked) {
      const where = item.agent ? `${item.stage}/${item.agent}` : item.stage;
      console.log(`   - [${where}] ${abbreviate(item.message, homeDir)}`);
      if (item.remediation) console.log(`     → ${abbreviate(item.remediation, homeDir)}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} warning(s) — did not block this run:`);
    for (const item of warnings) {
      const where = item.agent ? `${item.stage}/${item.agent}` : item.stage;
      console.log(`   - [${where}] ${abbreviate(item.message, homeDir)}`);
      if (item.remediation) console.log(`     → ${abbreviate(item.remediation, homeDir)}`);
    }
  }

  console.log(blocked.length > 0 ? "exit code: 1 — at least one blocking issue above" : "exit code: 0 — warnings only, nothing blocked this run");
}

export function normalizeDoctorVerdict(report: DoctorReport | undefined, managedAgents: readonly AgentId[]): VerdictItem[] {
  if (!report) return [];
  const managed = new Set(managedAgents);
  return report.findings.map((finding) => {
    const concernsOnlyUnmanaged = finding.agent !== undefined && !managed.has(finding.agent);
    const item: VerdictItem = { stage: "doctor", severity: concernsOnlyUnmanaged ? "warning" : "blocked", message: finding.message };
    if (finding.agent) item.agent = finding.agent;
    if (concernsOnlyUnmanaged) item.remediation = `concerns "${finding.agent}", which this run does not manage — run \`trellis doctor\` directly if you want to look into it`;
    return item;
  });
}
