/**
 * The `/plan/<op>` + `/apply/<op>` pattern (trellis-gui spec: "A dry-run
 * plan precedes every confirmable write", "Mutating operations require
 * explicit confirmation"). Every operation below calls its own existing
 * `collect*`/`apply*` function unmodified — never a reimplementation.
 * `mcp add`/`mcp remove`/`skill add`/`skill remove` needed one small,
 * behavior-preserving split in their source files first (extracting the
 * apply-and-cascade-sync orchestration those commands already did inline
 * into an exported function — `applyMcpAddWithSync` etc. — so this
 * sidecar can get the same structured result a JSON-mode CLI run prints,
 * instead of scraping stdout or re-deriving that sequencing itself;
 * trellis-gui design.md Decision 1, tasks.md 3.1/3.2 note).
 */
import { collectSyncReport, type RunSyncOptions } from "../../../../src/commands/sync.js";
import {
  applyMcpAddWithSync,
  applyMcpRemoveWithSync,
  collectMcpAddPlan,
  collectMcpRemovePlan,
  collectMcpSyncReport,
  type McpAddRawArgs,
} from "../../../../src/commands/mcp.js";
import {
  applySkillAddWithSync,
  applySkillRemoveWithSync,
  collectSkillAddPlan,
  collectSkillRemovePlan,
} from "../../../../src/commands/skill.js";
import { applyMcpImportWithSync, collectMcpImportPlan } from "../../../../src/commands/mcpImport.js";
import { applyRollbackPlan, collectRollbackPlan, loadManifest, type RollbackReport } from "../../../../src/commands/rollback.js";
import { collectOnboardPlan, type RunOnboardOptions } from "../../../../src/commands/onboard.js";
import { readJsonBody, sendJson, type Route } from "../server.js";
import { PlanStore } from "../planStore.js";

/**
 * The wizard-submittable subset of `RunOnboardOptions` (trellis-gui
 * tasks.md 3.4/7.3) — the same non-interactive flag contract
 * `trellis onboard --agent ... --manage ... --mcp-mode ...` already
 * exposes, since every one of `collectOnboardPlan`'s interactive
 * `promptFor*` branches is already gated on `!opts.json` (verified by
 * reading every one of them: `resolveManagedAgents`, the migration-
 * source picker, `resolveInteractiveCapabilitySelection`,
 * `resolveInteractiveMemoryChoice`, the mode-change confirmation). No new
 * resolver code needed on the Trellis side — the sidecar only has to
 * always force `json: true` below and never let a caller override it, so
 * a wizard step that's missing a required choice (e.g. `manage` with
 * multiple candidates present) comes back as a `refusal` string in the
 * plan, not a hung HTTP request waiting on a terminal prompt that can
 * never be answered (this sidecar has no attached TTY at all).
 * `selectionFile` (item-level skill/MCP selection) is deliberately not
 * exposed — it names a filesystem path on the machine `trellis` itself
 * runs on, which has no meaning from a browser; a future revision can
 * add an inline-selection equivalent if the wizard needs it.
 */
type OnboardWizardInput = Pick<RunOnboardOptions, "agent" | "manage" | "mcpMode" | "hubUrl" | "gatewayAgents" | "memory" | "memoryMigrate" | "workspaceDir">;

/** Builds one `{method, pattern}` pair for a plan/apply pair sharing an
 * operation name, so every route below is the same six lines regardless
 * of which underlying command it fronts. */
