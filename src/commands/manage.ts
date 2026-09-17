/**
 * Explicit lifecycle management for `~/.trellis/managed.yaml`.
 *
 * Onboarding stays additive: omission must never silently revoke Trellis's
 * write authorization. Exact replacement and subtraction live here so they
 * are deliberate, visible in shell history, dry-runnable, and recoverable.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { loadCanonicalSource } from "../core/canonical.js";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId } from "../core/types.js";
import { openBackupSession } from "../lib/backup.js";

export type ManageOperation = "list" | "set" | "add" | "remove";

export interface ManagePlan {
  operation: ManageOperation;
  current: AgentId[];
  desired: AgentId[];
  added: AgentId[];
  removed: AgentId[];
  changed: boolean;
}

export interface ParsedManageArgs {
  operation: ManageOperation;
  ids?: string;
  json: boolean;
  dryRun: boolean;
}

export type ManagePlanResult = { plan: ManagePlan } | { error: string };

function stableAgents(ids: Iterable<AgentId>): AgentId[] {
  const selected = new Set(ids);
  return ALL_AGENTS.filter((id) => selected.has(id)) as AgentId[];
}

function parseAgentList(raw: string | undefined, allowNone: boolean): { agents: AgentId[] } | { error: string } {
  if (raw === undefined || raw.trim() === "") {
    return { error: `agent list is required — use a comma-separated subset of ${ALL_AGENTS.join(", ")}${allowNone ? ", or none" : ""}` };
  }
  if (raw.trim().toLowerCase() === "none") {
    return allowNone ? { agents: [] } : { error: '"none" is valid only for `trellis manage set none`' };
  }
  const tokens = raw.split(",").map((token) => token.trim()).filter(Boolean);
  const invalid = tokens.filter((token) => !(ALL_AGENTS as readonly string[]).includes(token));
  if (invalid.length > 0) {
    return { error: `unknown agent id${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")} — expected ${ALL_AGENTS.join(", ")}` };
  }
  return { agents: stableAgents(tokens as AgentId[]) };
}

export function parseManageArgs(argv: readonly string[]): ParsedManageArgs | { error: string } {
  const [rawOperation, ...rest] = argv;
  if (rawOperation !== "list" && rawOperation !== "set" && rawOperation !== "add" && rawOperation !== "remove") {
    return { error: `unknown manage operation "${rawOperation ?? "(none)"}" — expected list, set, add, or remove` };
  }
  const unknownFlags = rest.filter((arg) => arg.startsWith("--") && arg !== "--json" && arg !== "--dry-run");
  if (unknownFlags.length > 0) return { error: `unknown manage flag "${unknownFlags[0]}"` };
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  if (rawOperation === "list") {
    if (positional.length > 0) return { error: "manage list accepts no agent list" };
  } else if (positional.length !== 1) {
    return { error: `manage ${rawOperation} requires exactly one comma-separated agent list` };
  }
  return {
    operation: rawOperation,
    ids: positional[0],
    json: rest.includes("--json"),
    dryRun: rest.includes("--dry-run"),
  };
}

export function collectManagePlan(operation: ManageOperation, rawIds: string | undefined, homeDir: string = homedir()): ManagePlanResult {
  const current = stableAgents(loadCanonicalSource(homeDir).managedAgents);
  if (operation === "list") {
    return { plan: { operation, current, desired: current, added: [], removed: [], changed: false } };
  }

  const parsed = parseAgentList(rawIds, operation === "set");
  if ("error" in parsed) return parsed;
  const requested = new Set(parsed.agents);
  const desired = operation === "set"
    ? stableAgents(requested)
    : operation === "add"
      ? stableAgents([...current, ...requested])
      : stableAgents(current.filter((id) => !requested.has(id)));
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  const added = desired.filter((id) => !currentSet.has(id));
  const removed = current.filter((id) => !desiredSet.has(id));
  return {
    plan: {
      operation,
      current,
      desired,
      added,
      removed,
      changed: added.length > 0 || removed.length > 0,
    },
  };
}

export function applyManagePlan(plan: ManagePlan, homeDir: string = homedir()): void {
  if (!plan.changed || plan.operation === "list") return;
  const session = openBackupSession(homeDir, `manage-${plan.operation}`);
  session.writeFile(join(homeDir, ".trellis", "managed.yaml"), `agents: [${plan.desired.join(", ")}]\n`);
  session.finalize();
}

function displayAgents(agents: readonly AgentId[]): string {
  return agents.length > 0 ? agents.join(", ") : "(none)";
}

export function runManage(parsed: ParsedManageArgs, opts: { homeDir?: string } = {}): { exitCode: number; plan?: ManagePlan } {
  const homeDir = opts.homeDir ?? homedir();
  let result: ManagePlanResult;
  try {
    result = collectManagePlan(parsed.operation, parsed.ids, homeDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }
  if ("error" in result) {
    console.error(result.error);
    return { exitCode: 1 };
  }
  const { plan } = result;
  if (!parsed.dryRun) applyManagePlan(plan, homeDir);

  if (parsed.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else if (parsed.operation === "list") {
    console.log(`managed agents: ${displayAgents(plan.current)}`);
  } else {
    console.log(`${parsed.dryRun ? "[dry run] " : ""}managed agents: ${displayAgents(plan.current)} -> ${displayAgents(plan.desired)}`);
    if (!plan.changed) console.log("  no change");
    if (plan.added.length > 0) console.log(`  added: ${plan.added.join(", ")}`);
    if (plan.removed.length > 0) console.log(`  detached: ${plan.removed.join(", ")} (native state preserved)`);
  }
  return { exitCode: 0, plan };
}
