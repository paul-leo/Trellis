/**
 * `trellis migrate --workspace` — absorbs a repo's existing project-level
 * agent config (all six agents' MCP files + root AGENTS.md) into
 * `.agents/`, then re-renders (trellis-workspace-scope group 4).
 *
 * Flow: plan (pure, `src/lib/workspaceMigrate.ts`) → refuse on unresolved
 * conflicts → one backup session named `workspace-<repo-hash>` covering
 * every write (task 4.6 — `.agents/` writes, the secret-store extraction,
 * the marker-headed AGENTS.md rewrite, and the cascade render, so a
 * single `trellis rollback` restores originals and removes generated
 * `.agents/` content) → post-migration equivalence report (task 4.7).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId } from "../core/types.js";
import { ensureGitignoreEntry, loadCanonicalSource, writeSecretsPolicyExtraction } from "../core/canonical.js";
import { openBackupSession, type BackupSession } from "../lib/backup.js";
import { writeLocalSecretValue } from "../lib/secretEnv.js";
import { findWorkspaceRoot } from "../lib/workspace.js";
import { upsertWorkspaceServer } from "../lib/workspaceConfig.js";
import { INSTRUCTIONS_MARKER } from "../lib/workspaceFiles.js";
import { recordWorkspaceRendered, renderWorkspaceManifestEntry } from "../lib/workspaceMcp.js";
import { collectWorkspaceMigratePlan, readWorkspaceAgentMcpDefsForApply } from "../lib/workspaceMigrate.js";
import type { WorkspaceMigrateItem, WorkspaceMigratePlan } from "../lib/workspaceMigrate.js";
import { collectMcpSyncReport } from "./mcp.js";
import { collectSyncReport } from "./sync.js";
import { defaultLocalSecretsEnvFilePath, DEFAULT_LOCAL_SECRETS_ENV_FILE_TILDE } from "./migrate.js";

/** Task 4.6's `<repo-hash>`: stable per checkout path, short enough to
 * stay readable in a backups listing. */
function repoHash(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
}

/**
 * Applies one plan item. MCP items go through `upsertWorkspaceServer`
 * (which serializes the snake_case shape and fills `version`); the
 * extract-secret companion write mirrors the global migrate's
 * `applyStaticEnvExtraction` — real value re-read from the SOURCE file at
 * apply time, never carried on the plan (D9). Instructions import writes
 * `.agents/AGENTS.md` and rewrites the root file marker-headed in place
 * (a `file-overwrite` op — rollback restores the original unmarked file).
 */