function planApplyRoute<TPlan>(
  operation: string,
  planStore: PlanStore,
  homeDir: string,
  compute: (homeDir: string, body: Record<string, unknown>) => Promise<TPlan> | TPlan,
  apply: (plan: TPlan, homeDir: string) => Promise<unknown>,
): Route[] {
  return [
    {
      method: "POST",
      pattern: new RegExp(`^/plan/${operation}$`),
      handler: async (req, res) => {
        const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
        const plan = await compute(homeDir, body);
        const planId = planStore.store(operation, plan);
        sendJson(res, 200, { planId, operation, plan });
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/apply/${operation}$`),
      handler: async (req, res) => {
        const body = (await readJsonBody<{ planId?: string }>(req)) ?? {};
        const stored = body.planId ? planStore.take(body.planId, operation) : undefined;
        if (!stored) {
          sendJson(res, 400, { error: `no matching plan for "${operation}" — call POST /plan/${operation} first, then apply with the returned planId` });
          return;
        }
        const result = await apply(stored.plan as TPlan, homeDir);
        sendJson(res, 200, { operation, result });
      },
    },
  ];
}

export function createPlanApplyRoutes(homeDir: string, planStore: PlanStore): Route[] {
  return [
    // sync — mirrors `trellis sync`; collectSyncReport itself both plans
    // (dryRun: true) and applies (dryRun: false) depending on the flag.
    {
      method: "POST",
      pattern: /^\/plan\/sync$/,
      handler: async (req, res) => {
        const body = await readJsonBody<{ target?: RunSyncOptions["target"] }>(req);
        const plan = await collectSyncReport({ homeDir, dryRun: true, target: body.target });
        const planId = planStore.store("sync", plan);
        sendJson(res, 200, { planId, operation: "sync", plan });
      },
    },
    {
      method: "POST",
      pattern: /^\/apply\/sync$/,
      handler: async (req, res) => {
        const body = await readJsonBody<{ planId?: string; target?: RunSyncOptions["target"] }>(req);
        const stored = body.planId ? planStore.take(body.planId, "sync") : undefined;
        if (!stored) {
          sendJson(res, 400, { error: 'no matching plan for "sync" — call POST /plan/sync first, then apply with the returned planId' });
          return;
        }
        const result = await collectSyncReport({ homeDir, dryRun: false, target: body.target });
        sendJson(res, 200, { operation: "sync", result });
      },
    },

    // mcp-sync — same shape as sync, for the MCP-only equivalent.
    {
      method: "POST",
      pattern: /^\/plan\/mcp-sync$/,
      handler: async (_req, res) => {
        const plan = await collectMcpSyncReport({ homeDir, dryRun: true });
        const planId = planStore.store("mcp-sync", plan);
        sendJson(res, 200, { planId, operation: "mcp-sync", plan });
      },
    },
    {
      method: "POST",
      pattern: /^\/apply\/mcp-sync$/,
      handler: async (req, res) => {
        const body = await readJsonBody<{ planId?: string }>(req);
        const stored = body.planId ? planStore.take(body.planId, "mcp-sync") : undefined;
        if (!stored) {
          sendJson(res, 400, { error: 'no matching plan for "mcp-sync" — call POST /plan/mcp-sync first, then apply with the returned planId' });
          return;
        }
        const result = await collectMcpSyncReport({ homeDir, dryRun: false });
        sendJson(res, 200, { operation: "mcp-sync", result });
      },
    },

    // mcp-add — collectMcpAddPlan is pure/sync; applyMcpAddWithSync does
    // the write-then-cascade-sync `runMcpAdd` already did inline.
    ...planApplyRoute(
      "mcp-add",
      planStore,
      homeDir,
      (home, body) => collectMcpAddPlan(body.name as string | undefined, (body.raw ?? {}) as McpAddRawArgs, home),
      (plan, home) => applyMcpAddWithSync(plan as Parameters<typeof applyMcpAddWithSync>[0], { homeDir: home, dryRun: false }),
    ),

    // mcp-remove
    ...planApplyRoute(
      "mcp-remove",
      planStore,
      homeDir,
      (home, body) => collectMcpRemovePlan(body.name as string, home),
      (plan, home) => applyMcpRemoveWithSync(plan as Parameters<typeof applyMcpRemoveWithSync>[0], { homeDir: home, dryRun: false }),
    ),

    // mcp-import — collectMcpImportPlan reads the source JSON file fresh
    // each time (plan.source carries the original path forward, so apply
    // doesn't need the request body a second time); applyMcpImportWithSync
    // mirrors applyMcpAddWithSync's own cascade-sync-after-apply pattern.
    ...planApplyRoute(
      "mcp-import",
      planStore,
      homeDir,
      (home, body) => collectMcpImportPlan(body.path as string, home),
      (plan, home) => applyMcpImportWithSync((plan as { source: string }).source, { homeDir: home, dryRun: false }),
    ),

    // skill-add
    ...planApplyRoute(
      "skill-add",
      planStore,
      homeDir,
      (home, body) => collectSkillAddPlan(body.name as string, body.fromPath as string, home),
      (plan, home) => applySkillAddWithSync(plan as Parameters<typeof applySkillAddWithSync>[0], { homeDir: home, dryRun: false }),
    ),

    // skill-remove
    ...planApplyRoute(
      "skill-remove",
      planStore,
      homeDir,
      (home, body) => collectSkillRemovePlan(body.name as string, home),
      (plan, home) => applySkillRemoveWithSync(plan as Parameters<typeof applySkillRemoveWithSync>[0], { homeDir: home, dryRun: false }),
    ),

    // onboard — collectOnboardPlan itself both plans (dryRun: true) and
    // applies (dryRun: false), same shape as sync/mcp-sync above. `json:
    // true` is hardcoded, never taken from the request body — see
    // OnboardWizardInput's doc comment for why that's a safety property,
    // not a preference.
    {
      method: "POST",
      pattern: /^\/plan\/onboard$/,
      handler: async (req, res) => {
        const body = (await readJsonBody<OnboardWizardInput>(req)) ?? {};
        const plan = await collectOnboardPlan({ ...body, homeDir, dryRun: true, json: true });
        const planId = planStore.store("onboard", plan);
        sendJson(res, 200, { planId, operation: "onboard", plan });
      },
    },
    {
      method: "POST",
      pattern: /^\/apply\/onboard$/,
      handler: async (req, res) => {
        const body = (await readJsonBody<{ planId?: string } & OnboardWizardInput>(req)) ?? {};
        const stored = body.planId ? planStore.take(body.planId, "onboard") : undefined;
        if (!stored) {
          sendJson(res, 400, { error: 'no matching plan for "onboard" — call POST /plan/onboard first, then apply with the returned planId' });
          return;
        }
        const { planId: _planId, ...wizardInput } = body;
        const result = await collectOnboardPlan({ ...wizardInput, homeDir, dryRun: false, json: true });
        sendJson(res, 200, { operation: "onboard", result });
      },
    },

    // rollback — `runRollback` reloads the manifest fresh at apply time
    // rather than threading it through the plan object; mirrored here
    // rather than extracting a new function, since (unlike mcp/skill
    // add/remove) there's no cascade-sync orchestration hidden behind a
    // console.log to unbury — just the two calls `runRollback` itself
    // already makes inline.
    ...planApplyRoute<RollbackReport>(
      "rollback",
      planStore,
      homeDir,
      (home, body) => collectRollbackPlan(home, body.runId as string | undefined),
      async (plan, home) => {
        const manifest = loadManifest(home, plan.runId);
        await applyRollbackPlan(home, plan.runId, manifest, plan.items);
        return plan;
      },
    ),
  ];
}
