# Proposal

## Why

pi 1.1.0 ships a native MCP client (`~/.pi/agent/mcp.json`, stdio +
streamable HTTP, `${VAR}` expansion in `env`/`headers` — verified against
the installed binary 2026-10-11 — native OAuth via `pi mcp login`, and
exposure modes). That removes the reason `src/pi-bridge/` exists. The
bridge is meanwhile the weakest delivery path Trellis has:

- **It drops capabilities.** The bridge forwards tools only; the
  runtime's resources, prompts and skills-over-MCP never reach pi.
- **It is degenerate under the gateway route.** Every real-machine
  route is `mode: gateway`, where the bridge spawns
  `trellis mcp-runtime --agent pi` as its single upstream — pi → bridge →
  runtime, two nested MCP hops to deliver what one native mcp.json entry
  delivers directly.
- **It misreads OAuth ownership.** The bridge attaches Trellis-store
  tokens to everything, including agent-owned servers that v0.12's
  ownership semantics say the agent's own client must authorize.

## What Changes

- The pi adapter gains a fourth managed artifact:
  `~/.pi/agent/mcp.json`, written through the shared
  `planJsonMcp`/`applyJsonMcp` machinery (ownership ledger, conflict
  detection, non-Trellis entries preserved) with a pi-shaped entry
  renderer. Gateway route → the single `trellis` runtime entry;
  direct route → one entry per in-scope server; hub route → the hub URL
  entry. All three routes become native.
- Agent-owned OAuth servers are written as bare `{url}` entries; pi's
  own `pi mcp login <name>` authorizes them into pi's own token store —
  exactly the v0.12 ownership split. Trellis-owned OAuth servers stay
  inside the runtime, unchanged.
- Delivery is gated on the probed pi version: pi ≥ 1.1.0 gets native
  mcp.json; older pis keep the bridge symlink untouched.
- When native delivery activates for a previously-bridged pi, sync
  removes the Trellis-owned bridge symlink in the same apply (the bridge
  and native entries would otherwise register every tool twice).
  `src/pi-bridge/` itself ships one more release for old-pi fallback and
  is deleted by a separate follow-up change.
- Sync prints a "restart pi or run `/reload`" hint when pi's mcp.json
  changed — pi does not watch the file (verified 2026-10-11).

## Capabilities

### New Capabilities

(none — pi delivery is a new delivery mechanism under the existing
`mcp-server-sync` capability)

### Modified Capabilities

- `mcp-server-sync`: pi joins the set of agents with native MCP config
  delivery, with pi-specific entry shapes and the version-gated bridge
  fallback.
- `pi-mcp-bridge`: deprecated — the bridge stops being delivered to
  pi ≥ 1.1.0; existing requirements are marked superseded pending the
  follow-up deletion change.

## Impact

- **Code**: `src/adapters/pi.ts` (plan/apply/verify), new
  `src/adapters/piMcp.ts` renderer + version gate, `src/probes/pi.ts`
  (version is already probed), sync output hint. No changes to
  `planJsonMcp` itself are expected — the `render` hook exists.
- **Specs**: `mcp-server-sync`, `pi-mcp-bridge`.
- **Docs**: `docs/getting-started.md`, `docs/research.md` (stale "pi has
  no native MCP client" claim), `docs/mcp-oauth-renewal.md` ownership
  table gains pi's `pi mcp login` row, `src/adapters/pi.ts` header
  comment.
- **User-facing behavior**: after sync, pi users must restart pi or run
  `/reload`; agent-owned OAuth servers (e.g. figma) need a one-time
  `pi mcp login <name>`.
- **Out of scope**: project-level `.pi/mcp.json`, an exposure-mode field
  in canonical schema, `!command` secret values, deletion of
  `src/pi-bridge/` (follow-up change after one release).
