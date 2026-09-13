## Why

`trellis onboard`'s own orchestration layer never surfaces MCP or memory
as migratable/syncable, even though both underlying commands fully
support them (`migrate --only mcp` since P16, `trellis memory sync`
since P15). A user who only ever runs `onboard` — the command whose own
purpose is "never run a further command by hand to finish onboarding" —
has no way to bring their real MCP servers or memory into canonical, or
to know memory sync exists at all. Confirmed live on a real machine this
session: `onboard`'s category picker literally hardcodes
`["skills", "instructions"]` as its only two options, and memory sync is
never called anywhere in `collectOnboardPlan`.

## What Changes

- `OnboardAgentSummary` gains an MCP-content signal for the candidate
  migration source, alongside its existing skill/instructions signals.
- `resolveMigrateCategories` (and its interactive picker / `--json`
  silent-default) extends from a two-way (skills, instructions) choice
  to a three-way (skills, instructions, mcp) choice, on the same footing.
- `collectOnboardPlan` runs `trellis memory sync`'s existing plan/apply
  logic as a new final stage, after `mcp sync` and before `secrets
  audit`, sharing the same `--dry-run`/`--json` conventions as every
  other stage. A `memory` server not yet being configured in
  `servers.yaml` is reported the same way memory sync's own standalone
  command already reports it — not swallowed, not treated as a failure.
- `printResult` prints the memory-sync stage's outcome in the same style
  as migrate/sync/mcp-sync/secrets-audit.

No change to `migrate.ts`, `mcp.ts`, or `memory.ts`'s own command
behavior — this is purely onboard's orchestration layer catching up to
commands that already exist and are already tested.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `onboarding-flow`: the chained-command list, the migrate-category
  picker's option set, and the onboard summary's own "what migrate can
  act on" description all change to include MCP; a new requirement is
  added for the memory-sync stage.

## Impact

- `src/commands/onboard.ts`: `OnboardAgentSummary`, `collectOnboardSummary`,
  `hasContent`, `resolveMigrateCategories`, `collectOnboardPlan`,
  `printResult`.
- `test/unit/onboard.test.ts`: existing tests must keep passing; new
  tests for the mcp category and the memory-sync stage.
- No change to `src/commands/migrate.ts`, `src/commands/mcp.ts`,
  `src/commands/memory.ts`, any adapter, or any probe.
