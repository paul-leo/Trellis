/**
 * Shared agent-scope selection for `skill scope` / `mcp scope`
 * (trellis-scope-editing-and-auth-status design.md D1–D3). Both commands
 * take exactly one of `--agents a,b`, `--all`, `--none`; keeping the parsing,
 * validation and normalization here means a skill and an MCP server can never
 * disagree about what a given selection means.
 */

import { ALL_AGENTS } from "../core/types.js";
import type { AgentId } from "../core/types.js";

/** Raw, unvalidated flag values — the parser stays a dumb reader and every
 * rule below lives in `resolveScopeSelection`. */
export interface ScopeSelectorRaw {
  /** Comma-separated agent ids. */
  agents?: string;
  all?: boolean;
  none?: boolean;
}

export type ScopeSelection =
  | {
      ok: true;
      /** What to record: `undefined` clears the explicit scope. */
      scope: AgentId[] | undefined;
      mode: "all" | "none" | "explicit";
      /** True when the user listed every managed agent and the explicit scope
       * was dropped instead of recorded (design.md D3). */
      normalizedFromFull: boolean;
    }
  | { ok: false; detail: string };

export const SCOPE_SELECTOR_USAGE = "exactly one of --agents <ids>, --all, --none is required";

/** `argv.indexOf`-style reader, same idiom as every other command's flags. */
export function parseScopeArgs(argv: readonly string[]): ScopeSelectorRaw {
  const i = argv.indexOf("--agents");
  return {
    ...(i >= 0 ? { agents: argv[i + 1] ?? "" } : {}),
    all: argv.includes("--all"),
    none: argv.includes("--none"),
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

export function resolveScopeSelection(raw: ScopeSelectorRaw, managed: readonly AgentId[]): ScopeSelection {
  const chosen = [raw.agents !== undefined, raw.all === true, raw.none === true].filter(Boolean).length;
  if (chosen !== 1) return { ok: false, detail: SCOPE_SELECTOR_USAGE };

  if (raw.all) return { ok: true, scope: undefined, mode: "all", normalizedFromFull: false };
  if (raw.none) return { ok: true, scope: [], mode: "none", normalizedFromFull: false };

  // An empty list is refused rather than read as "nobody": "nobody" is a real
  // choice and has its own spelling, so a blank value is almost always a slip.
  const ids = [...new Set((raw.agents ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return { ok: false, detail: "--agents must list at least one agent id (use --none for no agent at all)" };
  }

  for (const id of ids) {
    if (!(ALL_AGENTS as readonly string[]).includes(id)) {
      return { ok: false, detail: `--agents "${id}" is not a recognized agent id (${ALL_AGENTS.join(", ")})` };
    }
    // An unmanaged id would be accepted by the data model but never take
    // effect — scope is always intersected with the managed set — so writing
    // it would only leave config that looks like it does something.
    if (!managed.includes(id as AgentId)) {
      const known = managed.length > 0 ? `managed agents: ${managed.join(", ")}` : "no agents are managed yet — run `trellis onboard` first";
      return { ok: false, detail: `--agents "${id}" is not a managed agent (${known})` };
    }
  }

  // Stable on-disk order regardless of how the user typed the list.
  const scope = ALL_AGENTS.filter((id) => ids.includes(id));
  if (sameSet(scope, managed)) return { ok: true, scope: undefined, mode: "all", normalizedFromFull: true };
  return { ok: true, scope, mode: "explicit", normalizedFromFull: false };
}

/** Order-insensitive equality between the scope on disk and the one about to
 * be written, with `undefined` (no explicit scope) distinct from `[]`. */
export function sameScope(current: readonly AgentId[] | undefined, next: readonly AgentId[] | undefined): boolean {
  if (current === undefined || next === undefined) return current === next;
  return sameSet(current, next);
}

export function describeScope(scope: readonly AgentId[] | undefined, managed: readonly AgentId[]): string {
  if (scope === undefined) return `every managed agent (${managed.join(", ") || "none managed yet"})`;
  return scope.length > 0 ? scope.join(", ") : "no agent";
}
