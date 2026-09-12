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
  /** "create" also covers repair (wrong symlink target); "remove" is the
   * delete half — a Trellis-managed symlink whose canonical entry is gone
   * or was just scoped away from this agent. See `plan()`'s doc below. */
  action: "create" | "remove";
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
   * Diffs canonical state against this agent's current on-disk state to
   * produce a plan. Read-only against that state — it must never write —
   * but it does read (e.g. `lstat` each target) because "create" vs.
   * "remove" vs. no-op vs. conflict can't be decided from canonical alone.
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
   *
   * MUST also produce "remove" items: an on-disk symlink whose realpath
   * resolves inside the canonical source, but whose corresponding entry no
   * longer exists in `canonical` (or was just scoped away from `this.id`)
   * is stale and belongs in the plan as a removal — not silently left
   * behind. This is the delete half of "add once, remove once, reaches
   * every agent"; a plan() that only ever emits "create" items has an
   * add-only implementation regardless of what the roadmap says.
   *
   * MUST NOT plan removal of a path that isn't a symlink Trellis can prove
   * it created (realpath outside the canonical source) — that's a real
   * conflict, not a stale entry, and belongs in a thrown error `apply()`
   * surfaces, never in a "remove" plan item.
   */
  plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]>;

  /** Perform the diff. Must be idempotent and safely re-runnable: applying
   * a "create" item against an already-correct symlink is a no-op, and
   * applying a "remove" item against an already-gone path is a no-op. */
  apply(plan: AdapterPlanItem[]): Promise<void>;

  /** Re-read the agent's own state and confirm it matches canonical. */
  verify(canonical: CanonicalSource): Promise<AdapterVerifyResult>;
}

/** Convenience used by every adapter's `plan()` — see the scope-filtering
 * obligation documented above. */
export function isInScope(id: AgentId, scope: Parameters<typeof resolveScope>[0]): boolean {
  return resolveScope(scope).includes(id);
}
