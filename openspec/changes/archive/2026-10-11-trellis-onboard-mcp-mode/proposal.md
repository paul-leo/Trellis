## Why

Trellis has three MCP management modes — direct (the default, one native
entry per server per agent), hub (`mcp.hub.url`, one static HTTP entry),
and gateway (`mcp.gateway.enabled`, one `trellis mcp-gateway --agent
<id>` entry) — but no command can select or change which one is active.
`trellis mcp add`'s flags (`--transport`, `--command`, `--args`, `--url`,
`--headers`, `--env`, `--static-env`, `--agents`, `--enabled`) are all
per-server; none touch the top-level `mcp.gateway`/`mcp.hub` fields on
`McpConfig`. `src/core/canonical.ts` can read those fields
(`loadServersYaml`) but has no writer for them — only `upsertServerYaml`/
`removeServerYaml`, both scoped to one `servers` entry. The only way to
enable gateway or hub mode today is hand-editing
`~/.trellis/mcp/servers.yaml`'s top-level keys directly, which bypasses
every guarantee Trellis's plan/apply commands exist to provide (conflict
detection, backup/rollback, comment-preserving writes) — explicitly
rejected as a workaround during this project's own real-machine use.

Building that missing command naively — a one-shot `trellis mcp mode
<value>` a user runs once and never again — would repeat a mistake
`onboard` has already made once and fixed: forcing the user to learn a
second command for something that is really a reconfiguration of the
same state `onboard` already owns (compare `managed.yaml`, which
`onboard` reads, prompts a delta against, and writes back on every run,
first or hundredth). Mode selection should follow that same shape:
resolvable through `trellis onboard` itself, whether this is the very
first run on a fresh machine or the tenth run reconfiguring an existing
one — one command, not a fork into "setup" vs. "reconfigure" paths.

The same gap exists one level down for the shared-memory backend. Onboard
already chains a `memory sync` stage (`src/commands/memory.ts`), but that
stage is a no-op on any machine with no `mcp.servers["memory"]" entry —
which is every machine today, since nothing writes that entry either.
`schema/servers.example.yaml` documents the default definition
(`@modelcontextprotocol/server-memory`, `static_env.MEMORY_FILE_PATH`)
only as commented-out example text a user would otherwise have to
hand-copy in — the exact same class of workaround this change already
rejects for mode. Unlike mode, no new writer is needed
(`upsertServerYaml`/`removeServerYaml` already do exactly this, scoped to
one `servers` entry); what's missing is onboard's own resolution step and
flag, shaped the same idempotent way as mode.

## What Changes

- `src/core/canonical.ts` gains `writeMcpModeYaml(path, mode)`: a
  `Document`-based edit (same mechanism as `upsertServerYaml`) that sets
  or clears the top-level `hub`/`gateway` keys in `servers.yaml`,
  touching no `servers` entry and preserving every other key's
  formatting. This is the missing write path — the concrete fix for "no
  command can do this without hand-editing YAML."
- `trellis onboard` gains `--mcp-mode <direct|hub|gateway>`, plus
  `--hub-url <url>` (required with `hub`) and `--gateway-agents
  <ids>` (optional with `gateway`, omitted = every managed agent, same
  semantics `GatewayConfig.agents` already has). Omitting `--mcp-mode`
  entirely leaves whatever is already in canonical untouched and prompts
  for nothing — the current mode on a fresh machine (nothing configured)
  and the current mode on an established one (already configured) are
  both just "preserved," making first-run and Nth-run behavior identical
  by construction rather than by branching on which run this is.
- No interactive prompt is added for mode selection. Unlike managed-set
  (which varies per machine and benefits from a recurring checkbox), a
  mode change is infrequent and has a wide blast radius — it changes
  every managed agent's MCP transport at once — so it stays a deliberate,
  explicit flag rather than something a picker's Enter-mashing could
  toggle by accident. A non-`--json` TTY run does print the resolved mode
  as a one-line status, so `--mcp-mode` stays discoverable without
  costing every run a prompt.
- `OnboardResult` (and `--json` output) gains an additive `mcpMode: {
  current: "direct" | "hub" | "gateway", changed: boolean }` field.
- `trellis onboard` gains `--memory <on|off>`, resolved and reported the
  same way as `--mcp-mode`: omitted leaves whatever's already configured
  untouched (no `mcp.servers["memory"]` on a fresh machine stays absent;
  an already-configured one stays configured), no interactive prompt, one
  status line on a TTY. `on` writes the default definition via
  `upsertServerYaml` unless `"memory"` is already in
  `knownHostInjected` (refused, with the same explanation
  `schema/servers.example.yaml`'s own comment already gives — a host is
  presumed to inject its own connector under that name already); `off`
  removes it via `removeServerYaml`. Because this runs before onboard's
  existing `mcp sync` and `memory sync` stages in the same run, turning
  memory on and actually seeing it synced to every agent and populated
  from canonical `memories/*.md` is one `trellis onboard --memory on`
  call, not two. `OnboardResult` gains an additive `memory: { current:
  "on" | "off", changed: boolean }` field, mirroring `mcpMode`.

Explicitly out of scope:
- A standalone `trellis mcp mode` command outside onboard. The writer
  (`writeMcpModeYaml`) is a small, reusable primitive that such a command
  could call later with no rework, but the stated need is specifically
  `onboard`'s rerun story — shipping the smallest change that satisfies
  it first, consistent with this project's incremental delivery history.
- Per-agent mixed mode (e.g. codex on gateway, kiro on hub). Already
  structurally possible via `gateway.agents` narrowing plus per-server
  `agents` scoping in direct mode, but a three-way `--mcp-mode` selector
  can't express "different agents, different modes" without becoming a
  second, more complex flag grammar — a future change if real usage asks
  for it.

## Capabilities

### New Capabilities

(none — this deepens `onboarding-flow`, the same capability
`trellis-onboard-closed-loop` deepened)

### Modified Capabilities

- `onboarding-flow`: gains two new resolved-state stages (MCP mode, and
  the memory server toggle), each reported and included in `--json`
  output, following the same read-current/prompt-only-when-flagged/
  write-once shape the existing managed-set requirement already
  establishes.

## Impact

- Changed: `src/core/canonical.ts` (`writeMcpModeYaml`), `src/commands/
  memory.ts` (exports the default memory server definition, currently
  only example-file text, as a real constant `onboard` can write),
  `src/commands/onboard.ts` (mode and memory resolution wired into
  `collectOnboardPlan`, status lines in the report, `mcpMode`/`memory` on
  `OnboardResult`), `src/cli.ts` (`--mcp-mode`/`--hub-url`/
  `--gateway-agents`/`--memory` flag parsing and the onboard help text).
- Changed: `openspec/specs/onboarding-flow/spec.md` via this change's own
  spec delta.
- Changed: `docs/getting-started.md` (documents the new flags),
  `docs/architecture.md` (mentions onboard as the way to enable
  gateway/hub mode and the memory server, not hand-editing), `docs/
  roadmap.md`.
- Unchanged by design: every existing onboard flag and refusal message;
  `--json`'s existing fields keep their existing meaning (additive only);
  `resolveMcpPlan`'s gateway-before-hub-before-direct dispatch order
  (`src/adapters/mcpPlan.ts`) is untouched; `memory sync`'s own sync logic
  (`src/lib/memoryGraph.ts`) is untouched — this change only adds a way
  to get a `memory` server entry into canonical in the first place, so
  that existing stage has something to act on.
