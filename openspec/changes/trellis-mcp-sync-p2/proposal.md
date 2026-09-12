## Why

P1 syncs skills and instructions; MCP servers are still entirely manual
per agent — exactly the shape that produced this project's own worst
incident (`MCPR_TOKEN` existing as three different values across
`secrets.env`/`config.toml`/`kiro/mcp.json` simultaneously, one silently
invalid, docs/research.md). `trellis mcp sync` is where "define an MCP
server once" actually becomes true, and where `docs/research.md`'s
hardest-won constraint gets implemented for real: Codex's `config.toml`
must be patched in place, never regenerated, because it also holds
mirasim-independent settings (model, trust levels) Trellis has no business
touching, and because a same-name collision between a static definition
and a host-injected runtime override crashes the *entire* Codex process,
not just that server.

Investigating the write mechanism before committing to one changed the
plan from what `docs/implementation-plan.md` originally sketched — see
design.md D1/D2 for the evidence: `codex mcp add`'s `--env` flag only
accepts a literal `KEY=VALUE`, which would embed a real secret value into
`config.toml` — a direct violation of "configs hold variable names, never
values" (docs/research.md "Secrets"). And both TOML libraries evaluated
(`@iarna/toml`, `smol-toml`) silently drop every comment and reformat
untouched arrays on a bare parse→stringify round-trip, confirmed by
actually running both against a fixture, not assumed. Neither is safe for
"patch in place, touch nothing else."

## What Changes

- Extend `src/core/canonical.ts`'s `loadCanonicalSource()` to read
  `~/.trellis/mcp/servers.yaml` into `CanonicalSource.mcp` (deferred from
  P1 — MCP was explicitly out of scope there).
- Add `src/adapters/codex.ts` MCP support: a small, purpose-built
  line-based TOML section locator/splicer (no TOML library) that finds
  `[mcp_servers.<name>]`'s exact line span and replaces only that span —
  reading and writing, never a whole-document reserialize.
- Add `src/adapters/claude-code.ts` / `kiro.ts` MCP support: JSON
  parse→merge→stringify under the `mcpServers` key only, preserving every
  sibling key in the parsed object untouched.
- Collision check: refuse to write (and surface a specific, actionable
  error quoting the exact Codex failure class) if a server name about to
  be written also appears in `known_host_injected`.
- Pre-write secrets guard: refuse to write any literal value matching a
  known-dangerous pattern (`glpat-`, `sk-`, `ghp_`, `mcpr_` — mirrors
  `schema/secrets.policy.example.yaml`; full, configurable policy loading
  is P3's job, this is a narrow built-in floor, not the audit command).
- Hub mode: when `canonical.mcp.hub` is set, every adapter writes exactly
  one entry instead of N, per `docs/architecture.md` "MCP hub mode."
- `src/commands/mcp.ts` (`trellis mcp sync`), wired into `src/cli.ts`.

## Capabilities

### New Capabilities

- `mcp-server-sync`: create/repair/remove/refuse semantics for MCP server
  definitions across Claude Code, Codex, and Kiro — collision detection,
  scope filtering via each server's inline `agents:` field, the pre-write
  secrets guard, and hub-mode's N-vs-one-entry branching. pi is out of
  scope (no native MCP client — that's P4's bridge, a different problem).

### Modified Capabilities

- `canonical-source-loading`: `loadCanonicalSource()` now also reads
  `~/.trellis/mcp/servers.yaml` — previously an intentionally-empty
  placeholder (P1 proposal.md: "MCP stays out of scope until P2/P4").

## Impact

- **New code**: `src/lib/tomlSection.ts` (the section locator/splicer),
  `src/adapters/*.ts` (MCP additions), `src/commands/mcp.ts`.
- **No new runtime dependency** — the TOML-library evaluation is the
  reason: neither candidate is actually safe for this file, so this
  change adds none rather than one that would corrupt comments/formatting
  outside the touched section.
- **Real writes to `~/.codex/config.toml`, `~/.claude.json`,
  `~/.kiro/settings/mcp.json`** — verified only against
  `scripts/sandbox.sh` / a scratch `$HOME`, matching P1's precedent;
  never this developer's real dotfiles.
