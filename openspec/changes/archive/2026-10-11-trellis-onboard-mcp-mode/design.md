## Context

Three pieces of code already define the shape this change has to fit:

`src/core/canonical.ts`'s `loadServersYaml` (line 115) already reads
`hub`/`gateway` off `servers.yaml`'s top level into `McpConfig.hub`/
`.gateway`. Nothing writes them. `upsertServerYaml`/`removeServerYaml`
(lines 171/190) are the only writers this file has, and both are scoped
to one entry under `servers` — a `Document`-based `setIn`/`deleteIn`
edit that preserves every other key's formatting exactly, refusing (no
write) if the file doesn't exist or fails to parse. The missing writer
for `hub`/`gateway` needs the identical mechanism, not a new one.

`src/commands/onboard.ts`'s managed-set resolution (`resolveManagedAgents`,
`readManagedYaml`/`writeManagedYaml`, wired into `collectOnboardPlan`
around line 457) is the only existing place in this codebase that
already solves "same command, first run and Nth run": it reads persisted
state before deciding what to ask, a `--manage <ids|none>` flag gives
non-interactive control, an interactive picker pre-checks whatever's
already there, and the final write is computed once and applied
unconditionally (`writeManagedYaml` runs whenever `!opts.dryRun`,
regardless of whether the set actually changed). This is the shape to
match, not reinvent.

`src/adapters/mcpPlan.ts`'s `resolveMcpPlan` (line 138) is the *reader*
of `mcp.gateway`/`mcp.hub` — gateway checked first, then hub, then
per-server direct mode. This change never touches that dispatch; it only
adds a way to set the fields it already reads.

`src/commands/memory.ts`'s `resolveMemoryServerGraphPath` (line 48) looks
up `mcp.servers["memory"]` specifically and its
`static_env.MEMORY_FILE_PATH`; `collectMemorySyncResult`/`runMemorySync`
already work correctly the moment that entry exists — nothing in
`src/lib/memoryGraph.ts` needs to change for this feature. The gap is
purely upstream: nothing writes the entry.
`schema/servers.example.yaml`'s `memory:` block is commented out and only
ever a copy-paste template a user would apply by hand — this change turns
it into a real, code-owned constant and a writable toggle instead.

## Goals / Non-Goals

**Goals:**
- One command (`trellis onboard`) resolves MCP mode on a fresh machine
  and on an already-configured one, with no branching on which this is —
  omitting the new flag always means "preserve whatever canonical
  already has," which is a no-op on both a first run (nothing set) and a
  later one (something set).
- No canonical file is ever hand-edited to reach gateway or hub mode
  again; a real Trellis writer exists for it.
- `--mcp-mode` stays discoverable without adding a prompt to every
  interactive run.

