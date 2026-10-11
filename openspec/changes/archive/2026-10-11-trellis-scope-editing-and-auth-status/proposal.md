# Proposal

## Why

The GUI can list skills and MCP servers and which managed agents reach them, but
it cannot change that. Scope is the central idea of Trellis ("share everywhere
by default, restrict by exception"), yet restricting a capability still means
hand-editing `scope.yaml` or `servers.yaml`. The data model and the sync engine
already support it; only the write path and the surface are missing.

Three smaller gaps surfaced while using the GUI:

- An OAuth-classified MCP server shows no sign of whether it has ever been
  authorized, so "why does this server not work" has no answer on screen.
- Doctor findings are rendered without the agent they belong to, so one problem
  that exists for three agents reads as the same finding three times.
- The two previous points share a cause: the sidecar exposes no list of managed
  agents, so the GUI cannot offer a correct set of choices.

## What Changes

- Add `trellis skill scope <name>` and `trellis mcp scope <name>` with exactly
  one of `--agents a,b`, `--all`, `--none`, plus the usual `--dry-run` / `--json`.
  The write is followed by the same cascade sync `add` / `remove` already run.
- Selecting every managed agent is normalized to "no explicit scope" so a saved
  list never silently excludes an agent managed later.
- `trellis mcp list` reports a credential state for OAuth-classified servers
  (`authorized`, `refreshable`, `expired`, `not-authorized`) with an expiry,
  derived only from the per-server token store and never from a token value.
- The sidecar gains a managed-agents read route and `skill-scope` / `mcp-scope`
  plan/apply operations; the GUI gains agent toggles on skill and MCP cards, a
  credential badge on MCP cards, and an agent tag on every doctor finding.

## Capabilities

### New Capabilities

- `capability-scope-editing`: change the agents a skill or MCP server reaches.
- `mcp-credential-status`: report credential state for OAuth-classified servers.
- `gui-finding-attribution`: doctor findings carry and display their agent.

## Impact

- `src/commands/skill.ts`, `src/commands/mcp.ts`, `src/cli.ts`, and
  `packages/gui/sidecar/routes/{read,planApply}.ts`.
- `packages/gui/src/views/{SkillsView,McpView,AgentsView}.tsx` and
  `packages/gui/src/lib/i18n.tsx` (these carry uncommitted work — edits stay
  local to the touched views).
- No change to the on-disk schema: `scope.yaml` and `servers.yaml` already
  hold exactly the data this writes.
- Out of scope: starting an OAuth flow from the GUI (it needs a loopback
  listener and a browser, a separate change), editing hub/gateway routes, and
  editing a built-in Skill's scope.
