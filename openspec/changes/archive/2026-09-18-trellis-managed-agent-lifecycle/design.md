# Design

## Context

`onboard` intentionally unions new selections with `managed.yaml` to prevent
an omitted checkbox from silently revoking management. The same safety rule
means there is currently no Trellis-owned way to narrow an old managed set.
The canonical file is the outer authorization boundary for every adapter, so
manual editing is possible but contradicts the product's managed workflow.

## Goals / Non-Goals

**Goals:**

- Make add, exact replacement, and removal explicit and scriptable.
- Preserve existing onboarding semantics.
- Make the one canonical write recoverable through `trellis rollback`.
- Detach agents without mutating their current native state.

**Non-Goals:**

- No cleanup of skills, MCP entries, instructions, or extensions when an agent
  is detached.
- No installation, probing, migration, or synchronization inside `manage`.
- No change to capability scope semantics.

## Decisions

### D1 — Standalone lifecycle command

Use `trellis manage list|set|add|remove` rather than changing `--manage` on
onboard. This keeps the original no-silent-subtraction promise and makes
removal intent unambiguous in shell history and automation.

### D2 — Pure plan before apply

Parse a comma-separated list (`none` for an empty exact set), validate every
id, then compute `{ current, desired, added, removed, changed }` before any
write. JSON, text, dry-run, tests, and apply all consume that same plan.

### D3 — Detach means future-write boundary only

Removing an agent updates only `managed.yaml`. Trellis does not infer whether
an existing native file should be deleted, copied, or converted to user-owned
state. A later explicit cleanup capability can make that decision with its own
ownership and confirmation rules.

### D4 — Backup the canonical mutation

A real changed plan opens one backup session named `manage-<operation>`, writes
`managed.yaml` through it, and finalizes once. Dry runs and no-ops open no
session. Existing rollback drift checks apply unchanged.

### D5 — Stable canonical ordering

Persist ids in `ALL_AGENTS` order regardless of input ordering. This keeps
reruns byte-stable and avoids meaningless diffs.

## Risks / Trade-offs

- **Detached native state can later drift.** → This is intentional; doctor
  still reports it as unmanaged context, while Trellis performs no write.
- **`set none` can disable all future management.** → It is an explicit
  lifecycle command, supports dry-run, and is recoverable through rollback.
- **Users may expect remove to clean files.** → Output explicitly states that
  native state was preserved.

## Migration Plan

1. Ship the command without changing existing `managed.yaml` files.
2. Preview the local transition with `trellis manage set claude-code,pi
   --dry-run`.
3. Apply it, verify the backup run, then onboard/sync only the resulting set.
4. Use `trellis rollback` to restore the previous set if needed.