**Non-Goals:**
- An interactive picker for mode (D1 justifies why).
- A standalone `trellis mcp mode` command (proposal.md "Explicitly out
  of scope").
- Per-agent mixed mode selection through this flag (proposal.md
  "Explicitly out of scope").
- Changing `resolveMcpPlan`'s dispatch order or any per-server planning
  logic — this change is entirely about how the fields it reads get set.

## Decisions

**D1 — Mode selection is opt-in via `--mcp-mode`, never an interactive
prompt.** Resolves proposal.md's open question. Managed-set selection
recurs naturally because *what's installed* genuinely varies machine to
machine and run to run — a picker earns its place every time. MCP mode
does not vary the same way: most users pick direct (the default) and
never revisit it, and the decision has a wide blast radius the moment it
does change — switching to gateway reroutes every managed agent's MCP
transport through a subprocess Trellis now owns; switching to hub points
every agent at an external endpoint. A picker a user tabs through on
muscle memory is the wrong interaction for a change with that reach; a
flag the user has to type out (`--mcp-mode gateway`) cannot be triggered
by accident. Omitting the flag is therefore not "no answer given, please
choose" (managed-set's non-interactive posture) but "no change
requested" — a well-defined no-op identical on every run regardless of
prior state, which is exactly the "one command, first and Nth time"
property being asked for.

**D2 — `writeMcpModeYaml(path, mode)` in `src/core/canonical.ts`, same
`Document`-based mechanism as `upsertServerYaml`.** Parses with
`parseDocument`, refuses (matching `ServersYamlWriteResult`'s existing
`{ ok: false, error }` shape) if the file doesn't exist or fails to
parse, then:
  - `mode.kind === "direct"`: `doc.delete("hub")`, `doc.delete("gateway")`.
  - `mode.kind === "hub"`: `doc.set("hub", { url: mode.url })`,
    `doc.delete("gateway")`.
  - `mode.kind === "gateway"`: `doc.setIn(["gateway", "enabled"], true)`;
    if `mode.agents` is given, `doc.setIn(["gateway", "agents"],
    mode.agents)`, else `doc.deleteIn(["gateway", "agents"])`;
    `doc.delete("hub")`.
  Then `forceBlockStyle` on the touched top-level map the same way
  `upsertServerYaml` already does for a fresh `init`-scaffolded file, and
  `writeFileSync`. One function, one exhaustive switch on mode — no
  separate direct/hub/gateway writer functions, since they share the
  "clear the other two" behavior (D3) and diverging them would risk one
  path forgetting to clear a sibling field.

**D3 — The three modes are mutually exclusive at the writer.** Setting
`hub` always clears `gateway` and vice versa; setting `direct` clears
both. `resolveMcpPlan` already has an implicit priority order (gateway
before hub) that *could* tolerate both being set, but a mode selector
that left stale state behind — e.g. an old `hub.url` surviving a switch
to `gateway`, inert until the next switch back — is worse than one that
always leaves canonical in exactly the state the last selection implies.
A user who switches from hub back to direct and later wants hub again
supplies `--hub-url` again; the value is not remembered across a trip
through `direct` on purpose.

**D4 — Flag validation, done once, before any write.** `--mcp-mode hub`
without `--hub-url` refuses the whole run (same posture as an invalid
`--manage` token today — a top-level refusal, `verdict: []` plus the
existing refusal-folding onboard already does). `--hub-url` or
`--gateway-agents` given without a matching `--mcp-mode` also refuses,
rather than silently ignoring a flag the user clearly meant something
by. `--gateway-agents` parses as a comma-separated agent-id list only —
deliberately narrower than `parseManagedSelection`'s grammar, which also
accepts a numbered index referring to a candidate list shown during an
interactive prompt. `--gateway-agents` is flag-only and never prompted
(D1), so there is no numbered list on screen for a digit to mean
anything against; a shared parser would have silently accepted "1,2" as
shorthand for an ordering the user never saw.

**D5 — Resolution runs once, right after managed-set is written, before
migrate.** Both managed-set and mode are "how is this machine configured"
decisions that `onboard` resolves and persists once per run, ahead of
the stages (migrate, sync, mcp sync) that act on the result — placing
mode resolution immediately after managed-set keeps that grouping
explicit rather than burying an infrastructure decision among file-sync
stages. Nothing later in the chain needs mode resolved before
managed-set specifically (`GatewayConfig.agents`'s "omitted = every
managed agent" fallback is resolved later, at `resolveMcpPlan` time,
already reading canonical's `managedAgents` — not something `onboard`
needs to compute here), so the ordering constraint is about narrative
grouping, not data dependency.

**D6 — A non-`--json` TTY run prints the resolved mode as one status
line, never a prompt.** e.g. `mcp mode: direct (unchanged) — pass
--mcp-mode hub|gateway to change` or `mcp mode: gateway (changed from
direct)`. This is what keeps the flag discoverable under D1's
no-interactive-prompt rule — a user who never reads `--help` still sees,
every run, both the current mode and the flag name that changes it.
Suppressed under `--json` and non-TTY, matching every other purely
informational line onboard already prints.

**D7 — `OnboardResult` gains `mcpMode: { current, changed }`,
additive.** `current` is the mode *after* this run's resolution (so a
`--json` consumer never has to separately re-read canonical to know what
onboard just did), `changed` is `true` only when `--mcp-mode` was given
and differed from what canonical had before this run. No existing
`OnboardResult` field changes meaning, matching the additive-only
migration rule `trellis-onboard-closed-loop` already established for
`--json`.

**D8 — The memory toggle reuses the existing per-server writers
directly; no new writer is added.** `upsertServerYaml`/`removeServerYaml`
already do exactly what `--memory on`/`off` need — write or remove one
`servers` entry named `"memory"`, with the same comment-preserving,
refuse-if-missing-or-unparseable guarantees D2's new writer was built to
match for `hub`/`gateway`. Reaching for a third writer here would just be
`upsertServerYaml` again under a different name.