function applyWorkspaceMigrateItem(item: WorkspaceMigrateItem, plan: WorkspaceMigratePlan, homeDir: string, backup: BackupSession): void {
  if (item.kind === "mcp" && (item.action === "create" || item.action === "extract-secret") && item.mcpDef) {
    upsertWorkspaceServer(plan.workspaceRoot, item.name, item.mcpDef, backup);
    // Adopt the source entries: every agent file this name came from gets
    // a manifest ownership record, so the cascade render owns the entry
    // (bringing it to Trellis's canonical render) instead of conflict-
    // guarding on it as user-authored content. Without this the migration
    // would import into .agents/ and then immediately conflict on the
    // very files it absorbed.
    for (const agent of item.sources) {
      recordWorkspaceRendered(plan.workspaceRoot, agent, item.name, renderWorkspaceManifestEntry(agent, item.name, item.mcpDef), backup);
    }
    if (item.action === "extract-secret" && item.extractVarName && item.extractTargetPath && item.extractSourceKey && item.extractSourceAgent) {
      const realValue = readWorkspaceAgentMcpDefsForApply(plan.workspaceRoot, item.extractSourceAgent)
        .entries.find((e) => e.name === item.name)?.def.staticEnv?.[item.extractSourceKey];
      if (realValue !== undefined) {
        if (item.extractTargetPath === defaultLocalSecretsEnvFilePath(homeDir)) {
          ensureGitignoreEntry(join(homeDir, ".trellis", ".gitignore"), "mcp/servers.local.env", backup);
        }
        writeLocalSecretValue(item.extractTargetPath, item.extractVarName, realValue, backup);
        const policyResult = writeSecretsPolicyExtraction(join(homeDir, ".trellis", "secrets.policy.yaml"), { varName: item.extractVarName, envFilePath: DEFAULT_LOCAL_SECRETS_ENV_FILE_TILDE }, backup);
        // A failed policy write leaves the extracted var unresolvable —
        // the cascade render then refuses with a confusing conflict. Say
        // why, plainly, while the run is still honest about it.
        if (!policyResult.ok) {
          console.error(`warning: extracted ${item.extractVarName} but could not record it in secrets.policy.yaml: ${policyResult.error}`);
        }
      }
      // undefined = the source changed between plan and apply; the safe
      // def (name-only reference) is still imported, matching the global
      // migrate's "nothing left to extract" behavior.
    }
    return;
  }

  if (item.kind === "instructions" && item.action === "create" && item.sourceContent !== undefined) {
    const target = join(plan.workspaceRoot, ".agents", "AGENTS.md");
    mkdirSync(dirname(target), { recursive: true });
    backup.writeFile(target, item.sourceContent);
    // Rewrite the root file marker-headed NOW so the cascade instructions
    // sync sees current === rendered (no-op) instead of conflicting on an
    // unmarked file. Byte-identical to planWorkspaceInstructions' render.
    backup.writeFile(join(plan.workspaceRoot, "AGENTS.md"), `${INSTRUCTIONS_MARKER}\n\n${item.sourceContent}`);
  }
}

export interface RunMigrateWorkspaceOptions {
  /** Test/sandbox seam — CLI resolves via findWorkspaceRoot(cwd), falling
   * back to cwd itself so a legacy project without `.agents/` yet can
   * still be scanned (apply then creates `.agents/` through backup). */
  workspaceDir?: string;
  /** Raw `name=agentId` strings from repeated `--choose`. */
  choose?: string[];
  /** Raw `--dedup` value: `drop` (default) or `override`. */
  dedup?: string;
  dryRun?: boolean;
  json?: boolean;
  homeDir?: string;
}

export interface WorkspaceMigrateEquivalence {
  /** Per agent: server names found in its project config before the
   * migration vs. what the post-migration render now delivers. */
  agents: { agent: AgentId; before: string[]; after: string[] }[];
}

