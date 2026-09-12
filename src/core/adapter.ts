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

import type { AgentId, CanonicalSource, McpServerDef } from "./types.js";
import { resolveScope } from "./types.js";

export interface AdapterProbeResult {
  present: boolean;
  version?: string;
  detail?: string;
}

export interface AdapterPlanItem {
  /**
   * "create" also covers repair (wrong symlink target, or an MCP server
   * definition that differs from canonical); "remove" is the delete half
   * for skills/instructions — a Trellis-managed symlink whose canonical
   * entry is gone or was just scoped away from this agent. MCP server
   * items never use "remove" (see `kind: "mcp"` below — no ownership
   * marker exists yet to make that provably safe, trellis-mcp-sync-p2
   * design.md D7). "conflict" is either a real, non-symlink path
   * occupying a spot Trellis would otherwise touch, or an MCP server
   * refused for a collision/secrets-guard reason — reported, never acted
   * on. See `plan()`'s doc below.
   */
  action: "create" | "remove" | "conflict";
  /** Lets `trellis sync skills` / `trellis sync instructions` /
   * `trellis mcp sync` filter a full plan without changing `plan()`'s
   * signature — every adapter produces every kind it's responsible for in
   * one pass; the CLI subcommand decides which to apply, not the adapter. */
  kind: "skill" | "instructions" | "mcp";
  /** Human-readable description of one change this adapter would make
   * ("create" / "remove") or why it refused to ("conflict"). */
  description: string;
  /** What's being touched, for the collision/audit checks to reason
   * about. For `kind: "mcp"`, the config file being modified (e.g.
   * `~/.codex/config.toml`), not a per-server path — there isn't one. */
  target: string;
  /** Only set (and only meaningful) when `kind` is `"skill"` or
   * `"instructions"` and `action === "create"`: the absolute path
   * `target` should be symlinked to. Kept as a real field rather than
   * embedded in `description` — `apply()` must never have to parse prose
   * back into structured data. */
  linkTarget?: string;
  /** Only set (and only meaningful) when `kind === "mcp"` and
   * `action === "create"`: the server name and definition to write into
   * `target` (the config file) via that agent's own mechanism (JSON
   * merge or, for Codex, `src/lib/tomlSection.ts`'s splice). */
  mcpWrite?: { name: string; def: McpServerDef };
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
   * conflict, not a stale entry, and MUST instead produce a "conflict"
   * plan item so it's visible in the same report as everything else,
   * rather than only surfacing when `apply()` gets to it.
   */
  plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]>;

  /**
   * Perform the diff. Must be idempotent and safely re-runnable: applying
   * a "create" item against an already-correct symlink is a no-op, and
   * applying a "remove" item against an already-gone path is a no-op.
   *
   * MUST treat every "conflict" item as report-only: no filesystem
   * operation, and MUST NOT throw or abort the rest of the plan because
   * of it — a conflict on one item must never prevent every other, unrelated
   * item in the same plan from being applied. The caller (e.g. `trellis
   * sync`) is responsible for surfacing conflicts and failing the overall
   * command (non-zero exit), not `apply()` per item.
   */
  apply(plan: AdapterPlanItem[]): Promise<void>;

  /** Re-read the agent's own state and confirm it matches canonical. */
  verify(canonical: CanonicalSource): Promise<AdapterVerifyResult>;
}

/** Convenience used by every adapter's `plan()` — see the scope-filtering
 * obligation documented above. */
export function isInScope(id: AgentId, scope: Parameters<typeof resolveScope>[0]): boolean {
  return resolveScope(scope).includes(id);
}