**D9 — The default definition becomes one real constant, not two
independent copies of the same literal.**
`schema/servers.example.yaml`'s commented-out `memory:` block is prose a
human reads and hand-transcribes today. This change adds
`DEFAULT_MEMORY_SERVER_DEF` to `src/commands/memory.ts` (alongside the
`MEMORY_SERVER_NAME` constant already there) — `{ transport: "stdio",
command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"],
staticEnv: { MEMORY_FILE_PATH: "~/.trellis/memories/graph.jsonl" } }` —
and `onboard` writes that constant verbatim via `upsertServerYaml`. The
example file's comment stays as documentation for anyone reading
`servers.yaml` by hand, but is no longer the only place this shape is
recorded; a future edit to the default only has one place to change in
code.

**D10 — `--memory on` refuses if `"memory"` is already in
`knownHostInjected`, rather than writing a definition `mcp sync` would
immediately refuse to propagate.** `resolveMcpPlan` already refuses to
write any server whose name collides with `knownHostInjected`
(`collisionMessage`/`collisionRemediation`, `src/adapters/mcpPlan.ts`) —
letting `--memory on` add the entry anyway would mean the write to
canonical "succeeds" while every subsequent `mcp sync` fails on it for
every agent, a confusing two-step failure instead of one clear one.
Refusing at resolution time, before anything is written, states the real
reason plainly: a host on this machine is already presumed to inject its
own memory connector under that name (same fact
`schema/servers.example.yaml`'s own comment already explains), so there
is nothing for a static definition to add.

**D11 — Memory resolution runs in the same phase as mode resolution,
immediately after it, before migrate.** Same reasoning as D5 — both are
"how is this machine configured" decisions resolved once per run, ahead
of the stages that act on the result. Placing it right after mode keeps
that whole group of resolved-state decisions together and, concretely,
means a single `trellis onboard --memory on` run's own later `mcp sync`
stage sees the new entry and writes it to every agent, and its own later
`memory sync` stage sees a configured server and pushes canonical
`memories/*.md` into the graph — all in one run, not requiring a second
`trellis onboard` afterward.

**D12 — Same opt-in-only, no-prompt, status-line-only posture as mode
(D1/D6), and the same skip-under-`--dry-run` rule.** Turning memory on
does not carry mode's "reroutes every agent's transport at once" blast
radius, but consistency inside one command matters more here than a
narrower risk argument: `onboard` should not ask a picker question for
mode and a typed flag for memory, forcing the user to learn two different
interaction rules in the same run. `--memory on|off` prints one status
line the same way (`memory: off (unchanged) — pass --memory on to
enable` / `memory: on (changed from off)`), suppressed under `--json` and
non-TTY, and performs no write under `--dry-run`.

**D13 — `OnboardResult` gains `memory: { current: "on" | "off"; changed:
boolean }`, additive, mirroring `mcpMode` (D7).** Same rule: `current`
reflects this run's resolution, `changed` is `true` only when `--memory`
was given and differed from canonical's prior state, no existing field's
meaning changes.

## Risks / Trade-offs

- [A user wants mode discoverable without running the full onboard
  chain] → D6's status line only appears as part of a run that also does
  migrate/sync/etc.; a user who wants *just* the current mode has no
  narrower command. Accepted for this change (proposal.md's out-of-scope
  standalone-command note); `trellis doctor`/`--json` onboard runs
  already exist as narrower read paths if this proves a real gap.
- [Switching to `direct` silently drops a remembered `hub.url` (D3)] →
  deliberate, not silent to the user: the mode-change status line (D6)
  states the new mode plainly, and switching *back* requires re-supplying
  `--hub-url`, which is itself a legible signal that nothing was carried
  over.
- [No interactive prompt means scripting `--mcp-mode` wrong (e.g. typo'd
  value) only surfaces at run time] → same posture as `--manage`'s and
  `--agent`'s existing flag validation; a bad value refuses cleanly with
  a message listing the valid ones, not a silent fallback to direct.

## Migration Plan

Purely additive. `servers.yaml` files with no `hub`/`gateway` keys are
unaffected until `--mcp-mode` is explicitly passed; existing hand-set
`hub`/`gateway` blocks (however they got there) are read exactly as
`resolveMcpPlan` already reads them and are left untouched by any run
that omits `--mcp-mode`. No existing flag, refusal message, or exit-code
rule changes.

## Open Questions

- Whether `--gateway-agents` should validate that every named agent is
  actually in the managed set (vs. `GatewayConfig.agents` simply having
  no effect for an agent that isn't managed, which is already true of
  the field today via `isGatewayAgent`'s own `managedAgents.includes`
  check). Leaning toward no extra validation — consistent with treating
  `gateway.agents` as a pure narrowing filter, not a second managed-set —
  but worth revisiting if real use shows it's a common mistake.
