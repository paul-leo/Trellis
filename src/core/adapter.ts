/**
 * The adapter contract every agent integration (Claude Code, Codex, Kiro,
 * pi) must implement. See docs/architecture.md "Adapter contract" for the
 * rules each method must follow — in particular: `apply` must never
 * overwrite fields it doesn't own, and `verify` must re-read the agent's
 * own state rather than trust that `apply` succeeded.
 *
 * No adapter exists yet (see docs/roadmap.md P1/P2/P4). This interface is
 * the contract they'll be built against.
 */

import type { AgentId, CanonicalSource } from "./types.js";
import { resolveScope } from "./types.js";

export interface AdapterProbeResult {
  present: boolean;
  version?: string;
  detail?: string;
}

export interface AdapterPlanItem {
  /** Human-readable description of one change this adapter would make. */
  description: string;
  /** What's being touched, for the collision/audit checks to reason about. */
  target: string;
}

export interface AdapterVerifyResult {
  ok: boolean;
  /** Present only when ok is false — what didn't match canonical. */
  mismatches?: string[];
}

export interface TrellisAdapter {
  readonly name: string;
  readonly id: AgentId;

  /** Does this agent exist on this machine, and what version. No side effects. */
  probe(): Promise<AdapterProbeResult>;

  /**
   * Pure function: canonical state -> diff to apply. No I/O.
   *
   * MUST filter every scopable item (skills, subagent profiles, memory
   * entries, MCP servers) through its `scope` field before planning any
   * change for it — an item scoped away from `this.id` must produce no
   * plan item at all, not a plan item that's later skipped. Use
   * `resolveScope(item.scope).includes(this.id)`. See docs/architecture.md
   * "Private / agent-specific capabilities" — the default (`scope`
   * omitted) is "all agents," so this filter is a no-op for the common
   * case and only actually excludes anything when a capability was
   * explicitly restricted.
   */
  plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]>;

  /** Perform the diff. Must be idempotent and safely re-runnable. */
  apply(plan: AdapterPlanItem[]): Promise<void>;

  /** Re-read the agent's own state and confirm it matches canonical. */
  verify(canonical: CanonicalSource): Promise<AdapterVerifyResult>;
}

/** Convenience used by every adapter's `plan()` — see the scope-filtering
 * obligation documented above. */
export function isInScope(id: AgentId, scope: Parameters<typeof resolveScope>[0]): boolean {
  return resolveScope(scope).includes(id);
}
