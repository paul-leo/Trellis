# trellis-cli-init

## Why

Every command that needs `~/.trellis/` (`sync`, `mcp sync`, `secrets
audit`) already refuses cleanly when it's missing — verified live:
`No canonical source at .../.trellis. Create it before running trellis
sync — see docs/architecture.md's canonical schema.` But there is no
command that satisfies that instruction. A brand-new user's actual path
today is: read `docs/architecture.md`'s schema section, hand-write
`agents.md`, `scope.yaml`, `mcp/servers.yaml`, `secrets.policy.yaml`
from scratch. This is exactly the manual process this session used to
onboard pi for real (`mkdir`, hand-copy 44 skill directories, hand-write
`scope.yaml`) — it was never turned into a command.

A second, previously unnoticed inconsistency, found while designing
this command's output: `trellis doctor`'s MCP-collision check
(`capability-drift-detection`) still only ever uses
`DEFAULT_KNOWN_HOST_INJECTED` — a hardcoded 4-name list documented in
its own comment as "interim... until P1 wires this from
`.trellis/mcp/servers.yaml`'s real `known_host_injected` field." P1
shipped long ago; `mcp sync`'s collision refusal (`mcpPlan.ts`) has read
canonical's `known_host_injected` since then. `doctor`'s CLI entry point
(`src/cli.ts`) never picked it up — it still always constructs
`runDoctor({ json, probeMcp })` with no `knownHostInjected`, so `doctor`
and `mcp sync` can disagree about what counts as a collision on any
machine whose real host-injected connector names differ from this
project's own development machine (`atlassian`/`sentry`/`memory`/
`mirasim`, which are specific to this machine's mirasim install, not a
universal default). This directly shapes what `trellis init`'s
generated `servers.yaml` should contain: an empty
`known_host_injected: []` with an explanatory comment, not a copy of
this machine's own list — a fresh install elsewhere has different (or
no) runtime-injected connectors, and if `doctor` doesn't already read
canonical for real, seeding the template with this machine's values
would just create a second, silently-wrong hardcoded list.

## What Changes

- New command: `trellis init`. Creates `~/.trellis/` with a minimal,
  valid skeleton if it doesn't already exist:
  - `agents.md` — a short placeholder plus a comment pointing at
    `trellis migrate` (a following change) for pulling in an existing
    agent's real instructions.
  - `scope.yaml` — absent by default (its own absence already means
    "everything shared," per `canonical-source-loading`'s existing
    behavior) — not generated at all, to avoid a stub file implying
    scoping is required.
  - `mcp/servers.yaml` — `servers: {}` and `known_host_injected: []`,
    each with a comment explaining what they're for and pointing at
    `schema/servers.example.yaml`.
  - `secrets.policy.yaml` — `allowed_vars: []`, `reject_patterns:` seeded
    with the same generic credential-shape patterns
    `schema/servers.example.yaml`'s policy example already documents (not
    invented fresh — reusing an existing, already-reviewed list).
  - Idempotent: if `~/.trellis/agents.md` already exists, `init` reports
    "already initialized" and exits 0 — it never overwrites a real
    canonical source. Partial existence (e.g. `agents.md` present,
    `mcp/servers.yaml` missing) fills in only what's missing, the same
    create-only-what's-needed discipline every adapter's `plan()`
    already follows.
  - Also probes all four agents and prints which are present, with a
    one-line pointer to `trellis migrate --from <agent>` (next change)
    for each one found — connecting "you just initialized an empty
    source" to "here's how to not start from zero."
- `doctor`'s CLI entry (and `collectDoctorReport`'s default resolution,
  not its signature) now tries to load canonical source first; if it
  exists, `known_host_injected` comes from there; if it doesn't (P0's
  original no-canonical-source scenario, still fully supported), it
  falls back to the same hardcoded default as today — behavior for
  every machine that already has a canonical source with real
  `known_host_injected` entries changes to *use them*; every other
  scenario is unchanged.

## Capabilities Touched

- **NEW**: `canonical-source-bootstrap` (`trellis init`).
- **MODIFIED**: `capability-drift-detection` (doctor's collision check
  reads canonical's `known_host_injected` when a canonical source
  exists, instead of always using the hardcoded default).

## Non-Goals

- No `trellis migrate --from <agent>` here — that's the next change,
  deliberately separated since it touches real per-agent extraction
  logic and deserves its own design/testing pass.
- No interactive prompts (choosing which agents to target, confirming
  file contents) — `init` is a single, non-interactive, idempotent
  command. Anything requiring a choice is deferred to `migrate` or left
  as a manual edit of the generated files.
- No change to `sync`/`mcp sync`/`secrets audit`'s own no-canonical-
  source error message — it already correctly says "create it," and
  now there's a command that does.