export async function runMigrateWorkspace(opts: RunMigrateWorkspaceOptions = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const workspaceRoot = opts.workspaceDir ?? findWorkspaceRoot(process.cwd()) ?? process.cwd();

  // --- flag validation (raw strings arrive from cli.ts) ---
  const choose: Record<string, AgentId> = {};
  for (const raw of opts.choose ?? []) {
    const eq = raw.indexOf("=");
    const agent = eq === -1 ? "" : raw.slice(eq + 1);
    if (eq === -1 || !(ALL_AGENTS as readonly string[]).includes(agent)) {
      console.error(`--choose must be name=agentId with agentId one of: ${ALL_AGENTS.join(", ")} (got "${raw}")`);
      return { exitCode: 1 };
    }
    choose[raw.slice(0, eq)] = agent as AgentId;
  }
  if (opts.dedup !== undefined && opts.dedup !== "drop" && opts.dedup !== "override") {
    console.error(`--dedup must be drop or override (got ${opts.dedup})`);
    return { exitCode: 1 };
  }

  const secretsPolicy = loadCanonicalSource({ homeDir, workspaceDir: null }).secretsPolicy;
  const plan = collectWorkspaceMigratePlan({ workspaceRoot, homeDir, secretsPolicy, choose, dedup: opts.dedup as "drop" | "override" | undefined });

  // Task 4.3/4.2: a real run with ANY unresolved conflict writes nothing —
  // the user resolves (via --choose, or by fixing the source) and re-runs.
  const conflicts = plan.items.filter((i) => i.action === "conflict");
  if (conflicts.length > 0 && !opts.dryRun) {
    printWorkspaceMigratePlan(plan, false);
    console.error(`\n${conflicts.length} unresolved conflict(s) — nothing was written. Resolve each and re-run.`);
    return { exitCode: 1 };
  }

  // Task 4.7's "before" half: what each agent's project config held.
  const beforeByAgent = new Map<AgentId, string[]>();
  for (const item of plan.items) {
    if (item.kind !== "mcp" || item.action === "skip-local") continue;
    for (const agent of item.sources) {
      beforeByAgent.set(agent, [...new Set([...(beforeByAgent.get(agent) ?? []), item.name])]);
    }
  }

  let equivalence: WorkspaceMigrateEquivalence | undefined;
  if (!opts.dryRun) {
    const actionable = plan.items.filter((i) => i.action === "create" || i.action === "extract-secret");
    const backup = openBackupSession(homeDir, `workspace-${repoHash(workspaceRoot)}`);
    for (const item of actionable) {
      applyWorkspaceMigrateItem(item, plan, homeDir, backup);
    }
    // Cascade render through the SAME session (task 4.6): MCP artifacts
    // for every managed agent, so one `trellis rollback` undoes the whole
    // migration. Instructions only cascade when an instructions item was
    // actually applied — scoping the side effects to what migration
    // touched, same discipline as `mcp add --workspace`'s MCP-only
    // cascade.
    await collectMcpSyncReport({ homeDir, workspaceDir: workspaceRoot, backupSession: backup });
    if (actionable.some((i) => i.kind === "instructions")) {
      await collectSyncReport({ target: "instructions", homeDir, workspaceDir: workspaceRoot, backupSession: backup });
    }
    backup.finalize();

    // Task 4.7's "after" half: a fresh dry-run render against the
    // migrated `.agents/` proves the absorbed config now delivers.
    const after = await collectMcpSyncReport({ homeDir, workspaceDir: workspaceRoot, dryRun: true });
    equivalence = {
      agents: after.reports
        .filter((r) => r.present)
        .map((r) => ({
          agent: r.agent,
          before: (beforeByAgent.get(r.agent) ?? []).sort(),
          after: r.items.filter((i) => i.kind === "mcp" && i.layer === "workspace" && i.mcpWrite).map((i) => i.mcpWrite!.name).sort(),
        }))
        .filter((a) => a.before.length > 0 || a.after.length > 0),
    };
  }

  if (opts.json) {
    console.log(JSON.stringify({ ...plan, ...(equivalence ? { equivalence } : {}) }, null, 2));
  } else {
    printWorkspaceMigratePlan(plan, opts.dryRun ?? false);
    if (equivalence) printEquivalence(equivalence);
  }

  return { exitCode: conflicts.length > 0 ? 1 : 0 };
}

export function printWorkspaceMigratePlan(plan: WorkspaceMigratePlan, dryRun: boolean): void {
  console.log(`${dryRun ? "[dry run] " : ""}migrate --workspace ${plan.workspaceRoot}`);
  if (plan.items.length === 0) {
    console.log("  nothing to migrate");
    return;
  }
  for (const item of plan.items) {
    const label = item.kind === "mcp" ? `mcp server "${item.name}"` : "instructions (AGENTS.md)";
    console.log(`  [${item.action}] ${label} — ${item.detail}`);
    if (item.defs) {
      for (const [agent, def] of Object.entries(item.defs)) {
        console.log(`      ${agent}: ${JSON.stringify(def)}`);
      }
    }
    if (item.rotationAdvisory) {
      console.log(`      ⚠ ${item.rotationAdvisory}`);
    }
    if (item.remediation) {
      console.log(`      → ${item.remediation}`);
    }
  }
}

function printEquivalence(equivalence: WorkspaceMigrateEquivalence): void {
  console.log("equivalence (before → rendered after):");
  if (equivalence.agents.length === 0) {
    console.log("  no managed agent renders workspace servers on this machine");
    return;
  }
  for (const { agent, before, after } of equivalence.agents) {
    console.log(`  ${agent}: [${before.join(", ") || "—"}] → [${after.join(", ") || "—"}]`);
  }
}
