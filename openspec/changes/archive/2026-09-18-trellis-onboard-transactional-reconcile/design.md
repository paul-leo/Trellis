# Design

## Goals / Non-Goals

**Goals:**

- Make a real onboarding run all-or-nothing for files Trellis owns.
- Keep canonical source authoritative across mode switches.
- Make repeated runs idempotent and safe to use as reconciliation.
- Preserve the existing conflict rule: user-modified files are not forcibly
  restored during rollback.

**Non-Goals:**

- Do not delete and recreate canonical Skills, MCP servers, or memories on a
  mode switch.
- Do not automatically change or roll back an external Hub service.
- Do not make source migration overwrite differing canonical content.
- Do not automatically remove existing managed Agents during onboarding.

## Decisions

### D1 — Onboarding has one transaction boundary

After all non-mutating validation, source/target selection, install
confirmation, and mode preflight complete, `onboard` opens one backup session.
Every subsequent Trellis-owned file write receives that session. The session
is finalized only after sync and verification succeed.

### D2 — Mode changes are route transitions, not resets

The canonical MCP server definitions, Skill files, memories, secret policy,
and source migration results remain in place. A mode change updates only
`servers.yaml` routing and the native Agent projection. Unchanged migration
items remain `already-migrated`/no-op.

### D3 — Interactive mode changes require confirmation

When interactive onboarding requests a mode different from the current mode,
it shows the current mode, target mode, affected managed Agents, and whether a
local Gateway or external Hub is involved. The default is cancel. Explicit
CLI flags and selection files remain non-interactive and are already an
explicit authorization; their dry-run output must still show the transition.

### D4 — Preflight before writes

- Hub mode requires a non-empty URL and a valid canonical file before the
  transaction opens. Trellis does not mutate the external Hub.
- Gateway mode requires the Trellis runtime entry to be renderable and the
  local executable resolution to be available for the selected Agent.
- Direct mode has no external service precondition.

Full MCP handshakes remain opt-in; preflight must not unexpectedly spawn every
upstream server.

### D5 — Automatic rollback on blocked verification

After applying migration, native sync, and MCP sync, onboarding evaluates its
existing blocking verdicts and self-verification reports. If a blocking item
means the transaction did not hold, it runs the recorded rollback plan before
returning a non-zero result. If rollback encounters a user modification, it
reports that conflict and leaves the modified path untouched. The backup run
remains available to inspect.

### D6 — Repeated onboarding is reconcile-first

Already-managed Agents stay visible and selected in the interactive list.
Already-synced projections produce no writes. Source changes are migrated only
when new content exists or a user explicitly selects migration; conflicts are
reported rather than reset. There is no implicit `--reset` behavior.

## Verification

- A mode switch preview reports current → target and affected Agents.
- A repeated no-change onboard creates no backup operations and does not alter
  canonical or native files.
- A mode switch backup contains canonical and native writes and rollback
  restores both.
- A forced post-sync verification failure automatically restores the complete
  transaction and exits non-zero.
- Hub/Gateway validation failures occur before the first backup/write.
