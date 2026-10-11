# Design

## Context

pi's adapter (`src/adapters/pi.ts`) is the only adapter that delivers no
native MCP config: it writes skill symlinks, the `AGENTS.md` symlink, and
the `trellis-mcp-bridge.js` extension symlink. Its header comment still
claims "pi has no native MCP client" — true when written, false since
pi 1.1.0.

Facts verified on the real machine 2026-10-11 (pi 1.1.0 installed):

- `pi mcp add/list/login/logout` manage `~/.pi/agent/mcp.json` (global)
  and `.pi/mcp.json` (trusted projects). Stored shape:
  `{ "mcpServers": { name: { command, args, env, cwd? } | { url, headers?, ... } } }`
  — no `type` discriminator; transport is inferred from `url` vs
  `command`.
- `${VAR}` expansion works in `env` values (empirical: a probe server
  received the expanded value of `${HOME}`) and per docs in `headers`
  and OAuth `clientSecret`; `!command` whole-value form also exists.
  Expansion in `url` is undocumented — not relied on.
- No file watch: external mcp.json edits require `/reload` or a session
  restart.
- OAuth tokens live in pi's own `~/.pi/agent/mcp-auth.json`, independent
  of the Trellis store.
- The real `~/.pi/agent/mcp.json` already contains a user-authored
  server (`mailbox`) — merge semantics are mandatory, never overwrite.

## Goals

- pi receives the same first-class MCP delivery as every other agent:
  gateway/direct/hub routes, scope rules, secrets policy, ownership
  ledger and conflict reporting, via `resolveMcpPlan` +
  `planJsonMcp`/`applyJsonMcp`.
- Zero duplicate delivery: the bridge symlink and native entries never
  coexist after a sync.
- Zero plaintext discipline preserved: `env` names render as `${VAR}`
  references, which pi now expands natively.
- Old pis (< 1.1.0) are unaffected.

## Non-Goals

- Deleting `src/pi-bridge/` and its build step (follow-up change after
  one release of fallback coverage).
- Project-level `.pi/mcp.json`, exposure-mode canonical fields,
  `!command` rendering.

## Decisions

### D1: Reuse `planJsonMcp` with a pi renderer; no new merge machinery

`planJsonMcp` already provides everything the pi adapter needs:
`resolveMcpPlan` for the desired set, a `render` hook for entry shape,
the ownership ledger for removal, and conflict items. The pi adapter
calls it with `configPath: ~/.pi/agent/mcp.json` and a `piRenderer`.

`piRenderer(def)` differs from `renderJsonServerEntry` only in shape:

- stdio → `{ command, args, env? }` (`env` names render as `${VAR}`,
  same as today — pi expands them; `staticEnv` literals unchanged).
  No `type: "stdio"` field (pi infers from `command`).
- http/sse → `{ url, headers? }`. No `type` field. `sse` is not a pi
  transport — sse servers render as a conflict item with remediation
  ("pi supports streamable HTTP only"), matching the
  honest-unavailability principle.
- OAuth agent-owned http → `{ url }` bare entry (headers/auth material
  stripped; `mcpPlan` already routes these as direct entries beside the
  gateway entry — the renderer simply never invents auth fields).
- OAuth trellis-owned → never reaches the renderer under gateway mode
  (it is a runtime upstream); under direct mode it is a conflict
  ("requires gateway or runtime delivery"), unchanged from today.

### D2: Version gate on the probe, bridge as fallback

`src/probes/pi.ts` already reports pi's version. The adapter parses it
semver-ish (`major.minor` compare; unparseable → treat as old):

- pi ≥ 1.1.0 → plan mcp.json items; plan the bridge symlink for
  **removal** if present (it is Trellis-owned, provable via its target
  path under `dist/pi-bridge/`), ordered after the mcp.json write in the
  plan list.
- pi < 1.1.0 or version unknown → today's behavior, byte-for-byte:
  bridge symlink planned, no mcp.json writes.

Ordering inside one apply matters: `applyJsonMcp` must land before
`applySymlinkPlan` removes the bridge, so pi is never left with zero MCP
delivery. The adapter returns items in that order; if the mcp.json write
conflicts, the removal item must not proceed (conflict aborts the apply,
same as other partial-failure paths, with the backup session for
rollback).

### D3: Duplicate-tool prevention is the migration's correctness core

If both the bridge extension and native mcp.json entries are active, pi
registers every tool twice (native `trellis` runtime tools plus the
bridge's namespaced copies). Therefore the version gate is all-or-
nothing per sync: native delivery and bridge-removal are planned
together; there is no state where both are desired.

### D4: OAuth ownership maps to pi's native login

Agent-owned OAuth servers are written as bare `{url}` entries. First
use: the user runs `pi mcp login <name>`; pi stores the grant in its own
`mcp-auth.json`. Trellis's `mcp auth`/`renew`/`doctor` already exclude
agent-owned servers (trellis-mcp-oauth-reliability), and
`trellis.mcp.status` reports them `agent-managed` — that reporting stays
accurate for pi because `oauthServers` resolution is per-agent scope,
not per-agent delivery mechanism. No OAuth code changes.

### D5: Sync prints a reload hint for pi

pi does not watch mcp.json. When a sync's pi plan contains any mcp.json
write/remove, the sync summary for pi appends: "restart pi or run
/reload to pick up MCP changes". One line, pi-specific, emitted from the
sync reporter — not from the adapter (adapters plan; the reporter
narrates).

### D6: verify() gains mcp.json drift checks

`PiAdapter.verify` re-plans the mcp.json items and flags: desired
entries missing or altered, Trellis-owned entries (per the ownership
ledger) that no longer appear in the desired set, and — for pi ≥ 1.1.0 —
a surviving bridge symlink as drift. User-authored entries are never
mismatches.

## Risks / Trade-offs

- **pi entry shape drift.** The renderer targets pi 1.1.0's documented +
  observed shape. A future pi changing shape breaks verify, not sync
  (verify is read-only). Mitigation: renderer unit tests pin the shape;
  the `pi mcp list` real-machine check is part of the release checklist.
- **Ordering guarantee is by convention.** The adapter orders plan items
  (mcp write before symlink removal); if sync ever reorders items the
  invariant breaks. Mitigation: an integration test asserts the order,
  and the removal item is skipped whenever the mcp.json write item
  conflicted in the same plan.
- **`/reload` is manual.** Users on long-running pi sessions see stale
  tool sets until reload. Accepted: the hint line covers it; auto-reload
  is pi's roadmap, not ours.

## Migration Plan

1. Implement behind the version gate; bridge fallback intact.
2. Sandbox integration tests (fixture HOME, fixture canonical, fake
   `~/.pi`) prove the full plan/apply/verify loop both ways (≥1.1.0 and
   <1.1.0).
3. Real machine: `trellis sync --dry-run` output review, then one
   authorized real sync, then `pi mcp list` as end-to-end proof (it
   spawns `trellis mcp-runtime --agent pi` and lists its tools), then
   `pi /reload` note. `pi mcp login figma` remains the user's own
   action.
4. Follow-up change (one release later): delete `src/pi-bridge/`,
   `scripts/build-pi-bridge.mjs`, the fallback gate, and the
   `pi-mcp-bridge` spec.

## Open Questions

(none — the three carried over from the evaluation were resolved
2026-10-11: `${VAR}` expansion works in env/headers; exposure mode
defaults to codemode and stays pi's choice since canonical has no such
field; no hot-reload, handled by D5.)
